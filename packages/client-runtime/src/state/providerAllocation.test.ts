import { expect, it } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  legacyAllocationPolicyFields,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  allocationPreferenceKey,
  type AllocationAccount,
  type AllocationPolicy,
  type AllocationSnapshot,
  AllocationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import {
  allocationAccountGroups,
  allocationAccountOrder,
  allocationAccountRows,
  allocationModelChoices,
  allocationMoved,
  allocationPolicyChanges,
  allocationPolicyInvalid,
  allocationResetIn,
  allocationSaveFailure,
  rebaseAllocationPolicy,
  withAllocationAccountFableMode,
  withAllocationAccountGoal,
  withAllocationAccountMoved,
  withModelLadderEdit,
} from "./providerAllocation.ts";
const account = (
  environmentId: string,
  instanceId: string,
  label: string,
  accountKey: string | null,
  driver = "codex",
): AllocationAccount => ({
  environmentId,
  instanceId: ProviderInstanceId.make(instanceId),
  label,
  accountKey,
  driver: ProviderDriverKind.make(driver),
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [{ slug: "astra", capabilities: null }],
  shortWindow: "unknown",
  windows: [],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
});
const accounts = [
  account("alien", "codex", "SL", "sl"),
  account("acer", "codex_sl", "SL", "sl"),
  account("sliara", "codex", "SL", "sl"),
  account("alien", "codex_ad", "AD", "ad"),
  account("acer", "codex_ara", "ARA", "ara"),
  account("alien", "claude_es", "ES", "es", "claudeAgent"),
  account("sliara", "claude", "XL", "xl", "claudeAgent"),
];
const snapshot = (items = accounts): AllocationSnapshot => ({
  policy: defaultAllocationPolicy,
  authorityAvailable: true,
  notices: [],
  reservations: [],
  history: [],
  inventories: ["alien", "acer", "sliara"].map((environmentId) => ({
    environmentId,
    environmentLabel: environmentId,
    observedAt: "2026-10-24T12:00:00.000Z",
    complete: true,
    notices: [],
    demand: [],
    accounts: items.filter((a) => a.environmentId === environmentId),
  })),
});
it("counts known aliases once across three hosts in a stable order", () => {
  const groups = allocationAccountGroups(snapshot());
  expect(groups).toHaveLength(5);
  expect(groups.find((a) => a.label === "SL")?.hosts).toHaveLength(3);
  expect(groups.find((a) => a.label === "SL")?.key).toBe(allocationPreferenceKey(accounts[0]!));
  expect(allocationAccountGroups(snapshot(accounts.toReversed()))).toEqual(groups);
});
it("lists an account with no known login once, holding each computer's key", () => {
  const unknown = [
    account("alien", "codex", "SL", null),
    account("acer", "codex", "SL", null),
    account("sliara", "codex", "SL", null),
    account("sliara", "claude", "SL", null, "claudeAgent"),
  ];
  const groups = allocationAccountGroups(snapshot(unknown));
  expect(groups).toHaveLength(2);
  const codex = groups.find((g) => g.driver === "codex")!;
  expect(codex.hosts).toEqual(["acer", "alien", "sliara"]);
  expect(codex.keys).toEqual(unknown.slice(0, 3).map(allocationPreferenceKey).sort());
  expect(codex.key).toBe(codex.keys[0]);
  expect(allocationAccountGroups(snapshot(unknown.toReversed()))).toEqual(groups);
});
const now = Date.parse("2026-10-24T12:00:00.000Z");
const window = (
  usedPoints: number,
  checkedAt: string,
  id = "seven_day",
  kind: "weekly" | "session" = "weekly",
) => ({
  id,
  label: kind === "weekly" ? "Weekly" : "5 hours",
  kind,
  usedPoints,
  checkedAt,
  resetsAt: "2026-10-28T12:00:00.000Z",
  cycleStartedAt: null,
  durationHours: kind === "weekly" ? 168 : 5,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
});
const demand = (
  environmentId: string,
  instanceId: string,
  accountKey: string,
  worker?: boolean,
) => ({
  environmentId,
  threadId: ThreadId.make(`${environmentId}-${instanceId}-${String(worker)}`),
  instanceId: ProviderInstanceId.make(instanceId),
  accountKey,
  model: "astra",
  options: [],
  state: "running" as const,
  ...(worker === undefined ? {} : { worker }),
});

it("gives each login its live numbers: windows from the newest reading, workers and caps", () => {
  const unsupported = { usageLimitsUnavailableReason: "unsupported" as const };
  let state = snapshot([
    {
      ...accounts[0]!,
      windows: [
        window(40, "2026-10-24T10:00:00.000Z"),
        window(12, "2026-10-24T10:00:00.000Z", "five_hour", "session"),
      ],
    },
    { ...accounts[1]!, windows: [window(55, "2026-10-24T11:57:00.000Z")] },
    { ...account("acer", "codex_ara", "ARA", "ara"), availableForWorkers: false },
    { ...account("acer", "codex_off", "OFF", "off"), enabled: false },
    { ...account("acer", "grok", "Grok", null, "grok"), ...unsupported },
    { ...account("acer", "pi", "Pi", null, "pi"), ...unsupported },
  ]);
  const running = [
    demand("alien", "codex", "sl", true),
    demand("alien", "codex", "sl"),
    demand("alien", "codex", "sl", false),
    demand("acer", "codex_sl", "sl", true),
  ];
  state = {
    ...state,
    inventories: state.inventories.map((inventory) => ({
      ...inventory,
      demand: running.filter((d) => d.environmentId === inventory.environmentId),
    })),
  };
  const pi = allocationAccountGroups(state).find((group) => group.label === "Pi")!;
  const policy = {
    ...defaultAllocationPolicy,
    accountCaps: [
      {
        key: pi.key,
        weeklyPercent: 80,
        fiveHourPercent: null,
        stopWorkers: true,
        stopMasters: false,
      },
    ],
  };
  const rows = allocationAccountRows({ ...state, policy }, policy, now);
  expect(rows.map((row) => [row.label, row.other])).toEqual([
    ["ARA", false],
    ["OFF", true],
    ["SL", false],
    ["Grok", true],
    // A saved cap keeps a quota-less account with the rest.
    ["Pi", false],
  ]);
  const sl = rows.find((row) => row.label === "SL")!;
  expect(sl.windows).toMatchObject([
    {
      id: "seven_day",
      label: "Weekly",
      kind: "weekly",
      models: [],
      usedPercent: 55,
      resetsAt: "2026-10-28T12:00:00.000Z",
      checkedAt: "2026-10-24T11:57:00.000Z",
      age: "3 min",
    },
    expect.objectContaining({ id: "five_hour", usedPercent: 12, age: "2 h" }),
  ]);
  expect(sl.workers).toBe(2);
  expect(sl.workersEnabled).toBe(true);
  expect(sl.instances).toEqual([
    { environmentId: "alien", computer: "alien", instanceId: "codex", workersEnabled: true },
    { environmentId: "acer", computer: "acer", instanceId: "codex_sl", workersEnabled: true },
  ]);
  const ara = rows.find((row) => row.label === "ARA")!;
  expect([ara.workers, ara.workersEnabled, ara.workersOffOn]).toEqual([0, false, ["acer"]]);
  expect(rows.find((row) => row.label === "Pi")?.cap?.weeklyPercent).toBe(80);
});

it("orders logins by the policy, then the rest, and moves one up or down", () => {
  const rows = allocationAccountRows(snapshot(), defaultAllocationPolicy, now);
  const labels = (policy = defaultAllocationPolicy) =>
    allocationAccountOrder(rows, policy).map((row) => row.label);
  expect(labels()).toEqual(["ES", "XL", "AD", "ARA", "SL"]);
  const key = (label: string) => rows.find((row) => row.label === label)!.key;
  const listed = { ...defaultAllocationPolicy, accountOrder: ["gone", key("SL"), key("XL")] };
  expect(labels(listed)).toEqual(["SL", "XL", "ES", "AD", "ARA"]);
  const moved = withAllocationAccountMoved(listed, rows, key("ES"), -1);
  expect(labels(moved)).toEqual(["SL", "ES", "XL", "AD", "ARA"]);
  // Every shown login is now listed, and a key for a login that is not shown is kept.
  expect(moved.accountOrder).toEqual([...["SL", "ES", "XL", "AD", "ARA"].map(key), "gone"]);
  expect(labels(withAllocationAccountMoved(moved, rows, key("SL"), -1))).toEqual(labels(moved));
  expect(labels(withAllocationAccountMoved(moved, rows, key("AD"), 1))).toEqual([
    "SL",
    "ES",
    "XL",
    "ARA",
    "AD",
  ]);
  expect(allocationMoved([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
});

it("reads each login's daily goal, its own or its provider's, and sets or clears its own", () => {
  const goal = (policy = defaultAllocationPolicy) =>
    Object.fromEntries(
      allocationAccountRows(snapshot(), policy, now).map((row) => [row.label, row.goal]),
    );
  const claude = { ...legacyAllocationPolicyFields.claude, dailyPoints: 20 };
  const stored = { ...defaultAllocationPolicy, claude };
  expect(goal(stored)).toMatchObject({
    ES: { percentPerDay: 20, own: false },
    SL: { percentPerDay: 10, own: false },
  });
  const sl = allocationAccountRows(snapshot(), stored, now).find((row) => row.label === "SL")!;
  const set = withAllocationAccountGoal(stored, sl, 12);
  expect(goal(set)).toMatchObject({
    ES: { percentPerDay: 20, own: false },
    SL: { percentPerDay: 12, own: true },
  });
  // The family values are the user's and stay as they are.
  expect(set.claude).toEqual(claude);
  expect(goal(withAllocationAccountGoal(set, sl, undefined)).SL).toEqual({
    percentPerDay: 10,
    own: false,
  });
});

it("switches Fable mode per Claude login, starting from the single switch stored before", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const fableMode = (policy: AllocationPolicy) =>
    Object.fromEntries(
      allocationAccountRows(snapshot(), policy, now).map((row) => [row.label, row.fableMode]),
    );
  // Codex logins have no switch.
  expect(fableMode(defaultAllocationPolicy)).toEqual({
    AD: null,
    ARA: null,
    SL: null,
    ES: false,
    XL: false,
  });
  const legacy = { ...defaultAllocationPolicy, fableOnly: true };
  expect(fableMode(legacy)).toMatchObject({ ES: true, XL: true });
  // Turning one login off keeps the others on, as a list that replaces the single switch.
  const es = allocationAccountRows(snapshot(), legacy, now).find((row) => row.label === "ES")!;
  const next = withAllocationAccountFableMode(legacy, snapshot(), es, false);
  expect(next.fableOnly).toBeUndefined();
  expect(next.fableAccounts).toEqual([allocationPreferenceKey(accounts[6]!)]);
  expect(fableMode(next)).toMatchObject({ ES: false, XL: true });
  expect(withAllocationAccountFableMode(next, snapshot(), es, true).fableAccounts).toEqual([
    allocationPreferenceKey(accounts[6]!),
    allocationPreferenceKey(accounts[5]!),
  ]);
});
it("edits the ladder starting from the default one", () => {
  const rung = { model: "typed-model", effort: "high" };
  const added = withModelLadderEdit(defaultModelRoutingPolicy, { type: "add", rung });
  expect(added.ladder).toEqual([...defaultModelLadder, rung]);
  const last = added.ladder!.length - 1;
  const moved = withModelLadderEdit(added, { type: "move", index: last, delta: -1 });
  expect(moved.ladder?.at(-2)).toEqual(rung);
  const set = withModelLadderEdit(moved, { type: "set", index: last - 1, rung: { effort: "low" } });
  expect(set.ladder?.at(-2)).toEqual({ model: "typed-model", effort: "low" });
  expect(withModelLadderEdit(set, { type: "remove", index: last - 1 }).ladder).toEqual(
    defaultModelLadder,
  );
});

it("lists the models connected accounts offer with their efforts", () => {
  const efforts = (ids: string[]) => ({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select" as const,
        options: ids.map((id) => ({ id, label: id })),
      },
    ],
  });
  const state = snapshot([
    { ...accounts[0]!, models: [{ slug: "astra", capabilities: efforts(["low", "high"]) }] },
    { ...accounts[1]!, models: [{ slug: "astra", capabilities: efforts(["high", "max"]) }] },
    accounts[5]!,
  ]);
  expect(allocationModelChoices(state.inventories, "codex")).toEqual([
    { model: "astra", efforts: ["low", "high", "max"] },
  ]);
  expect(allocationModelChoices(state.inventories).map((choice) => choice.model)).toEqual([
    "astra",
  ]);
});

const capOf = (key: string, weeklyPercent: number) => ({
  key,
  weeklyPercent,
  fiveHourPercent: null,
  stopWorkers: true,
  stopMasters: false,
});

it("names what an edit changed, by value and by account", () => {
  const base: AllocationPolicy = {
    ...defaultAllocationPolicy,
    version: 4,
    accountCaps: [capOf("a", 50), capOf("b", 60)],
  };
  const mine = {
    ...base,
    closeMarginPoints: 20,
    accountCaps: [capOf("a", 40)],
    accountGoals: [{ key: "a", percentPerDay: 12 }],
  };
  expect([...allocationPolicyChanges(base, mine)].sort()).toEqual([
    "cap:a",
    "cap:b",
    "closeMarginPoints",
    "goal:a",
  ]);
  // The version is not a value, and the order of an object's keys does not matter.
  const reordered = base.accountCaps!.map(({ key, ...rest }) => ({ ...rest, key }));
  expect(allocationPolicyChanges(base, { ...base, version: 9, accountCaps: reordered }).size).toBe(
    0,
  );
});

it("applies an edit onto settings stored elsewhere and says when both changed the same value", () => {
  const base: AllocationPolicy = {
    ...defaultAllocationPolicy,
    version: 4,
    accountCaps: [capOf("a", 50), capOf("b", 60)],
  };
  const mine = {
    ...base,
    closeMarginPoints: 20,
    accountCaps: [capOf("a", 40)],
    accountGoals: [{ key: "a", percentPerDay: 12 }],
  };
  // Stored elsewhere as version 5: another value, and a cap for a third account.
  const theirs = {
    ...base,
    version: 5,
    longWaitHours: 9,
    accountCaps: [...base.accountCaps!, capOf("c", 70)],
  };
  const merged = rebaseAllocationPolicy(base, mine, theirs);
  expect(merged.collides).toBe(false);
  expect(merged.policy).toMatchObject({
    version: 5,
    closeMarginPoints: 20,
    longWaitHours: 9,
    accountGoals: [{ key: "a", percentPerDay: 12 }],
  });
  // My cap for a, theirs for c, and b stays removed.
  expect(merged.policy.accountCaps).toEqual([capOf("c", 70), capOf("a", 40)]);
  expect(allocationPolicyChanges(theirs, merged.policy)).toEqual(
    allocationPolicyChanges(base, mine),
  );

  const both = (patch: Partial<AllocationPolicy>) =>
    rebaseAllocationPolicy(base, mine, { ...theirs, ...patch });
  expect(both({ closeMarginPoints: 30 }).collides).toBe(true);
  expect(both({ closeMarginPoints: 30 }).policy.closeMarginPoints).toBe(20);
  // The very same value stored elsewhere is no collision.
  expect(both({ closeMarginPoints: 20 }).collides).toBe(false);
  expect(both({ accountCaps: [capOf("a", 45), capOf("b", 60)] }).collides).toBe(true);
  expect(both({ accountCaps: [capOf("a", 50)] }).collides).toBe(false);
});

it("refuses a number out of range before it is sent, naming it", () => {
  const policy: AllocationPolicy = { ...defaultAllocationPolicy, version: 1 };
  expect(allocationPolicyInvalid(policy)).toBeNull();
  expect(allocationPolicyInvalid({ ...policy, closeMarginPoints: 51 })).toBe(
    "The margin must be a number from 0 to 50.",
  );
  expect(allocationPolicyInvalid({ ...policy, longWaitHours: Number.NaN })).toBe(
    "The wait must be a number from 0 to 168.",
  );
  expect(allocationPolicyInvalid({ ...policy, sessionReserveGiB: 17 })).toBe(
    "Session reserve must be a number from 0 to 16.",
  );
  expect(allocationPolicyInvalid({ ...policy, memoryKillHoldMinutes: 1441 })).toBe(
    "Memory kill hold must be a number from 0 to 1440.",
  );
  expect(allocationPolicyInvalid({ ...policy, accountCaps: [capOf("a", 101)] })).toBe(
    "A cap must be a number from 0 to 100.",
  );
  expect(
    allocationPolicyInvalid({ ...policy, accountGoals: [{ key: "a", percentPerDay: -1 }] }),
  ).toBe("A daily goal must be a number from 0 to 100.");
});

it("tells a newer stored version from a save that failed", () => {
  const refused = (code: "conflict" | "unavailable") =>
    Cause.fail(new AllocationError({ code, detail: "The settings computer is off." }));
  expect(allocationSaveFailure(refused("conflict"))).toEqual({ conflict: true });
  expect(allocationSaveFailure(refused("unavailable"))).toEqual({
    error: "The settings computer is off.",
  });
  // Anything else, such as a dropped connection, is not the user's to read.
  for (const cause of [undefined, Cause.fail(new Error("socket closed"))])
    expect(allocationSaveFailure(cause)).toEqual({
      error: "The computer that keeps these settings did not answer.",
    });
});

it("says how long until a limit resets in a few characters", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const resetIn = (at: string | null) => allocationResetIn(at, now);
  expect(resetIn("2026-11-22T06:00:00.000Z")).toBe("in 6d 18h");
  expect(resetIn("2026-11-15T14:10:00.000Z")).toBe("in 2h 10m");
  expect(resetIn("2026-11-15T12:45:00.000Z")).toBe("in 45m");
  expect(resetIn("2026-11-15T11:00:00.000Z")).toBe("reset");
  expect(resetIn(null)).toBeNull();
});

it("gives each limit a short line with the rest behind it, and a notice only when the account is tight", () => {
  const now = Date.parse("2026-11-15T12:00:00.000Z");
  const claude = {
    ...account("sliara", "claude", "XL", "xl", "claudeAgent"),
    windows: [
      {
        id: "seven_day",
        label: "Weekly",
        kind: "weekly" as const,
        usedPoints: 16,
        checkedAt: "2026-11-15T11:59:00.000Z",
        resetsAt: "2026-11-22T06:00:00.000Z",
        cycleStartedAt: "2026-11-15T06:00:00.000Z",
        durationHours: 168,
        ratePointsPerHour: null,
        samples: 0,
        rateAgeMinutes: null,
      },
    ],
  };
  const key = allocationPreferenceKey(claude);
  const policy: AllocationPolicy = { ...defaultAllocationPolicy, accountCaps: [capOf(key, 10)] };
  const rows = (tight: boolean | undefined, line: string) =>
    allocationAccountRows(
      {
        ...snapshot([claude]),
        policy,
        runways: [
          {
            key,
            label: "XL",
            line,
            ...(tight === undefined ? {} : { tight }),
            windows: [
              {
                id: "seven_day",
                label: "Weekly",
                meterPercent: 16,
                goalPercent: 5,
                sizeDollars: 1603.4,
                source: "estimated",
              },
            ],
          },
        ],
      },
      policy,
      now,
    );
  const stopped = "Weekly reached its 10% hard cap; it resets in about 6d 18h.";
  const [row] = rows(true, stopped);
  expect(row!.windows).toMatchObject([
    {
      label: "Weekly",
      usedPercent: 16,
      resetIn: "in 6d 18h",
      stale: false,
      capPercent: 10,
      detail:
        "read 1 min ago · holds about $1,603 (estimated) · daily goal allows 5% by now · hard cap 10%",
    },
  ]);
  expect(row!.notice).toBe(stopped);
  const room = "No limit runs out before its reset at the current load (0 working sessions).";
  expect(rows(false, room)[0]!.notice).toBeNull();
  // A settings computer from before the flag: its line is shown as it was.
  expect(rows(undefined, room)[0]!.notice).toBe(room);
  // No reading at all is said in its place.
  expect(
    allocationAccountRows(snapshot([{ ...claude, windows: [] }]), policy, now)[0]!.notice,
  ).toBe("No reading");
});
