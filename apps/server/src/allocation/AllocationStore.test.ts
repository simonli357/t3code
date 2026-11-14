import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  allocationPreferenceKey,
  legacyAllocationPolicyFields,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type AllocationRequest,
} from "@t3tools/contracts";
import migration from "../persistence/Migrations/063_ProviderAllocation.ts";
import * as Store from "./AllocationStore.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
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
  yield* migration;
  const store = yield* Store.AllocationStore;
  yield* store.savePolicy({
    expectedVersion: 0,
    policy: {
      ...defaultAllocationPolicy,
      mode: "automatic",
      coordinatorEnvironmentId: "a",
    },
  });
  return store;
});
const layer = Store.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
// Each test gets its own database and the actual SQL transaction implementation.
const run = <A, E>(effect: Effect.Effect<A, E, Store.AllocationStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer));

it.effect(
  "applies a saved preference order, margin and hard cap to the next recommendation without restart",
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
        const hosts = [{ ...inventory("a"), accounts: [a, b] }];
        const recommend = () =>
          store.allocate({
            at,
            request,
            inventories: hosts,
            authorityAvailable: true,
            reserve: false,
          });
        // Both keep within their daily goals, so room decides: a has half a point more.
        let current = yield* store.policy;
        current = yield* store.savePolicy({
          expectedVersion: current.version,
          policy: {
            ...current,
            accountGoals: [a, b].map((x) => ({
              key: allocationPreferenceKey(x),
              percentPerDay: 100,
            })),
          },
        });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("a");
        current = yield* store.savePolicy({
          expectedVersion: current.version,
          policy: { ...current, accountOrder: [allocationPreferenceKey(b)] },
        });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("b");
        current = yield* store.savePolicy({
          expectedVersion: current.version,
          policy: { ...current, closeMarginPoints: 0 },
        });
        expect((yield* recommend()).decision.selectedInstanceId).toBe("a");
        yield* store.savePolicy({
          expectedVersion: current.version,
          policy: {
            ...current,
            accountCaps: [
              {
                key: allocationPreferenceKey(a),
                weeklyPercent: 50,
                fiveHourPercent: null,
                stopWorkers: true,
                stopMasters: false,
              },
            ],
          },
        });
        const capped = yield* recommend();
        expect(capped.decision.selectedInstanceId).toBe("b");
        expect(capped.decision.candidates.find((c) => c.instanceId === "a")?.drainedUntil).toBe(
          "2026-10-29T12:00:00.000Z",
        );
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
          previewPolicy: { ...policy, closeMarginPoints: 0 },
        });
        expect(yield* store.history).toHaveLength(1);
        expect((yield* store.policy).mode).toBe("observation");
        expect(yield* store.reservations).toEqual([]);
        expect((yield* store.allocate({ ...args, reserve: true })).reservation).not.toBeNull();
      }),
    ),
);
it.effect("rejects stale policy editors and an order that lists an account twice", () =>
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
              policy: { ...policy, accountOrder: ["a", "b", "a"] },
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
  "loads a policy saved before smart allocation, and saves every policy readable by older builds",
  () =>
    run(
      Effect.gen(function* () {
        yield* migration;
        const store = yield* Store.AllocationStore;
        const sql = yield* SqlClient.SqlClient;
        const a = inventory("a").accounts[0]!;
        const b = { ...a, instanceId: ProviderInstanceId.make("b"), accountKey: "other-login" };
        const hosts = [{ ...inventory("a"), accounts: [a, b] }];
        const capKey = allocationPreferenceKey(a);
        // Everything smart allocation removed, with values other than the ones it now writes.
        const removed = {
          claude: {
            preset: "sustainable",
            dailyPoints: 100 / 7,
            burstPoints: 0,
            burstHours: 0,
            reservePoints: 10,
            borrowPoints: 15,
          },
          codex: {
            preset: "burst",
            dailyPoints: 23,
            burstPoints: 30,
            burstHours: 0,
            reservePoints: 5,
            borrowPoints: 15,
          },
          minimumSamples: 9,
          overrides: [
            {
              accountKey: "same-login",
              windowId: "week",
              createdAt: at,
              expiresAt: "2026-10-30T12:00:00.000Z",
              baselineUsedPoints: 10,
            },
          ],
          accountRules: [
            { key: capKey, kind: "exclude", note: "never" },
            { key: allocationPreferenceKey(b), kind: "maxWorkers", value: 1 },
          ],
          workerModels: { claude: { model: "claude-fable-5", effort: "medium" } },
        };
        const {
          accountCaps: _caps,
          accountOrder: _order,
          closeMarginPoints: _margin,
          longWaitHours: _wait,
          ...before
        } = defaultAllocationPolicy;
        const legacy = { ...before, version: 7, ...removed };
        yield* sql`INSERT INTO provider_allocation_policy (id, version, policy_json) VALUES (1, 7, ${json({ ...legacy, accountWeights: [{ key: "old", weight: 100 }] })})`;
        const loaded = yield* store.policy;
        expect(loaded).toEqual(legacy);
        // The removed rules no longer decide anything: the once excluded account has the most room.
        const free = { ...a, windows: a.windows.map((w) => ({ ...w, usedPoints: 10 })) };
        expect(
          (yield* store.allocate({
            at,
            request,
            inventories: [{ ...inventory("a"), accounts: [free, b] }],
            authorityAvailable: true,
            reserve: false,
          })).decision.selectedInstanceId,
        ).toBe("a");

        const cap = {
          key: capKey,
          weeklyPercent: 80,
          fiveHourPercent: null,
          stopWorkers: true,
          stopMasters: true,
        };
        const saved = yield* store.savePolicy({
          expectedVersion: 7,
          policy: {
            ...loaded,
            accountOrder: [allocationPreferenceKey(b)],
            closeMarginPoints: 4,
            longWaitHours: 1,
            accountCaps: [cap],
          },
        });
        // The user's values of the removed fields stay; only the rules go.
        const { accountRules: _rules, workerModels: _models, ...kept } = removed;
        expect(saved).toEqual({
          ...before,
          ...legacyAllocationPolicyFields,
          ...kept,
          version: 8,
          accountOrder: [allocationPreferenceKey(b)],
          closeMarginPoints: 4,
          longWaitHours: 1,
          accountCaps: [cap],
        });
        expect(saved.accountRules).toBeUndefined();
        expect(saved.workerModels).toBeUndefined();
        expect(yield* store.policy).toEqual(saved);
        // What is on disk holds every field a build from before smart allocation requires.
        const stored = sql<{
          policy_json: string;
        }>`SELECT policy_json FROM provider_allocation_policy WHERE id = 1`.pipe(
          Effect.map((rows) => parse(rows[0]!.policy_json)),
        );
        expect(yield* stored).toMatchObject({
          ...legacyAllocationPolicyFields,
          ...kept,
          mode: "observation",
          maxReadingAgeMinutes: 10,
          reservationMinutes: 5,
        });
        expect(Object.keys(yield* stored)).not.toContain("accountRules");
        expect(Object.keys(yield* stored)).not.toContain("workerModels");

        // A reached hard cap drains the account: the suggestion moves, and a pin is refused.
        const suggested = yield* store.allocate({
          at,
          request,
          inventories: hosts,
          authorityAvailable: true,
          reserve: false,
        });
        expect(suggested.decision.selectedInstanceId).toBe("b");
        const pinned = yield* store.allocate({
          at,
          request: { ...request, explicitInstanceId: a.instanceId },
          inventories: hosts,
          authorityAvailable: true,
          reserve: true,
        });
        expect(pinned.decision).toMatchObject({
          outcome: "wait",
          selectedInstanceId: null,
          waitUntil: "2026-10-29T12:00:00.000Z",
        });
        expect(pinned.reservation).toBeNull();

        const stale = yield* Effect.exit(store.savePolicy({ expectedVersion: 7, policy: loaded }));
        expect(Exit.isFailure(stale)).toBe(true);
        expect(yield* store.policy).toEqual(saved);
        // A build from before smart allocation saves without the new fields and with its own
        // rules: what is stored stays, and the rules are not kept.
        const {
          accountCaps: _savedCaps,
          accountOrder: _savedOrder,
          closeMarginPoints: _savedMargin,
          longWaitHours: _savedWait,
          ...oldEditor
        } = saved;
        const legacySaved = yield* store.savePolicy({
          expectedVersion: saved.version,
          policy: { ...oldEditor, ...removed },
        });
        expect(legacySaved).toEqual({ ...saved, version: 9 });
        for (const accountCaps of [[cap, cap], [{ ...cap, weeklyPercent: null }]])
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                store.savePolicy({
                  expectedVersion: legacySaved.version,
                  policy: { ...legacySaved, accountCaps },
                }),
              ),
            ),
          ).toBe(true);
        expect(yield* store.policy).toEqual(legacySaved);
        const reset = yield* store.savePolicy({
          expectedVersion: legacySaved.version,
          policy: defaultAllocationPolicy,
        });
        expect(reset).toEqual({ ...defaultAllocationPolicy, version: 10 });
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

it.effect("keeps the stored daily goals when a save does not change them", () =>
  Effect.gen(function* () {
    yield* migration;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.AllocationStore;
    // The user's own values, unlike the fixed ones builds from before smart allocation wrote.
    const claude = { ...legacyAllocationPolicyFields.claude, dailyPoints: 20, reservePoints: 7 };
    const codex = { ...legacyAllocationPolicyFields.codex, dailyPoints: 12 };
    const stored = { ...defaultAllocationPolicy, version: 12, claude, codex };
    yield* sql`INSERT INTO provider_allocation_policy (id, version, policy_json) VALUES (1, 12, ${json(stored)})`;
    const goal = { key: "account-key", percentPerDay: 12 };
    // A save from this build sends what it read, with its own change.
    const first = yield* store.savePolicy({
      expectedVersion: 12,
      policy: { ...(yield* store.policy), accountGoals: [goal], fableWorkers: false },
    });
    expect(first).toMatchObject({ claude, codex, accountGoals: [goal], fableWorkers: false });
    // A save that omits them keeps what is stored, never a constant.
    const {
      claude: _claude,
      codex: _codex,
      accountGoals: _goals,
      fableWorkers: _fable,
      ...partial
    } = first;
    const second = yield* store.savePolicy({ expectedVersion: 13, policy: partial });
    expect(second).toMatchObject({ claude, codex, accountGoals: [goal], fableWorkers: false });
    expect(yield* store.policy).toEqual(second);
  }).pipe(Effect.provide(layer)),
);
