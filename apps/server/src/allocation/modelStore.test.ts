import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  workerChoice,
  type AllocationInventory,
  type ModelRoutingRequest,
} from "@t3tools/contracts";
import allocationMigration from "../persistence/Migrations/063_ProviderAllocation.ts";
import modelMigration from "../persistence/Migrations/065_ModelSelection.ts";
import * as Store from "./AllocationStore.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
    },
  });
  return store;
});
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const claude = inventory.accounts.find((a) => a.driver === "claudeAgent")!;
const claudeOnly = { ...request, allowedDrivers: [claudeAgent] };
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
  "records the wanted profile when a drained model moved the choice, and the reset when refused",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const week = claude.windows[0]!;
        const withWindows = (windows: AllocationInventory["accounts"][number]["windows"]) => [
          { ...inventory, accounts: [{ ...claude, windows }] },
        ];
        // Difficulty 7, stakes 7 is Opus medium, and Opus has its own used-up window.
        const moved = yield* store.selectModel({
          ...args,
          request: claudeOnly,
          inventories: withWindows([
            week,
            {
              ...week,
              id: "week_opus",
              label: "Week · Opus",
              models: ["claude-opus-5-5"],
              usedPoints: 100,
              resetsAt: "2026-10-25T12:00:00.000Z",
            },
          ]),
        });
        expect(moved.allocation?.decision.request).toMatchObject({
          model: "claude-sonnet-5-5",
          options: [{ id: "effort", value: "high" }],
        });
        expect(moved.wanted).toEqual({
          driver: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "medium" }],
        });
        expect(moved.profiles.map((p) => [p.model, p.eligible])).toEqual([
          ["claude-opus-5-5", false],
          ["claude-sonnet-5-5", true],
        ]);
        expect(moved.reasons[0]).toContain(
          "claude-opus-5-5 / medium is drained on every account (earliest reset 2026-10-25T12:00:00.000Z)",
        );
        expect(moved.accounts).toHaveLength(1);
        expect(moved.drainedUntil).toBeUndefined();
        expect(moved.allocation?.reservation?.instanceId).toBe("claudeAgent");
        expect(workerChoice(moved)).toMatchObject({
          state: "chosen",
          chosen: { instanceId: "claudeAgent", model: "claude-sonnet-5-5", effort: "high" },
          wanted: "claude-opus-5-5 / medium",
        });
        expect(yield* store.modelDecisionById("one")).toEqual(moved);

        // Difficulty 7, stakes 8 is Opus high, above the fallback threshold: with the whole
        // account used up the start is refused until the reset.
        const high = {
          ...claudeOnly,
          assignmentId: "refused",
          threadId: ThreadId.make("refused"),
          assessment: { difficulty: 7, stakes: 8 },
        };
        const refused = yield* store.selectModel({
          ...args,
          request: high,
          inventories: withWindows([{ ...week, usedPoints: 100 }]),
        });
        expect(refused.allocation).toBeNull();
        expect(refused.wanted).toBeUndefined();
        expect(refused.drainedUntil).toBe("2026-10-29T12:00:00.000Z");
        expect(refused.reasons[0]).toContain("Drained: claude-opus-5-5 / high");
        expect(workerChoice(refused)).toMatchObject({
          state: "drained",
          chosen: null,
          drainedUntil: "2026-10-29T12:00:00.000Z",
        });
        expect(yield* store.reservations).toHaveLength(1);
        // The same start, retried once there is room, is admitted.
        const started = yield* store.selectModel({ ...args, request: high });
        expect(started.allocation?.reservation).not.toBeNull();
        expect(started.allocation?.decision.request).toMatchObject({
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        });
        expect(started.drainedUntil).toBeUndefined();
        expect(yield* store.reservations).toHaveLength(2);
      }),
    ),
);
it.effect("asks Claude first when both families are allowed, whatever room Codex has", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const current = {
        ...inventory,
        accounts: inventory.accounts.map((a) => ({
          ...a,
          windows: a.windows.map((w) => ({ ...w, usedPoints: a.driver === "codex" ? 0 : 90 })),
        })),
      };
      const chosen = yield* store.selectModel({ ...args, reserve: false, inventories: [current] });
      expect(chosen.allocation?.decision.request.driver).toBe("claudeAgent");
      expect(chosen.profiles.map((p) => [p.driver, p.eligible])).toEqual([["claudeAgent", true]]);
      expect(yield* store.reservations).toHaveLength(0);
    }),
  ),
);
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
it.effect("retries a refused start once there is room, then replays its reservation exactly", () =>
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
      const refused = yield* store.selectModel({
        ...args,
        request: pinned,
        inventories: [blocked],
      });
      expect(refused.allocation).toBeNull();
      expect(refused.drainedUntil).toBe("2026-10-29T12:00:00.000Z");
      expect(refused.reasons[0]).toContain("a pinned account is exact.");
      expect(refused.profiles.map((p) => [p.model, p.eligible])).toEqual([["gpt-6-astra", false]]);
      expect(yield* store.reservations).toHaveLength(0);
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
      expect(missingExact.drainedUntil).toBeUndefined();
      expect(missingExact.reasons.join(" ")).toContain(
        "no account on this computer offers gpt-6-astra / medium",
      );
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
      expect(finished.message).toContain("finished or was cancelled");
    }),
  ),
);
it.effect("admits an observed exact profile after mode recovery without changing identity", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const policy = yield* store.policy;
      yield* store.savePolicy({ expectedVersion: 1, policy: { ...policy, mode: "observation" } });
      const observed = yield* store.selectModel({
        ...args,
        reserve: false,
        expectedPolicyVersion: 2,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO model_selection_decisions (assignment_id,created_at,decision_json) VALUES (${request.assignmentId},${at},${encode(observed)})`;
      expect(observed.allocation?.mode).toBe("observation");
      expect(yield* store.reservations).toHaveLength(0);
      yield* store.savePolicy({ expectedVersion: 2, policy: { ...policy, mode: "automatic" } });
      const admitted = yield* store.selectModel({ ...args, expectedPolicyVersion: 3 });
      expect(admitted.allocation?.reservation).not.toBeNull();
      expect(admitted.profiles.map((p) => p.driver)).toEqual(["claudeAgent"]);
      expect(yield* store.reservations).toHaveLength(1);
      const changed = yield* store
        .selectModel({
          ...args,
          expectedPolicyVersion: 3,
          request: { ...request, expectedHours: 2 },
        })
        .pipe(Effect.flip);
      expect(changed.message).toContain("different assessment");
      const retried = yield* store
        .selectModel({ ...args, expectedPolicyVersion: 3 })
        .pipe(Effect.provide(Store.layer));
      expect(retried.allocation?.mode).toBe("automatic");
      expect(retried.allocation?.reservation?.request).toEqual(
        observed.allocation?.decision.request,
      );
      expect(retried.policyVersion).toBe(observed.policyVersion);
      expect(yield* store.reservations).toHaveLength(1);
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
it.effect("counts a reserved start as load, so the next start goes to the other account", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const pair = [
        {
          ...inventory,
          accounts: ["a", "b"].map((id, n) => ({
            ...claude,
            instanceId: ProviderInstanceId.make(id),
            accountKey: id,
            label: id,
            windows: claude.windows.map((w) => ({ ...w, usedPoints: 10 + n })),
          })),
        },
      ];
      // A worker costs a dollar an hour, so both accounts keep within their daily goals.
      const learned = {
        learnedAt: at,
        costs: [
          {
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-opus-5-5",
            effort: "medium",
            kind: "worker" as const,
            dollarsPerHour: 1,
            perHundredK: 0,
            contextTokens: 0,
            samples: 1,
            hours: 1,
            source: "measured" as const,
          },
        ],
        limits: [],
        workerHours: null,
        notes: [],
      };
      const start = (id: string) =>
        store.selectModel({
          ...args,
          inventories: pair,
          learned,
          request: { ...claudeOnly, assignmentId: id, threadId: ThreadId.make(id) },
        });
      expect((yield* start("first")).allocation?.decision.selectedInstanceId).toBe("a");
      // The reservation just made counts as a worker on a.
      const second = yield* start("second");
      expect(second.allocation?.decision.selectedInstanceId).toBe("b");
      expect(second.reasons[0]).toContain("most room of 2 accounts.");
      expect((yield* start("third")).allocation?.decision.selectedInstanceId).toBe("a");
      expect(yield* store.reservations).toHaveLength(3);
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
              cells: defaultModelRoutingPolicy.codex.cells.map((r) =>
                r.map(() => ({ model: "gpt-6.1-sol", effort: "medium" })),
              ),
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
      expect(restored.policy).toEqual({ ...defaultModelRoutingPolicy, version: 2 });
      expect((yield* store.modelPolicies).map((p) => p.version)).toEqual([2, 1]);
    }),
  ),
);
it.effect(
  "accepts a model no account offers with a warning, and keeps the ladder for older editors",
  () =>
    run(
      Effect.gen(function* () {
        const store = yield* setup;
        const table = defaultModelRoutingPolicy.claudeAgent;
        const ladder = [
          { model: "claude-sonnet-5-5", effort: "high" },
          { model: "claude-opus-5-5", effort: "xhigh" },
          { model: "claude-next-9", effort: "high" },
        ];
        const saved = yield* store.saveModelPolicy({
          expectedVersion: 0,
          inventories: [inventory],
          policy: {
            ...defaultModelRoutingPolicy,
            claudeAgent: {
              ...table,
              cells: table.cells.map((row, d) =>
                row.map((cell, s) =>
                  d === 0 && s === 0 ? { model: "claude-next-9", effort: "high" } : cell,
                ),
              ),
            },
            ladder,
            fallback: null,
          },
        });
        expect(saved.policy.version).toBe(1);
        expect(saved.policy.claudeAgent.cells[0]![0]).toEqual({
          model: "claude-next-9",
          effort: "high",
        });
        expect(saved.warnings).toEqual([
          "claudeAgent table: no connected account offers claude-next-9.",
          "claudeAgent table: claude-next-9 is not in the table's model list.",
          "Ladder: no connected account offers claude-next-9.",
        ]);
        expect(yield* store.modelPolicy).toEqual(saved.policy);
        // No computer could be read: the save still goes through.
        const unread = yield* store.saveModelPolicy({
          expectedVersion: 1,
          inventories: [],
          policy: saved.policy,
        });
        expect(unread.policy.version).toBe(2);
        expect(unread.warnings.length).toBeGreaterThan(0);
        // A build from before the ladder saves the table without it: what is stored stays.
        const older = yield* store.saveModelPolicy({
          expectedVersion: 2,
          inventories: [inventory],
          policy: { ...defaultModelRoutingPolicy, maxReassessments: 1 },
        });
        expect(older.policy).toEqual({
          ...defaultModelRoutingPolicy,
          maxReassessments: 1,
          version: 3,
          ladder,
          fallback: null,
        });
        expect(yield* store.modelPolicy).toEqual(older.policy);
        // The stored ladder decides the next start: Opus is drained, no account offers the rung
        // above it, so the rung below it is taken.
        const week = claude.windows[0]!;
        const drained = {
          ...inventory,
          accounts: [
            {
              ...claude,
              windows: [
                week,
                { ...week, id: "week_opus", models: ["claude-opus-5-5"], usedPoints: 100 },
              ],
            },
          ],
        };
        const chosen = yield* store.selectModel({
          ...args,
          reserve: false,
          expectedModelVersion: 3,
          // Difficulty 10, stakes 10 is Opus xhigh.
          request: { ...claudeOnly, assessment: { difficulty: 10, stakes: 10 } },
          inventories: [drained],
        });
        expect(chosen.allocation?.decision.request).toMatchObject({
          model: "claude-sonnet-5-5",
          options: [{ id: "effort", value: "high" }],
        });
      }),
    ),
);
it.effect("chooses the same profile whatever is unread, stale, unavailable or burning fast", () =>
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
              windows: a.windows.map((w) => ({
                ...w,
                usedPoints: 99,
                checkedAt: "2026-10-20T12:00:00.000Z",
                ratePointsPerHour: 20,
                rateAgeMinutes: 0,
                samples: 10,
              })),
            })),
          },
        ],
      ]) {
        const result = yield* store.selectModel({ ...args, reserve: false, inventories });
        expect(result.allocation?.decision.request).toMatchObject({
          driver: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "medium" }],
        });
        expect(result.wanted).toBeUndefined();
      }
      expect(
        (yield* store.selectModel({ ...args, reserve: false, authorityAvailable: false }))
          .allocation,
      ).not.toBeNull();
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

for (const oldOutcome of ["denied", "observation"] as const)
  it.effect(
    `master can choose another account on the same never-started ${oldOutcome} assignment`,
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* setup;
          const sql = yield* SqlClient.SqlClient;
          const ad = inventory.accounts.find((a) => a.driver === "codex")!;
          const catalogs = {
            ...inventory,
            accounts: [
              {
                ...ad,
                instanceId: ProviderInstanceId.make("ad"),
                accountKey: "ad",
                windows: ad.windows.map((w) => ({ ...w, usedPoints: 74 })),
              },
              {
                ...ad,
                instanceId: ProviderInstanceId.make("sl"),
                accountKey: "sl",
                windows: ad.windows.map((w) => ({ ...w, usedPoints: 59 })),
              },
            ],
          };
          const pinned = {
            ...request,
            allowedDrivers: [ProviderDriverKind.make("codex")],
            explicitInstanceId: ProviderInstanceId.make("ad"),
            assessment: { ...request.assessment, difficulty: 7, stakes: 6 },
            override: {
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-6-astra",
              options: [{ id: "reasoningEffort", value: "high" }],
              reason: "Master chose Astra High",
            },
          };
          const proposed = yield* store.selectModel({
            ...args,
            request: pinned,
            inventories: [catalogs],
            reserve: false,
          });
          const previous = {
            ...proposed,
            allocation:
              oldOutcome === "denied"
                ? null
                : { ...proposed.allocation!, reservation: null, mode: "observation" as const },
          };
          yield* sql`INSERT INTO model_selection_decisions (assignment_id,created_at,decision_json) VALUES (${request.assignmentId},${at},${encode(previous)})`;
          const chosen = { ...pinned, explicitInstanceId: ProviderInstanceId.make("sl") };
          const result = yield* store
            .selectModel({ ...args, request: chosen, inventories: [catalogs] })
            .pipe(Effect.provide(Store.layer));
          expect(result.allocation?.decision.selectedInstanceId).toBe("sl");
          expect(result.allocation?.decision.request).toMatchObject({
            assignmentId: "one",
            threadId: "one",
            environmentId: "host",
            model: "gpt-6-astra",
            options: pinned.override.options,
          });
          expect(result.allocation?.decision.reasons[0]).toContain("pinned account.");
          yield* store.lifecycle(
            {
              assignmentId: "one",
              threadId: request.threadId,
              environmentId: "host",
              action: "start",
              startIntent: "chosen-intent",
            },
            at,
          );
          expect(yield* store.selectModel({ ...args, request: chosen, inventories: [] })).toEqual(
            result,
          );
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                store.selectModel({ ...args, request: pinned, inventories: [catalogs] }),
              ),
            ),
          ).toBe(true);
          expect(yield* store.reservations).toHaveLength(1);
        }),
      ),
  );
// A policy as saved before exact-score editing: six shared profiles and a six-band grid.
// Former profile 4 (Astra medium) now uses profile 3 (Sol max).
const bandPolicy = (version: number) => ({
  version,
  codex: {
    profiles: ["medium", "high", "max", "medium", "high", "xhigh"].map((effort, i) => ({
      model: i < 3 ? "gpt-6.1-sol" : "gpt-6-astra",
      effort,
    })),
    grid: [
      [1, 2, 2, 4, 5, 5],
      [2, 2, 3, 4, 5, 5],
      [3, 3, 4, 5, 5, 6],
      [3, 4, 5, 5, 6, 6],
      [5, 5, 5, 6, 6, 6],
      [6, 6, 6, 6, 6, 6],
    ].map((row) => row.map((id) => (id === 4 ? 3 : id))),
    alternatives: [[], [], [], [], [], []],
    allowedModels: ["gpt-6.1-sol", "gpt-6-astra"],
  },
  claudeAgent: defaultModelRoutingPolicy.claudeAgent,
  maxReassessments: 2,
});
const storedPolicy = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      codex: Schema.Struct({
        grid: Schema.optional(Schema.Unknown),
        cells: Schema.optional(Schema.Array(Schema.Unknown)),
      }),
    }),
  ),
);
const codexOnly = { ...request, allowedDrivers: [ProviderDriverKind.make("codex")] };
it.effect("reads a saved band policy as an exact table and keeps its row until the next save", () =>
  run(
    Effect.gen(function* () {
      const store = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO model_selection_policies (version, policy_json) VALUES (${1}, ${encode(bandPolicy(1))})`;
      const resolved = (modelVersion: number, difficulty: number, stakes: number) =>
        store
          .selectModel({
            ...args,
            reserve: false,
            expectedModelVersion: modelVersion,
            request: { ...codexOnly, assessment: { ...request.assessment, difficulty, stakes } },
          })
          .pipe(
            Effect.map((d) => {
              const chosen = d.allocation?.decision.request;
              return chosen ? `${chosen.model}/${chosen.options[0]!.value}` : null;
            }),
          );
      const saved = yield* store.modelPolicy;
      expect(saved.version).toBe(1);
      expect(saved.codex.cells).toHaveLength(11);
      expect(saved.codex.cells[7]![7]).toEqual({ model: "gpt-6.1-sol", effort: "max" });
      expect(saved.codex.cells[7]![8]).toEqual({ model: "gpt-6-astra", effort: "high" });
      // Reading never rewrites the stored row; it stays in its saved shape.
      const stored = () =>
        sql<{
          policy_json: string;
        }>`SELECT policy_json FROM model_selection_policies WHERE version = 1`.pipe(
          Effect.map((rows) => storedPolicy(rows[0]!.policy_json)),
        );
      expect((yield* stored()).codex.grid).toBeDefined();
      expect(yield* resolved(1, 7, 7)).toBe("gpt-6.1-sol/max");
      expect(yield* resolved(1, 7, 8)).toBe("gpt-6-astra/high");
      // Saving one exact pair creates a new exact version; its neighbours keep their choices.
      const edit = {
        ...saved,
        codex: {
          ...saved.codex,
          cells: saved.codex.cells.map((row, d) =>
            row.map((cell, s) =>
              d === 7 && s === 8 ? { model: "gpt-6-astra", effort: "xhigh" } : cell,
            ),
          ),
        },
      };
      const next = yield* store.saveModelPolicy({
        expectedVersion: 1,
        policy: edit,
        inventories: [inventory],
      });
      expect(next.policy.version).toBe(2);
      expect(yield* resolved(2, 7, 8)).toBe("gpt-6-astra/xhigh");
      expect(yield* resolved(2, 7, 7)).toBe("gpt-6.1-sol/max");
      for (const [d, s] of [
        [7, 7],
        [7, 9],
        [8, 8],
        [6, 8],
      ] as const)
        expect(next.policy.codex.cells[d]![s]).toEqual(saved.codex.cells[d]![s]);
      expect((yield* stored()).codex.grid).toBeDefined();
      const latest = yield* sql<{
        policy_json: string;
      }>`SELECT policy_json FROM model_selection_policies WHERE version = 2`;
      expect(storedPolicy(latest[0]!.policy_json).codex.cells).toHaveLength(11);
      // Reverting to the saved band version restores its exact pairs as a new version.
      const reverted = yield* store.saveModelPolicy({
        expectedVersion: 2,
        revertVersion: 1,
        inventories: [inventory],
      });
      expect(reverted.policy).toEqual({ ...saved, version: 3 });
    }),
  ),
);
