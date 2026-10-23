import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type AllocationRequest,
} from "@t3tools/contracts";
import migration from "../persistence/Migrations/063_ProviderAllocation.ts";
import * as Store from "./AllocationStore.ts";

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
      codex: { ...defaultAllocationPolicy.codex, burstPoints: 80 },
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
        expect([one, two].filter((r) => r.reservation)).toHaveLength(1);
        const winner = one.reservation ? one : two;
        expect(yield* allocate(winner.decision.request)).toEqual(winner);
        const conflict = yield* Effect.exit(
          allocate({ ...winner.decision.request, model: "changed" }),
        );
        expect(Exit.isFailure(conflict)).toBe(true);
        expect(yield* store.reservations).toHaveLength(1);
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
        ).toBeNull();
        yield* store.lifecycle({ ...life, action: "consume" }, later);
        yield* store.lifecycle({ ...life, action: "consume" }, later);
        yield* store.lifecycle({ ...life, action: "release" }, later);
        expect((yield* store.reservations)[0]?.state).toBe("released");
      }),
    ),
);
it.effect(
  "observation makes proposals without capacity mutation; preview policy never persists",
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
          reserve: true,
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
it.effect("does not silently reuse a cancelled or expired assignment", () =>
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
        Exit.isFailure(
          yield* Effect.exit(store.allocate({ ...args, at: "2026-10-23T12:06:00.000Z" })),
        ),
      ).toBe(true);
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
