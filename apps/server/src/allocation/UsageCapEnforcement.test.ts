import { expect, it } from "@effect/vitest";
import {
  allocationPreferenceKey,
  AllocationError,
  defaultAllocationPolicy,
  EnvironmentId,
  OrchestrationThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  TurnId,
  type AllocationPolicy,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkerControl from "../orchestration/WorkerControls.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as Allocation from "./ProviderAllocation.ts";
import * as UsageCaps from "./UsageCapEnforcement.ts";
import { allocationIdentity } from "./inventory.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);

type HarnessState = {
  providers: ServerProvider[];
  threads: ReturnType<typeof thread>[];
  policy: AllocationPolicy;
  policyUnavailable: boolean;
  commands: OrchestrationCommand[];
  notifications: string[];
};

const provider = (
  instanceId: string,
  email: string,
  checkedAt: string,
  resetsAt: string,
  fiveHourUsedPercent = 20,
) =>
  decodeProvider({
    instanceId,
    driver: "claudeAgent",
    displayName: instanceId,
    enabled: true,
    installed: true,
    availability: "available",
    version: null,
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt,
    models: [{ slug: "claude", name: "Claude", isCustom: false, capabilities: null }],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 80,
          resetsAt,
          windowDurationMins: 10080,
        },
        {
          id: "five_hour",
          kind: "session",
          label: "5-hour",
          usedPercent: fiveHourUsedPercent,
          resetsAt,
          windowDurationMins: 300,
        },
      ],
    },
  });

const thread = (id: string, instanceId: string, at: string) =>
  decodeThread({
    id,
    projectId: "project",
    title: id,
    modelSelection: { instanceId, model: "claude", options: [] },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    session: {
      threadId: id,
      status: "running",
      providerName: "claudeAgent",
      providerInstanceId: instanceId,
      activeTurnId: "turn",
      lastError: null,
      updatedAt: at,
    },
  });

const makeState = (input: {
  readonly checkedAt: string;
  readonly resetsAt: string;
  readonly weeklyPercent?: number | null;
  readonly fiveHourPercent?: number | null;
  readonly fiveHourUsedPercent?: number;
  readonly stopWorkers?: boolean;
  readonly stopMasters?: boolean;
}): HarnessState => {
  const selectedProvider = provider(
    "claude-a",
    "same@example.test",
    input.checkedAt,
    input.resetsAt,
    input.fiveHourUsedPercent,
  );
  const otherProvider = provider("claude-b", "other@example.test", input.checkedAt, input.resetsAt);
  const identity = allocationIdentity(selectedProvider)!;
  const accountKey = allocationPreferenceKey({
    environmentId: "host-a",
    instanceId: selectedProvider.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    accountKey: identity,
  });
  return {
    providers: [selectedProvider, otherProvider],
    threads: [
      thread("master", "claude-a", input.checkedAt),
      thread("worker", "claude-a", input.checkedAt),
      thread("human", "claude-a", input.checkedAt),
      thread("other", "claude-b", input.checkedAt),
    ],
    policy: {
      ...defaultAllocationPolicy,
      accountCaps: [
        {
          key: accountKey,
          weeklyPercent: input.weeklyPercent === undefined ? 80 : input.weeklyPercent,
          fiveHourPercent: input.fiveHourPercent ?? null,
          stopWorkers: input.stopWorkers ?? true,
          stopMasters: input.stopMasters ?? false,
        },
      ],
    },
    policyUnavailable: false,
    commands: [],
    notifications: [],
  };
};

const makeHarness = (state: HarnessState, input: { readonly checkedAt: string }) =>
  Layer.unwrap(
    Effect.sync(() => {
      const db = NodeSqliteClient.layer({ filename: ":memory:" });
      const readyDb = Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE provider_usage_cap_latches (
            account_key TEXT NOT NULL,
            driver TEXT NOT NULL,
            window_id TEXT NOT NULL,
            cycle_key TEXT NOT NULL,
            used_percent REAL NOT NULL,
            threshold_percent REAL NOT NULL,
            checked_at TEXT NOT NULL,
            resets_at TEXT,
            enforced_at TEXT NOT NULL,
            stop_workers INTEGER NOT NULL,
            stop_masters INTEGER NOT NULL,
            PRIMARY KEY (account_key, window_id)
          )`;
          yield* sql`CREATE TABLE custom_workers (
            thread_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL
          )`;
          yield* sql`CREATE TABLE custom_worker_jobs (
            id TEXT PRIMARY KEY,
            target_id TEXT NOT NULL,
            kind TEXT NOT NULL
          )`;
          yield* sql`INSERT INTO custom_workers (thread_id, owner_id)
            VALUES ('worker', 'master')`;
        }),
      ).pipe(Layer.provideMerge(db));
      const allocation = Layer.mock(Allocation.ProviderAllocation)({
        execute: () =>
          state.policyUnavailable
            ? Effect.fail(
                new AllocationError({
                  code: "unavailable",
                  detail: "Allocation policy is unavailable.",
                }),
              )
            : Effect.succeed({ policy: state.policy }),
      });
      const providers = Layer.mock(ProviderRegistry)({
        getProviders: Effect.suspend(() => Effect.succeed(state.providers)),
      });
      const providerService = Layer.mock(ProviderService)({
        streamEvents: Stream.empty,
      });
      const projection = Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: state.threads,
            updatedAt: input.checkedAt,
          }),
        getThreadShellById: (id) =>
          Effect.succeed(Option.fromNullishOr(state.threads.find((value) => value.id === id))),
      });
      const engine = Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            if (!state.commands.some((value) => value.commandId === command.commandId))
              state.commands.push(command);
            return { sequence: state.commands.length };
          }),
      });
      const workers = Layer.mock(WorkerControl.WorkerControls)({
        notifyUsageCap: (_, notice) =>
          Effect.sync(() => {
            if (state.notifications.includes(notice.requestId)) return false;
            state.notifications.push(notice.requestId);
            return true;
          }),
      });
      const environment = Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("host-a")),
      });
      return UsageCaps.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            readyDb,
            allocation,
            providers,
            providerService,
            projection,
            engine,
            workers,
            environment,
          ),
        ),
      );
    }),
  );

it.effect(
  "stops the worker once, stops a matching master when enabled, and isolates other accounts",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        yield* enforcement.evaluate();
        expect(yield* enforcement.check(ThreadId.make("master"))).toBeNull();
        expect(yield* enforcement.check(ThreadId.make("human"))).toBeNull();
        expect(yield* enforcement.check(ThreadId.make("worker"))).not.toBeNull();
        yield* enforcement.evaluate();
        expect(
          state.commands.flatMap((command) =>
            command.type === "thread.session.stop" ? [command.threadId] : [],
          ),
        ).toEqual(["worker"]);
        expect(state.notifications).toHaveLength(1);

        state.policy = {
          ...state.policy,
          accountCaps: state.policy.accountCaps?.map((value) => ({
            ...value,
            stopMasters: true,
          })),
        };
        yield* enforcement.evaluate();
        expect(yield* enforcement.check(ThreadId.make("master"))).not.toBeNull();
        yield* enforcement.evaluate();
        expect(
          state.commands.flatMap((command) =>
            command.type === "thread.session.stop" ? [command.threadId] : [],
          ),
        ).toEqual(["worker", "master"]);
        expect(
          state.commands.filter((command) => command.type === "thread.activity.append"),
        ).toHaveLength(2);
        expect(state.notifications).toHaveLength(1);
        expect(
          state.commands.some(
            (command) => "threadId" in command && command.threadId === ThreadId.make("other"),
          ),
        ).toBe(false);
        expect(
          state.commands.some(
            (command) => "threadId" in command && command.threadId === ThreadId.make("human"),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("enforces a reached Claude 5-hour cap independently of the weekly cap", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const resetsAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
    const state = makeState({
      checkedAt,
      resetsAt,
      weeklyPercent: 90,
      fiveHourPercent: 80,
      fiveHourUsedPercent: 80,
    });
    const layer = makeHarness(state, { checkedAt });
    yield* Effect.gen(function* () {
      const enforcement = yield* UsageCaps.UsageCapEnforcement;
      yield* enforcement.evaluate();
      expect(yield* enforcement.check(ThreadId.make("worker"))).toMatchObject({
        windowId: "fiveHour",
        usedPercent: 80,
        capPercent: 80,
      });
      expect(
        state.commands.filter(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "provider.usage-cap.stopped",
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("shares a cap across provider aliases of the same login identity", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
    const state = makeState({ checkedAt, resetsAt });
    state.providers = [
      ...state.providers,
      provider("claude-alias", "same@example.test", checkedAt, resetsAt),
    ];
    state.threads = [...state.threads, thread("alias-worker", "claude-alias", checkedAt)];
    const layer = makeHarness(state, { checkedAt });
    yield* Effect.gen(function* () {
      const enforcement = yield* UsageCaps.UsageCapEnforcement;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO custom_workers (thread_id, owner_id)
        VALUES ('alias-worker', 'alias-master'), ('other', 'other-master')`;
      yield* enforcement.evaluate();
      expect(
        state.commands.flatMap((command) =>
          command.type === "thread.session.stop" ? [command.threadId] : [],
        ),
      ).toEqual(["worker", "alias-worker"]);
      expect(state.notifications).toHaveLength(2);
      expect(yield* enforcement.check(ThreadId.make("alias-worker"))).not.toBeNull();
      expect(yield* enforcement.check(ThreadId.make("other"))).toBeNull();
      expect(
        yield* enforcement.check(ThreadId.make("other"), ProviderInstanceId.make("claude-a")),
      ).not.toBeNull();
      expect(
        yield* enforcement.check(ThreadId.make("other"), ProviderInstanceId.make("claude-b")),
      ).toBeNull();
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "keeps a durable cap through a probe failure, blocks queued/automatic admission, and recovers or resets",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        const stops = () =>
          state.commands.flatMap((command) =>
            command.type === "thread.session.stop" ? [command.threadId] : [],
          );
        yield* enforcement.evaluate();
        expect(stops()).toEqual(["worker"]);

        state.providers = state.providers.map((value) =>
          value.instanceId === "claude-a" && value.usageLimits
            ? {
                ...value,
                usageLimits: {
                  checkedAt,
                  windows: [],
                  unavailable: { reason: "probeFailed" },
                },
              }
            : value,
        );
        state.threads = state.threads.map((value) =>
          value.id === "worker" && value.session
            ? {
                ...value,
                session: {
                  ...value.session,
                  activeTurnId: TurnId.make("turn-after-probe-failure"),
                },
              }
            : value,
        );
        yield* enforcement.evaluate();
        expect(stops()).toEqual(["worker", "worker"]);
        expect(yield* enforcement.check(ThreadId.make("worker"))).toMatchObject({
          windowId: "weekly",
          usedPercent: 80,
        });
        expect(state.notifications).toHaveLength(1);

        const recovered = provider("claude-a", "same@example.test", checkedAt, resetsAt);
        state.providers = [
          {
            ...recovered,
            usageLimits: {
              ...recovered.usageLimits!,
              windows: recovered.usageLimits!.windows.map((window) =>
                window.kind === "weekly" ? { ...window, usedPercent: 10 } : window,
              ),
            },
          },
          state.providers[1]!,
        ];
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();

        state.providers = makeState({ checkedAt, resetsAt }).providers;
        expect(yield* enforcement.check(ThreadId.make("worker"))).not.toBeNull();
        yield* TestClock.adjust("2 days");
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["unsupported", "unverified"] as const)(
  "clears an established cap when provenance becomes %s",
  (reason) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        const sql = yield* SqlClient.SqlClient;
        yield* enforcement.evaluate();
        expect(
          state.commands.filter((command) => command.type === "thread.session.stop"),
        ).toHaveLength(1);

        state.providers = state.providers.map((value) =>
          value.instanceId === "claude-a" && value.usageLimits
            ? {
                ...value,
                usageLimits: {
                  checkedAt,
                  windows: [],
                  unavailable: { reason },
                },
              }
            : value,
        );
        yield* enforcement.evaluate();
        expect(
          state.commands.filter((command) => command.type === "thread.session.stop"),
        ).toHaveLength(1);
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        expect(state.notifications).toHaveLength(1);
        expect(
          yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM provider_usage_cap_latches
          `,
        ).toEqual([{ count: 0 }]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("does not create a stop from stale telemetry or when the cap is disabled", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
    const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
    const state = makeState({ checkedAt, resetsAt });
    const layer = makeHarness(state, { checkedAt });
    yield* Effect.gen(function* () {
      const enforcement = yield* UsageCaps.UsageCapEnforcement;
      expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
      expect(state.commands).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["unsupported", "unverified", "probeFailed"] as const)(
  "ignores cached subscription windows when quota provenance is %s",
  (reason) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      state.providers = state.providers.map((value) =>
        value.instanceId === "claude-a" && value.usageLimits
          ? {
              ...value,
              usageLimits: {
                ...value.usageLimits,
                unavailable: { reason },
              },
            }
          : value,
      );
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        expect(state.commands).toEqual([]);
        expect(state.notifications).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "clears enforcement when actions are disabled and stops a new session after re-enable",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        const sql = yield* SqlClient.SqlClient;
        const stops = () =>
          state.commands.filter(
            (command) =>
              command.type === "thread.session.stop" &&
              command.threadId === ThreadId.make("worker"),
          );
        yield* enforcement.evaluate();
        expect(stops()).toHaveLength(1);

        state.policy = {
          ...state.policy,
          accountCaps: state.policy.accountCaps?.map((cap) => ({
            ...cap,
            stopWorkers: false,
            stopMasters: false,
          })),
        };
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        expect(
          yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM provider_usage_cap_latches
        `,
        ).toEqual([{ count: 0 }]);

        state.threads = state.threads.map((thread) =>
          thread.id === "worker"
            ? {
                ...thread,
                session: thread.session
                  ? { ...thread.session, activeTurnId: TurnId.make("turn-after-reenable") }
                  : null,
              }
            : thread,
        );
        yield* TestClock.adjust("1 second");
        state.policy = {
          ...state.policy,
          accountCaps: state.policy.accountCaps?.map((cap) => ({
            ...cap,
            stopWorkers: true,
          })),
        };
        expect(yield* enforcement.check(ThreadId.make("worker"))).not.toBeNull();
        yield* enforcement.evaluate();
        expect(stops()).toHaveLength(2);
        expect(state.notifications).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "retains a crossed latch while account telemetry is missing and clears it on reset or disable",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const checkedAt = DateTime.formatIso(now);
      const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
      const state = makeState({ checkedAt, resetsAt });
      const layer = makeHarness(state, { checkedAt });
      yield* Effect.gen(function* () {
        const enforcement = yield* UsageCaps.UsageCapEnforcement;
        const sql = yield* SqlClient.SqlClient;
        yield* enforcement.evaluate();
        const commandCount = state.commands.length;
        state.providers = state.providers.map((value) => ({
          ...value,
          usageLimits: value.usageLimits
            ? { checkedAt: value.usageLimits.checkedAt, windows: [] }
            : undefined,
        }));
        expect(yield* enforcement.check(ThreadId.make("worker"))).not.toBeNull();
        expect(state.commands).toHaveLength(commandCount);

        state.policy = {
          ...state.policy,
          accountCaps: state.policy.accountCaps?.map((value) => ({
            ...value,
            stopWorkers: false,
            stopMasters: false,
          })),
        };
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        expect(
          yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM provider_usage_cap_latches
          `,
        ).toEqual([{ count: 0 }]);

        state.policy = {
          ...state.policy,
          accountCaps: makeState({ checkedAt, resetsAt }).policy.accountCaps,
        };
        state.providers = makeState({ checkedAt, resetsAt }).providers;
        expect(yield* enforcement.check(ThreadId.make("worker"))).not.toBeNull();
        yield* TestClock.adjust("2 days");
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        state.policy = { ...state.policy, accountCaps: [] };
        expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
        expect(
          yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM provider_usage_cap_latches
          `,
        ).toEqual([{ count: 0 }]);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("uses the last durable latch when policy reconciliation is temporarily unavailable", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const resetsAt = DateTime.formatIso(DateTime.add(now, { days: 1 }));
    const state = makeState({ checkedAt, resetsAt });
    const layer = makeHarness(state, { checkedAt });
    yield* Effect.gen(function* () {
      const enforcement = yield* UsageCaps.UsageCapEnforcement;
      yield* enforcement.evaluate();
      const commandCount = state.commands.length;
      state.policyUnavailable = true;
      expect(yield* enforcement.check(ThreadId.make("worker"))).toMatchObject({
        accountKey: expect.any(String),
        stopWorkers: true,
        stopMasters: false,
      });
      expect(yield* enforcement.check(ThreadId.make("other"))).toBeNull();
      expect(state.commands).toHaveLength(commandCount);
      state.providers = state.providers.map((provider) =>
        provider.instanceId === "claude-a" && provider.usageLimits
          ? {
              ...provider,
              usageLimits: {
                ...provider.usageLimits,
                unavailable: { reason: "unsupported" },
              },
            }
          : provider,
      );
      expect(yield* enforcement.check(ThreadId.make("worker"))).toBeNull();
    }).pipe(Effect.provide(layer));
  }),
);
