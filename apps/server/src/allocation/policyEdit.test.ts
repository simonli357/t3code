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
    // The values behind the choice of computer are edited the same way, one at a time.
    const placed = {
      workerMemoryGiB: 5,
      minFreeMemoryGiB: 6,
      startSettleMinutes: 20,
      sessionReserveGiB: 0.5,
      memoryKillHoldMinutes: 90,
    };
    expect(yield* edit(placed, saved)).toEqual({ ...snapshot(saved).policy, ...placed });
    expect(yield* edit({ minFreeMemoryGiB: 0 }, { ...saved, ...placed })).toEqual({
      ...snapshot(saved).policy,
      ...placed,
      minFreeMemoryGiB: 0,
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
    workerMemoryGiB: 3,
    minFreeMemoryGiB: 4,
    startSettleMinutes: 15,
    sessionReserveGiB: 0.25,
    memoryKillHoldMinutes: 60,
    caps: [{ account: "ES", ...cap }],
    // Without a goal of its own an account reads its provider family's.
    goals: [
      { account: "ES", percentPerDay: 17, from: "family" },
      { account: "XL", percentPerDay: 17, from: "family" },
    ],
    fableGoals: [],
    fableWorkers: true,
    fableAccounts: [],
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
    workerMemoryGiB: _memory,
    minFreeMemoryGiB: _minimum,
    startSettleMinutes: _settle,
    sessionReserveGiB: _reserve,
    memoryKillHoldMinutes: _hold,
    accountCaps: _caps,
    ...old
  } = stored.policy;
  expect(allocationPolicyView({ ...stored, policy: old }, defaultModelRoutingPolicy)).toMatchObject(
    {
      accountOrder: [],
      closeMarginPoints: 10,
      longWaitHours: 3,
      workerMemoryGiB: 3,
      minFreeMemoryGiB: 4,
      startSettleMinutes: 15,
      sessionReserveGiB: 0.25,
      memoryKillHoldMinutes: 60,
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
  expect(custom.table![0]![0]).toBe("gpt-6.2-sol / medium");
  expect(custom.table![10]![10]).toBe("gpt-6.2-astra / xhigh");
});

it.effect("sets Fable mode per account by label or instance ID, and only on Claude accounts", () =>
  Effect.gen(function* () {
    // A Codex login that shares the ES label.
    const codexEs = {
      ...account("box", "codex_es", "ES", "es-codex"),
      driver: ProviderDriverKind.make("codex"),
    };
    const stored = snapshot();
    const withCodex = { ...stored, inventories: [...stored.inventories, host("box", [codexEs])] };
    const set = (fableAccounts: readonly string[], policy?: Partial<AllocationPolicy>) =>
      Effect.map(
        editAllocationPolicy(
          { ...withCodex, policy: { ...withCodex.policy, ...policy } },
          { fableAccounts },
        ),
        (next) => next.fableAccounts,
      );
    // "Only XL", then "XL and ES": the whole list each time; ES names the Claude ES logins.
    expect(yield* set(["XL"])).toEqual([key(xl)]);
    expect(yield* set(["claude_xinya", "ES"], { fableAccounts: [key(es)] })).toEqual([
      key(xl),
      key(es),
      key(unknownEs),
    ]);
    expect(yield* set([], { fableAccounts: [key(xl)] })).toEqual([]);
    expect((yield* Effect.flip(set(["codex_es"]))).detail).toBe(
      "codex_es is not a Claude account; only Claude runs Fable.",
    );
    // An edit that does not name it keeps what is stored.
    expect(
      (yield* edit({ closeMarginPoints: 4 }, { fableAccounts: [key(xl)] })).fableAccounts,
    ).toEqual([key(xl)]);
    // The result names the accounts that are on, also for the single switch stored before.
    const model = defaultModelRoutingPolicy;
    expect(
      allocationPolicyView(snapshot({ fableAccounts: [key(xl)] }), model).fableAccounts,
    ).toEqual(["XL"]);
    expect(allocationPolicyView(snapshot({ fableOnly: true }), model).fableAccounts).toEqual([
      "ES",
      "XL",
    ]);
  }),
);

it.effect("sets and clears Fable goals by label, only on Claude accounts", () =>
  Effect.gen(function* () {
    const codexEs = {
      ...account("box", "codex_es", "ES", "es-codex"),
      driver: ProviderDriverKind.make("codex"),
    };
    const stored = snapshot();
    const withCodex = { ...stored, inventories: [...stored.inventories, host("box", [codexEs])] };
    const change = (edit: AllocationPolicyEdit, policy?: Partial<AllocationPolicy>) =>
      editAllocationPolicy({ ...withCodex, policy: { ...withCodex.policy, ...policy } }, edit);
    // ES names the Claude ES logins, not the Codex one with the same label.
    const set = yield* change({ setFableGoals: [{ account: "ES", percentPerDay: 14 }] });
    expect(set.fableGoals).toEqual([
      { key: key(es), percentPerDay: 14 },
      { key: key(unknownEs), percentPerDay: 14 },
    ]);
    expect(
      allocationPolicyView({ ...withCodex, policy: set }, defaultModelRoutingPolicy).fableGoals,
    ).toEqual([{ account: "ES", percentPerDay: 14 }]);
    // An edit that does not name them keeps them; clearing one leaves the others.
    const both = yield* change({ setFableGoals: [{ account: "XL", percentPerDay: 10 }] }, set);
    expect((yield* change({ closeMarginPoints: 4 }, both)).fableGoals).toEqual(both.fableGoals);
    expect((yield* change({ clearFableGoals: ["claude_eol"] }, both)).fableGoals).toEqual([
      { key: key(unknownEs), percentPerDay: 14 },
      { key: key(xl), percentPerDay: 10 },
    ]);
    expect(
      (yield* Effect.flip(change({ setFableGoals: [{ account: "codex_es", percentPerDay: 14 }] })))
        .detail,
    ).toBe("codex_es is not a Claude account; only Claude runs Fable.");
    // A policy without Fable goals stays without them.
    expect((yield* change({ closeMarginPoints: 4 })).fableGoals).toBeUndefined();
  }),
);

it("keeps Fable mode and Fable workers from contradicting each other", () => {
  const switches = (stored: Partial<AllocationPolicy>, next: Partial<AllocationPolicy>) => {
    const saved = withFableSwitches(snapshot(stored).policy, snapshot(next).policy);
    return {
      fableWorkers: saved.fableWorkers,
      fableAccounts: saved.fableAccounts,
      fableOnly: saved.fableOnly,
    };
  };
  // Turning an account's Fable mode on turns Fable workers on.
  expect(
    switches({ fableWorkers: false }, { fableWorkers: false, fableAccounts: [key(xl)] }),
  ).toEqual({ fableWorkers: true, fableAccounts: [key(xl)], fableOnly: undefined });
  // Turning Fable workers off turns every account's Fable mode off.
  const both = [key(xl), key(es)];
  expect(switches({ fableAccounts: both }, { fableAccounts: both, fableWorkers: false })).toEqual({
    fableWorkers: false,
    fableAccounts: [],
    fableOnly: undefined,
  });
  // One save that does both: Fable mode wins.
  expect(
    switches({ fableAccounts: [key(xl)] }, { fableAccounts: both, fableWorkers: false }),
  ).toEqual({ fableWorkers: true, fableAccounts: both, fableOnly: undefined });
  // The single switch stored before: a list replaces it, and Fable workers off turns it off.
  expect(switches({ fableOnly: true }, { fableOnly: true, fableAccounts: [key(xl)] })).toEqual({
    fableWorkers: undefined,
    fableAccounts: [key(xl)],
    fableOnly: undefined,
  });
  expect(switches({ fableOnly: true }, { fableOnly: true, fableWorkers: false })).toEqual({
    fableWorkers: false,
    fableAccounts: [],
    fableOnly: undefined,
  });
  // Anything that does not contradict is stored as sent.
  expect(switches({ fableOnly: true }, { fableOnly: true })).toEqual({
    fableWorkers: undefined,
    fableAccounts: undefined,
    fableOnly: true,
  });
  expect(switches({}, { fableWorkers: false })).toEqual({
    fableWorkers: false,
    fableAccounts: undefined,
    fableOnly: undefined,
  });
});

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
      { table: "codex", difficulty: 10, stakes: 0, model: "gpt-6.2-astra", effort: "low" },
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
  expect(next.codex.cells[10]![0]).toEqual({ model: "gpt-6.2-astra", effort: "low" });
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
