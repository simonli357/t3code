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
it.effect("retains family consent through denied lineage after store reconstruction", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      expect((yield* store.selectModel(args)).allocation?.decision.request.driver).toBe(
        "claudeAgent",
      );
      const next = {
        ...request,
        assignmentId: "denied",
        threadId: ThreadId.make("denied"),
        allowedDrivers: [ProviderDriverKind.make("codex")],
        reassessment: {
          previousAssignmentId: "one",
          cause: "scope-change" as const,
          reason: "New interactions",
          allowFreshProviderSession: false,
        },
      };
      expect((yield* store.selectModel({ ...args, request: next })).allocation).toBeNull();
      const third = {
        ...next,
        assignmentId: "denied-again",
        threadId: ThreadId.make("denied-again"),
        reassessment: { ...next.reassessment, previousAssignmentId: "denied" },
      };
      const denied = yield* store
        .selectModel({ ...args, request: third })
        .pipe(Effect.provide(Store.layer));
      expect(denied.allocation).toBeNull();
      expect(denied.reasons.join(" ")).toContain("explicit consent");
      expect(yield* store.reservations).toHaveLength(1);
      const consented = yield* store.selectModel({
        ...args,
        request: {
          ...third,
          assignmentId: "consented",
          threadId: ThreadId.make("consented"),
          reassessment: { ...third.reassessment, allowFreshProviderSession: true },
        },
      });
      expect(consented.allocation?.decision.request.driver).toBe("codex");
      expect(consented.revision).toBe(2);
    }),
  ),
);
it.effect(
  "retries never-reserved quota denial with frozen profiles and version after reconstruction",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const pinned = {
          ...request,
          policyVersion: 0,
          explicitInstanceId: ProviderInstanceId.make("codex"),
        };
        const blocked = {
          ...inventory,
          accounts: inventory.accounts.map((a) => ({
            ...a,
            windows: a.windows.map((w) => ({ ...w, usedPoints: 100 })),
          })),
        };
        const first = yield* store.selectModel({
          ...args,
          request: pinned,
          inventories: [blocked],
        });
        expect(first.allocation).toBeNull();
        expect(yield* store.reservations).toHaveLength(0);
        yield* store.saveModelPolicy({
          expectedVersion: 0,
          inventories: [inventory],
          policy: {
            ...defaultModelRoutingPolicy,
            codex: {
              ...defaultModelRoutingPolicy.codex,
              grid: defaultModelRoutingPolicy.codex.grid.map((row) => row.map(() => 1)),
            },
          },
        });
        const recoveredAt = "2026-10-29T18:00:00.000Z";
        const recovered = {
          ...inventory,
          observedAt: recoveredAt,
          accounts: inventory.accounts.map((a) => ({
            ...a,
            shortWindowAbsentCheckedAt: recoveredAt,
            windows: a.windows.map((w) => ({
              ...w,
              checkedAt: recoveredAt,
              cycleStartedAt: "2026-10-29T12:00:00.000Z",
              resetsAt: "2026-11-05T12:00:00.000Z",
            })),
          })),
        };
        const retryArgs = {
          ...args,
          request: pinned,
          at: recoveredAt,
          inventories: [recovered],
          expectedModelVersion: 1,
        };
        const missingExact = yield* store.selectModel({
          ...retryArgs,
          inventories: [
            {
              ...recovered,
              accounts: recovered.accounts.map((a) => ({
                ...a,
                models: a.models.filter((m) => m.slug !== "gpt-6-astra"),
              })),
            },
          ],
        });
        expect(missingExact.allocation).toBeNull();
        expect(missingExact.profiles.map((p) => p.model)).toEqual(["gpt-6-astra"]);
        expect(yield* store.reservations).toHaveLength(0);
        const [retry, concurrent] = yield* Effect.all(
          [store.selectModel(retryArgs), store.selectModel(retryArgs)],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(Store.layer));
        expect(concurrent).toEqual(retry);
        expect(retry.allocation?.reservation).not.toBeNull();
        expect(retry.allocation?.decision.request).toMatchObject({
          assignmentId: "one",
          threadId: "one",
          explicitInstanceId: "codex",
          model: "gpt-6-astra",
          options: [{ id: "reasoningEffort", value: "medium" }],
        });
        expect(retry.policyVersion).toBe(0);
        expect(retry.request).toEqual(pinned);
        expect(yield* store.reservations).toHaveLength(1);
        expect(yield* store.selectModel({ ...retryArgs, inventories: [blocked] })).toEqual(retry);
        for (const action of ["start", "consume", "release"] as const) {
          yield* store.lifecycle(
            {
              assignmentId: "one",
              environmentId: "host",
              threadId: pinned.threadId,
              action,
              ...(action === "start" ? { startIntent: "original-start-intent" } : {}),
            },
            recoveredAt,
          );
          expect(yield* store.selectModel(retryArgs).pipe(Effect.provide(Store.layer))).toEqual(
            retry,
          );
          expect(yield* store.reservations).toHaveLength(1);
        }
        const finished = yield* store
          .allocate({ ...retryArgs, request: retry.allocation!.decision.request })
          .pipe(Effect.flip);
        expect(finished.message).toContain("finished or expired");
      }),
    ),
);
it.effect("admits an observed exact profile after mode recovery without changing identity", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const policy = yield* store.policy;
      yield* store.savePolicy({ expectedVersion: 1, policy: { ...policy, mode: "observation" } });
      const observed = yield* store.selectModel({ ...args, expectedPolicyVersion: 2 });
      expect(observed.allocation?.mode).toBe("observation");
      expect(yield* store.reservations).toHaveLength(0);
      yield* store.savePolicy({ expectedVersion: 2, policy: { ...policy, mode: "automatic" } });
      const denied = yield* store.selectModel({
        ...args,
        expectedPolicyVersion: 3,
        inventories: [
          {
            ...inventory,
            accounts: inventory.accounts.map((a) =>
              a.driver === "claudeAgent"
                ? { ...a, available: false, unavailableReason: "Provider rejected" }
                : a,
            ),
          },
        ],
      });
      expect(denied.allocation).toBeNull();
      expect(denied.profiles.map((p) => p.driver)).toEqual(["claudeAgent"]);
      expect(yield* store.reservations).toHaveLength(0);
      const changed = yield* store
        .selectModel({
          ...args,
          expectedPolicyVersion: 3,
          request: { ...request, expectedHours: 2 },
        })
        .pipe(Effect.flip);
      expect(changed.message).toContain("different assessment or constraints");
      const retried = yield* store
        .selectModel({ ...args, expectedPolicyVersion: 3 })
        .pipe(Effect.provide(Store.layer));
      expect(retried.allocation?.mode).toBe("automatic");
      expect(retried.allocation?.reservation?.request).toEqual(
        observed.allocation?.decision.request,
      );
      expect(retried.policyVersion).toBe(observed.policyVersion);
      expect(yield* store.reservations).toHaveLength(1);
      expect((yield* store.history).some((d) => d.selectedInstanceId === null)).toBe(true);
    }),
  ),
);
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
