import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  defaultAllocationPolicy,
  allocationPreferenceKey,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type AllocationRequest,
} from "@t3tools/contracts";
import * as Store from "./AllocationStore.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-10-23T12:00:00.000Z";
const request: AllocationRequest = {
  assignmentId: "one",
  environmentId: "a",
  threadId: ThreadId.make("one"),
  driver: ProviderDriverKind.make("codex"),
  model: "astra",
  options: [],
};
const inventory = (environmentId: string): AllocationInventory => ({
  environmentId,
  observedAt: at,
  complete: true,
  notices: [],
  demand: [],
  accounts: [
    {
      environmentId,
      instanceId: ProviderInstanceId.make(environmentId),
      driver: request.driver,
      accountKey: "same-login",
      label: environmentId,
      retainHistory: true,
      available: true,
      unavailableReason: null,
      limitedUntil: null,
      models: [{ slug: "astra", capabilities: null }],
      shortWindow: "known-absent",
      shortWindowAbsentCheckedAt: at,
      resetCredits: null,
      profileSamples: 0,
      profileUncertainty: 1,
      windows: [
        {
          id: "week",
          label: "Week",
          kind: "weekly",
          usedPoints: 80,
          checkedAt: at,
          resetsAt: "2026-10-29T12:00:00.000Z",
          cycleStartedAt: "2026-10-22T12:00:00.000Z",
          durationHours: 168,
          ratePointsPerHour: null,
          samples: 0,
          rateAgeMinutes: null,
        },
      ],
    },
  ],
});
const setup = Effect.gen(function* () {
  const store = yield* Store.AllocationStore;
  yield* store.savePolicy({
    expectedVersion: 0,
    policy: {
      ...defaultAllocationPolicy,
      mode: "automatic",
      coordinatorEnvironmentId: "a",
      codex: { ...defaultAllocationPolicy.codex, burstPoints: 80 },
    },
  });
  return store;
});
const layer = Store.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
// Each test gets its own database and the actual SQL transaction implementation.
const run = <A, E>(effect: Effect.Effect<A, E, Store.AllocationStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer));

it.effect(
  "applies saved preference margins and forecast settings to the next recommendation without restart",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const a = {
          ...inventory("a").accounts[0]!,
          accountKey: "a",
          windows: inventory("a").accounts[0]!.windows.map((w) => ({ ...w, usedPoints: 59 })),
        };
        const b = {
          ...a,
          instanceId: ProviderInstanceId.make("b"),
          accountKey: "b",
          windows: a.windows.map((w) => ({ ...w, usedPoints: 59.5 })),
        };
        let current = yield* store.savePolicy({
          expectedVersion: 1,
          policy: {
            ...defaultAllocationPolicy,
            uncertaintyMultiplier: 1,
            coldLongPointsPerHour: 2,
            codex: {
              ...defaultAllocationPolicy.codex,
              burstPoints: 80,
              dailyPoints: 0,
              reservePoints: 20,
              borrowPoints: 0,
            },
            accountWeights: [
              { key: allocationPreferenceKey(a), weight: 0 },
              { key: allocationPreferenceKey(b), weight: 100 },
            ],
          },
        });
        const hosts = [
          { ...inventory("a"), accounts: [a, b], demand: [] as AllocationInventory["demand"] },
        ];
        const recommend = () =>
          store.allocate({
            at,
            request,
            inventories: hosts,
            authorityAvailable: true,
            reserve: false,
            stableSelection: true,
          });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("b");
        current = yield* store.savePolicy({
          expectedVersion: current.version,
          policy: { ...current, hysteresisPoints: 0 },
        });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("a");
        hosts[0]!.demand = Array.from({ length: 3 }, (_, n) => ({
          environmentId: "a",
          threadId: ThreadId.make(`active-${n}`),
          instanceId: a.instanceId,
          accountKey: a.accountKey,
          model: request.model,
          options: [],
          state: "running",
        }));
        expect((yield* recommend()).decision.selectedInstanceId).toBe("b");
        yield* store.savePolicy({
          expectedVersion: current.version,
          policy: { ...current, coldLongPointsPerHour: 0.1 },
        });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("a");
      }),
    ),
);

it.effect(
  "serializes simultaneous hosts against shared identity and replays duplicate assignments",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const allocate = (r: AllocationRequest) =>
          store.allocate({
            at,
            request: r,
            inventories: [inventory("a"), inventory("b")],
            authorityAvailable: true,
            reserve: true,
          });
        const [one, two] = yield* Effect.all(
          [
            allocate(request),
            allocate({
              ...request,
              assignmentId: "two",
              environmentId: "b",
              threadId: ThreadId.make("two"),
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect([one, two].filter((r) => r.reservation)).toHaveLength(2);
        const winner = one.reservation ? one : two;
        expect(yield* allocate(winner.decision.request)).toEqual(winner);
        const conflict = yield* Effect.exit(
          allocate({ ...winner.decision.request, model: "changed" }),
        );
        expect(Exit.isFailure(conflict)).toBe(true);
        expect(yield* store.reservations).toHaveLength(2);
      }),
    ),
);
it.effect(
  "expires unused capacity but retains ambiguous startup across service reconstruction",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const args = {
          at,
          request,
          inventories: [inventory("a")],
          authorityAvailable: true,
          reserve: true,
        };
        yield* store.allocate(args);
        const life = {
          assignmentId: request.assignmentId,
          environmentId: "a",
          threadId: request.threadId,
          action: "start" as const,
          startIntent: "same-intent",
        };
        yield* store.lifecycle(life, at);
        yield* store.lifecycle(life, at);
        expect(
          Exit.isFailure(
            yield* Effect.exit(store.lifecycle({ ...life, startIntent: "different" }, at)),
          ),
        ).toBe(true);
        const recovered = yield* Effect.gen(function* () {
          return yield* (yield* Store.AllocationStore).reservations;
        }).pipe(Effect.provide(Store.layer));
        expect(recovered[0]?.state).toBe("starting");
        const later = "2026-10-23T12:06:00.000Z";
        const next = { ...request, assignmentId: "next", threadId: ThreadId.make("next") };
        expect(
          (yield* store.allocate({ ...args, at: later, request: next })).reservation,
        ).not.toBeNull();
        yield* store.lifecycle({ ...life, action: "consume" }, later);
        yield* store.lifecycle({ ...life, action: "consume" }, later);
        yield* store.lifecycle({ ...life, action: "release" }, later);
        expect(
          (yield* store.reservations).find((r) => r.assignmentId === request.assignmentId)?.state,
        ).toBe("released");
      }),
    ),
);
it.effect(
  "preview never reserves and legacy observation does not suppress an explicit reservation",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const policy = yield* store.policy;
        yield* store.savePolicy({
          expectedVersion: policy.version,
          policy: { ...policy, mode: "observation" },
        });
        const args = {
          at,
          request,
          inventories: [inventory("a")],
          authorityAvailable: true,
          reserve: false,
        };
        expect((yield* store.allocate(args)).reservation).toBeNull();
        expect(yield* store.history).toHaveLength(1);
        yield* store.allocate({
          ...args,
          previewPolicy: { ...policy, codex: { ...policy.codex, reservePoints: 99 } },
        });
        expect(yield* store.history).toHaveLength(1);
        expect((yield* store.policy).mode).toBe("observation");
        expect(yield* store.reservations).toEqual([]);
        expect((yield* store.allocate({ ...args, reserve: true })).reservation).not.toBeNull();
      }),
    ),
);
it.effect("rejects stale policy editors and expired overrides", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.savePolicy({ expectedVersion: 0, policy: defaultAllocationPolicy }),
          ),
        ),
      ).toBe(true);
      const policy = yield* store.policy;
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.allocate({
              at,
              request,
              inventories: [inventory("a")],
              authorityAvailable: true,
              reserve: true,
              expectedPolicyVersion: policy.version - 1,
            }),
          ),
        ),
      ).toBe(true);
      expect(yield* store.reservations).toEqual([]);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.savePolicy({
              expectedVersion: policy.version,
              policy: {
                ...policy,
                overrides: [
                  {
                    accountKey: "a",
                    windowId: "week",
                    createdAt: at,
                    expiresAt: "2026-10-22T12:00:00.000Z",
                    baselineUsedPoints: 0,
                  },
                ],
              },
            }),
          ),
        ),
      ).toBe(true);
    }),
  ),
);
it.effect(
  "renews unused expired accounting with the same ID but retains explicit cancellation",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const args = {
          at,
          request,
          inventories: [inventory("a")],
          authorityAvailable: true,
          reserve: true,
        };
        yield* store.allocate(args);
        expect(
          (yield* store.allocate({ ...args, at: "2026-10-23T12:06:00.000Z" })).reservation
            ?.assignmentId,
        ).toBe(request.assignmentId);
        yield* store.lifecycle(
          {
            assignmentId: request.assignmentId,
            environmentId: "a",
            threadId: request.threadId,
            action: "release",
          },
          at,
        );
        expect(Exit.isFailure(yield* Effect.exit(store.allocate(args)))).toBe(true);
      }),
    ),
);

it.effect("concurrent pre-start account choices cannot bind one account's intent to another", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const other = {
        ...inventory("a").accounts[0]!,
        instanceId: ProviderInstanceId.make("other"),
        accountKey: "other",
      };
      const inventories = [{ ...inventory("a"), accounts: [...inventory("a").accounts, other] }];
      const args = { at, inventories, authorityAvailable: true, reserve: true };
      yield* store.allocate({
        ...args,
        request: { ...request, explicitInstanceId: ProviderInstanceId.make("a") },
      });
      yield* store.allocate({
        ...args,
        request: { ...request, explicitInstanceId: other.instanceId },
      });
      const start = {
        assignmentId: request.assignmentId,
        threadId: request.threadId,
        environmentId: "a",
        action: "start" as const,
        startIntent: "first-intent",
        expectedRequest: { ...request, explicitInstanceId: ProviderInstanceId.make("a") },
      };
      expect(Exit.isFailure(yield* Effect.exit(store.lifecycle(start, at)))).toBe(true);
      expect((yield* store.reservations)[0]?.state).toBe("reserved");
      const held = yield* store.lifecycle(
        {
          ...start,
          expectedRequest: { ...request, explicitInstanceId: other.instanceId },
          startIntent: "second-intent",
        },
        at,
      );
      expect(held.instanceId).toBe("other");
      expect(held.startIntent).toBe("second-intent");
    }),
  ),
);

it.effect(
  "persists numeric budgets and weights, reloads old policies unchanged, and resets without admission enforcement",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* Store.AllocationStore;
        const sql = yield* SqlClient.SqlClient;
        const legacy = {
          ...defaultAllocationPolicy,
          version: 7,
          claude: {
            ...defaultAllocationPolicy.claude,
            preset: "sustainable" as const,
            dailyPoints: 100 / 7,
          },
          codex: { ...defaultAllocationPolicy.codex, dailyPoints: 23 },
        };
        yield* sql`INSERT INTO provider_allocation_policy (id, version, policy_json) VALUES (1, 7, ${json(legacy)})`;
        expect(yield* store.policy).toEqual(legacy);
        const a = inventory("a").accounts[0]!;
        const b = { ...a, instanceId: ProviderInstanceId.make("b"), accountKey: "other-login" };
        const hosts = [{ ...inventory("a"), accounts: [a, b] }];
        const capKey = allocationPreferenceKey(a);
        const saved = yield* store.savePolicy({
          expectedVersion: 7,
          policy: {
            ...legacy,
            claude: { ...legacy.claude, preset: "custom", dailyPoints: 40 },
            accountWeights: [
              { key: allocationPreferenceKey(a), weight: 0 },
              { key: allocationPreferenceKey(b), weight: 100 },
            ],
            accountCaps: [
              {
                key: capKey,
                weeklyPercent: 80,
                fiveHourPercent: null,
                stopWorkers: true,
                stopMasters: true,
              },
            ],
          },
        });
        expect(yield* store.policy).toEqual(saved);
        const suggested = yield* store.allocate({
          at,
          request,
          inventories: hosts,
          authorityAvailable: true,
          reserve: false,
        });
        expect(suggested.decision.selectedInstanceId).toBe("b");
        const chosen = yield* store.allocate({
          at,
          request: { ...request, explicitInstanceId: a.instanceId },
          inventories: hosts,
          authorityAvailable: true,
          reserve: true,
        });
        expect(chosen.decision.selectedInstanceId).toBe("a");
        expect(chosen.reservation?.instanceId).toBe("a");
        const stale = yield* Effect.exit(store.savePolicy({ expectedVersion: 7, policy: legacy }));
        expect(Exit.isFailure(stale)).toBe(true);
        expect(yield* store.policy).toEqual(saved);
        const { accountWeights: _weights, accountCaps: _caps, ...oldEditor } = saved;
        const legacySaved = yield* store.savePolicy({
          expectedVersion: saved.version,
          policy: oldEditor,
        });
        expect(legacySaved.accountWeights).toEqual(saved.accountWeights);
        expect(legacySaved.accountCaps).toEqual(saved.accountCaps);
        const inactive = yield* store.savePolicy({
          expectedVersion: legacySaved.version,
          policy: {
            ...legacySaved,
            accountCaps: [
              {
                key: capKey,
                weeklyPercent: 80,
                fiveHourPercent: null,
                stopWorkers: false,
                stopMasters: false,
              },
            ],
          },
        });
        expect(inactive.accountCaps?.[0]).toMatchObject({
          stopWorkers: false,
          stopMasters: false,
        });
        const emptyThreshold = yield* Effect.exit(
          store.savePolicy({
            expectedVersion: inactive.version,
            policy: {
              ...inactive,
              accountCaps: [
                {
                  key: capKey,
                  weeklyPercent: null,
                  fiveHourPercent: null,
                  stopWorkers: true,
                  stopMasters: false,
                },
              ],
            },
          }),
        );
        expect(Exit.isFailure(emptyThreshold)).toBe(true);
        expect(yield* store.policy).toEqual(inactive);
        const reset = yield* store.savePolicy({
          expectedVersion: inactive.version,
          policy: { ...defaultAllocationPolicy, accountWeights: [] },
        });
        expect(reset.claude.dailyPoints).toBe(17);
        expect(reset.codex.burstPoints).toBe(30);
        expect(reset.accountCaps).toEqual([]);
        expect(yield* store.policy).toEqual(reset);
        const explicitAfterReset = yield* store.allocate({
          at,
          request: {
            ...request,
            assignmentId: "after-reset",
            threadId: ThreadId.make("after-reset"),
            explicitInstanceId: a.instanceId,
          },
          inventories: hosts,
          authorityAvailable: true,
          reserve: true,
        });
        expect(explicitAfterReset.decision.selectedInstanceId).toBe("a");
        expect(explicitAfterReset.reservation).not.toBeNull();
      }),
    ),
);
