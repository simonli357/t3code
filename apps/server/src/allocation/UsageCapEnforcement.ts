import {
  allocationPreferenceKey,
  CommandId,
  type ProviderInstanceId,
  type ThreadId,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as WorkerService from "../workers/WorkerService.ts";
import { allocationIdentity, allocationInventory } from "./inventory.ts";
import * as Allocation from "./ProviderAllocation.ts";
import {
  readUsageCapLatch,
  reconcileUsageCap,
  usageCapDetail,
  usageCapLatchId,
  type UsageCapLatch,
  type UsageCapReach,
} from "./usageCaps.ts";

const CHECK_INTERVAL = "15 seconds";
const CAP_NOTIFICATION_PREFIX = "usage-cap:";
const NO_MEASUREMENTS: UsageMeasurementsReport = {
  observedAt: "1970-01-01T00:00:00.000Z",
  monitoredInstanceIds: [],
  retentionDays: 0,
  persistenceError: null,
  accounts: [],
  turns: [],
  totalMatchingTurns: 0,
  profiles: [],
  limitations: [],
};

export class UsageCapError extends Schema.TaggedError<UsageCapError>()("UsageCapError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

type LatchRow = {
  account_key: string;
  driver: string;
  window_id: string;
  cycle_key: string;
  used_percent: number;
  threshold_percent: number;
  checked_at: string;
  resets_at: string | null;
  enforced_at: string;
  stop_workers: number;
  stop_masters: number;
};

const latchFromRow = (row: LatchRow): UsageCapLatch => ({
  accountKey: row.account_key,
  driver: row.driver,
  windowId: row.window_id,
  cycleKey: row.cycle_key,
  usedPercent: row.used_percent,
  thresholdPercent: row.threshold_percent,
  checkedAt: row.checked_at,
  resetsAt: row.resets_at,
  enforcedAt: row.enforced_at,
  stopWorkers: row.stop_workers === 1,
  stopMasters: row.stop_masters === 1,
});
const sameLatch = (left: UsageCapLatch, right: UsageCapLatch) =>
  left.accountKey === right.accountKey &&
  left.driver === right.driver &&
  left.windowId === right.windowId &&
  left.cycleKey === right.cycleKey &&
  left.usedPercent === right.usedPercent &&
  left.thresholdPercent === right.thresholdPercent &&
  left.checkedAt === right.checkedAt &&
  left.resetsAt === right.resetsAt &&
  left.enforcedAt === right.enforcedAt &&
  left.stopWorkers === right.stopWorkers &&
  left.stopMasters === right.stopMasters;
const reachFromLatch = (latch: UsageCapLatch): UsageCapReach => ({
  accountKey: latch.accountKey,
  driver: latch.driver,
  windowId: latch.windowId as "weekly" | "fiveHour",
  windowLabel:
    latch.windowId === "fiveHour"
      ? "5-hour"
      : latch.windowId === "weekly"
        ? "Weekly"
        : latch.windowId,
  capPercent: latch.thresholdPercent,
  usedPercent: latch.usedPercent,
  checkedAt: latch.checkedAt,
  resetsAt: latch.resetsAt,
  cycleKey: latch.cycleKey,
  latchId: usageCapLatchId(latch),
  enforcedAt: latch.enforcedAt,
  stopWorkers: latch.stopWorkers,
  stopMasters: latch.stopMasters,
});

type CapDeps = {
  readonly sql: SqlClient.SqlClient;
  readonly providers: typeof ProviderRegistry.Service;
  readonly localEnvironmentId: string;
};

/**
 * The cap, if any, that stops this thread on this account. A probe failure or a missing window
 * cannot strengthen a cap, but it never releases a crossing that verified telemetry established;
 * accounts that cannot report or verify quota are never capped.
 */
const capReachFor = Effect.fn("UsageCap.reachFor")(function* (
  deps: CapDeps,
  reaches: readonly UsageCapReach[],
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
) {
  if (!reaches.length) return null;
  const provider = (yield* deps.providers.getProviders).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  if (!provider) return null;
  if (
    provider.usageLimits?.unavailable?.reason === "unsupported" ||
    provider.usageLimits?.unavailable?.reason === "unverified"
  )
    return null;
  const key = allocationPreferenceKey({
    driver: provider.driver,
    accountKey: allocationIdentity(provider),
    environmentId: deps.localEnvironmentId,
    instanceId: provider.instanceId,
  });
  const reach = reaches.find((candidate) => candidate.accountKey === key);
  if (!reach) return null;
  const roles = (yield* deps.sql<{ is_worker: number; is_master: number }>`SELECT
      EXISTS(SELECT 1 FROM custom_workers WHERE thread_id = ${threadId}) AS is_worker,
      EXISTS(SELECT 1 FROM custom_workers WHERE owner_id = ${threadId}) AS is_master`.pipe(
    Effect.mapError(
      (cause) =>
        new UsageCapError({
          detail: "Could not inspect the thread's worker or master role.",
          cause,
        }),
    ),
  ))[0];
  const stopsWorker = roles?.is_worker === 1 && reach.stopWorkers;
  const stopsMaster = roles?.is_master === 1 && reach.stopMasters;
  return stopsWorker || stopsMaster ? reach : null;
});

/**
 * What the provider start asks before it runs a turn. It reads the crossings the enforcement loop
 * saved, so it is cheap and never waits on a provider read.
 */
export class UsageCapGuard extends Context.Service<
  UsageCapGuard,
  {
    readonly check: (
      threadId: ThreadId,
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<UsageCapReach | null, UsageCapError>;
  }
>()("t3/allocation/UsageCapEnforcement/UsageCapGuard") {}

export const guardLayer = Layer.effect(
  UsageCapGuard,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providers = yield* ProviderRegistry;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const localEnvironmentId = yield* environment.getEnvironmentId;
    return UsageCapGuard.of({
      check: Effect.fn("UsageCapGuard.check")(function* (threadId, instanceId) {
        const at = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<LatchRow>`SELECT * FROM provider_usage_cap_latches`.pipe(
          Effect.mapError(
            (cause) => new UsageCapError({ detail: "Could not read account usage caps.", cause }),
          ),
        );
        const reaches = rows
          .map(latchFromRow)
          .filter((latch) => latch.resetsAt === null || latch.resetsAt > at)
          .map(reachFromLatch);
        return yield* capReachFor(
          { sql, providers, localEnvironmentId },
          reaches,
          threadId,
          instanceId,
        );
      }),
    });
  }),
);

export class UsageCapEnforcement extends Context.Service<
  UsageCapEnforcement,
  {
    /** Reconciles reports, persists crossings, and stops matching local sessions. */
    readonly evaluate: () => Effect.Effect<readonly UsageCapReach[], UsageCapError>;
    /** Null means this thread is eligible. A reach carries the durable stop reason. */
    readonly check: (
      threadId: ThreadId,
      targetInstanceId?: ProviderInstanceId,
    ) => Effect.Effect<UsageCapReach | null, UsageCapError>;
    readonly start: () => Effect.Effect<void, UsageCapError, Scope.Scope>;
  }
>()("t3/allocation/UsageCapEnforcement") {}

const make = Effect.gen(function* () {
  const allocation = yield* Allocation.ProviderAllocation;
  const providers = yield* ProviderRegistry;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const workers = yield* WorkerService.WorkerService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const localEnvironmentId = yield* environment.getEnvironmentId;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const failure = (detail: string, cause?: unknown) =>
    new UsageCapError({ detail, ...(cause === undefined ? {} : { cause }) });
  const latches = sql<LatchRow>`SELECT * FROM provider_usage_cap_latches`.pipe(
    Effect.map((rows) => rows.map(latchFromRow)),
    Effect.mapError((cause) => failure("Could not read account usage caps.", cause)),
  );
  const persist = (next: readonly UsageCapLatch[]) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM provider_usage_cap_latches`;
          for (const latch of next)
            yield* sql`INSERT INTO provider_usage_cap_latches
              (account_key, driver, window_id, cycle_key, used_percent,
               threshold_percent, checked_at, resets_at, enforced_at,
               stop_workers, stop_masters)
              VALUES (${latch.accountKey}, ${latch.driver}, ${latch.windowId},
                ${latch.cycleKey}, ${latch.usedPercent}, ${latch.thresholdPercent},
                ${latch.checkedAt}, ${latch.resetsAt}, ${latch.enforcedAt},
                ${latch.stopWorkers ? 1 : 0}, ${latch.stopMasters ? 1 : 0})`;
        }),
      )
      .pipe(Effect.mapError((cause) => failure("Could not save account usage caps.", cause)));

  const reconcile = Effect.fn("UsageCapEnforcement.reconcile")(function* () {
    const at = yield* now;
    const response = yield* allocation
      .execute({ _tag: "caps" })
      .pipe(Effect.mapError((cause) => failure("Usage-cap settings are unavailable.", cause)));
    const policy = response.policy;
    if (!policy) return yield* failure("Usage-cap settings are unavailable.");
    const existing = yield* latches;
    const caps = policy.accountCaps ?? [];
    if (!caps.length) {
      if (existing.length) yield* persist([]);
      return { at, reaches: [] };
    }
    const providerRows = yield* providers.getProviders;
    const accounts = allocationInventory({
      environmentId: localEnvironmentId,
      at,
      providers: providerRows,
      threads: [],
      measurements: NO_MEASUREMENTS,
    }).accounts;
    const next: UsageCapLatch[] = [];
    const reaches: UsageCapReach[] = [];
    for (const cap of caps) {
      const members = accounts.filter((account) => allocationPreferenceKey(account) === cap.key);
      const prior = existing.find((latch) => latch.accountKey === cap.key);
      if (!members.length) {
        if (!prior) continue;
        const retained = readUsageCapLatch({
          latch: prior,
          accounts: [],
          cap,
          at,
          maxReadingAgeMinutes: policy.maxReadingAgeMinutes,
        });
        if (!retained) continue;
        next.push({
          ...prior,
          thresholdPercent: retained.capPercent,
          stopWorkers: cap.stopWorkers,
          stopMasters: cap.stopMasters,
        });
        reaches.push(retained);
        continue;
      }
      const driver = members[0]!.driver;
      const result = reconcileUsageCap({
        accounts,
        accountKey: cap.key,
        driver,
        cap,
        latch: prior,
        at,
        maxReadingAgeMinutes: policy.maxReadingAgeMinutes,
      });
      if (result.latch) next.push(result.latch);
      if (result.reach) reaches.push(result.reach);
    }
    if (
      next.length !== existing.length ||
      next.some((latch) => !existing.some((value) => sameLatch(latch, value)))
    )
      yield* persist(next);
    return {
      at,
      reaches,
    };
  });

  const stopLocalSessions = Effect.fn("UsageCapEnforcement.stopLocalSessions")(function* (input: {
    readonly at: string;
    readonly reaches: readonly UsageCapReach[];
  }) {
    if (!input.reaches.length) return;
    const shell = yield* threads
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => failure("Could not inspect local sessions.", cause)));
    const workerRows = yield* sql<{
      thread_id: string;
      owner_id: string;
    }>`SELECT thread_id, owner_id FROM custom_workers`.pipe(
      Effect.mapError((cause) => failure("Could not inspect managed workers.", cause)),
    );
    const owners = new Set(workerRows.map((worker) => worker.owner_id));
    const workerIds = new Set(workerRows.map((worker) => worker.thread_id));
    const accountByInstance = new Map(
      (yield* providers.getProviders).map((provider) => [
        provider.instanceId,
        allocationPreferenceKey({
          driver: provider.driver,
          accountKey: allocationIdentity(provider),
          environmentId: localEnvironmentId,
          instanceId: provider.instanceId,
        }),
      ]),
    );
    const reachByAccount = new Map(input.reaches.map((reach) => [reach.accountKey, reach]));
    for (const thread of shell.threads) {
      const accountKey = accountByInstance.get(thread.providerInstanceId);
      const reach = accountKey === undefined ? undefined : reachByAccount.get(accountKey);
      if (!reach) continue;
      const stopsAsMaster = owners.has(thread.id) && reach.stopMasters;
      const stopsAsWorker = workerIds.has(thread.id) && reach.stopWorkers;
      if (!stopsAsMaster && !stopsAsWorker) continue;
      const detail = usageCapDetail(reach);
      const suffix = `${reach.latchId}:${reach.enforcedAt}:${thread.id}`;
      if (stopsAsWorker)
        yield* workers
          .notifyUsageCap(thread.id, { requestId: `${CAP_NOTIFICATION_PREFIX}${suffix}`, detail })
          .pipe(
            Effect.mapError((cause) =>
              failure("Could not notify the worker's master about the usage cap.", cause),
            ),
          );
      if (thread.activeRunId !== null)
        yield* threads
          .interruptThread({
            projectId: thread.projectId,
            threadId: thread.id,
            runId: thread.activeRunId,
            commandId: CommandId.make(
              `${CAP_NOTIFICATION_PREFIX}${suffix}:stop:${thread.activeRunId}`,
            ),
            reason: `Account usage cap reached. ${detail}`,
          })
          .pipe(
            Effect.mapError((cause) =>
              failure("Could not stop the session stopped by its account usage cap.", cause),
            ),
          );
    }
  });

  const evaluateUnlocked = Effect.fn("UsageCapEnforcement.evaluate")(function* () {
    const result = yield* reconcile();
    yield* stopLocalSessions(result);
    return result.reaches;
  });
  const evaluate = () => lock.withPermit(evaluateUnlocked());

  const check = Effect.fn("UsageCapEnforcement.check")(function* (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ) {
    const reaches = yield* evaluate().pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Using durable account caps while policy is unavailable", {
            detail: cause.detail,
          });
          const at = yield* now;
          return (yield* latches)
            .filter((latch) => latch.resetsAt === null || latch.resetsAt > at)
            .map(reachFromLatch);
        }),
      ),
    );
    const instanceId =
      targetInstanceId ??
      (yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => failure("Could not inspect the thread.", cause))))
        ?.providerInstanceId;
    if (instanceId === undefined) return null;
    return yield* capReachFor(
      { sql, providers, localEnvironmentId },
      reaches,
      threadId,
      instanceId,
    );
  });

  const start = Effect.fn("UsageCapEnforcement.start")(function* () {
    const logFailure = (cause: UsageCapError) =>
      Effect.logWarning("Account usage cap enforcement failed", { detail: cause.detail });
    yield* evaluate().pipe(Effect.catch(logFailure));
    yield* providers.streamChanges.pipe(
      Stream.runForEach(() => evaluate().pipe(Effect.catch(logFailure))),
      Effect.forkScoped,
    );
    yield* evaluate().pipe(
      Effect.catch(logFailure),
      Effect.repeat(Schedule.spaced(CHECK_INTERVAL)),
      Effect.asVoid,
      Effect.forkScoped,
    );
  });

  return UsageCapEnforcement.of({ evaluate, check, start });
});

export const layer = Layer.effect(UsageCapEnforcement, make);
