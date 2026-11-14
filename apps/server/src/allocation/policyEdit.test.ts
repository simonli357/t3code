import { expect, it } from "@effect/vitest";
import {
  allocationPreferenceKey,
  defaultAllocationPolicy,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationAccount,
  type AllocationPolicy,
  type AllocationPolicyEdit,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideAllocation } from "./decision.ts";
import {
  allocationPolicyView,
  editAllocationPolicy,
  editModelPolicy,
  withFableSwitches,
} from "./policyEdit.ts";

const at = "2026-11-09T12:00:00.000Z";
const account = (
  environmentId: string,
  instanceId: string,
  label: string,
  accountKey: string | null,
  usedPoints = 30,
): AllocationAccount => ({
  environmentId,
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  accountKey,
  label,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [{ slug: "claude-sonnet-5-5", capabilities: null }],
  shortWindow: "unknown",
  windows: [
    {
      id: "weekly",
      label: "Weekly",
      kind: "weekly",
      usedPoints,
      checkedAt: at,
      resetsAt: null,
      cycleStartedAt: null,
      durationHours: 168,
      ratePointsPerHour: null,
      samples: 0,
      rateAgeMinutes: null,
    },
  ],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
});
const es = account("desk", "claude_eol", "ES", "es-login");
const xl = account("desk", "claude_xinya", "XL", "xl-login");
const unknownEs = account("laptop", "local", "ES", null);
const key = allocationPreferenceKey;
const host = (environmentId: string, accounts: AllocationAccount[]) => ({
  environmentId,
  observedAt: at,
  complete: true,
  demand: [],
  notices: [],
  accounts,
});
const snapshot = (policy: Partial<AllocationPolicy> = {}): AllocationSnapshot => ({
  accountCapsSupported: true,
  accountOrderSupported: true,
  policy: { ...defaultAllocationPolicy, version: 3, ...policy },
  inventories: [
    host("desk", [es, xl]),
    // The same ES login under another alias, and an account whose login is unknown.
    host("laptop", [account("laptop", "claude_es_laptop", "ES", "es-login"), unknownEs]),
  ],
  reservations: [],
  history: [],
  authorityAvailable: true,
  notices: [],
});
const edit = (change: AllocationPolicyEdit, policy?: Partial<AllocationPolicy>) =>
  editAllocationPolicy(snapshot(policy), change);
const cap = { weeklyPercent: 80, fiveHourPercent: null, stopWorkers: true, stopMasters: false };

it.effect("resolves labels and instance IDs to the shared account identity", () =>
  Effect.gen(function* () {
    // Any case, and any of the login's instance IDs on any computer.
    expect((yield* edit({ accountOrder: ["xl", "claude_es_laptop"] })).accountOrder).toEqual([
      key(xl),
      key(es),
    ]);
    // A label covers the shared login and any account whose login is unknown.
    expect((yield* edit({ accountOrder: ["ES"] })).accountOrder).toEqual([key(es), key(unknownEs)]);
    // Naming one account twice lists it once.
    expect(
      (yield* edit({ accountOrder: ["claude_eol", "XL", "claude_es_laptop"] })).accountOrder,
    ).toEqual([key(es), key(xl)]);
    const unknown = yield* Effect.flip(edit({ accountOrder: ["AD"] }));
    expect(unknown).toMatchObject({ code: "invalid" });
    expect(unknown.detail).toContain('No account matches "AD"');
    expect(unknown.detail).toContain("XL (claude_xinya)");
  }),
);

it.effect("replaces the whole order and changes only what the edit names", () =>
  Effect.gen(function* () {
    const saved = {
      accountOrder: [key(xl), key(es)],
      closeMarginPoints: 5,
      longWaitHours: 2,
      accountCaps: [{ key: key(xl), ...cap }],
    };
    expect((yield* edit({ accountOrder: ["ES"] }, saved)).accountOrder).toEqual([
      key(es),
      key(unknownEs),
    ]);
    expect((yield* edit({ accountOrder: [] }, saved)).accountOrder).toEqual([]);
    const next = yield* edit({ closeMarginPoints: 20, longWaitHours: 0.5 }, saved);
    expect(next).toEqual({
      ...snapshot(saved).policy,
      closeMarginPoints: 20,
      longWaitHours: 0.5,
    });
    // Nothing named: the stored policy, with the fields older builds require.
    expect(yield* edit({}, saved)).toEqual(snapshot(saved).policy);
    expect(yield* edit({ ladder: [], showTable: "codex" }, saved)).toEqual(snapshot(saved).policy);
  }),
);

it.effect("sets and clears hard caps", () =>
  Effect.gen(function* () {
    const next = yield* edit({ setCaps: [{ account: "XL", ...cap }] });
    expect(next.accountCaps).toEqual([{ key: key(xl), ...cap }]);
    // Setting again replaces; a clear and a set in one edit both apply.
    const changed = yield* edit(
      {
        clearCaps: ["claude_xinya"],
        setCaps: [{ account: "claude_eol", ...cap, weeklyPercent: 50, stopMasters: true }],
      },
      next,
    );
    expect(changed.accountCaps).toEqual([
      { key: key(es), ...cap, weeklyPercent: 50, stopMasters: true },
    ]);
    expect(
      (yield* edit({ setCaps: [{ account: "ES", ...cap, weeklyPercent: 60 }] }, changed))
        .accountCaps,
    ).toEqual([
      { key: key(es), ...cap, weeklyPercent: 60 },
      { key: key(unknownEs), ...cap, weeklyPercent: 60 },
    ]);
    expect((yield* edit({ clearCaps: ["ES"] }, changed)).accountCaps).toEqual([]);
    expect((yield* Effect.flip(edit({ clearCaps: ["nobody"] }))).detail).toContain("No account");
  }),
);

it("reads both policies with accounts by label", () => {
  const stored = snapshot({
    accountOrder: [key(xl), key(es), "gone"],
    closeMarginPoints: 7,
    longWaitHours: 1.5,
    accountCaps: [{ key: key(es), ...cap }],
  });
  const view = allocationPolicyView(stored, { ...defaultModelRoutingPolicy, version: 9 });
  expect(view).toEqual({
    version: 3,
    modelVersion: 9,
    // An account that is no longer connected reads back as its stored key.
    accountOrder: ["XL", "ES", "gone"],
    closeMarginPoints: 7,
    longWaitHours: 1.5,
    caps: [{ account: "ES", ...cap }],
    // Without a goal of its own an account reads its provider family's.
    goals: [
      { account: "ES", percentPerDay: 17, from: "family" },
      { account: "XL", percentPerDay: 17, from: "family" },
    ],
    fableWorkers: true,
    fableOnly: false,
    ladder: defaultModelLadder.map(({ model, effort }) => `${model} / ${effort}`),
    fallback: "deepseek-flash / max when the wanted rung is below claude-sonnet-5-5 / xhigh",
    accounts: [
      { label: "ES", driver: "claudeAgent", instanceIds: ["claude_eol", "claude_es_laptop"] },
      { label: "XL", driver: "claudeAgent", instanceIds: ["claude_xinya"] },
      { label: "ES", driver: "claudeAgent", instanceIds: ["local"] },
    ],
    warnings: [],
  });
  // A policy saved before these fields reads with the defaults.
  const {
    accountOrder: _order,
    closeMarginPoints: _margin,
    longWaitHours: _wait,
    accountCaps: _caps,
    ...old
  } = stored.policy;
  expect(allocationPolicyView({ ...stored, policy: old }, defaultModelRoutingPolicy)).toMatchObject(
    {
      accountOrder: [],
      closeMarginPoints: 10,
      longWaitHours: 3,
      caps: [],
    },
  );

  const custom = allocationPolicyView(
    stored,
    {
      ...defaultModelRoutingPolicy,
      ladder: [{ model: "claude-next-9", effort: "high" }],
      fallback: null,
    },
    { showTable: "codex", warnings: ["Ladder: no connected account offers claude-next-9."] },
  );
  expect(custom.ladder).toEqual(["claude-next-9 / high"]);
  expect(custom.fallback).toBeNull();
  expect(custom.warnings).toEqual(["Ladder: no connected account offers claude-next-9."]);
  expect(custom.table).toHaveLength(11);
  expect(custom.table![0]).toHaveLength(11);
  expect(custom.table![0]![0]).toBe("gpt-6.1-sol / medium");
  expect(custom.table![10]![10]).toBe("gpt-6-astra / xhigh");
});

it.effect("keeps the two Fable switches from contradicting each other", () =>
  Effect.gen(function* () {
    const switches = (policy: AllocationPolicy) => ({
      fableWorkers: policy.fableWorkers,
      fableOnly: policy.fableOnly,
    });
    const save = (stored: Partial<AllocationPolicy>, change: AllocationPolicyEdit) =>
      Effect.map(edit(change, stored), (next) =>
        switches(withFableSwitches(snapshot(stored).policy, next)),
      );
    // Turning Fable mode on turns Fable workers on.
    expect(yield* save({ fableWorkers: false }, { fableOnly: true })).toEqual({
      fableWorkers: true,
      fableOnly: true,
    });
    // Turning Fable workers off turns Fable mode off.
    expect(yield* save({ fableOnly: true }, { fableWorkers: false })).toEqual({
      fableWorkers: false,
      fableOnly: false,
    });
    // Anything that does not contradict is stored as sent.
    expect(yield* save({ fableOnly: true }, { fableOnly: false })).toEqual({
      fableWorkers: undefined,
      fableOnly: false,
    });
    expect(yield* save({}, { fableWorkers: false })).toEqual({
      fableWorkers: false,
      fableOnly: undefined,
    });
  }),
);

it.effect("lists an account with no known login once and prefers it on every computer", () =>
  Effect.gen(function* () {
    // DS has no known login on any of three computers, so each computer keys it separately.
    const computers = ["desk", "laptop", "server"].map((environmentId) =>
      host(environmentId, [
        account(environmentId, "ds", "DS", null, 35),
        account(environmentId, "other", "Other", `other-${environmentId}`, 30),
      ]),
    );
    const everywhere = { ...snapshot(), inventories: computers };
    expect(allocationPolicyView(everywhere, defaultModelRoutingPolicy).accounts[0]).toEqual({
      label: "DS",
      driver: "claudeAgent",
      instanceIds: ["ds"],
    });
    const policy = yield* editAllocationPolicy(everywhere, {
      accountOrder: ["DS"],
      setCaps: [{ account: "ds", ...cap }],
    });
    expect(policy.accountOrder).toHaveLength(3);
    expect(policy.accountCaps).toHaveLength(3);
    // Three stored entries read back as one.
    const view = allocationPolicyView({ ...everywhere, policy }, defaultModelRoutingPolicy);
    expect(view.accountOrder).toEqual(["DS"]);
    expect(view.caps).toEqual([{ account: "DS", ...cap }]);
    // DS has a little less room than the other account on each computer: the order decides.
    const chosen = (decided: AllocationPolicy) =>
      computers.map(
        ({ environmentId }) =>
          decideAllocation({
            at,
            policy: decided,
            request: {
              assignmentId: "job",
              environmentId,
              threadId: ThreadId.make("thread"),
              driver: ProviderDriverKind.make("claudeAgent"),
              model: "claude-sonnet-5-5",
              options: [],
            },
            inventories: computers,
            reservations: [],
            authorityAvailable: true,
          }).selectedInstanceId,
      );
    expect(chosen(everywhere.policy)).toEqual(["other", "other", "other"]);
    expect(chosen({ ...policy, accountCaps: [] })).toEqual(["ds", "ds", "ds"]);
    const cleared = yield* editAllocationPolicy(
      { ...everywhere, policy },
      { accountOrder: [], clearCaps: ["DS"] },
    );
    expect(cleared.accountOrder).toEqual([]);
    expect(cleared.accountCaps).toEqual([]);
  }),
);

it("writes table entries for a range of scores and accepts any model ID", () => {
  const policy = defaultModelRoutingPolicy;
  const next = editModelPolicy(policy, {
    setCells: [
      {
        difficulty: 2,
        difficultyTo: 3,
        stakes: 5,
        stakesTo: 4,
        model: "claude-next-9",
        effort: "high",
      },
      { table: "codex", difficulty: 10, stakes: 0, model: "gpt-6-astra", effort: "low" },
    ],
  });
  for (const [d, row] of next.claudeAgent.cells.entries())
    for (const [s, cell] of row.entries())
      expect(cell).toEqual(
        (d === 2 || d === 3) && (s === 4 || s === 5)
          ? { model: "claude-next-9", effort: "high" }
          : policy.claudeAgent.cells[d]![s],
      );
  // A model the code has never heard of joins the table's model list; a listed one is not repeated.
  expect(next.claudeAgent.allowedModels).toEqual([
    ...policy.claudeAgent.allowedModels,
    "claude-next-9",
  ]);
  expect(next.codex.cells[10]![0]).toEqual({ model: "gpt-6-astra", effort: "low" });
  expect(next.codex.cells[10]![1]).toEqual(policy.codex.cells[10]![1]);
  expect(next.codex.allowedModels).toEqual(policy.codex.allowedModels);
  // A later entry for the same pair wins.
  const twice = editModelPolicy(policy, {
    setCells: [
      { difficulty: 0, difficultyTo: 10, stakes: 0, stakesTo: 10, model: "a", effort: "low" },
      { difficulty: 4, stakes: 4, model: "b", effort: "max" },
    ],
  });
  expect(twice.claudeAgent.cells[4]![4]).toEqual({ model: "b", effort: "max" });
  expect(twice.claudeAgent.cells[4]![5]).toEqual({ model: "a", effort: "low" });
});

it("replaces the ladder and the fallback only when the edit names them", () => {
  const stored = {
    ...defaultModelRoutingPolicy,
    ladder: [{ model: "claude-sonnet-5-5", effort: "high" }],
    fallback: {
      model: "kimi",
      effort: "max",
      below: { model: "claude-sonnet-5-5", effort: "high" },
    },
  };
  expect(editModelPolicy(stored, { accountOrder: ["ES"], closeMarginPoints: 3 })).toEqual(stored);
  const ladder = [
    { model: "claude-haiku-5-5", effort: "max" },
    { model: "claude-next-9", effort: "high" },
  ];
  expect(editModelPolicy(stored, { ladder })).toEqual({ ...stored, ladder });
  // Null turns the fallback off; leaving it out keeps it.
  expect(editModelPolicy(stored, { fallback: null })).toEqual({ ...stored, fallback: null });
  expect(editModelPolicy(defaultModelRoutingPolicy, { ladder })).toEqual({
    ...defaultModelRoutingPolicy,
    ladder,
  });
});
