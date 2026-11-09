import {
  allocationPreferenceKey,
  type ProviderInstanceId,
  ThreadId,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { allocationIdentity, allocationInventory } from "./inventory.ts";
import * as Allocation from "./ProviderAllocation.ts";
import {
  readUsageCapLatch,
  reconcileUsageCap,
  usageCapLatchId,
  type UsageCapLatch,
  type UsageCapReach,
} from "./usageCaps.ts";

const CHECK_INTERVAL = "15 seconds";
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

export class UsageCapEnforcement extends Context.Service<
  UsageCapEnforcement,
  {
    /**
     * Reconciles reports and persists crossings. A reached cap closes the account to new turns
     * (`check`) and new worker assignments; turns already running finish.
     */
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
  const providerService = yield* ProviderService;
  const projection = yield* ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const localEnvironmentId = yield* environment.getEnvironmentId.pipe(
    Effect.mapError((cause) => failure("Could not read the local environment.", cause)),
  );
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((value) => DateTime.formatIso(DateTime.makeUnsafe(value))),
  );
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
    const providerRows = yield* providers.getProviders.pipe(
      Effect.mapError((cause) => failure("Could not inspect local providers.", cause)),
    );
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

  const evaluateUnlocked = Effect.fn("UsageCapEnforcement.evaluate")(function* () {
    return (yield* reconcile()).reaches;
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
    if (!reaches.length) return null;
    const thread = yield* projection
      .getThreadShellById(threadId)
      .pipe(Effect.mapError((cause) => failure("Could not inspect the thread.", cause)));
    if (thread._tag === "None") return null;
    const instanceId =
      targetInstanceId ??
      thread.value.session?.providerInstanceId ??
      thread.value.modelSelection.instanceId;
    const provider = (yield* providers.getProviders.pipe(
      Effect.mapError((cause) => failure("Could not inspect provider identity.", cause)),
    )).find((candidate) => candidate.instanceId === instanceId);
    if (!provider) return null;
    // A probe failure or missing window cannot strengthen a cap, but it must
    // not release a crossing that was established from verified telemetry.
    if (
      provider.usageLimits?.unavailable?.reason === "unsupported" ||
      provider.usageLimits?.unavailable?.reason === "unverified"
    )
      return null;
    const key = allocationPreferenceKey({
      driver: provider.driver,
      accountKey: allocationIdentity(provider),
      environmentId: localEnvironmentId,
      instanceId: provider.instanceId,
    });
    const reach = reaches.find((candidate) => candidate.accountKey === key);
    if (!reach) return null;
    const roles = (yield* sql<{ is_worker: number; is_master: number }>`SELECT
        EXISTS(SELECT 1 FROM custom_workers WHERE thread_id = ${threadId}) AS is_worker,
        EXISTS(SELECT 1 FROM custom_workers WHERE owner_id = ${threadId}) AS is_master`.pipe(
      Effect.mapError((cause) =>
        failure("Could not inspect the thread's worker or master role.", cause),
      ),
    ))[0];
    const stopsWorker = roles?.is_worker === 1 && reach.stopWorkers;
    const stopsMaster = roles?.is_master === 1 && reach.stopMasters;
    return stopsWorker || stopsMaster ? reach : null;
  });

  const start = Effect.fn("UsageCapEnforcement.start")(function* () {
    const logFailure = (cause: UsageCapError) =>
      Effect.logWarning("Account usage cap enforcement failed", { detail: cause.detail });
    yield* evaluate().pipe(Effect.catch(logFailure));
    yield* providerService.streamEvents.pipe(
      Stream.filter((event) => event.type === "account.rate-limits.updated"),
      Stream.runForEach(() => evaluate().pipe(Effect.catch(logFailure))),
      Effect.forkScoped,
    );
    yield* evaluate().pipe(
      Effect.catch(logFailure),
      Effect.repeat(Schedule.spaced(CHECK_INTERVAL)),
      Effect.asVoid,
      Effect.forkScoped,
    );
    return yield* Effect.void;
  });

  return UsageCapEnforcement.of({ evaluate, check, start });
});

export const layer = Layer.effect(UsageCapEnforcement, make);
export const liveLayer = layer.pipe(Layer.provide(Allocation.liveLayer));
