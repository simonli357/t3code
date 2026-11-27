import {
  AllocationError,
  AllocationEvidence,
  AllocationInventory,
  AllocationOperation,
  AllocationResponse,
  AllocationRequest,
  ComputerPlacementProbe,
  DEFAULT_LONG_WAIT_HOURS,
  MAX_MEMORY_KILL_HOLD_MINUTES,
  MAX_START_SETTLE_MINUTES,
  ModelSelection,
  ThreadId,
  WORKER_ACCOUNT_DISABLED_REASON,
  ASSIGNMENT_FINISHED,
  ASSIGNMENT_FINISHED_REASON,
  allocationPreferenceKey,
  modelFallback,
  modelLadder,
  type AllocationLearned,
  type AllocationSnapshot,
  type AllocationPolicy,
  type AllocationPolicyEdit,
  type AllocationPolicyView,
  type ComputersReport,
  type ComputersRequest,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Store from "./AllocationStore.ts";
import * as Computers from "../computers/Computers.ts";
import * as Peers from "../orchestration/PeerLinks.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { quotaEvidenceInstances, readQuotaEvidenceRows } from "./quotaEvidence.ts";
import { allocationIdentity, allocationInventory, windowModels } from "./inventory.ts";
import { accountCap, accountRoom, accountRunways, decideAllocation } from "./decision.ts";
import { learnAllocation, replacesLearned } from "./learning.ts";
import { isFable, span } from "./runway.ts";
import { allocationPolicyView, editAllocationPolicy, editModelPolicy } from "./policyEdit.ts";
import { chooseProfile, fableModeAccount } from "./modelDecision.ts";
import {
  computerNumbers,
  placeWorker,
  type ComputerPlacement,
  type PlacedStart,
} from "./placement.ts";

const PeerInput = Schema.TaggedUnion({
  allocation: { operation: AllocationOperation },
  // `placement` asks for the computer's capacity and checkouts too; ordinary reads never pay for it.
  allocationInventory: {
    request: Schema.optional(AllocationRequest),
    placement: Schema.optional(ComputerPlacementProbe),
    /** A decision is about to use this inventory: refresh quota readings older than this first. */
    refreshOlderThanMinutes: Schema.optional(Schema.Number),
  },
  allocationProbe: {
    threadId: ThreadId,
    assignmentId: Schema.String,
    since: Schema.String,
    startIntent: Schema.optional(Schema.String),
  },
  /** This computer's turns and limit readings, for the coordinator's learning. */
  allocationEvidence: {},
});
const Probe = Schema.Struct({
  state: Schema.Literals(["pending", "running", "terminal", "unknown"]),
});
const unavailable = () =>
  new AllocationError({
    code: "unavailable",
    detail:
      "Allocation authority or execution environment is unavailable; capacity remains reserved.",
  });
/** Sent by a peer that cannot decode the request, usually because it runs another version. */
const UNREADABLE_PEER_REQUEST = "Invalid allocation peer request";
/** The longest a decision waits for accounts to report a fresh quota reading. */
const READING_REFRESH_BUDGET = "3 seconds";
/** A decision placed on one computer waits this long for the load on each of the others. */
const OTHER_COMPUTER_READ_BUDGET = "5 seconds";
/** Decisions probe one slow or failing account at most this often. */
const READING_REFRESH_RETRY_MS = 60_000;
/** After the coordinator fails to answer, the rest of that start decides locally without waiting again. */
const COORDINATOR_RETRY_MS = 60_000;
/** Without a provider reset time, a limited account is tried again after this long. */
const UNKNOWN_RESET_WAIT_MS = 30 * 60_000;
/** The coordinator relearns costs and limit sizes this often, from every computer's history. */
const LEARN_INTERVAL = "30 minutes";
const FIRST_LEARN_DELAY = "2 minutes";
/** An unchanged settings copy is rewritten at most this often, to keep its age current. */
const COPY_WRITE_INTERVAL_MS = 10 * 60_000;
/** Where a worker's next turn runs when its account is limited, capped or was just rejected. */
export type UsageRoute =
  | { readonly _tag: "proceed" }
  | {
      readonly _tag: "switch";
      readonly selection: ModelSelection;
      /** The worker continues on another model, so its master is told. */
      readonly modelChanged: boolean;
    }
  | {
      readonly _tag: "wait";
      readonly until: string;
      /** A reading or cap shows the exhaustion, so the wait may end as soon as that clears. */
      readonly observed: boolean;
      /** The wait is longer than the policy's threshold, so the master is told. */
      readonly long: boolean;
    };
const decodeResponse = Schema.decodeUnknownEffect(AllocationResponse);
const decodePeerInput = Schema.decodeUnknownEffect(PeerInput);
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const now = Clock.currentTimeMillis.pipe(
  Effect.map((n) => DateTime.formatIso(DateTime.makeUnsafe(n))),
);
/** A computer that could not be read: listed unreachable with its error, never left out or zero. */
const unreadInventory = (
  peer: { environmentId: string; label: string },
  observedAt: string,
  cause?: string,
): AllocationInventory => ({
  coordinatorEnvironmentId: null,
  environmentId: peer.environmentId,
  environmentLabel: peer.label,
  observedAt,
  accounts: [],
  demand: [],
  complete: false,
  notices: [`${peer.label}: load unavailable for this decision${cause ? `: ${cause}` : "."}`],
});
/**
 * Builds from before smart allocation require a reason beside each score and pin. They are
 * filled in on the way to a coordinator that may still run one.
 */
const withLegacyReasons = (request: ModelRoutingRequest): ModelRoutingRequest => ({
  ...request,
  assessment: {
    ...request.assessment,
    difficultyReason: request.assessment.difficultyReason ?? "Scored by the master",
    stakesReason: request.assessment.stakesReason ?? "Scored by the master",
  },
  ...(request.override
    ? { override: { ...request.override, reason: request.override.reason ?? "Pinned" } }
    : {}),
});

export interface PlaceInput {
  readonly projectId?: ProjectId | undefined;
  readonly environmentId?: string | undefined;
  /** Said instead of "named in the request". */
  readonly namedBecause?: string | undefined;
  /** The worker being placed, so a retry does not count its own first attempt. */
  readonly threadId?: string | undefined;
  /** Starts the caller placed that their computers may not report yet. */
  readonly placed?: ReadonlyArray<PlacedStart> | undefined;
}

export class ProviderAllocation extends Context.Service<
  ProviderAllocation,
  {
    readonly execute: (
      operation: AllocationOperation,
    ) => Effect.Effect<AllocationResponse, AllocationError>;
    /**
     * Routes a worker whose model is drained on its account or (`rejected`) was just refused a
     * turn: the same model on another account with room; else wait for a reset that is near;
     * else the closest model that has room; else wait. `switchAccount: false` only waits.
     * `proceed` means nothing is known against the current account.
     */
    readonly reroute: (
      threadId: ThreadId,
      current: ModelSelection,
      options?: { readonly rejected?: boolean; readonly switchAccount?: boolean },
    ) => Effect.Effect<UsageRoute, AllocationError>;
    /**
     * True when retained readings or a hard cap already show the model drained there. No
     * probing. The cap is the one that stops `kind`: workers unless a session is named.
     */
    readonly limited: (
      selection: Pick<ModelSelection, "instanceId" | "model">,
      kind?: AllocationRequest["kind"],
    ) => Effect.Effect<boolean, AllocationError>;
    /** Reads the coordinator's policies, after applying `edit` when it changes anything. */
    readonly editPolicy: (
      edit: AllocationPolicyEdit,
    ) => Effect.Effect<AllocationPolicyView, AllocationError>;
    readonly receive: (from: string, request: unknown) => Effect.Effect<unknown, AllocationError>;
    /** Load numbers of this computer and every linked one. Nothing is ranked or reserved. */
    readonly computers: (
      request: ComputersRequest,
    ) => Effect.Effect<ComputersReport, AllocationError>;
    /**
     * The computers a new worker may start on, best first by room, from a fresh reading of every
     * linked computer and the coordinator's stored values. `environmentId` names one instead.
     * `projectId` is this computer's; each ranked computer carries its own ID for the project.
     */
    readonly place: (input: PlaceInput) => Effect.Effect<ComputerPlacement, AllocationError>;
  }
>()("t3/allocation/ProviderAllocation") {}

const make = Effect.gen(function* () {
  const store = yield* Store.AllocationStore;
  const peers = yield* Peers.PeerLinks;
  const providers = yield* ProviderRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const measurements = yield* UsageMeasurements;
  const settings = yield* ServerSettingsService;
  const computers = yield* Computers.Computers;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* peers.localEnvironment;
  const scope = yield* Effect.scope;
  const refreshAttempts = new Map<string, number>();
  let coordinatorUnreachableAt = -Infinity;
  /** The coordinator's policies as last read, so a lost connection decides by them. */
  let coordinatorPolicy: AllocationPolicy | undefined;
  let coordinatorModelPolicy: ModelRoutingPolicy | undefined;
  let coordinatorLearned: AllocationLearned | undefined;
  /** When the coordinator last sent its policies, and when this computer last stored them. */
  let copySyncedAt: number | undefined;
  let copyWrittenAt = -Infinity;
  // The stored copy stands in from startup, so a lost coordinator never means built-in defaults.
  const savedCopy = yield* store.copy.pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (
    savedCopy &&
    savedCopy.coordinatorEnvironmentId ===
      (yield* settings.getSettings).allocationCoordinatorEnvironmentId
  ) {
    coordinatorPolicy = savedCopy.policy;
    coordinatorModelPolicy = savedCopy.modelPolicy;
    coordinatorLearned = savedCopy.learned;
    copySyncedAt = Date.parse(savedCopy.syncedAt);
  }
  const keepCopy = Effect.fn("ProviderAllocation.keepCopy")(function* (
    coordinatorId: string,
    response: AllocationResponse,
  ) {
    const policy = response.policy ?? response.snapshot?.policy;
    const modelPolicy = response.modelPolicy ?? response.modelSnapshot?.policy;
    if (!policy && !modelPolicy && !response.learned) return;
    const changed =
      (policy !== undefined && policy.version !== coordinatorPolicy?.version) ||
      (modelPolicy !== undefined && modelPolicy.version !== coordinatorModelPolicy?.version) ||
      (response.learned !== undefined &&
        response.learned.learnedAt !== coordinatorLearned?.learnedAt);
    coordinatorPolicy = policy ?? coordinatorPolicy;
    coordinatorModelPolicy = modelPolicy ?? coordinatorModelPolicy;
    coordinatorLearned = response.learned ?? coordinatorLearned;
    const at = yield* Clock.currentTimeMillis;
    copySyncedAt = at;
    if (!coordinatorPolicy || (!changed && at - copyWrittenAt < COPY_WRITE_INTERVAL_MS)) return;
    copyWrittenAt = at;
    yield* store
      .saveCopy({
        coordinatorEnvironmentId: coordinatorId,
        syncedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
        policy: coordinatorPolicy,
        ...(coordinatorModelPolicy ? { modelPolicy: coordinatorModelPolicy } : {}),
        ...(coordinatorLearned ? { learned: coordinatorLearned } : {}),
      })
      .pipe(Effect.ignore);
  });
  /** Said with a choice made here because the coordinator could not be reached. */
  const copyNote = Effect.gen(function* () {
    if (copySyncedAt === undefined || !coordinatorPolicy)
      return "The coordinator could not be reached and never sent its settings here: decided with this computer's own settings.";
    const age = ((yield* Clock.currentTimeMillis) - copySyncedAt) / 3_600_000;
    return `The coordinator could not be reached: decided here with the settings and learned numbers it last sent, ${span(Math.max(0, age))} ago.`;
  });

  /**
   * Readings are only probed while a client watches provider status, so they can be days old
   * when a decision reads them. Probe the stale ones, wait briefly, and let slower probes
   * finish for the next decision. Which accounts keep history is unchanged.
   */
  const refreshStaleReadings = Effect.fn("ProviderAllocation.refreshStaleReadings")(function* (
    maxAgeMinutes: number,
    driver?: string,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const stale = (yield* providers.getProviders).filter((p) => {
      const limits = p.usageLimits;
      if (!p.enabled || !p.installed || (driver !== undefined && p.driver !== driver)) return false;
      if (
        limits?.unavailable?.reason === "unsupported" ||
        limits?.unavailable?.reason === "unverified"
      )
        return false;
      if (nowMs - (refreshAttempts.get(p.instanceId) ?? -Infinity) < READING_REFRESH_RETRY_MS)
        return false;
      if (!limits) {
        // A failed Claude health check can leave neither quota nor login identity.
        // Retry a known sign-out at the normal interval so a new login is discovered.
        return (
          p.driver === "claudeAgent" &&
          (p.auth.status !== "unauthenticated" ||
            nowMs - Date.parse(p.checkedAt) > maxAgeMinutes * 60_000)
        );
      }
      const readings = limits.windows.length
        ? limits.windows.map((w) => w.checkedAt ?? limits.checkedAt)
        : [limits.checkedAt];
      return readings.some((checkedAt) => nowMs - Date.parse(checkedAt) > maxAgeMinutes * 60_000);
    });
    if (!stale.length) return;
    for (const p of stale) refreshAttempts.set(p.instanceId, nowMs);
    const probes = yield* Effect.forEach(
      stale,
      (p) => Effect.suspend(() => providers.refreshInstance(p.instanceId)).pipe(Effect.exit),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.forkIn(scope));
    yield* Fiber.await(probes).pipe(Effect.timeoutOption(READING_REFRESH_BUDGET));
  });

  const inventory = Effect.fn("ProviderAllocation.inventory")(function* (
    request: AllocationRequest | undefined,
    placement?: ComputerPlacementProbe,
    refreshOlderThanMinutes?: number,
  ) {
    if (refreshOlderThanMinutes !== undefined)
      yield* refreshStaleReadings(refreshOlderThanMinutes, request?.driver);
    const shell = yield* projection.getShellSnapshot();
    const threads = shell.threads;
    const currentProviders = yield* providers.getProviders;
    // A placement read also measures this computer and finds its checkouts of the repository.
    // It is sampled before the inventory is stamped, so the reading is never newer than it.
    const checkouts =
      placement?.repositoryKey === undefined
        ? undefined
        : shell.projects.filter(
            (project) => project.repositoryIdentity?.canonicalKey === placement.repositoryKey,
          );
    const computer = placement
      ? yield* computers
          .capacity({
            workPath:
              (yield* settings.getSettings).agentWorkRoot.trim() || checkouts?.[0]?.workspaceRoot,
          })
          .pipe(
            // A reading that outlasts a peer deadline leaves this computer unmeasured, not the
            // whole advice late.
            Effect.timeoutOption(Peers.PEER_CALL_TIMEOUT_MS),
            Effect.map(Option.getOrUndefined),
          )
      : undefined;
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const rows = threads.length
      ? yield* sql<{
          payload_json: string;
          created_at: string;
          kind: string;
          ordinal: number;
          thread_id: ThreadId;
          turn_id: string | null;
          historical_session_json: string | null;
          native_error_text: string | null;
        }>`SELECT payload_json, created_at, kind, rowid AS ordinal, thread_id, turn_id,
          (SELECT m.text FROM projection_turns t JOIN projection_thread_messages m
           ON m.message_id = t.assistant_message_id AND m.thread_id = t.thread_id AND m.turn_id = t.turn_id
           WHERE t.thread_id = a.thread_id AND t.turn_id = a.turn_id AND t.state = 'error'
             AND a.kind = 'runtime.error' AND m.role = 'assistant' AND m.updated_at <= a.created_at
             AND length(m.text) <= 256 AND m.text LIKE 'You''ve hit your % limit %' LIMIT 1) AS native_error_text,
          COALESCE((SELECT json_extract(e.payload_json, '$.session')
           FROM orchestration_events e
           WHERE e.aggregate_kind = 'thread' AND e.event_type = 'thread.session-set'
             AND e.stream_id = a.thread_id AND e.occurred_at <= a.created_at
             AND json_extract(e.payload_json, '$.session.activeTurnId') = a.turn_id
           ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1),
          (SELECT json_extract(e.payload_json, '$.session')
           FROM orchestration_events e
           WHERE e.aggregate_kind = 'thread' AND e.event_type = 'thread.session-set'
             AND e.stream_id = a.thread_id AND e.occurred_at <= a.created_at
           ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1)) AS historical_session_json
          FROM projection_thread_activities a INDEXED BY idx_projection_thread_activities_quota_evidence WHERE ${sql.in("thread_id", [...byThread.keys()])} AND kind IN ('account.quota-state', 'runtime.error', 'runtime.warning') AND (kind = 'account.quota-state' OR kind = 'runtime.error' OR (kind = 'runtime.warning' AND json_extract(payload_json, '$.detail.status') = 'rejected')) ORDER BY created_at DESC, rowid DESC`
      : [];
    // The model each measured turn ran: a later acceptance clears a model-scoped rejection
    // only when its turn used a model that bucket covers.
    const turnModels = new Map(
      (rows.length ? (yield* measurements.evidence).turns : []).flatMap((t) =>
        t.model && !t.mixedModels
          ? [[`${t.instanceId}:${t.threadId}:${t.turnId}`, t.model] as const]
          : [],
      ),
    );
    const quotaEvidence = readQuotaEvidenceRows(
      rows.flatMap((row) => {
        const thread = byThread.get(row.thread_id)!;
        // Explicit receipt identity wins in the decoder. Legacy activities use the
        // session at their event time, not the account selected after a switch.
        return quotaEvidenceInstances(
          row.historical_session_json,
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
          currentProviders,
          row.payload_json,
        ).map((instanceId) => ({
          ...row,
          instanceId,
          model: turnModels.get(`${instanceId}:${row.thread_id}:${row.turn_id}`),
        }));
      }),
    );
    const current = allocationInventory({
      environmentId: local.environmentId,
      at: yield* now,
      providers: currentProviders,
      workerDisabledInstanceIds: (yield* settings.getSettings).workerDisabledInstanceIds,
      threads,
      quotaEvidence,
      measurements: yield* measurements.read({ lookbackHours: 168, turnLimit: 1 }),
      ...(request ? { request } : {}),
    });
    const pending = yield* sql<{
      thread_id: string;
      selection_json: string;
    }>`SELECT DISTINCT w.thread_id, json_extract(w.plan_json, '$.modelSelection') AS selection_json FROM custom_workers w JOIN custom_worker_jobs j ON j.worker_id = w.thread_id WHERE j.kind = 'work' AND j.state IN ('queued', 'submitted') AND (json_extract(w.plan_json, '$.environmentId') IS NULL OR json_extract(w.plan_json, '$.environmentId') = ${local.environmentId})`;
    const demand = [...current.demand];
    for (const p of pending) {
      if (demand.some((d) => d.threadId === p.thread_id)) continue;
      const selection = yield* decodeSelection(p.selection_json);
      demand.push({
        environmentId: local.environmentId,
        threadId: ThreadId.make(p.thread_id),
        instanceId: selection.instanceId,
        accountKey:
          current.accounts.find((a) => a.instanceId === selection.instanceId)?.accountKey ?? null,
        model: selection.model,
        options: selection.options ?? [],
        state: "pending",
      });
    }
    const workers = new Set(
      demand.length
        ? (yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM custom_workers WHERE owner_id IS NOT NULL AND ${sql.in(
            "thread_id",
            demand.map((d) => d.threadId),
          )}`).map((row) => row.thread_id)
        : [],
    );
    // Each working session's context, which sets what its next hour costs.
    const contexts = new Map<string, number>();
    yield* Effect.forEach(demand, (d) =>
      sql<{
        used: number | null;
      }>`SELECT json_extract(payload_json, '$.usedTokens') AS used FROM projection_thread_activities
        WHERE kind = 'context-window.updated' AND thread_id = ${d.threadId} ORDER BY created_at DESC LIMIT 1`.pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            const used = rows[0]?.used;
            if (typeof used === "number" && used >= 0) contexts.set(d.threadId, Math.round(used));
          }),
        ),
      ),
    );
    // A session this young may not have taken its memory yet; one still queued has no thread.
    const startedSince = Date.parse(current.observedAt) - MAX_START_SETTLE_MINUTES * 60_000;
    const recentStarts = placement
      ? demand.flatMap((d) => {
          const at = byThread.get(d.threadId)?.createdAt ?? current.observedAt;
          return Date.parse(at) >= startedSince ? [{ threadId: d.threadId, at }] : [];
        })
      : undefined;
    // The system killing a session for memory is the plainest sign that this computer is full.
    // The index is partial: its own kind filter is repeated so SQLite can use it.
    const lastMemoryKill = placement
      ? yield* sql<{
          at: string;
        }>`SELECT created_at AS at FROM projection_thread_activities INDEXED BY idx_projection_thread_activities_quota_evidence
          WHERE kind IN ('account.quota-state', 'runtime.error', 'runtime.warning') AND kind = 'runtime.error' AND created_at >= ${DateTime.formatIso(
            DateTime.makeUnsafe(
              Date.parse(current.observedAt) - MAX_MEMORY_KILL_HOLD_MINUTES * 60_000,
            ),
          )} AND json_extract(payload_json, '$.code') = 'oom_kill'
          ORDER BY created_at DESC LIMIT 1`
      : undefined;
    return {
      ...current,
      ...(recentStarts ? { recentStarts } : {}),
      ...(lastMemoryKill ? { lastMemoryKillAt: lastMemoryKill[0]?.at ?? null } : {}),
      maxActiveAgentSessions: (yield* settings.getSettings).maxActiveAgentSessions,
      environmentLabel: local.label,
      demand: demand.map((d) => ({
        ...d,
        ...(workers.has(d.threadId) ? { worker: true } : {}),
        ...(contexts.has(d.threadId) ? { contextTokens: contexts.get(d.threadId)! } : {}),
      })),
      coordinatorEnvironmentId: (yield* settings.getSettings).allocationCoordinatorEnvironmentId,
      ...(computer ? { computer } : {}),
      ...(checkouts
        ? { projects: checkouts.slice(0, 20).map(({ id, title }) => ({ id, title })) }
        : {}),
    };
  }, Effect.mapError(unavailable));
  /** The coordinator's policies: asked now, else as last read, else this computer's own copy. */
  const policies = Effect.gen(function* () {
    yield* execute({ _tag: "caps" }).pipe(
      Effect.timeoutOption(READING_REFRESH_BUDGET),
      Effect.catch(() => Effect.succeedNone),
    );
    return {
      policy: coordinatorPolicy ?? (yield* store.policy),
      modelPolicy: coordinatorModelPolicy ?? (yield* store.modelPolicy),
      learned: coordinatorLearned ?? (yield* store.learned),
    };
  });
  const limited = Effect.fn("ProviderAllocation.limited")(function* (
    selection: Pick<ModelSelection, "instanceId" | "model">,
    kind: AllocationRequest["kind"] = "worker",
  ) {
    const at = yield* now;
    const provider = (yield* providers.getProviders).find(
      (p) => p.instanceId === selection.instanceId,
    );
    if (!provider) return false;
    const [account] = allocationInventory({
      environmentId: local.environmentId,
      at,
      providers: [provider],
      threads: [],
      measurements: {
        observedAt: at,
        monitoredInstanceIds: [],
        retentionDays: 0,
        persistenceError: null,
        accounts: [],
        turns: [],
        totalMatchingTurns: 0,
        profiles: [],
        limitations: [],
      },
    }).accounts;
    if (!account) return false;
    const policy = coordinatorPolicy ?? (yield* store.policy);
    return (
      accountRoom({
        account,
        model: selection.model,
        cap: accountCap(policy, account, kind),
        at,
      }).drainedUntil !== undefined
    );
  }, Effect.mapError(unavailable));
  /** This computer's finished turns and limit readings, for learning, on every account. */
  const evidence = Effect.gen(function* () {
    const raw = yield* measurements.evidence;
    const current = yield* providers.getProviders;
    const byInstance = new Map(current.map((p) => [p.instanceId as string, p]));
    const keyOf = (instanceId: string) => {
      const p = byInstance.get(instanceId);
      return p
        ? allocationPreferenceKey({
            driver: p.driver,
            accountKey: allocationIdentity(p),
            environmentId: local.environmentId,
            instanceId: p.instanceId,
          })
        : undefined;
    };
    const rows = yield* sql<{
      thread_id: string;
      owner_id: string | null;
    }>`SELECT thread_id, owner_id FROM custom_workers`;
    const workers = new Set(rows.map((r) => r.thread_id));
    // A thread that owns workers is a master, even when another master started it.
    const owners = new Set(
      rows.flatMap((r) => (r.owner_id ? [r.owner_id.split(":").at(-1)!] : [])),
    );
    return {
      environmentId: local.environmentId,
      observedAt: yield* now,
      turns: raw.turns.flatMap((t) => {
        const key = keyOf(t.instanceId);
        const provider = byInstance.get(t.instanceId);
        if (!key || !provider || !t.model || t.priced === null || !t.startedAt || !t.endedAt)
          return [];
        const tokens = t.tokens;
        const context =
          t.peakContextTokens === null
            ? null
            : Math.round(
                ((t.initialContextTokens ?? t.peakContextTokens) + t.peakContextTokens) / 2,
              );
        return [
          {
            key,
            driver: provider.driver,
            model: t.model,
            effort: t.effort,
            kind: workers.has(t.threadId) && !owners.has(t.threadId) ? "worker" : "master",
            threadId: t.threadId,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            contextTokens: context,
            costUsd: t.priced,
            ...(tokens?.inputTokens !== undefined && tokens.outputTokens !== undefined
              ? {
                  tokens: {
                    input: Math.max(
                      0,
                      tokens.inputTokens -
                        (tokens.cachedInputTokens ?? 0) -
                        (tokens.cacheCreationTokens ?? 0),
                    ),
                    cacheRead: tokens.cachedInputTokens ?? 0,
                    cacheWrite: tokens.cacheCreationTokens ?? 0,
                    output: tokens.outputTokens,
                  },
                }
              : {}),
          } as const,
        ];
      }),
      readings: raw.quotas.flatMap((q) => {
        const key = keyOf(q.instanceId);
        const provider = byInstance.get(q.instanceId);
        if (!key || !provider) return [];
        const models = windowModels(q.window.modelScope, provider.models);
        return [
          {
            key,
            label: provider.displayName ?? provider.instanceId,
            driver: provider.driver,
            windowId: q.window.id,
            windowLabel: q.window.label,
            kind: q.window.kind,
            ...(models.length ? { models } : {}),
            usedPercent: q.window.usedPercent,
            checkedAt: q.checkedAt,
            resetsAt: q.window.resetsAt ?? null,
            durationHours: q.window.windowDurationMins ? q.window.windowDurationMins / 60 : null,
            plan: q.plan ?? null,
          },
        ];
      }),
    } satisfies AllocationEvidence;
  }).pipe(Effect.mapError(unavailable));
  /**
   * Learns cost per working hour and each limit's share per dollar from every computer's
   * history, and stores the result for every decision and every computer's copy.
   */
  const learn = Effect.gen(function* () {
    const at = yield* now;
    const linked = yield* peers.list;
    const remote = yield* Effect.forEach(
      linked,
      (peer) =>
        peers
          .call(peer.environmentId, { _tag: "allocationEvidence" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AllocationEvidence)), Effect.result),
      { concurrency: "unbounded" },
    );
    const inventories = yield* collect();
    const accounts = [
      ...new Map(
        inventories
          .flatMap((i) => i.accounts)
          .map((a) => [
            allocationPreferenceKey(a),
            {
              key: allocationPreferenceKey(a),
              label: a.label,
              driver: a.driver,
              plan: a.plan ?? null,
              windows: a.windows.map((w) => ({
                id: w.id,
                label: w.label,
                kind: w.kind,
                ...(w.models ? { models: w.models } : {}),
              })),
            },
          ]),
      ).values(),
    ];
    const modelPolicy = yield* store.modelPolicy;
    const fallback = modelFallback(modelPolicy);
    const offered = (model: string) => [
      ...new Set(
        inventories
          .flatMap((i) => i.accounts)
          .filter((a) => a.models.some((m) => m.slug === model))
          .map((a) => a.driver),
      ),
    ];
    const profiles = [
      ...modelLadder(modelPolicy).map((r) => ({ driver: "claudeAgent", ...r })),
      ...(["claudeAgent", "codex"] as const).flatMap((driver) =>
        modelPolicy[driver].cells.flat().map((c) => ({ driver, model: c.model, effort: c.effort })),
      ),
      ...(fallback
        ? offered(fallback.model).map((driver) => ({
            driver,
            model: fallback.model,
            effort: fallback.effort,
          }))
        : []),
    ];
    const learned = learnAllocation({
      at,
      evidence: [
        yield* evidence,
        ...remote.flatMap((r) => (r._tag === "Success" ? [r.success] : [])),
      ],
      accounts,
      profiles: [...new Map(profiles.map((p) => [JSON.stringify(p), p])).values()],
      price: yield* measurements.prices,
      notes: remote.flatMap((r, i) =>
        r._tag === "Success"
          ? []
          : [
              `${linked[i]!.label}: history not read (${r.failure.message}); its use counts as background.`,
            ],
      ),
    });
    // A learn missing a computer's history, or much of the evidence, keeps the stored numbers.
    const stored = yield* store.learned;
    const unread = remote.filter((r) => r._tag !== "Success").length;
    if (stored && !replacesLearned(stored, learned, unread)) {
      yield* Effect.logWarning("Allocation learning kept the stored numbers", {
        storedAt: stored.learnedAt,
        notes: learned.notes,
      });
      return stored;
    }
    yield* store.saveLearned(learned);
    return learned;
  });
  const reroute = Effect.fn("ProviderAllocation.reroute")(function* (
    threadId: ThreadId,
    current: ModelSelection,
    options?: { readonly rejected?: boolean; readonly switchAccount?: boolean },
  ) {
    const { policy, modelPolicy, learned } = yield* policies;
    const localInventory = yield* inventory(undefined, undefined, policy.maxReadingAgeMinutes);
    const at = yield* now;
    const account = localInventory.accounts.find((a) => a.instanceId === current.instanceId);
    const reset = account
      ? accountRoom({
          account,
          model: current.model,
          cap: accountCap(policy, account, "worker"),
          at,
        }).drainedUntil
      : undefined;
    if (!options?.rejected && reset === undefined) return { _tag: "proceed" } as const;
    const until =
      reset ?? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + UNKNOWN_RESET_WAIT_MS));
    const long =
      Date.parse(until) - Date.parse(at) >
      (policy.longWaitHours ?? DEFAULT_LONG_WAIT_HOURS) * 3_600_000;
    const wait = { _tag: "wait", until, observed: reset !== undefined, long } as const;
    if (options?.switchAccount === false || !account) return wait;
    // A worker that is not on Fable never moves onto an account in Fable mode.
    const reachable = {
      ...localInventory,
      accounts: localInventory.accounts.filter(
        (a) => isFable(current.model) || !fableModeAccount(policy, a),
      ),
    };
    // The account that is drained or just refused the turn is out, whatever its readings say.
    const inventories = [
      {
        ...reachable,
        accounts: reachable.accounts.filter(
          (a) =>
            a.instanceId !== current.instanceId &&
            (!account.accountKey || a.accountKey !== account.accountKey),
        ),
      },
    ];
    const reservations = yield* store.reservations;
    // What is left of the job the worker was started for, as the projection's horizon.
    const started = reservations.findLast((r) => r.request.threadId === threadId);
    const remaining = started?.request.expectedHours
      ? Math.max(
          0.5,
          started.request.expectedHours -
            (Date.parse(at) - Date.parse(started.createdAt)) / 3_600_000,
        )
      : undefined;
    const base = {
      kind: "worker" as const,
      assignmentId: `usage-switch:${threadId}`,
      environmentId: local.environmentId,
      threadId,
      ...(remaining === undefined ? {} : { expectedHours: Math.min(168, remaining) }),
    };
    const context = { at, policy, inventories, reservations, authorityAvailable: true, learned };
    // The same model on another account that lasts the rest of the job inside its plan, ranked
    // like a start; an account on credits comes only after the wait, as for a start.
    const same = decideAllocation({
      ...context,
      request: {
        ...base,
        driver: account.driver,
        model: current.model,
        options: current.options ?? [],
      },
    });
    const sameModel = same.candidates.find(
      (c) => c.instanceId === same.selectedInstanceId && c.fits !== false && !c.onCredits,
    )?.instanceId;
    if (sameModel)
      return {
        _tag: "switch",
        selection: { ...current, instanceId: sameModel },
        modelChanged: false,
      } as const;
    // Another model continues from the same conversation with other abilities: only when the
    // reset is far, and then the master is told. It moves at most two rungs, never onto Fable
    // when Fable workers are off, and only between Fable rungs on an account in Fable mode.
    if (!long) return wait;
    // A reading that shows the drain is scoped to the model, so this account may offer another.
    const choice = chooseProfile({
      ...context,
      ...(reset !== undefined ? { inventories: [reachable] } : {}),
      modelPolicy,
      request: {
        ...base,
        selection: "automatic",
        // Unused: the worker's own model is the starting rung.
        assessment: { difficulty: 0, stakes: 0 },
        allowedDrivers: [account.driver],
        override: { driver: account.driver, model: current.model, options: current.options ?? [] },
      },
    });
    const decision = choice.decision;
    // Another account's limit resets soon: wait for it, then decide again.
    if (choice.startAt) return { ...wait, until: choice.startAt, observed: false };
    return decision?.selectedInstanceId
      ? ({
          _tag: "switch",
          selection: {
            instanceId: decision.selectedInstanceId,
            model: decision.request.model,
            options: decision.request.options,
          },
          modelChanged: decision.request.model !== current.model,
        } as const)
      : wait;
  }, Effect.mapError(unavailable));
  const probe = Effect.fn("ProviderAllocation.probe")(function* (
    threadId: ThreadId,
    assignmentId: string,
    since: string,
    startIntent?: string,
  ) {
    const rejected =
      yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id IN (${`allocation:${assignmentId}`}, ${`allocation:${assignmentId}:create`}) AND aggregate_id = ${threadId} AND status = 'rejected'`;
    const failedStart =
      yield* sql`SELECT 1 FROM provider_allocation_failed_starts WHERE assignment_id = ${assignmentId} AND thread_id = ${threadId}`;
    const remoteRefusal = startIntent
      ? yield* sql`SELECT 1 FROM provider_allocation_start_rejections WHERE assignment_id = ${assignmentId} AND thread_id = ${threadId} AND start_intent = ${startIntent}`
      : [];
    if (rejected.length || failedStart.length || remoteRefusal.length)
      return { state: "terminal" as const };
    const jobs = yield* sql<{
      state: string;
    }>`SELECT state FROM custom_worker_jobs WHERE id = ${`spawn:${threadId}`} AND target_id = ${threadId} AND kind = 'work'`;
    if (jobs[0]?.state === "queued" || jobs[0]?.state === "submitted")
      return { state: "pending" as const };
    if (jobs[0] && ["completed", "error", "interrupted", "cancelled"].includes(jobs[0].state))
      return { state: "terminal" as const };
    const failed =
      yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId} AND state = 'error'`;
    if (failed.length) return { state: "terminal" as const };
    const thread = yield* projection.getThreadShellById(threadId);
    if (Option.isNone(thread)) return { state: "unknown" as const };
    const t = thread.value;
    if (
      t.session?.status === "running" ||
      t.latestTurn?.state === "running" ||
      t.backgroundLiveness === "working"
    )
      return { state: "running" as const };
    if (t.session?.status === "starting") return { state: "pending" as const };
    if (
      (t.latestTurn?.completedAt && t.latestTurn.completedAt >= since) ||
      (t.session?.status === "error" && t.session.updatedAt >= since) ||
      (jobs[0] && ["completed", "error", "interrupted", "cancelled"].includes(jobs[0].state))
    )
      return { state: "terminal" as const };
    return { state: "unknown" as const };
  }, Effect.mapError(unavailable));
  const collect = Effect.fn("ProviderAllocation.collect")(function* (
    request?: AllocationRequest,
    executionEnvironmentId = request?.environmentId,
    placement?: ComputerPlacementProbe,
    refreshOlderThanMinutes?: number,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const linked = yield* peers.list;
        const observed = new Map<string, AllocationInventory>();
        const read = (environmentId: string) =>
          peers
            .call(environmentId, {
              _tag: "allocationInventory",
              ...(request ? { request } : {}),
              ...(placement ? { placement } : {}),
              // An observer has only five seconds to return its existing account readings
              // and load. Probing stale accounts first can use up most of that deadline.
              ...(refreshOlderThanMinutes !== undefined && environmentId === executionEnvironmentId
                ? { refreshOlderThanMinutes }
                : {}),
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AllocationInventory)));
        const own = inventory(request, placement, refreshOlderThanMinutes);
        // Every reading starts at once, this computer's too: the caller waits for the slowest of
        // them, not for their sum.
        if (executionEnvironmentId === undefined) {
          const [here, remote] = yield* Effect.all(
            [
              own,
              Effect.forEach(linked, (peer) => Effect.result(read(peer.environmentId)), {
                concurrency: "unbounded",
              }),
            ],
            { concurrency: "unbounded" },
          );
          return [
            here,
            ...remote.map((result, index) =>
              result._tag === "Success"
                ? result.success
                : unreadInventory(linked[index]!, here.observedAt, result.failure.message),
            ),
          ];
        }
        // A decision counts the working sessions on every computer, so the other hosts' reads
        // get a short bound of their own instead of being cancelled when the required reads
        // finish. One that is slow or offline costs at most that bound, and its missing load
        // is stated in a note, never counted as zero silently.
        const others = linked.filter((peer) => peer.environmentId !== executionEnvironmentId);
        const pending = yield* Effect.forEach(others, (peer) =>
          Effect.result(read(peer.environmentId)).pipe(
            Effect.timeoutOption(OTHER_COMPUTER_READ_BUDGET),
            Effect.forkScoped({ startImmediately: true }),
          ),
        );
        const [here, target] = yield* Effect.all(
          [
            own,
            executionEnvironmentId === local.environmentId
              ? Effect.succeed(undefined)
              : read(executionEnvironmentId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AllocationError({
                        code: "unavailable",
                        detail: `Execution environment ${executionEnvironmentId} inventory unavailable: ${cause.message}`,
                      }),
                  ),
                ),
          ],
          { concurrency: "unbounded" },
        );
        if (target) observed.set(executionEnvironmentId, target);
        const answers = yield* Effect.forEach(pending, Fiber.join);
        answers.forEach((answer, index) => {
          const peer = others[index]!;
          observed.set(
            peer.environmentId,
            Option.isNone(answer)
              ? unreadInventory(
                  peer,
                  here.observedAt,
                  `no answer within ${OTHER_COMPUTER_READ_BUDGET}`,
                )
              : answer.value._tag === "Success"
                ? answer.value.success
                : unreadInventory(peer, here.observedAt, answer.value.failure.message),
          );
        });
        return [
          here,
          ...linked.map(
            (peer) => observed.get(peer.environmentId) ?? unreadInventory(peer, here.observedAt),
          ),
        ];
      }),
    );
  });
  /**
   * Settles started reservations from their computers' receipts: every open one without an
   * `assignmentId`, else that assignment's own. With `until`, a selecting operation settles every
   * open one too, but only its own probe is awaited: any other still unanswered when `until`
   * ends is unknown and keeps its demand, so a slow computer never delays a new assignment.
   */
  const reconcile = Effect.fn("ProviderAllocation.reconcile")(function* (
    assignmentId?: string,
    until?: Effect.Effect<void>,
  ) {
    yield* store.expireUnused(yield* now);
    const open = (yield* store.reservations).filter(
      (r) =>
        (assignmentId === undefined || until !== undefined || r.assignmentId === assignmentId) &&
        (r.state === "starting" || r.state === "consumed"),
    );
    const unknown = { state: "unknown" as const };
    // Asked together, so a slow or unreachable computer costs one deadline, not one per start.
    const states = yield* Effect.forEach(
      open,
      (r) => {
        const asked = (
          r.request.environmentId === local.environmentId
            ? probe(r.request.threadId, r.assignmentId, r.createdAt, r.startIntent ?? undefined)
            : peers
                .call(r.request.environmentId, {
                  _tag: "allocationProbe",
                  ...(r.startIntent ? { startIntent: r.startIntent } : {}),
                  threadId: r.request.threadId,
                  assignmentId: r.assignmentId,
                  since: r.createdAt,
                })
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Probe)),
                  Effect.mapError(unavailable),
                )
        ).pipe(Effect.orElseSucceed(() => unknown));
        return until && r.assignmentId !== assignmentId
          ? asked.pipe(Effect.raceFirst(until.pipe(Effect.as(unknown))))
          : asked;
      },
      { concurrency: "unbounded" },
    );
    for (const [index, r] of open.entries()) {
      const state = states[index]!;
      if (state.state === "terminal" || (state.state === "running" && r.state === "starting")) {
        const settled = store.lifecycle(
          {
            assignmentId: r.assignmentId,
            environmentId: r.request.environmentId,
            threadId: r.request.threadId,
            action: state.state === "terminal" ? "release" : "consume",
          },
          yield* now,
        );
        // Another operation may have settled someone else's reservation first.
        yield* r.assignmentId === assignmentId ? settled : Effect.ignore(settled);
      }
    }
  });
  /** A selecting operation's inventory read, with every started reservation settled meanwhile. */
  const readSettling = <A, E, R>(read: Effect.Effect<A, E, R>, assignmentId: string) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const [, value] = yield* Effect.all(
        [
          reconcile(assignmentId, Deferred.await(done)),
          read.pipe(Effect.ensuring(Deferred.succeed(done, undefined))),
        ],
        { concurrency: "unbounded" },
      );
      return value;
    });
  const executeLocal = Effect.fn("ProviderAllocation.executeLocal")(function* (
    operation: AllocationOperation,
    /** The coordinator cannot be used: decide here, and let the decision record that. */
    fallback = false,
  ): Effect.fn.Return<AllocationResponse, AllocationError> {
    const policy = yield* store.policy;
    const authorityAvailable = policy.coordinatorEnvironmentId === local.environmentId;
    const decides = authorityAvailable || fallback;
    // A fallback applies the coordinator's last known policies.
    const standIn: {
      coordinatorPolicy?: AllocationPolicy | null;
      coordinatorModelPolicy?: ModelRoutingPolicy;
    } = fallback
      ? {
          coordinatorPolicy: coordinatorPolicy ?? null,
          ...(coordinatorModelPolicy ? { coordinatorModelPolicy } : {}),
        }
      : {};
    if (operation._tag === "caps") {
      // Only a newer build asks with `learnedAt`, and only a newer table is sent back.
      const learned = operation.learnedAt === undefined ? undefined : yield* store.learned;
      return {
        policy,
        modelPolicy: yield* store.modelPolicy,
        ...(learned && learned.learnedAt !== operation.learnedAt ? { learned } : {}),
      };
    }
    // The coordinator decides with what it learned; a stand-in with the copy it last received,
    // else with what it learned itself.
    const learned = (fallback ? coordinatorLearned : undefined) ?? (yield* store.learned);
    const notes = fallback ? [yield* copyNote] : [];
    if (
      operation._tag === "modelSnapshot" ||
      operation._tag === "modelPolicy" ||
      operation._tag === "modelRevert" ||
      operation._tag === "modelPreview" ||
      operation._tag === "modelAllocate"
    ) {
      const modelPolicy = yield* store.modelPolicy;
      const selecting = operation._tag === "modelPreview" || operation._tag === "modelAllocate";
      // Half a snapshot neither reconciles reservations nor, for settings, asks any computer.
      const part = operation._tag === "modelSnapshot" ? operation.part : undefined;
      if (part === undefined && !selecting) yield* reconcile();
      const read = collect(
        undefined,
        selecting ? operation.request.environmentId : undefined,
        undefined,
        selecting ? policy.maxReadingAgeMinutes : undefined,
      );
      const inventories =
        part === "settings"
          ? []
          : selecting
            ? yield* readSettling(read, operation.request.assignmentId)
            : yield* read;
      if (operation._tag === "modelSnapshot")
        return {
          modelSnapshot: {
            policy: modelPolicy,
            policies: part === "accounts" ? [] : yield* store.modelPolicies,
            history: part === "accounts" ? [] : yield* store.modelHistory,
            inventories,
            authorityAvailable,
          },
        };
      if (operation._tag === "modelPolicy" || operation._tag === "modelRevert") {
        // Models are only warned about, so a computer that is off never blocks an edit.
        if (!authorityAvailable) return yield* unavailable();
        const saved = yield* store.saveModelPolicy({
          expectedVersion: operation.expectedVersion,
          inventories,
          ...(operation._tag === "modelPolicy"
            ? { policy: operation.policy }
            : { revertVersion: operation.version }),
        });
        return { modelPolicy: saved.policy, warnings: [...saved.warnings] };
      }
      if (operation._tag === "modelAllocate" && !decides) return yield* unavailable();
      const effectiveModelPolicy = operation._tag === "modelPreview" ? operation.policy : undefined;
      return {
        selection: yield* store.selectModel({
          at: yield* now,
          request: operation.request,
          inventories,
          authorityAvailable,
          reserve: operation._tag === "modelAllocate",
          expectedPolicyVersion: policy.version,
          expectedModelVersion: modelPolicy.version,
          learned,
          notes: [...notes, ...inventories.flatMap((i) => (i.complete ? [] : i.notices))],
          ...standIn,
          ...(effectiveModelPolicy ? { previewPolicy: effectiveModelPolicy } : {}),
        }),
      };
    }
    if (operation._tag === "policy") {
      if (operation.input.policy.coordinatorEnvironmentId !== local.environmentId)
        return yield* new AllocationError({
          code: "invalid",
          detail: "Save policies on their configured coordinator.",
        });
      if (policy.coordinatorEnvironmentId && !authorityAvailable) return yield* unavailable();
      return { policy: yield* store.savePolicy(operation.input) };
    }
    if (operation._tag === "lifecycle") {
      if (!decides) return yield* unavailable();
      if (operation.input.action === "start") {
        const held = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
        );
        if (held?.state === "reserved") {
          const request = { ...held.request, explicitInstanceId: held.instanceId };
          const inventories = yield* collect(request);
          const decision = decideAllocation({
            at: yield* now,
            policy: standIn.coordinatorPolicy ?? policy,
            request,
            inventories,
            reservations: yield* store.reservations,
            authorityAvailable,
            learned,
          });
          if (!decision.selectedInstanceId)
            return yield* new AllocationError({
              code: "unavailable",
              detail: decision.reasons.includes(WORKER_ACCOUNT_DISABLED_REASON)
                ? WORKER_ACCOUNT_DISABLED_REASON
                : decision.outcome === "wait"
                  ? decision.reasons[0]!
                  : "Reserved account no longer supports the exact requested profile or identity constraints.",
            });
        }
      }
      if (operation.input.action === "release") {
        const r = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
        );
        if (r && ["starting", "consumed"].includes(r.state)) {
          yield* reconcile(r.assignmentId);
          const updated = (yield* store.reservations).find(
            (v) => v.assignmentId === r.assignmentId,
          );
          if (updated?.state !== "released")
            return yield* new AllocationError({
              code: "conflict",
              detail:
                "Cancel or stop the assignment first. Capacity stays reserved until its execution receipt confirms completion.",
            });
        }
      }
      return { reservation: yield* store.lifecycle(operation.input, yield* now) };
    }
    if (operation._tag === "connect" || operation._tag === "connections")
      return yield* new AllocationError({
        code: "invalid",
        detail: "Connect must run on the requesting environment.",
      });
    const part = operation._tag === "snapshot" ? operation.part : undefined;
    if (operation._tag === "snapshot" && part === undefined) yield* reconcile();
    const inventories =
      part === "settings"
        ? []
        : operation._tag === "snapshot"
          ? yield* collect()
          : yield* readSettling(
              collect(operation.request, undefined, undefined, policy.maxReadingAgeMinutes),
              operation.request.assignmentId,
            );
    const coordinated =
      authorityAvailable &&
      inventories.every((i) => i.coordinatorEnvironmentId === local.environmentId);
    if (operation._tag === "snapshot")
      return {
        snapshot: {
          accountCapsSupported: true,
          accountOrderSupported: true,
          policy,
          inventories,
          reservations: part ? [] : yield* store.reservations,
          history: part ? [] : yield* store.history,
          authorityAvailable,
          ...(learned && part !== "accounts" ? { learned } : {}),
          runways: accountRunways({
            at: yield* now,
            policy,
            inventories,
            learned,
          }),
          notices: [
            ...inventories.flatMap((i) => i.notices),
            ...(!coordinated && part !== "settings"
              ? [
                  "Some linked computers could not be read or name another coordinator, so their accounts and workers may be missing here.",
                ]
              : []),
          ],
        } satisfies AllocationSnapshot,
      };
    if (operation._tag === "allocate" && !decides) return yield* unavailable();
    return {
      result: yield* store.allocate({
        at: yield* now,
        request: operation.request,
        inventories,
        authorityAvailable,
        reserve: operation._tag === "allocate",
        expectedPolicyVersion: policy.version,
        learned,
        ...standIn,
        ...(operation._tag === "preview" && operation.policy
          ? { previewPolicy: operation.policy }
          : {}),
      }),
    };
  });
  // Only this computer knows its project IDs; checkouts elsewhere match by repository.
  const placementRead = Effect.fn("ProviderAllocation.placementRead")(function* (
    projectId: ProjectId | undefined,
  ) {
    const project =
      projectId === undefined
        ? undefined
        : (yield* projection.getShellSnapshot().pipe(Effect.mapError(unavailable))).projects.find(
            ({ id }) => id === projectId,
          );
    const repositoryKey = project?.repositoryIdentity?.canonicalKey;
    const inventories = yield* collect(
      undefined,
      undefined,
      repositoryKey === undefined ? {} : { repositoryKey },
    );
    return {
      found: project !== undefined,
      inventories,
      notes:
        projectId !== undefined && !project
          ? [`Project ${projectId} was not found on this computer, so no checkout was matched.`]
          : project && repositoryKey === undefined
            ? [
                "The project has no repository identity (a Git remote or a projectKey in t3.json), so no checkout was matched.",
              ]
            : [],
    };
  });
  const computersReport = Effect.fn("ProviderAllocation.computers")(function* (
    request: ComputersRequest,
  ) {
    const { inventories, notes } = yield* placementRead(request.projectId);
    return {
      at: yield* now,
      computers: inventories.map(computerNumbers),
      notes: [...notes, ...inventories.flatMap((i) => (i.complete ? [] : i.notices))],
    };
  });
  const place = Effect.fn("ProviderAllocation.place")(function* (input: PlaceInput) {
    const [read, { policy }] = yield* Effect.all(
      [placementRead(input.projectId), policies.pipe(Effect.mapError(unavailable))],
      { concurrency: "unbounded" },
    );
    const placement = placeWorker({
      at: yield* now,
      policy,
      inventories: read.inventories,
      localEnvironmentId: local.environmentId,
      ...(input.placed ? { placed: input.placed } : {}),
      ...(input.projectId === undefined
        ? {}
        : { project: { id: input.projectId, found: read.found } }),
      ...(input.environmentId === undefined ? {} : { named: input.environmentId }),
      ...(input.namedBecause === undefined ? {} : { namedBecause: input.namedBecause }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    });
    // When the missing project is the refusal, it is not also a note.
    return {
      ...placement,
      notes: [...(placement.refusal && !read.found ? [] : read.notes), ...placement.notes],
    };
  });
  const execute = Effect.fn("ProviderAllocation.execute")(function* (
    operation: AllocationOperation,
  ): Effect.fn.Return<AllocationResponse, AllocationError> {
    if (operation._tag === "connections")
      return {
        connections: {
          coordinatorEnvironmentId: (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
            .allocationCoordinatorEnvironmentId,
          environments: [local, ...(yield* peers.list.pipe(Effect.mapError(unavailable)))].map(
            ({ environmentId, label }) => ({ environmentId, label }),
          ),
        },
      };
    if (operation._tag === "connect") {
      yield* store.expireUnused(yield* now);
      const id = operation.coordinatorEnvironmentId;
      const previous = (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
        .allocationCoordinatorEnvironmentId;
      if (previous && previous !== id) {
        const old =
          previous === local.environmentId
            ? yield* executeLocal({ _tag: "snapshot" })
            : yield* peers
                .call(previous, { _tag: "allocation", operation: { _tag: "snapshot" } })
                .pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
        if (
          !old.snapshot ||
          old.snapshot.reservations.some((r) =>
            ["reserved", "starting", "consumed"].includes(r.state),
          )
        )
          return yield* new AllocationError({
            code: "conflict",
            detail: "Drain the previous coordinator's reservations before moving authority.",
          });
      }
      if (id !== local.environmentId) {
        const remote = yield* peers
          .call(id, { _tag: "allocation", operation: { _tag: "snapshot" } })
          .pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
        if (remote.snapshot?.policy.coordinatorEnvironmentId !== id)
          return yield* new AllocationError({
            code: "invalid",
            detail: "Selected peer is not an allocation coordinator.",
          });
      }
      const active = (yield* store.reservations).some((r) =>
        ["reserved", "starting", "consumed"].includes(r.state),
      );
      if (active)
        return yield* new AllocationError({
          code: "conflict",
          detail: "Drain active reservations before changing coordinator.",
        });
      yield* settings
        .updateSettings({ allocationCoordinatorEnvironmentId: id })
        .pipe(Effect.mapError(unavailable));
      if (id === local.environmentId) {
        const current = yield* store.policy;
        if (!current.coordinatorEnvironmentId)
          yield* store.savePolicy({
            expectedVersion: current.version,
            policy: { ...current, coordinatorEnvironmentId: id },
          });
      }
      return {};
    }
    const id = (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
      .allocationCoordinatorEnvironmentId;
    if (id && id !== local.environmentId) {
      // The coordinator's model policy version is unknown here, so a local decision drops its pin.
      const here = ((): AllocationOperation => {
        if (operation._tag !== "modelPreview" && operation._tag !== "modelAllocate")
          return operation;
        const { policyVersion: _pin, ...request } = operation.request;
        return { ...operation, request };
      })();
      // A start that fell back holds its reservation on this computer, so it continues here.
      const assignmentId =
        operation._tag === "lifecycle"
          ? operation.input.assignmentId
          : operation._tag === "allocate" || operation._tag === "modelAllocate"
            ? operation.request.assignmentId
            : undefined;
      if (
        assignmentId !== undefined &&
        (yield* store.reservations).some(
          (r) =>
            r.assignmentId === assignmentId &&
            ["reserved", "starting", "consumed"].includes(r.state),
        )
      )
        return yield* executeLocal(here, true);
      // Work that runs on the coordinator itself cannot start without it.
      const decidesHere =
        (operation._tag === "preview" ||
          operation._tag === "allocate" ||
          operation._tag === "modelPreview" ||
          operation._tag === "modelAllocate") &&
        operation.request.environmentId !== id;
      if (
        decidesHere &&
        (yield* Clock.currentTimeMillis) - coordinatorUnreachableAt < COORDINATOR_RETRY_MS
      )
        return yield* executeLocal(here, true);
      const sent =
        operation._tag === "modelPreview" || operation._tag === "modelAllocate"
          ? { ...operation, request: withLegacyReasons(operation.request) }
          : operation._tag === "caps"
            ? { ...operation, learnedAt: coordinatorLearned?.learnedAt ?? "" }
            : operation;
      return yield* peers.call(id, { _tag: "allocation", operation: sent }).pipe(
        Effect.flatMap(decodeResponse),
        Effect.tap((response) => keepCopy(id, response)),
        Effect.catch((cause) => {
          if (cause.message.includes(WORKER_ACCOUNT_DISABLED_REASON))
            return Effect.fail(
              new AllocationError({ code: "invalid", detail: WORKER_ACCOUNT_DISABLED_REASON }),
            );
          // The coordinator's own answer to a policy save is the message.
          if (
            cause._tag === "PeerRejected" &&
            (operation._tag === "policy" || operation._tag === "modelPolicy")
          )
            return Effect.fail(new AllocationError({ code: "invalid", detail: cause.message }));
          // An unreachable coordinator, or one on a version that cannot read the request, must
          // not fail a start. A deliberate refusal still does.
          const refused =
            cause._tag === "PeerRejected" && !cause.message.includes(UNREADABLE_PEER_REQUEST);
          // Checks outside a start read the policy; an unreachable coordinator's last copy answers.
          if (operation._tag === "caps" && !refused && coordinatorPolicy)
            return Effect.succeed({
              policy: coordinatorPolicy,
              ...(coordinatorModelPolicy ? { modelPolicy: coordinatorModelPolicy } : {}),
              ...(coordinatorLearned ? { learned: coordinatorLearned } : {}),
            });
          // The coordinator's own words tell the caller what to do; only silence is "unavailable".
          if (refused)
            return Effect.fail(
              cause.message.includes(ASSIGNMENT_FINISHED)
                ? new AllocationError({ code: "conflict", detail: ASSIGNMENT_FINISHED_REASON })
                : new AllocationError({ code: "unavailable", detail: cause.message }),
            );
          if (!decidesHere) return Effect.fail(unavailable());
          return Effect.logWarning("Allocation coordinator unavailable; deciding locally", {
            operation: operation._tag,
            cause: cause.message,
          }).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.tap((at) =>
              Effect.sync(() => {
                if (cause._tag === "PeerUnavailable") coordinatorUnreachableAt = at;
              }),
            ),
            Effect.andThen(executeLocal(here, true)),
          );
        }),
      );
    }
    return yield* executeLocal(operation);
  });
  const editPolicy = Effect.fn("ProviderAllocation.editPolicy")(function* (
    edit: AllocationPolicyEdit,
  ) {
    const snapshot = (yield* execute({ _tag: "snapshot" })).snapshot;
    if (!snapshot) return yield* unavailable();
    // A coordinator from before smart allocation answers `caps` without the model policy.
    const model =
      (yield* execute({ _tag: "caps" })).modelPolicy ??
      (yield* execute({ _tag: "modelSnapshot" })).modelSnapshot?.policy;
    if (!model) return yield* unavailable();
    const { showTable, ...changes } = edit;
    const { accountOrder, closeMarginPoints, longWaitHours, setCaps, clearCaps } = changes;
    const allocationEdit = [
      accountOrder,
      closeMarginPoints,
      longWaitHours,
      changes.workerMemoryGiB,
      changes.minFreeMemoryGiB,
      changes.startSettleMinutes,
      changes.sessionReserveGiB,
      changes.memoryKillHoldMinutes,
      changes.creditsPerDollar,
      setCaps,
      clearCaps,
      changes.setGoals,
      changes.clearGoals,
      changes.setFableGoals,
      changes.clearFableGoals,
      changes.fableWorkers,
      changes.fableAccounts,
    ];
    const modelEdit = [changes.ladder, changes.fallback, changes.setCells];
    const edits = (values: readonly unknown[]) => values.some((value) => value !== undefined);
    if ((edits(allocationEdit) || edits(modelEdit)) && snapshot.accountOrderSupported !== true)
      return yield* new AllocationError({
        code: "invalid",
        detail: "Update the allocation coordinator before changing its policy from here.",
      });
    const policy = edits(allocationEdit)
      ? (yield* execute({
          _tag: "policy",
          input: {
            expectedVersion: snapshot.policy.version,
            policy: yield* editAllocationPolicy(snapshot, edit),
          },
        })).policy
      : snapshot.policy;
    const saved = edits(modelEdit)
      ? yield* execute({
          _tag: "modelPolicy",
          expectedVersion: model.version,
          policy: editModelPolicy(model, edit),
        })
      : { modelPolicy: model };
    if (!policy || !saved.modelPolicy) return yield* unavailable();
    return allocationPolicyView({ ...snapshot, policy }, saved.modelPolicy, {
      ...(showTable ? { showTable } : {}),
      ...(saved.warnings ? { warnings: saved.warnings } : {}),
      learned: snapshot.learned ?? coordinatorLearned,
    });
  });
  // Only the coordinator learns; every other computer receives its numbers with the policies.
  yield* Effect.gen(function* () {
    const id = (yield* settings.getSettings).allocationCoordinatorEnvironmentId;
    if (id && id !== local.environmentId) return;
    yield* learn;
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Allocation learning failed", cause)),
    Effect.delay(FIRST_LEARN_DELAY),
    Effect.repeat(Schedule.spaced(LEARN_INTERVAL)),
    Effect.forkIn(scope),
  );
  return ProviderAllocation.of({
    reroute,
    limited,
    execute,
    editPolicy,
    computers: computersReport,
    place,
    receive: Effect.fn("ProviderAllocation.receive")(function* (from, raw) {
      if (Option.isNone(yield* peers.resolve(from)))
        return yield* new AllocationError({
          code: "invalid",
          detail: "Allocation traffic requires a linked environment.",
        });
      const request = yield* decodePeerInput(raw).pipe(
        Effect.mapError(
          () =>
            new AllocationError({
              code: "invalid",
              detail: `${UNREADABLE_PEER_REQUEST}. The two computers may run different T3 versions.`,
            }),
        ),
      );
      switch (request._tag) {
        case "allocationInventory":
          return yield* inventory(
            request.request,
            request.placement,
            request.refreshOlderThanMinutes,
          );
        case "allocationProbe":
          return yield* probe(
            request.threadId,
            request.assignmentId,
            request.since,
            request.startIntent,
          );
        case "allocation":
          return yield* executeLocal(request.operation);
        case "allocationEvidence":
          return yield* evidence;
      }
    }),
  });
});
export const layer = Layer.effect(ProviderAllocation, make);
export const liveLayer = layer.pipe(
  Layer.provide(Store.layer),
  Layer.provide(Peers.layer),
  Layer.provide(Computers.liveLayer),
);
