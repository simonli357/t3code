import {
  CheckpointRef,
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  SettledThreadPurgeError,
  ThreadId,
  type ProviderInstanceConfig,
  type ServerSettings,
  type SettledThreadPurgeInput,
  type SettledThreadPurgeReport,
  type SettledThreadPurgeThread,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import {
  findSessionTranscripts,
  resolveDeepseekHarnessTranscriptHome,
  resolveTranscriptHome,
  type TranscriptEntry,
} from "../project/AgentTranscripts.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export class SettledThreadPurge extends Context.Service<
  SettledThreadPurge,
  {
    /**
     * Remove threads settled for more than `settledForDays` days: every row they own except
     * their final `thread.deleted` event, plus their native provider transcripts and checkpoint
     * refs. The thread's projection row stays, as replaying that one event would recreate it.
     * Dry run unless `dryRun` is false.
     */
    readonly purge: (
      input: SettledThreadPurgeInput,
    ) => Effect.Effect<SettledThreadPurgeReport, SettledThreadPurgeError>;
  }
>()("t3/orchestration-v2/SettledThreadPurge") {}

const DAY_MS = 86_400_000;

/**
 * Everything one thread owns, bulk tables first. The projection row of the thread itself is not
 * here: it stays with the tombstone event. `?1` is the thread, `?2` the sequence of the one
 * event that stays. V1 tables are skipped on databases that no longer have them.
 */
const THREAD_ROWS = [
  ["orchestration_events", "aggregate_kind = 'thread' AND stream_id = ?1 AND sequence <> ?2"],
  ["orchestration_command_receipts", "aggregate_kind = 'thread' AND aggregate_id = ?1"],
  ["orchestration_v2_command_receipts", "thread_id = ?1"],
  ["orchestration_v2_effect_outbox", "thread_id = ?1 AND status NOT IN ('pending', 'running')"],
  ["orchestration_v2_turn_item_positions", "thread_id = ?1"],
  ["orchestration_v2_projection_turn_items", "thread_id = ?1"],
  ["orchestration_v2_projection_messages", "thread_id = ?1"],
  ["orchestration_v2_projection_plans", "thread_id = ?1"],
  ["orchestration_v2_projection_runtime_requests", "thread_id = ?1"],
  ["orchestration_v2_projection_provider_turns", "thread_id = ?1"],
  ["orchestration_v2_projection_provider_threads", "thread_id = ?1"],
  ["orchestration_v2_projection_provider_session_bindings", "thread_id = ?1"],
  ["orchestration_v2_projection_provider_sessions", "thread_id = ?1"],
  ["orchestration_v2_projection_subagents", "thread_id = ?1 OR child_thread_id = ?1"],
  ["orchestration_v2_projection_nodes", "thread_id = ?1"],
  ["orchestration_v2_projection_run_attempts", "thread_id = ?1"],
  ["orchestration_v2_projection_runs", "thread_id = ?1"],
  ["orchestration_v2_projection_checkpoints", "thread_id = ?1"],
  ["orchestration_v2_projection_checkpoint_scopes", "thread_id = ?1"],
  ["orchestration_v2_projection_context_handoffs", "thread_id = ?1"],
  [
    "orchestration_v2_projection_context_transfers",
    "source_thread_id = ?1 OR target_thread_id = ?1",
  ],
  ["orchestration_v2_thread_launch_workflows", "thread_id = ?1"],
  ["orchestration_v2_legacy_imports", "thread_id = ?1"],
  ["mcp_app_model_context", "thread_id = ?1"],
  ["checkpoint_diff_blobs", "thread_id = ?1"],
  ["projection_thread_activities", "thread_id = ?1"],
  ["projection_thread_messages", "thread_id = ?1"],
  ["projection_turns", "thread_id = ?1"],
  ["projection_pending_approvals", "thread_id = ?1"],
  ["projection_thread_proposed_plans", "thread_id = ?1"],
  ["projection_thread_pull_requests", "thread_id = ?1"],
  ["projection_thread_sessions", "thread_id = ?1"],
  ["provider_session_runtime", "thread_id = ?1"],
  ["custom_workers", "thread_id = ?1 OR owner_id = ?1"],
  ["custom_worker_jobs", "worker_id = ?1 OR target_id = ?1"],
  ["custom_orchestrator_handoffs", "thread_id = ?1 OR owner_id = ?1"],
  ["custom_orchestrator_authority", "thread_id = ?1"],
  ["custom_session_message_confirmations", "sender_id = ?1 OR target_id = ?1"],
  ["custom_worker_reclaims", "owner_id = ?1"],
  ["custom_session_renewals", "thread_id = ?1"],
  ["custom_session_moves", "(thread_id = ?1 OR target_thread_id = ?1) AND locked = 0"],
  ["custom_session_move_job_aliases", "thread_id = ?1"],
  ["session_workspaces", "thread_id = ?1"],
  ["worker_recommendations", "thread_id = ?1"],
  ["base_session_submissions", "thread_id = ?1"],
  ["provider_allocation_failed_starts", "thread_id = ?1"],
  ["provider_allocation_start_rejections", "thread_id = ?1"],
  ["provider_allocation_reservations", "thread_id = ?1"],
  // V1's own row for the thread. The V1 importer recreates any thread without a created event.
  ["projection_threads", "thread_id = ?1"],
] as const;
// A busy thread owns tens of thousands of event rows with random-key indexes:
// one DELETE of them holds SQLite, and with it the event loop, for a minute.
const DELETE_BATCH = 500;
const V1_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export interface PurgeGraph {
  /** Top-level threads settled long enough. `blocked` is a reason that holds on its own. */
  readonly candidates: ReadonlyArray<{
    readonly threadId: string;
    readonly blocked: string | null;
  }>;
  /** Threads that exist and are not deleted. */
  readonly liveThreadIds: ReadonlySet<string>;
  readonly workers: ReadonlyArray<{
    readonly threadId: string;
    readonly ownerId: string;
    readonly remote: boolean;
  }>;
  readonly activeJobs: ReadonlyArray<{
    readonly id: string;
    readonly workerId: string;
    readonly targetId: string;
    readonly state: string;
  }>;
  /** `threadId` is the successor, `ownerId` the orchestrator it replaces. */
  readonly handoffs: ReadonlyArray<{ readonly threadId: string; readonly ownerId: string }>;
  /** A run of `threadId` implements a proposed plan of `linkedThreadId`. */
  readonly planLinks: ReadonlyArray<{ readonly threadId: string; readonly linkedThreadId: string }>;
  /** Forks inherit their parent's history, so a kept child needs its parent. */
  readonly forks: ReadonlyArray<{ readonly threadId: string; readonly parentId: string }>;
  /** Subagent threads go with their parent; one that is still busy keeps it. */
  readonly subagents: ReadonlyArray<{
    readonly threadId: string;
    readonly parentId: string;
    readonly blocked: string | null;
  }>;
  /** Native provider session of each thread, as `driver:sessionId`. */
  readonly sessionKeys: ReadonlyArray<{ readonly threadId: string; readonly key: string }>;
  /** Sessions a thread's own sessions were forked from and still read. */
  readonly sessionAncestors: ReadonlyArray<{ readonly threadId: string; readonly key: string }>;
}

/**
 * Which candidates can go without breaking a thread that stays. Removing one
 * candidate can strand another, so the rules repeat until nothing changes.
 * `cascade` lists the subagent threads that go with a purged parent.
 */
export function selectThreadsToPurge(graph: PurgeGraph): {
  readonly purge: ReadonlySet<string>;
  readonly skipped: ReadonlyMap<string, string>;
  readonly cascade: ReadonlyArray<string>;
} {
  const purge = new Set<string>();
  const skipped = new Map<string, string>();
  for (const candidate of graph.candidates) {
    // A settled worker's interrupted assignment will never resume; queued work still would.
    const job = graph.activeJobs.find(
      (entry) =>
        entry.workerId === candidate.threadId &&
        entry.targetId === candidate.threadId &&
        entry.state !== "interrupted",
    );
    const reason = candidate.blocked ?? (job ? `worker job ${job.id} is ${job.state}` : null);
    if (reason === null) purge.add(candidate.threadId);
    else skipped.set(candidate.threadId, reason);
  }

  const subagentChildren = new Map<string, Array<(typeof graph.subagents)[number]>>();
  for (const child of graph.subagents) {
    subagentChildren.set(child.parentId, [...(subagentChildren.get(child.parentId) ?? []), child]);
  }
  // A thread's whole subagent subtree, which is purged or kept with it.
  const subtree = (threadId: string, seen = new Set<string>()) => {
    const found: Array<(typeof graph.subagents)[number]> = [];
    for (const child of subagentChildren.get(threadId) ?? []) {
      if (seen.has(child.threadId)) continue;
      seen.add(child.threadId);
      found.push(child, ...subtree(child.threadId, seen));
    }
    return found;
  };
  const cascading = (threadId: string) => new Set(subtree(threadId).map((c) => c.threadId));

  const kept = (threadId: string) =>
    !purge.has(threadId) && !purgedWithParent.has(threadId) && graph.liveThreadIds.has(threadId);
  const purgedWithParent = new Set<string>();
  let changed = true;
  const drop = (threadId: string, reason: string) => {
    if (!purge.delete(threadId)) return;
    skipped.set(threadId, reason);
    changed = true;
  };
  while (changed) {
    changed = false;
    purgedWithParent.clear();
    for (const threadId of purge)
      for (const child of cascading(threadId)) purgedWithParent.add(child);
    for (const threadId of purge) {
      const busy = subtree(threadId).find((child) => child.blocked !== null);
      if (busy !== undefined) {
        drop(threadId, `its subagent ${busy.threadId} is kept: ${busy.blocked}`);
      }
    }
    for (const worker of graph.workers) {
      if (worker.remote || kept(worker.threadId)) {
        drop(worker.ownerId, `owns worker ${worker.threadId}, which is kept`);
      }
    }
    for (const job of graph.activeJobs) {
      if (job.workerId === job.targetId) continue;
      if (kept(job.targetId))
        drop(job.workerId, `worker job ${job.id} for ${job.targetId} is ${job.state}`);
      if (kept(job.workerId))
        drop(job.targetId, `worker job ${job.id} from ${job.workerId} is ${job.state}`);
    }
    for (const handoff of graph.handoffs) {
      if (kept(handoff.ownerId))
        drop(handoff.threadId, `took over from ${handoff.ownerId}, which is kept`);
      if (kept(handoff.threadId))
        drop(handoff.ownerId, `handed off to ${handoff.threadId}, which is kept`);
    }
    for (const link of graph.planLinks) {
      if (kept(link.linkedThreadId)) {
        drop(link.threadId, `shares a proposed plan with ${link.linkedThreadId}, which is kept`);
      }
      if (kept(link.threadId)) {
        drop(link.linkedThreadId, `shares a proposed plan with ${link.threadId}, which is kept`);
      }
    }
    for (const fork of graph.forks) {
      if (kept(fork.threadId)) {
        drop(fork.parentId, `is the history source of ${fork.threadId}, which is kept`);
      }
    }
    const keptSessions = new Map(
      graph.sessionKeys.filter((entry) => kept(entry.threadId)).map((entry) => [entry.key, entry]),
    );
    const keptAncestors = new Map(
      graph.sessionAncestors
        .filter((entry) => kept(entry.threadId))
        .map((entry) => [entry.key, entry]),
    );
    for (const entry of graph.sessionKeys) {
      const other = keptSessions.get(entry.key);
      if (other !== undefined && other.threadId !== entry.threadId) {
        drop(entry.threadId, `shares its provider session with ${other.threadId}, which is kept`);
      }
      const descendant = keptAncestors.get(entry.key);
      if (descendant !== undefined && descendant.threadId !== entry.threadId) {
        drop(
          entry.threadId,
          `its provider session is a fork ancestor of ${descendant.threadId}, which is kept`,
        );
      }
    }
  }
  purgedWithParent.clear();
  for (const threadId of purge)
    for (const child of cascading(threadId)) purgedWithParent.add(child);
  return { purge, skipped, cascade: [...purgedWithParent] };
}

const decodeCursor = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      resume: Schema.optional(Schema.String),
      threadId: Schema.optional(Schema.String),
    }),
  ),
);

interface RuntimeRow {
  readonly thread_id: string;
  readonly provider_name: string;
  readonly provider_instance_id: string | null;
  readonly resume_cursor_json: string | null;
}

/** V1 kept Claude's session UUID and Codex's thread id in the resume cursor. */
function legacySessionId(runtime: RuntimeRow): string | null {
  const cursor = Option.getOrUndefined(decodeCursor(runtime.resume_cursor_json ?? ""));
  const sessionId =
    runtime.provider_name === "claudeAgent"
      ? cursor?.resume
      : runtime.provider_name === "codex"
        ? cursor?.threadId
        : undefined;
  return sessionId ? sessionId : null;
}

const TRANSCRIPT_DRIVERS = new Set(["claudeAgent", "codex", "deepseekHarness", "pi"]);

interface NativeSession {
  readonly threadId: string;
  readonly driver: string;
  readonly instanceId: string;
  readonly nativeId: string;
  readonly providerThreadId: string | null;
  readonly forkedFrom: string | null;
}

const sessionKey = (session: Pick<NativeSession, "driver" | "nativeId">) =>
  `${session.driver}:${session.nativeId}`;

function instanceConfig(
  settings: ServerSettings,
  instanceId: string,
  driver: string,
): ProviderInstanceConfig | null {
  const configured = settings.providerInstances[ProviderInstanceId.make(instanceId)];
  if (configured !== undefined) return configured;
  // Built-in instances need no settings entry.
  if (instanceId === driver && TRANSCRIPT_DRIVERS.has(driver)) {
    return { driver: ProviderDriverKind.make(driver) };
  }
  return null;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly title: string;
  readonly project_id: string;
  readonly deleted_at: string | null;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly pinned_at: string | null;
  readonly worktree_path: string | null;
  readonly parent_id: string | null;
  readonly relationship: string | null;
  readonly workspace_root: string | null;
  readonly workspace_directory: string | null;
  readonly has_history: number;
  readonly busy: number;
  readonly locked: number;
}

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const checkpoints = yield* CheckpointStore;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const git = yield* GitVcsDriver;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const lock = yield* Semaphore.make(1);

  const existingTables = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
      (row) => row.name,
    ),
  );
  const threadRows = THREAD_ROWS.filter(([table]) => existingTables.has(table));
  // Only `orchestration_events` binds the sequence it keeps.
  const rowParams = (where: string, threadId: string, keepSequence: number) =>
    where.includes("?2") ? [threadId, keepSequence] : [threadId];

  const loadGraph = Effect.fn("SettledThreadPurge.loadGraph")(function* (settledBefore: string) {
    const threads = yield* sql<ThreadRow>`
      SELECT t.thread_id, t.title, t.project_id, t.deleted_at,
        json_extract(t.payload_json, '$.settledOverride') AS settled_override,
        json_extract(t.payload_json, '$.settledAt') AS settled_at,
        json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
        json_extract(t.payload_json, '$.worktreePath') AS worktree_path,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_id,
        json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
        p.workspace_root,
        (SELECT json_extract(w.binding_json, '$.workspaceDirectory') FROM session_workspaces w
          WHERE w.thread_id = t.thread_id AND w.active = 1) AS workspace_directory,
        EXISTS (SELECT 1 FROM orchestration_events e INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE e.application_event_version = 2 AND e.aggregate_kind = 'thread'
            AND e.stream_id = t.thread_id AND e.event_type = 'thread.created') AS has_history,
        (EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = t.thread_id
              AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting'))
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests q
            WHERE q.thread_id = t.thread_id AND q.status = 'pending')
          OR EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads b
            WHERE b.thread_id = t.thread_id
              AND json_array_length(COALESCE(json_extract(b.payload_json, '$.pendingBackgroundTasks'), '[]')) > 0)
        ) AS busy,
        EXISTS (SELECT 1 FROM custom_session_moves m WHERE m.thread_id = t.thread_id AND m.locked = 1) AS locked
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id`;
    const providerThreads = yield* sql<{
      thread_id: string;
      provider_thread_id: string;
      driver: string | null;
      provider_instance_id: string | null;
      native_id: string | null;
      forked_from: string | null;
    }>`
      SELECT thread_id, provider_thread_id, driver, provider_instance_id,
        json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id,
        json_extract(payload_json, '$.forkedFrom.providerThreadId') AS forked_from
      FROM orchestration_v2_projection_provider_threads`;
    const runtimes = existingTables.has("provider_session_runtime")
      ? yield* sql<RuntimeRow>`
          SELECT thread_id, provider_name, provider_instance_id, resume_cursor_json
          FROM provider_session_runtime`
      : [];
    const workers = yield* sql<{ thread_id: string; owner_id: string; state: string }>`
      SELECT thread_id, owner_id, state FROM custom_workers WHERE owner_id IS NOT NULL`;
    const activeJobs = yield* sql<{
      id: string;
      worker_id: string;
      target_id: string;
      state: string;
    }>`
      SELECT id, worker_id, target_id, state FROM custom_worker_jobs
      WHERE state IN ('queued', 'submitted', 'interrupted')`;
    const handoffs = yield* sql<{ thread_id: string; owner_id: string }>`
      SELECT thread_id, owner_id FROM custom_orchestrator_handoffs`;
    const planLinks = yield* sql<{ thread_id: string; linked: string }>`
      SELECT DISTINCT thread_id, json_extract(payload_json, '$.sourcePlanRef.threadId') AS linked
      FROM orchestration_v2_projection_runs
      WHERE json_extract(payload_json, '$.sourcePlanRef.threadId') IS NOT NULL
        AND json_extract(payload_json, '$.sourcePlanRef.threadId') <> thread_id`;

    const candidates = threads.filter(
      (thread) =>
        thread.has_history === 1 &&
        thread.relationship !== "subagent" &&
        thread.settled_override === "settled" &&
        thread.settled_at !== null &&
        thread.settled_at < settledBefore,
    );
    const blockedReason = (thread: ThreadRow) =>
      thread.pinned_at !== null
        ? "pinned"
        : thread.locked === 1
          ? "session move in progress, or a parked copy kept for a return move"
          : thread.busy === 1
            ? "a run, request or background task is still active"
            : null;

    const native = new Map<string, Array<NativeSession>>();
    const providerThreadById = new Map<string, NativeSession>();
    const addNative = (session: NativeSession) => {
      native.set(session.threadId, [...(native.get(session.threadId) ?? []), session]);
    };
    for (const row of providerThreads) {
      if (row.native_id === null || row.driver === null) continue;
      const session: NativeSession = {
        threadId: row.thread_id,
        driver: row.driver,
        instanceId: row.provider_instance_id ?? row.driver,
        nativeId: row.native_id,
        providerThreadId: row.provider_thread_id,
        forkedFrom: row.forked_from,
      };
      providerThreadById.set(row.provider_thread_id, session);
      addNative(session);
    }
    for (const runtime of runtimes) {
      const nativeId = legacySessionId(runtime);
      if (nativeId === null) continue;
      addNative({
        threadId: runtime.thread_id,
        driver: runtime.provider_name,
        instanceId: runtime.provider_instance_id ?? runtime.provider_name,
        nativeId,
        providerThreadId: null,
        forkedFrom: null,
      });
    }
    const ancestorsOf = (session: NativeSession) => {
      const found: Array<NativeSession> = [];
      const seen = new Set<string>();
      let current =
        session.forkedFrom === null ? undefined : providerThreadById.get(session.forkedFrom);
      while (current !== undefined && !seen.has(current.providerThreadId ?? "")) {
        seen.add(current.providerThreadId ?? "");
        found.push(current);
        current =
          current.forkedFrom === null ? undefined : providerThreadById.get(current.forkedFrom);
      }
      return found;
    };

    const graph: PurgeGraph = {
      candidates: candidates.map((thread) => ({
        threadId: thread.thread_id,
        blocked: blockedReason(thread),
      })),
      liveThreadIds: new Set(
        threads.filter((thread) => thread.deleted_at === null).map((thread) => thread.thread_id),
      ),
      workers: workers.map((worker) => ({
        threadId: worker.thread_id,
        ownerId: worker.owner_id,
        remote: worker.state === "remote",
      })),
      activeJobs: activeJobs.map((job) => ({
        id: job.id,
        workerId: job.worker_id,
        targetId: job.target_id,
        state: job.state,
      })),
      handoffs: handoffs.map((row) => ({ threadId: row.thread_id, ownerId: row.owner_id })),
      planLinks: planLinks.map((row) => ({ threadId: row.thread_id, linkedThreadId: row.linked })),
      forks: threads.flatMap((thread) =>
        thread.relationship === "fork" && thread.parent_id !== null && thread.has_history === 1
          ? [{ threadId: thread.thread_id, parentId: thread.parent_id }]
          : [],
      ),
      subagents: threads.flatMap((thread) =>
        thread.relationship === "subagent" && thread.parent_id !== null && thread.has_history === 1
          ? [
              {
                threadId: thread.thread_id,
                parentId: thread.parent_id,
                blocked: blockedReason(thread),
              },
            ]
          : [],
      ),
      sessionKeys: [...native.values()].flatMap((sessions) =>
        sessions.map((session) => ({ threadId: session.threadId, key: sessionKey(session) })),
      ),
      sessionAncestors: [...native.values()].flatMap((sessions) =>
        sessions.flatMap((session) =>
          ancestorsOf(session).map((ancestor) => ({
            threadId: session.threadId,
            key: sessionKey(ancestor),
          })),
        ),
      ),
    };
    const selected = selectThreadsToPurge(graph);
    return { threads, candidates, graph, native, ...selected };
  });
  type Plan = Effect.Success<ReturnType<typeof loadGraph>>;

  const resolveTranscripts = Effect.fn("SettledThreadPurge.resolveTranscripts")(
    function* (sessions: ReadonlyArray<NativeSession>, settings: ServerSettings) {
      const entries = new Map<string, TranscriptEntry>();
      const notes: Array<string> = [];
      let instanceId: string | null = sessions[0]?.instanceId ?? null;
      for (const session of sessions) {
        instanceId = session.instanceId;
        if (!TRANSCRIPT_DRIVERS.has(session.driver)) {
          notes.push(`transcripts not removed: unsupported provider (${session.driver})`);
          continue;
        }
        const instance = instanceConfig(settings, session.instanceId, session.driver);
        if (instance === null || instance.driver !== session.driver) {
          notes.push(
            `transcripts not removed: provider instance ${session.instanceId} is not configured`,
          );
          continue;
        }
        const home =
          session.driver === "deepseekHarness"
            ? yield* resolveDeepseekHarnessTranscriptHome(
                instance,
                ProviderInstanceId.make(session.instanceId),
                hostEnvironment,
                config.stateDir,
              ).pipe(Effect.provideService(Crypto.Crypto, crypto))
            : yield* resolveTranscriptHome(instance, hostEnvironment);
        if (home === null || home.driver !== session.driver) {
          notes.push(`transcripts not removed: cannot resolve the home of ${session.instanceId}`);
          continue;
        }
        const found = yield* findSessionTranscripts(home, session.nativeId);
        if (found.length === 0) notes.push(`no transcript found under ${home.homePath}`);
        for (const entry of found) entries.set(entry.path, entry);
      }
      return {
        instanceId,
        entries: [...entries.values()],
        note: sessions.length === 0 ? "no provider session recorded" : (notes[0] ?? null),
      };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const existingDirectory = (candidate: string | null) =>
    candidate === null
      ? Effect.succeed(null)
      : fs.exists(candidate).pipe(
          Effect.map((exists) => (exists ? candidate : null)),
          Effect.orElseSucceed(() => null),
        );

  // Refs are shared by every checkout of the repository; prefer the thread's own.
  const checkpointCwd = Effect.fn("SettledThreadPurge.checkpointCwd")(function* (
    thread: ThreadRow,
  ) {
    for (const cwd of [thread.worktree_path, thread.workspace_root]) {
      const existing = yield* existingDirectory(cwd);
      if (existing !== null) return existing;
    }
    return null;
  });

  /** V2 refs with the directory their scope captured in, plus V1's refs under the legacy prefix. */
  const collectCheckpointRefs = Effect.fn("SettledThreadPurge.collectCheckpointRefs")(function* (
    thread: ThreadRow,
  ) {
    const v2 = yield* sql<{ ref: string | null; cwd: string | null }>`
      SELECT json_extract(c.payload_json, '$.ref') AS ref,
        json_extract(s.payload_json, '$.cwd') AS cwd
      FROM orchestration_v2_projection_checkpoints c
      LEFT JOIN orchestration_v2_projection_checkpoint_scopes s ON s.scope_id = c.scope_id
      WHERE c.thread_id = ${thread.thread_id}`;
    const fallbackCwd = yield* checkpointCwd(thread);
    const byCwd = new Map<string, Set<string>>();
    for (const row of v2) {
      if (row.ref === null) continue;
      const cwd = (yield* existingDirectory(row.cwd)) ?? fallbackCwd;
      if (cwd === null) continue;
      byCwd.set(cwd, (byCwd.get(cwd) ?? new Set()).add(row.ref));
    }
    if (fallbackCwd !== null) {
      const listed = yield* git
        .execute({
          operation: "SettledThreadPurge.listLegacyCheckpointRefs",
          cwd: fallbackCwd,
          args: [
            "for-each-ref",
            "--format=%(refname)",
            `${V1_CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(thread.thread_id)}/`,
          ],
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (listed !== null && listed.exitCode === 0) {
        const refs = byCwd.get(fallbackCwd) ?? new Set<string>();
        for (const line of listed.stdout.split("\n")) if (line.length > 0) refs.add(line);
        byCwd.set(fallbackCwd, refs);
      }
    }
    return [...byCwd].map(([cwd, refs]) => ({ cwd, refs: [...refs] }));
  });

  const describe = (
    thread: ThreadRow,
    transcripts: {
      readonly instanceId: string | null;
      readonly entries: ReadonlyArray<TranscriptEntry>;
      readonly note: string | null;
    },
    checkpointRefs: number,
    worktreePath: string | null,
  ): SettledThreadPurgeThread => ({
    threadId: ThreadId.make(thread.thread_id),
    title: thread.title,
    providerInstanceId: transcripts.instanceId,
    settledAt: thread.settled_at ?? "",
    transcriptPaths: transcripts.entries.map((entry) => entry.path),
    transcriptBytes: transcripts.entries.reduce((total, entry) => total + entry.bytes, 0),
    transcriptNote: transcripts.note,
    checkpointRefs,
    worktreePath,
  });

  const worktreeOf = (thread: ThreadRow) =>
    existingDirectory(thread.worktree_path ?? thread.workspace_directory);

  const countRows = Effect.fn("SettledThreadPurge.countRows")(function* (
    threadId: string,
    keepSequence: number,
  ) {
    const counts: Record<string, number> = {};
    for (const [table, where] of threadRows) {
      const rows = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        rowParams(where, threadId, keepSequence),
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  });

  const deleteFrom = (
    table: string,
    where: string,
    threadId: string,
    keepSequence: number,
    limit?: number,
  ) =>
    sql
      .unsafe(
        `DELETE FROM ${table} WHERE rowid IN
          (SELECT rowid FROM ${table} WHERE ${where}${limit === undefined ? "" : ` LIMIT ${limit}`})
          RETURNING 1`,
        rowParams(where, threadId, keepSequence),
      )
      .pipe(Effect.map((rows) => rows.length));

  // The thread is already deleted for clients, so its bulk rows can go in
  // small autocommitted batches that let other requests in between.
  const deleteInBatches = Effect.fn("SettledThreadPurge.deleteInBatches")(function* (
    threadId: string,
    keepSequence: number,
  ) {
    const counts: Record<string, number> = {};
    for (const [table, where] of threadRows.slice(0, -1)) {
      let deleted = 0;
      let batch = DELETE_BATCH;
      while (batch === DELETE_BATCH) {
        batch = yield* deleteFrom(table, where, threadId, keepSequence, DELETE_BATCH);
        deleted += batch;
        yield* Effect.yieldNow;
      }
      counts[table] = deleted;
    }
    return counts;
  });

  // Whatever is left, including rows written since the batches and V1's thread
  // row, goes in one transaction while no command can touch the thread. The
  // projection cursor then follows the event log if the thread owned its tail.
  const deleteRemaining = (threadId: string, keepSequence: number) =>
    executor.withLock(
      ThreadId.make(threadId),
      sql.withTransaction(
        Effect.gen(function* () {
          const counts: Array<readonly [string, number]> = [];
          for (const [table, where] of threadRows) {
            counts.push([table, yield* deleteFrom(table, where, threadId, keepSequence)] as const);
          }
          yield* sql`
            UPDATE orchestration_v2_projection_metadata
            SET last_sequence = MIN(last_sequence, COALESCE((
              SELECT MAX(sequence) FROM orchestration_events
              WHERE application_event_version = 2 AND aggregate_kind = 'thread'), 0))
            WHERE projection_name = 'thread-projections'`;
          return counts;
        }),
      ),
    );

  const tombstoneSequence = (threadId: string) =>
    sql<{ sequence: number | null }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.deleted'`.pipe(
      Effect.map((rows) => rows[0]?.sequence ?? null),
    );

  const purgeThread = Effect.fn("SettledThreadPurge.purgeThread")(function* (
    thread: ThreadRow,
    plan: Plan,
    settings: ServerSettings,
  ) {
    const threadId = ThreadId.make(thread.thread_id);
    // The normal deletion path tells clients, detaches provider sessions and runs the
    // cleanup effects (terminals, previews, scheduled tasks, attachments).
    let keepSequence = yield* tombstoneSequence(threadId);
    if (keepSequence === null) {
      const commandId = CommandId.make(
        `server:purge-settled:${threadId}:${yield* crypto.randomUUIDv4()}`,
      );
      yield* orchestrator.dispatch({ type: "thread.delete", commandId, threadId });
      const effects = yield* outbox.listByCommandId(commandId);
      yield* Effect.forEach(effects, (effect) => outbox.awaitSettled(effect.id), {
        discard: true,
      });
      keepSequence = yield* tombstoneSequence(threadId);
    }
    if (keepSequence === null) {
      return yield* new SettledThreadPurgeError({
        message: "the thread has no thread.deleted event",
      });
    }
    const transcripts = yield* resolveTranscripts(
      plan.native.get(thread.thread_id) ?? [],
      settings,
    );
    const refGroups = yield* collectCheckpointRefs(thread);
    const worktreePath = yield* worktreeOf(thread);

    // Files first: a purge that stops part-way still finds the thread and its locators.
    let refsDeleted = 0;
    for (const { cwd, refs } of refGroups) {
      refsDeleted += yield* checkpoints
        .deleteCheckpointRefs({ cwd, checkpointRefs: refs.map((ref) => CheckpointRef.make(ref)) })
        .pipe(
          Effect.as(refs.length),
          Effect.catch((error) =>
            Effect.logWarning("settled thread purge kept checkpoint refs", {
              threadId,
              error,
            }).pipe(Effect.as(0)),
          ),
        );
    }
    const removed: Array<TranscriptEntry> = [];
    const failures: Array<string> = [];
    for (const entry of transcripts.entries) {
      const result = yield* Effect.exit(fs.remove(entry.path, { recursive: true }));
      if (Exit.isSuccess(result)) removed.push(entry);
      else failures.push(`${entry.path}: ${errorMessage(result.cause)}`);
    }

    const rows = yield* deleteInBatches(threadId, keepSequence);
    for (const [table, count] of yield* deleteRemaining(threadId, keepSequence)) {
      rows[table] = (rows[table] ?? 0) + count;
    }
    return {
      thread: describe(
        thread,
        {
          ...transcripts,
          entries: removed,
          note: failures.length > 0 ? `could not remove ${failures.join("; ")}` : transcripts.note,
        },
        refsDeleted,
        worktreePath,
      ),
      rows,
    };
  });

  const previewThread = Effect.fn("SettledThreadPurge.previewThread")(function* (
    thread: ThreadRow,
    plan: Plan,
    settings: ServerSettings,
  ) {
    const transcripts = yield* resolveTranscripts(
      plan.native.get(thread.thread_id) ?? [],
      settings,
    );
    const groups = yield* collectCheckpointRefs(thread);
    const keepSequence = yield* tombstoneSequence(thread.thread_id);
    return {
      thread: describe(
        thread,
        transcripts,
        groups.reduce((total, group) => total + group.refs.length, 0),
        yield* worktreeOf(thread),
      ),
      rows: yield* countRows(thread.thread_id, keepSequence ?? -1),
    };
  });

  const run = Effect.fn("SettledThreadPurge.purge")(function* (input: SettledThreadPurgeInput) {
    const dryRun = input.dryRun ?? true;
    const now = yield* Clock.currentTimeMillis;
    const settledBefore = DateTime.formatIso(
      DateTime.makeUnsafe(now - input.settledForDays * DAY_MS),
    );
    const settings = yield* settingsService.getSettings;
    const plan = yield* loadGraph(settledBefore);
    const rowsByThread = new Map(plan.threads.map((thread) => [thread.thread_id, thread]));
    const skipped = new Map(plan.skipped);
    const purged: Array<SettledThreadPurgeThread> = [];
    const failed: Array<{ threadId: ThreadId; title: string; error: string }> = [];
    const rowCounts: Record<string, number> = {};
    // A subagent thread goes right after the parent it belongs to.
    const order = [...plan.purge].flatMap((threadId) => {
      const children = plan.cascade.filter(
        (child) => cascadeParent(plan.graph.subagents, plan.purge, child) === threadId,
      );
      return [threadId, ...children];
    });

    for (const threadId of order) {
      const thread = rowsByThread.get(threadId);
      if (thread === undefined) continue;
      let current = plan;
      if (!dryRun) {
        // Earlier purges and concurrent activity can change what this one may break.
        current = yield* loadGraph(settledBefore);
        const stillGoing = current.purge.has(threadId) || current.cascade.includes(threadId);
        if (!stillGoing) {
          skipped.set(threadId, current.skipped.get(threadId) ?? "no longer settled long enough");
          continue;
        }
      }
      const result = yield* Effect.exit(
        dryRun ? previewThread(thread, current, settings) : purgeThread(thread, current, settings),
      );
      if (Exit.isFailure(result)) {
        failed.push({
          threadId: ThreadId.make(thread.thread_id),
          title: thread.title,
          error: errorMessage(result.cause),
        });
        continue;
      }
      purged.push(result.value.thread);
      for (const [table, count] of Object.entries(result.value.rows)) {
        rowCounts[table] = (rowCounts[table] ?? 0) + count;
      }
    }

    const freePages = yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`;
    const pageSize = yield* sql<{ page_size: number }>`PRAGMA page_size`;
    return {
      dryRun,
      settledForDays: input.settledForDays,
      settledBefore,
      purged,
      skipped: [...skipped].map(([threadId, reason]) => ({
        threadId: ThreadId.make(threadId),
        title: rowsByThread.get(threadId)?.title ?? "",
        reason,
      })),
      failed,
      transcriptPathsRemoved: purged.flatMap((thread) => thread.transcriptPaths),
      bytesRemoved: purged.reduce((total, thread) => total + thread.transcriptBytes, 0),
      rowCounts,
      databaseReusableBytes:
        Number(freePages[0]?.freelist_count ?? 0) * Number(pageSize[0]?.page_size ?? 0),
      notes: [
        dryRun
          ? "Dry run: nothing changed. Rows, transcripts and checkpoint refs are what a real run would remove."
          : "No VACUUM ran: SQLite reuses the freed pages for new rows, so the database file keeps its size.",
        "A purged thread keeps only its final thread.deleted event (and its deleted projection row), so clients that were offline still drop it when they reconnect.",
        ...(purged.some((thread) => thread.worktreePath !== null)
          ? ["Worktrees are left on disk; worktreePath lists the ones that still exist."]
          : []),
      ],
    } satisfies SettledThreadPurgeReport;
  });

  // A purge outlives the request that started it, so a client that gives up
  // waiting cannot stop it between deleting a thread's rows and its transcripts.
  const scope = yield* Scope.Scope;
  return SettledThreadPurge.of({
    purge: Effect.fn("SettledThreadPurge.purge")((input: SettledThreadPurgeInput) =>
      lock.withPermit(run(input)).pipe(
        Effect.forkIn(scope),
        Effect.flatMap(Fiber.join),
        Effect.mapError(
          (cause) =>
            new SettledThreadPurgeError({
              message: `Settled thread purge failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      ),
    ),
  });
});

/** The purged thread a cascading subagent thread hangs off, however deep. */
function cascadeParent(
  subagents: PurgeGraph["subagents"],
  purge: ReadonlySet<string>,
  threadId: string,
): string | null {
  const parentOf = new Map(subagents.map((child) => [child.threadId, child.parentId]));
  let current = threadId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parentOf.get(current);
    if (parent === undefined) return null;
    if (purge.has(parent)) return parent;
    current = parent;
  }
  return null;
}

export const layer = Layer.effect(SettledThreadPurge, make);
