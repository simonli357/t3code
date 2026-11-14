import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  type IdleCompactionSettings,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import * as ProviderAllocation from "../allocation/ProviderAllocation.ts";
import * as UsageCapEnforcement from "../allocation/UsageCapEnforcement.ts";
import type { UsageCapReach } from "../allocation/usageCaps.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  IdleCompactionReactor,
  idleCompactionSkip,
  idleCompactionStartMs,
  layer as idleCompactionLayer,
} from "./IdleCompactionReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const claude = ProviderInstanceId.make("claudeAgent");
const defaults: IdleCompactionSettings = DEFAULT_SERVER_SETTINGS.idleCompaction;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Session = NonNullable<OrchestrationThreadShell["session"]>;

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    threadId: ThreadId.make(id),
    status: "ready",
    providerName: "claudeAgent",
    providerInstanceId: claude,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: iso(T0),
    ...overrides,
  };
}

function shell(id: string, overrides: Partial<OrchestrationThreadShell> = {}) {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Thread",
    modelSelection: createModelSelection(claude, "claude-opus-5-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: {
      turnId: TurnId.make(`${id}-turn`),
      state: "completed",
      requestedAt: iso(T0),
      startedAt: iso(T0),
      completedAt: iso(T0),
      assistantMessageId: null,
    },
    createdAt: iso(T0),
    updatedAt: iso(T0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: session(id),
    latestUserMessageAt: iso(T0),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    organization: {
      owner: null,
      workers: [],
      revision: 0,
      assignmentState: null,
      reportOutcome: null,
      directInputAt: null,
    },
    ...overrides,
  } satisfies OrchestrationThreadShell;
}

const usageCap: UsageCapReach = {
  accountKey: "capped-account",
  driver: "claudeAgent",
  windowId: "weekly",
  windowLabel: "Weekly",
  capPercent: 80,
  usedPercent: 84,
  checkedAt: "2026-01-01T00:00:00.000Z",
  resetsAt: "2026-01-02T00:00:00.000Z",
  cycleKey: "2026-01-02T00:00:00.000Z",
  latchId: "cap-latch",
  enforcedAt: "2026-01-01T00:00:00.000Z",
  stopWorkers: true,
  stopMasters: true,
};

const worker = (reportOutcome: "done" | "blocked" | null) => ({
  owner: { environmentId: null, threadId: ThreadId.make("master") },
  workers: [],
  revision: 0,
  assignmentState: "completed",
  reportOutcome,
  directInputAt: null,
});

describe("idle compaction timing", () => {
  const reading = { usedTokens: 335_000, expiresAtMs: T0 + HOUR, readAtMs: T0 + 5_000 };

  it("starts the lead time before the request's cache expires", () => {
    assert.equal(idleCompactionStartMs(reading, defaults), T0 + 58 * MINUTE);
    assert.equal(
      idleCompactionStartMs({ ...reading, expiresAtMs: T0 + 5 * MINUTE }, defaults),
      T0 + 3 * MINUTE,
    );
  });

  it("never starts below the threshold, when disabled, or with a lead as long as the cache", () => {
    assert.isNull(idleCompactionStartMs({ ...reading, usedTokens: 199_999 }, defaults));
    assert.equal(
      idleCompactionStartMs({ ...reading, usedTokens: 200_000 }, defaults),
      T0 + 58 * MINUTE,
    );
    assert.isNull(idleCompactionStartMs(reading, { ...defaults, enabled: false }));
    assert.isNull(idleCompactionStartMs({ ...reading, expiresAtMs: T0 + 2 * MINUTE }, defaults));
  });
});

describe("idle compaction skip rules", () => {
  it.each([
    ["archived", shell("t", { archivedAt: iso(T0) }), "archived"],
    ["settled", shell("t", { settledAt: iso(T0) }), "settled"],
    ["settled by hand", shell("t", { settledOverride: "settled" }), "settled"],
    ["snoozed", shell("t", { snoozedUntil: iso(T0 + HOUR) }), "snoozed"],
    ["without a session", shell("t", { session: null }), "not a Claude session"],
    [
      "on another provider",
      shell("t", { session: session("t", { providerName: "codex" }) }),
      "not a Claude session",
    ],
    [
      "switching accounts",
      shell("t", {
        modelSelection: createModelSelection(ProviderInstanceId.make("claude_2"), "m"),
      }),
      "switching accounts",
    ],
    ["running", shell("t", { session: session("t", { status: "running" }) }), "turn running"],
    ["starting", shell("t", { session: session("t", { status: "starting" }) }), "turn running"],
    [
      "with an active turn",
      shell("t", { session: session("t", { activeTurnId: TurnId.make("x") }) }),
      "turn running",
    ],
    ["waiting on an approval", shell("t", { hasPendingApprovals: true }), "waiting on the user"],
    ["waiting on input", shell("t", { hasPendingUserInput: true }), "waiting on the user"],
    ["with background work", shell("t", { backgroundLiveness: "monitoring" }), "background work"],
    [
      "a worker that reported done",
      shell("t", { organization: worker("done") }),
      "worker reported done",
    ],
  ])("skips a thread %s", (_name, thread, reason) => {
    assert.equal(idleCompactionSkip(thread), reason);
  });

  it.each([
    ["a human session", shell("t")],
    [
      "a master",
      shell("t", {
        organization: {
          owner: null,
          workers: [{ environmentId: null, threadId: ThreadId.make("w") }],
          revision: 0,
          assignmentState: null,
          reportOutcome: null,
          directInputAt: null,
        },
      }),
    ],
    ["a worker that reported blocked", shell("t", { organization: worker("blocked") })],
    ["a worker with an unreported assignment", shell("t", { organization: worker(null) })],
  ])("keeps %s eligible", (_name, thread) => {
    assert.isNull(idleCompactionSkip(thread));
  });
});

/** A reactor over an in-memory database, with the engine, settings and providers faked. */
const makeHarness = (initial: Partial<IdleCompactionSettings> = {}) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const settingsChanges = yield* PubSub.unbounded<ServerSettingsValue>();
    const settings = yield* Ref.make<ServerSettingsValue>({
      ...DEFAULT_SERVER_SETTINGS,
      idleCompaction: { ...defaults, ...initial },
    });
    const threads = new Map<string, OrchestrationThreadShell>();
    const compacted: string[] = [];
    const drained = new Set<string>();
    const capped = new Set<string>();
    const services = yield* Layer.build(
      idleCompactionLayer.pipe(
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (id) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settings),
            subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
              Effect.map(Stream.fromSubscription),
            ),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderCommandReactor)({
            compactIdleThread: (threadId) => Effect.sync(() => void compacted.push(threadId)),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderAllocation.ProviderAllocation)({
            limited: (selection) => Effect.succeed(drained.has(selection.instanceId)),
          }),
        ),
        Layer.provide(
          Layer.mock(UsageCapEnforcement.UsageCapEnforcement)({
            check: (threadId) => Effect.succeed(capped.has(threadId) ? usageCap : null),
          }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    );
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(services));
    const reactor = yield* IdleCompactionReactor.pipe(Effect.provide(services));
    let sequence = 0;

    /** Stores a context reading and, when live, announces it the way the projection does. */
    const addReading = (
      thread: OrchestrationThreadShell,
      input: { usedTokens: number; readAtMs: number; expiresAtMs?: number },
      options: { live?: boolean; metadata?: OrchestrationEvent["metadata"] } = {},
    ) =>
      Effect.gen(function* () {
        threads.set(thread.id, thread);
        sequence += 1;
        const payload = {
          usedTokens: input.usedTokens,
          ...(input.expiresAtMs === undefined
            ? {}
            : { promptCacheExpiresAt: iso(input.expiresAtMs) }),
        };
        const activity = {
          id: EventId.make(`reading-${sequence}`),
          tone: "info" as const,
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: null,
          createdAt: iso(input.readAtMs),
        };
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${activity.id}, ${thread.id}, NULL, 'info', ${activity.kind}, ${activity.summary},
            ${encodeJson(payload)}, ${activity.createdAt})`;
        if (options.live === false) return;
        yield* PubSub.publish(events, {
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: activity.createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: options.metadata ?? {},
          type: "thread.activity-appended",
          payload: { threadId: thread.id, activity },
        });
      });

    const updateSettings = (next: Partial<IdleCompactionSettings>) =>
      Ref.updateAndGet(settings, (current) => ({
        ...current,
        idleCompaction: { ...current.idleCompaction, ...next },
      })).pipe(Effect.flatMap((current) => PubSub.publish(settingsChanges, current)));

    const start = Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* reactor.start().pipe(Scope.provide(scope));
      yield* Effect.yieldNow;
      return scope;
    });
    /** Moves the clock to `ms` and lets the woken timers run. */
    const at = (ms: number) =>
      TestClock.setTime(ms).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(Effect.sleep(0)),
        Effect.andThen(Effect.yieldNow),
      );
    return { sql, start, at, addReading, updateSettings, threads, compacted, drained, capped };
  });

describe("IdleCompactionReactor", () => {
  it.effect("compacts an idle thread once, shortly before its cache expires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const harness = yield* makeHarness();
      yield* harness.start;
      const thread = shell("idle");
      yield* harness.addReading(thread, {
        usedTokens: 335_000,
        readAtMs: T0 + 5_000,
        expiresAtMs: T0 + HOUR,
      });
      yield* harness.at(T0 + 58 * MINUTE - 1);
      assert.deepEqual(harness.compacted, []);
      yield* harness.at(T0 + 58 * MINUTE);
      assert.deepEqual(harness.compacted, ["idle"]);
      yield* harness.at(T0 + 2 * HOUR);
      assert.deepEqual(harness.compacted, ["idle"]);
    }).pipe(Effect.scoped),
  );

  it.effect("re-arms on each request and cancels when the context drops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const harness = yield* makeHarness();
      yield* harness.start;
      const busy = shell("busy");
      yield* harness.addReading(busy, {
        usedTokens: 300_000,
        readAtMs: T0,
        expiresAtMs: T0 + HOUR,
      });
      yield* harness.at(T0 + 30 * MINUTE);
      yield* harness.addReading(busy, {
        usedTokens: 310_000,
        readAtMs: T0 + 30 * MINUTE,
        expiresAtMs: T0 + 90 * MINUTE,
      });
      yield* harness.at(T0 + 60 * MINUTE);
      assert.deepEqual(harness.compacted, []);
      yield* harness.at(T0 + 88 * MINUTE);
      assert.deepEqual(harness.compacted, ["busy"]);

      // A manual compaction leaves a small context, so nothing is armed for it.
      const small = shell("small");
      yield* harness.addReading(small, {
        usedTokens: 300_000,
        readAtMs: T0 + 88 * MINUTE,
        expiresAtMs: T0 + 148 * MINUTE,
      });
      yield* harness.addReading(small, {
        usedTokens: 20_000,
        readAtMs: T0 + 89 * MINUTE,
        expiresAtMs: T0 + 148 * MINUTE,
      });
      // A reading without a cache expiry, such as another provider's, arms nothing either.
      const unknown = shell("unknown");
      yield* harness.addReading(unknown, { usedTokens: 300_000, readAtMs: T0 + 88 * MINUTE });
      yield* harness.at(T0 + 4 * HOUR);
      assert.deepEqual(harness.compacted, ["busy"]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips threads that are busy, parked, moving, queued or on a drained account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const harness = yield* makeHarness();
      yield* harness.start;
      const reading = { usedTokens: 400_000, readAtMs: T0, expiresAtMs: T0 + HOUR };
      const blockers: ReadonlyArray<
        [OrchestrationThreadShell, Effect.Effect<unknown, SqlError.SqlError>]
      > = [
        [shell("control"), Effect.void],
        [shell("settled", { settledAt: iso(T0) }), Effect.void],
        [shell("done-worker", { organization: worker("done") }), Effect.void],
        [
          shell("pending-turn"),
          harness.sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state,
            requested_at, checkpoint_files_json) VALUES ('pending-turn', NULL, 'm', 'pending', ${iso(T0)}, '[]')`,
        ],
        [
          shell("queued-work"),
          harness.sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
            VALUES ('job', 'queued-work', 'queued-work', 'work', 'next', ${iso(T0)})`,
        ],
        [
          shell("moving"),
          harness.sql`INSERT INTO custom_session_moves (id, thread_id, target_thread_id, direction,
            peer_environment_id, state, locked, input_json, created_at, updated_at)
            VALUES ('move', 'moving', 'moving', 'out', 'peer', 'copying', 1, '{}', ${iso(T0)}, ${iso(T0)})`,
        ],
        [
          shell("handoff"),
          harness.sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json, state)
            VALUES ('successor', 'handoff', '{}', 'queued')`,
        ],
        [
          shell("renewing"),
          harness.sql`INSERT INTO custom_session_renewals (thread_id, checkpoint_id, state)
            VALUES ('renewing', 'checkpoint', 'checkpoint')`,
        ],
        [
          shell("compacted"),
          harness.sql`INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
            VALUES ('manual', 'compacted', NULL, 'info', 'context-compaction', 'Context compacted',
              '{}', ${iso(T0 + MINUTE)})`,
        ],
        [
          shell("drained", {
            modelSelection: createModelSelection(ProviderInstanceId.make("drained"), "m"),
            session: session("drained", { providerInstanceId: ProviderInstanceId.make("drained") }),
          }),
          Effect.sync(() => harness.drained.add("drained")),
        ],
        [shell("capped"), Effect.sync(() => harness.capped.add("capped"))],
      ];
      for (const [thread, block] of blockers) {
        yield* block;
        yield* harness.addReading(thread, reading);
      }
      yield* harness.at(T0 + 59 * MINUTE);
      assert.deepEqual(harness.compacted, ["control"]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores readings imported by a session move", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const harness = yield* makeHarness();
      yield* harness.start;
      yield* harness.addReading(
        shell("imported"),
        { usedTokens: 300_000, readAtMs: T0, expiresAtMs: T0 + HOUR },
        { metadata: { sessionMoveImport: true } },
      );
      yield* harness.at(T0 + 59 * MINUTE);
      assert.deepEqual(harness.compacted, []);
    }).pipe(Effect.scoped),
  );

  it.effect("rebuilds timers after a restart without compacting early or twice", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      const harness = yield* makeHarness();
      const reading = { usedTokens: 300_000 };
      // Still ahead of its start: compacts when due.
      yield* harness.addReading(
        shell("ahead"),
        { ...reading, readAtMs: T0 + 20 * MINUTE, expiresAtMs: T0 + 80 * MINUTE },
        { live: false },
      );
      // Its start passed while the server was down, so it may already have compacted.
      yield* harness.addReading(
        shell("passed"),
        { ...reading, readAtMs: T0, expiresAtMs: T0 + 31 * MINUTE },
        { live: false },
      );
      // Its cache already expired.
      yield* harness.addReading(
        shell("expired"),
        { ...reading, readAtMs: T0, expiresAtMs: T0 + 20 * MINUTE },
        { live: false },
      );
      // Compacted before the restart, with the cache still warm.
      yield* harness.addReading(
        shell("done"),
        { ...reading, readAtMs: T0 + 25 * MINUTE, expiresAtMs: T0 + 85 * MINUTE },
        { live: false },
      );
      yield* harness.sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        VALUES ('idle', 'done', NULL, 'info', 'context-compaction', 'Compacted while idle', '{}',
          ${iso(T0 + 28 * MINUTE)})`;
      yield* harness.start;
      yield* harness.at(T0 + 78 * MINUTE - 1);
      assert.deepEqual(harness.compacted, []);
      yield* harness.at(T0 + 78 * MINUTE);
      assert.deepEqual(harness.compacted, ["ahead"]);
      yield* harness.at(T0 + 3 * HOUR);
      assert.deepEqual(harness.compacted, ["ahead"]);
    }).pipe(Effect.scoped),
  );

  it.effect("applies settings changes without a restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const harness = yield* makeHarness({ enabled: false });
      yield* harness.start;
      yield* harness.addReading(shell("a"), {
        usedTokens: 250_000,
        readAtMs: T0,
        expiresAtMs: T0 + HOUR,
      });
      yield* harness.at(T0 + 10 * MINUTE);
      yield* harness.updateSettings({ enabled: true, leadMinutes: 5 });
      yield* harness.at(T0 + 55 * MINUTE - 1);
      assert.deepEqual(harness.compacted, []);
      yield* harness.at(T0 + 55 * MINUTE);
      assert.deepEqual(harness.compacted, ["a"]);

      // Raising the threshold above a thread's context disarms it.
      yield* harness.addReading(shell("b"), {
        usedTokens: 250_000,
        readAtMs: T0 + HOUR,
        expiresAtMs: T0 + 2 * HOUR,
      });
      yield* harness.updateSettings({ contextTokens: 300_000 });
      yield* harness.at(T0 + 3 * HOUR);
      assert.deepEqual(harness.compacted, ["a"]);
    }).pipe(Effect.scoped),
  );
});
