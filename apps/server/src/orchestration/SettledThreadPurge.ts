import {
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
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefPrefixForThread } from "../checkpointing/Utils.ts";
import {
  findSessionTranscripts,
  resolveTranscriptHome,
  type TranscriptEntry,
} from "../project/AgentTranscripts.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  OrchestrationEngineService,
  OrchestrationThreadPurge,
} from "./Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";

export class SettledThreadPurge extends Context.Service<
  SettledThreadPurge,
  {
    /**
     * Remove threads settled for more than `settledForDays` days: every row
     * they own except their final `thread.deleted` event, which clients that
     * were offline still need, plus their native provider transcripts and
     * checkpoint refs. Dry run unless `dryRun` is false.
     */
    readonly purge: (
      input: SettledThreadPurgeInput,
    ) => Effect.Effect<SettledThreadPurgeReport, SettledThreadPurgeError>;
  }
>()("t3/orchestration/SettledThreadPurge") {}

const DAY_MS = 86_400_000;

/** Everything owned by one thread, deleted in this order inside one transaction. */
const THREAD_ROWS = [
  ["orchestration_events", "aggregate_kind = 'thread' AND stream_id = ?1 AND sequence <> ?2"],
  ["orchestration_command_receipts", "aggregate_kind = 'thread' AND aggregate_id = ?1"],
  ["checkpoint_diff_blobs", "thread_id = ?1"],
  ["projection_thread_activities", "thread_id = ?1"],
  ["projection_thread_messages", "thread_id = ?1"],
  ["projection_turns", "thread_id = ?1"],
  ["projection_pending_approvals", "thread_id = ?1"],
  ["projection_thread_proposed_plans", "thread_id = ?1"],
  ["projection_thread_pull_requests", "thread_id = ?1"],
  ["projection_thread_sessions", "thread_id = ?1"],
  ["provider_session_runtime", "thread_id = ?1"],
  ["projection_threads", "thread_id = ?1"],
  ["custom_workers", "thread_id = ?1 OR owner_id = ?1"],
  ["custom_worker_jobs", "worker_id = ?1 OR target_id = ?1"],
  ["custom_orchestrator_handoffs", "thread_id = ?1 OR owner_id = ?1"],
] as const;

export interface PurgeGraph {
  /** Threads settled long enough. `blocked` is a reason that holds on its own. */
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
  /** Proposed-plan links in either direction between two threads. */
  readonly planLinks: ReadonlyArray<{ readonly threadId: string; readonly linkedThreadId: string }>;
  /** Native provider session of each thread, as `driver:sessionId`. */
  readonly sessionKeys: ReadonlyArray<{ readonly threadId: string; readonly key: string }>;
}

/**
 * Which candidates can go without breaking a thread that stays. Removing one
 * candidate can strand another, so the rules repeat until nothing changes.
 */
export function selectThreadsToPurge(graph: PurgeGraph): {
  readonly purge: ReadonlySet<string>;
  readonly skipped: ReadonlyMap<string, string>;
} {
  const purge = new Set<string>();
  const skipped = new Map<string, string>();
  for (const candidate of graph.candidates) {
    const job = graph.activeJobs.find(
      (entry) => entry.workerId === candidate.threadId || entry.targetId === candidate.threadId,
    );
    const reason = candidate.blocked ?? (job ? `worker job ${job.id} is ${job.state}` : null);
    if (reason === null) purge.add(candidate.threadId);
    else skipped.set(candidate.threadId, reason);
  }

  const kept = (threadId: string) => !purge.has(threadId) && graph.liveThreadIds.has(threadId);
  let changed = true;
  const drop = (threadId: string, reason: string) => {
    if (!purge.delete(threadId)) return;
    skipped.set(threadId, reason);
    changed = true;
  };
  while (changed) {
    changed = false;
    for (const worker of graph.workers) {
      if (worker.remote || kept(worker.threadId)) {
        drop(worker.ownerId, `owns worker ${worker.threadId}, which is kept`);
      }
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
    const keptSessions = new Map(
      graph.sessionKeys.filter((entry) => kept(entry.threadId)).map((entry) => [entry.key, entry]),
    );
    for (const entry of graph.sessionKeys) {
      const other = keptSessions.get(entry.key);
      if (other !== undefined) {
        drop(entry.threadId, `shares its provider session with ${other.threadId}, which is kept`);
      }
    }
  }
  return { purge, skipped };
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
  readonly provider_name: string;
  readonly provider_instance_id: string | null;
  readonly resume_cursor_json: string | null;
}

/** Claude resumes by session UUID, Codex by its own thread id. Other drivers have none we can use. */
export function providerSessionKey(runtime: RuntimeRow): string | null {
  const cursor = Option.getOrUndefined(decodeCursor(runtime.resume_cursor_json ?? ""));
  const sessionId =
    runtime.provider_name === "claudeAgent"
      ? cursor?.resume
      : runtime.provider_name === "codex"
        ? cursor?.threadId
        : undefined;
  return sessionId ? `${runtime.provider_name}:${sessionId}` : null;
}

function instanceConfig(
  settings: ServerSettings,
  instanceId: string,
  driver: string,
): ProviderInstanceConfig | null {
  const configured = settings.providerInstances[ProviderInstanceId.make(instanceId)];
  if (configured !== undefined) return configured;
  // Built-in instances fall back to the legacy per-driver settings, as the registry does.
  if (instanceId === driver && (driver === "claudeAgent" || driver === "codex")) {
    return { driver: ProviderDriverKind.make(driver), config: settings.providers[driver] };
  }
  return null;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly title: string;
  readonly settled_override: string | null;
  readonly settled_at: string | null;
  readonly pinned_at: string | null;
  readonly deleted_at: string | null;
  readonly worktree_path: string | null;
  readonly workspace_root: string | null;
  readonly pending_approval_count: number;
  readonly pending_user_input_count: number;
  readonly session_status: string | null;
  readonly active_turn_id: string | null;
  readonly running_turn: number;
}

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const threadPurge = yield* OrchestrationThreadPurge;
  const threadDeletion = yield* ThreadDeletionReactor;
  const providers = yield* ProviderService;
  const ingestion = yield* ProviderRuntimeIngestionService;
  const liveness = yield* ThreadBackgroundLivenessService;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const git = yield* GitVcsDriver;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcessEnvironment;
  const lock = yield* Semaphore.make(1);
  // Only `orchestration_events` binds the sequence it keeps.
  const rowParams = (where: string, threadId: string, keepSequence: number) =>
    where.includes("?2") ? [threadId, keepSequence] : [threadId];

  const loadGraph = Effect.fn("SettledThreadPurge.loadGraph")(function* (settledBefore: string) {
    const threads = yield* sql<ThreadRow>`
      SELECT t.thread_id, t.title, t.settled_override, t.settled_at, t.pinned_at, t.deleted_at,
        t.worktree_path, p.workspace_root, t.pending_approval_count, t.pending_user_input_count,
        s.status AS session_status, s.active_turn_id,
        EXISTS (SELECT 1 FROM projection_turns u
          WHERE u.thread_id = t.thread_id AND u.state IN ('pending', 'running')) AS running_turn
      FROM projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id`;
    const runtimes = yield* sql<RuntimeRow & { readonly thread_id: string }>`
      SELECT thread_id, provider_name, provider_instance_id, resume_cursor_json
      FROM provider_session_runtime`;
    const workers = yield* sql<{ thread_id: string; owner_id: string; state: string }>`
      SELECT thread_id, owner_id, state FROM custom_workers`;
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
      SELECT thread_id, implementation_thread_id AS linked FROM projection_thread_proposed_plans
      WHERE implementation_thread_id IS NOT NULL AND implementation_thread_id <> thread_id
      UNION
      SELECT thread_id, source_proposed_plan_thread_id FROM projection_turns
      WHERE source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_thread_id <> thread_id`;
    const liveSessions = new Set(
      (yield* providers.listSessions())
        .filter((session) => session.status === "connecting" || session.status === "running")
        .map((session) => session.threadId as string),
    );

    const candidates = threads.filter(
      (thread) =>
        thread.settled_override === "settled" &&
        thread.settled_at !== null &&
        thread.settled_at < settledBefore,
    );
    const graph: PurgeGraph = {
      candidates: candidates.map((thread) => ({
        threadId: thread.thread_id,
        blocked:
          thread.pinned_at !== null
            ? "pinned"
            : thread.session_status === "starting" ||
                thread.session_status === "running" ||
                thread.active_turn_id !== null ||
                thread.running_turn !== 0 ||
                thread.pending_approval_count > 0 ||
                thread.pending_user_input_count > 0 ||
                liveSessions.has(thread.thread_id) ||
                liveness.getThreadBackgroundLiveness(thread.thread_id) !== null
              ? "its provider session is live or a turn is active"
              : null,
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
      sessionKeys: runtimes.flatMap((runtime) => {
        const key = providerSessionKey(runtime);
        return key === null ? [] : [{ threadId: runtime.thread_id, key }];
      }),
    };
    return { candidates, graph, ...selectThreadsToPurge(graph) };
  });

  const resolveTranscripts = Effect.fn("SettledThreadPurge.resolveTranscripts")(
    function* (threadId: string, settings: ServerSettings) {
      const runtime = (yield* sql<RuntimeRow>`
      SELECT provider_name, provider_instance_id, resume_cursor_json
      FROM provider_session_runtime WHERE thread_id = ${threadId}`)[0];
      const none = (note: string) => ({
        instanceId: runtime?.provider_instance_id ?? runtime?.provider_name ?? null,
        entries: [] as ReadonlyArray<TranscriptEntry>,
        note,
      });
      if (runtime === undefined) return none("no provider session recorded");
      const driver = runtime.provider_name;
      const instanceId = runtime.provider_instance_id ?? driver;
      if (driver !== "claudeAgent" && driver !== "codex") {
        return none(`transcripts not removed: unsupported provider (${driver})`);
      }
      const key = providerSessionKey(runtime);
      if (key === null) return none("no provider session id in the resume cursor");
      const config = instanceConfig(settings, instanceId, driver);
      if (config === null) {
        return none(`transcripts not removed: provider instance ${instanceId} is not configured`);
      }
      const home = yield* resolveTranscriptHome(config, hostEnvironment);
      if (home === null || home.driver !== driver) {
        return none(`transcripts not removed: cannot resolve the home of ${instanceId}`);
      }
      const entries = yield* findSessionTranscripts(home, key.slice(driver.length + 1));
      return {
        instanceId,
        entries,
        note: entries.length === 0 ? `no transcript found under ${home.homePath}` : null,
      };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  // Refs are shared by every checkout of the repository; prefer the thread's own.
  const checkpointCwd = Effect.fn("SettledThreadPurge.checkpointCwd")(function* (
    thread: ThreadRow,
  ) {
    for (const cwd of [thread.worktree_path, thread.workspace_root]) {
      if (cwd !== null && (yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) {
        return cwd;
      }
    }
    return null;
  });

  const listCheckpointRefs = Effect.fn("SettledThreadPurge.listCheckpointRefs")(function* (
    cwd: string | null,
    threadId: string,
  ) {
    if (cwd === null) return [];
    const listed = yield* git
      .execute({
        operation: "SettledThreadPurge.listCheckpointRefs",
        cwd,
        args: [
          "for-each-ref",
          "--format=%(refname)",
          checkpointRefPrefixForThread(ThreadId.make(threadId)),
        ],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (listed === null || listed.exitCode !== 0) return [];
    return listed.stdout.split("\n").filter((line) => line.length > 0);
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

  const existingWorktree = (thread: ThreadRow) =>
    thread.worktree_path === null
      ? Effect.succeed(null)
      : fs.exists(thread.worktree_path).pipe(
          Effect.map((exists) => (exists ? thread.worktree_path : null)),
          Effect.orElseSucceed(() => null),
        );

  const countRows = Effect.fn("SettledThreadPurge.countRows")(function* (
    threadId: string,
    keepSequence: number,
  ) {
    const counts: Record<string, number> = {};
    for (const [table, where] of THREAD_ROWS) {
      const rows = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        rowParams(where, threadId, keepSequence),
      );
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  });

  const deleteRows = (threadId: string, keepSequence: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const counts: Record<string, number> = {};
        for (const [table, where] of THREAD_ROWS) {
          yield* sql.unsafe(
            `DELETE FROM ${table} WHERE ${where}`,
            rowParams(where, threadId, keepSequence),
          );
          const changed = yield* sql<{ n: number }>`SELECT changes() AS n`;
          counts[table] = Number(changed[0]?.n ?? 0);
        }
        return counts;
      }),
    );

  const tombstoneSequence = (threadId: string) =>
    sql<{ sequence: number | null }>`
      SELECT MAX(sequence) AS sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.deleted'`.pipe(
      Effect.map((rows) => rows[0]?.sequence ?? null),
    );

  const purgeThread = Effect.fn("SettledThreadPurge.purgeThread")(function* (
    thread: ThreadRow,
    settings: ServerSettings,
  ) {
    const threadId = ThreadId.make(thread.thread_id);
    const live = (yield* providers.listSessions()).some(
      (session) => session.threadId === threadId && session.status !== "closed",
    );
    if (live) {
      yield* providers.stopSession({ threadId });
      // Its stop events become commands; let them land before the thread goes.
      yield* ingestion.drain;
    }
    // The normal deletion path tells clients and runs the deletion reactors
    // (provider stop, terminal history, attachments).
    const deletedSequence =
      thread.deleted_at === null
        ? (yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(
              `server:purge-settled:${threadId}:${yield* crypto.randomUUIDv4}`,
            ),
            threadId,
          })).sequence
        : yield* engine.latestSequence;
    yield* threadDeletion.drainThrough(deletedSequence);

    const keepSequence = yield* tombstoneSequence(threadId);
    if (keepSequence === null) {
      return yield* new SettledThreadPurgeError({
        message: "the thread has no thread.deleted event",
      });
    }
    const transcripts = yield* resolveTranscripts(threadId, settings);
    const cwd = yield* checkpointCwd(thread);
    const refs = yield* listCheckpointRefs(cwd, threadId);
    const worktreePath = yield* existingWorktree(thread);

    const rows = yield* threadPurge.purgeThreads([threadId], deleteRows(threadId, keepSequence));

    const refsDeleted =
      cwd === null || refs.length === 0
        ? 0
        : yield* git
            .execute({
              operation: "SettledThreadPurge.deleteCheckpointRefs",
              cwd,
              args: ["update-ref", "--stdin"],
              stdin: refs.map((ref) => `delete ${ref}\n`).join(""),
            })
            .pipe(
              Effect.as(refs.length),
              Effect.catch((error) =>
                Effect.logWarning("settled thread purge kept checkpoint refs", {
                  threadId,
                  error,
                }).pipe(Effect.as(0)),
              ),
            );
    const removed: Array<TranscriptEntry> = [];
    const failures: Array<string> = [];
    for (const entry of transcripts.entries) {
      const result = yield* Effect.exit(fs.remove(entry.path, { recursive: true }));
      if (Exit.isSuccess(result)) removed.push(entry);
      else failures.push(`${entry.path}: ${errorMessage(result.cause)}`);
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
    settings: ServerSettings,
  ) {
    const transcripts = yield* resolveTranscripts(thread.thread_id, settings);
    const refs = yield* listCheckpointRefs(yield* checkpointCwd(thread), thread.thread_id);
    const keepSequence =
      thread.deleted_at === null ? null : yield* tombstoneSequence(thread.thread_id);
    return {
      thread: describe(thread, transcripts, refs.length, yield* existingWorktree(thread)),
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
    const titles = new Map(plan.candidates.map((thread) => [thread.thread_id, thread.title]));
    const skipped = new Map(plan.skipped);
    const purged: Array<SettledThreadPurgeThread> = [];
    const failed: Array<{ threadId: ThreadId; title: string; error: string }> = [];
    const rowCounts: Record<string, number> = {};

    for (const thread of plan.candidates) {
      if (!plan.purge.has(thread.thread_id)) continue;
      if (!dryRun) {
        // Earlier purges and concurrent activity can change what this one may break.
        const current = yield* loadGraph(settledBefore);
        if (!current.purge.has(thread.thread_id)) {
          skipped.set(
            thread.thread_id,
            current.skipped.get(thread.thread_id) ?? "no longer settled long enough",
          );
          continue;
        }
      }
      const result = yield* Effect.exit(
        dryRun ? previewThread(thread, settings) : purgeThread(thread, settings),
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
        title: titles.get(threadId) ?? "",
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
        "A purged thread keeps only its final thread.deleted event, so clients that were offline still drop it when they reconnect.",
        ...(purged.some((thread) => thread.worktreePath !== null)
          ? ["Worktrees are left on disk; worktreePath lists the ones that still exist."]
          : []),
      ],
    } satisfies SettledThreadPurgeReport;
  });

  return SettledThreadPurge.of({
    purge: (input) =>
      lock.withPermit(run(input)).pipe(
        Effect.mapError(
          (cause) =>
            new SettledThreadPurgeError({
              message: `Settled thread purge failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(SettledThreadPurge, make);
