import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type ModelRoutingRequest,
} from "@t3tools/contracts";
import allocationMigration from "../persistence/Migrations/063_ProviderAllocation.ts";
import modelMigration from "../persistence/Migrations/065_ModelSelection.ts";
import * as Store from "./AllocationStore.ts";

const at = "2026-10-23T12:00:00.000Z";
const request: ModelRoutingRequest = {
  selection: "automatic",
  assignmentId: "one",
  environmentId: "host",
  threadId: ThreadId.make("one"),
  allowedDrivers: [ProviderDriverKind.make("codex"), ProviderDriverKind.make("claudeAgent")],
  assessment: {
    difficulty: 7,
    stakes: 7,
    difficultyReason: "Several interactions",
    stakesReason: "Recoverable but consequential",
  },
};
const inventory: AllocationInventory = {
  environmentId: "host",
  observedAt: at,
  complete: true,
  notices: [],
  demand: [],
  accounts: ["codex", "claudeAgent"].map((driver) => ({
    environmentId: "host",
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    label: driver,
    accountKey: driver,
    available: true,
    unavailableReason: null,
    limitedUntil: null,
    shortWindow: "known-absent" as const,
    shortWindowAbsentCheckedAt: at,
    resetCredits: null,
    profileSamples: 0,
    profileUncertainty: 1,
    models: (driver === "codex"
      ? defaultModelRoutingPolicy.codex
      : defaultModelRoutingPolicy.claudeAgent
    ).allowedModels.map((slug) => ({
      slug,
      capabilities: {
        optionDescriptors: [
          {
            id: driver === "codex" ? "reasoningEffort" : "effort",
            type: "select" as const,
            label: "Effort",
            options: ["medium", "high", "max", "xhigh"].map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
    windows: [
      {
        id: "week",
        label: "Week",
        kind: "weekly" as const,
        usedPoints: 10,
        checkedAt: at,
        resetsAt: "2026-10-29T12:00:00.000Z",
        cycleStartedAt: "2026-10-22T12:00:00.000Z",
        durationHours: 168,
        ratePointsPerHour: null,
        samples: 0,
        rateAgeMinutes: null,
      },
    ],
  })),
};
const layer = Store.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const run = <A, E>(effect: Effect.Effect<A, E, Store.AllocationStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer));
const setup = Effect.gen(function* () {
  yield* allocationMigration;
  yield* modelMigration;
  const store = yield* Store.AllocationStore;
  yield* store.savePolicy({
    expectedVersion: 0,
    policy: {
      ...defaultAllocationPolicy,
      mode: "automatic",
      coordinatorEnvironmentId: "host",
      claude: defaultAllocationPolicy.codex,
    },
  });
  return store;
});
const args = {
  at,
  request,
  inventories: [inventory],
  authorityAvailable: true,
  reserve: true,
  expectedPolicyVersion: 1,
  expectedModelVersion: 0,
};
it.effect(
  "rejects a stale preview for new work while replaying the original version for an existing assignment",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const pinned = { ...args, request: { ...request, policyVersion: 0 } };
        const original = yield* store.selectModel(pinned);
        yield* store.saveModelPolicy({
          expectedVersion: 0,
          policy: { ...defaultModelRoutingPolicy, maxReassessments: 1 },
          inventories: [inventory],
        });
        expect(yield* store.selectModel(pinned)).toEqual(original);
        const stale = yield* store
          .selectModel({
            ...pinned,
            expectedModelVersion: 1,
            request: {
              ...pinned.request,
              assignmentId: "new-stale",
              threadId: ThreadId.make("new-stale"),
            },
          })
          .pipe(Effect.flip);
        expect(stale.message).toContain("changed since preview");
        expect(yield* store.reservations).toHaveLength(1);
      }),
    ),
);
it.effect(
  "serializes different automatic assignments across both provider families without double admission",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        yield* store.savePolicy({
          expectedVersion: 1,
          policy: {
            ...defaultAllocationPolicy,
            mode: "automatic",
            coordinatorEnvironmentId: "host",
            codex: { ...defaultAllocationPolicy.codex, burstPoints: 80 },
            claude: { ...defaultAllocationPolicy.codex, burstPoints: 80 },
          },
        });
        const scarce = {
          ...inventory,
          accounts: inventory.accounts.map((a) => ({
            ...a,
            windows: a.windows.map((w) => ({ ...w, usedPoints: 80 })),
          })),
        };
        const allocate = (id: string) =>
          store.selectModel({
            ...args,
            expectedPolicyVersion: 2,
            inventories: [scarce],
            request: { ...request, assignmentId: id, threadId: ThreadId.make(id) },
          });
        const [one, two] = yield* Effect.all([allocate("race-one"), allocate("race-two")], {
          concurrency: "unbounded",
        });
        expect(
          new Set([
            one.allocation?.decision.selectedInstanceId,
            two.allocation?.decision.selectedInstanceId,
          ]),
        ).toEqual(new Set(["codex", "claudeAgent"]));
        expect(yield* store.reservations).toHaveLength(2);
        const blocked = yield* allocate("race-three");
        expect(blocked.allocation).toBeNull();
        expect(blocked.profiles.map((p) => p.profile)).toEqual([4, 4]);
      }),
    ),
);
it.effect(
  "keeps deterministic ties independent of inventory order, and preserves explicit account and host pins",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const one = yield* store.selectModel({ ...args, reserve: false });
        const two = yield* store.selectModel({
          ...args,
          reserve: false,
          inventories: [{ ...inventory, accounts: inventory.accounts.toReversed() }],
        });
        expect(one).toEqual(two);
        const pinned = yield* store.selectModel({
          ...args,
          request: { ...request, explicitInstanceId: ProviderInstanceId.make("codex") },
        });
        expect(pinned.allocation?.decision.selectedInstanceId).toBe("codex");
        expect(pinned.allocation?.decision.request).toMatchObject({
          environmentId: "host",
          model: "gpt-6-astra",
          explicitInstanceId: "codex",
          options: [{ id: "reasoningEffort", value: "medium" }],
        });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.selectModel({
                ...args,
                expectedModelVersion: 10,
                request: { ...request, assignmentId: "stale", threadId: ThreadId.make("stale") },
              }),
            ),
          ),
        ).toBe(true);
      }),
    ),
);
it.effect(
  "commits one exact profile and reservation across both families; retry survives policy changes and reconstruction",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const [one, two] = yield* Effect.all([store.selectModel(args), store.selectModel(args)], {
          concurrency: "unbounded",
        });
        expect(one).toEqual(two);
        expect(one.allocation?.decision.request.model).toBe("claude-opus-5-5");
        expect(one.allocation?.decision.request.options).toEqual([
          { id: "effort", value: "medium" },
        ]);
        expect(yield* store.reservations).toHaveLength(1);
        yield* store.saveModelPolicy({
          expectedVersion: 0,
          policy: {
            ...defaultModelRoutingPolicy,
            codex: {
              ...defaultModelRoutingPolicy.codex,
              grid: defaultModelRoutingPolicy.codex.grid.map((r) => r.map(() => 1)),
            },
          },
          inventories: [inventory],
        });
        expect(yield* store.selectModel(args).pipe(Effect.provide(Store.layer))).toEqual(one);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              store.selectModel({
                ...args,
                request: { ...request, assessment: { ...request.assessment, stakes: 0 } },
              }),
            ),
          ),
        ).toBe(true);
      }),
    ),
);
it.effect("saves optimistically and reverts as a new immutable policy version", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.saveModelPolicy({
        expectedVersion: 0,
        policy: { ...defaultModelRoutingPolicy, maxReassessments: 1 },
        inventories: [inventory],
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.saveModelPolicy({
              expectedVersion: 0,
              policy: defaultModelRoutingPolicy,
              inventories: [inventory],
            }),
          ),
        ),
      ).toBe(true);
      const restored = yield* store.saveModelPolicy({
        expectedVersion: 1,
        revertVersion: 0,
        inventories: [inventory],
      });
      expect(restored).toEqual({ ...defaultModelRoutingPolicy, version: 2 });
      expect((yield* store.modelPolicies).map((p) => p.version)).toEqual([2, 1]);
    }),
  ),
);
it.effect(
  "does not reserve on offline/stale target, rejection or measured burn, and does not downgrade for quota",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        for (const inventories of [
          [{ ...inventory, complete: false }],
          [{ ...inventory, observedAt: "2026-10-22T12:00:00.000Z" }],
          [
            {
              ...inventory,
              accounts: inventory.accounts.map((a) => ({
                ...a,
                available: false,
                unavailableReason: "Provider rejected",
              })),
            },
          ],
          [
            {
              ...inventory,
              accounts: inventory.accounts.map((a) => ({
                ...a,
                windows: a.windows.map((w) => ({
                  ...w,
                  ratePointsPerHour: 20,
                  rateAgeMinutes: 0,
                  samples: 10,
                })),
              })),
            },
          ],
        ]) {
          const result = yield* store.selectModel({ ...args, reserve: false, inventories });
          expect(result.allocation).toBeNull();
        }
        expect(
          (yield* store.selectModel({ ...args, reserve: false, authorityAvailable: false }))
            .allocation,
        ).toBeNull();
        expect(yield* store.reservations).toHaveLength(0);
      }),
    ),
);
it.effect("bounds explicit reassessment, keeps pins and requires fresh-provider consent", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      yield* store.selectModel(args);
      const next = {
        ...request,
        assignmentId: "two",
        threadId: ThreadId.make("two"),
        allowedDrivers: [ProviderDriverKind.make("codex")],
        reassessment: {
          previousAssignmentId: "one",
          cause: "scope-change" as const,
          reason: "New interactions",
          allowFreshProviderSession: false,
        },
      };
      expect(
        (yield* store.selectModel({ ...args, request: next, reserve: false })).allocation,
      ).toBeNull();
      const two = yield* store.selectModel({
        ...args,
        request: {
          ...next,
          reassessment: { ...next.reassessment, allowFreshProviderSession: true },
        },
      });
      expect(two.revision).toBe(1);
      expect(two.allocation?.decision.request.driver).toBe("codex");
      yield* store.saveModelPolicy({
        expectedVersion: 0,
        policy: { ...defaultModelRoutingPolicy, maxReassessments: 1 },
        inventories: [inventory],
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.selectModel({
              ...args,
              expectedModelVersion: 1,
              request: {
                ...next,
                assignmentId: "three",
                threadId: ThreadId.make("three"),
                reassessment: { ...next.reassessment, previousAssignmentId: "two" },
              },
            }),
          ),
        ),
      ).toBe(true);
    }),
  ),
);
