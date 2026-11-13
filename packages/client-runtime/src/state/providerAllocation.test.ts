import { expect, it } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  allocationPreferenceKey,
  type AllocationAccount,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import {
  allocationAccountGroups,
  allocationAccountOrder,
  allocationAccountRows,
  allocationModelChoices,
  allocationMoved,
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
  expect(sl.windows).toEqual([
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
