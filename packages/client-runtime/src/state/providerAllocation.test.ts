import { expect, it } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  allocationPreferenceKey,
  type AllocationAccount,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import {
  allocationAccountGroups,
  allocationAccountRows,
  allocationModelRows,
  allocationRateEvidence,
  withAllocationTarget,
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
it("lists an account with no known login once, holding each computer's rule key", () => {
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
it("does not turn account rates or model token throughput into model quota percentages", () => {
  const a = accounts[0]!;
  expect(allocationModelRows(a)).toMatchObject([
    { model: "astra", quotaRate: null, samples: 0, outputTokensPerHour: null },
  ]);
  expect(
    allocationModelRows({
      ...a,
      usageProfiles: [
        {
          model: "astra",
          effort: null,
          contextBand: "under32k",
          samples: 8,
          observedAt: null,
          outputTokensPerHour: 1200,
        },
      ],
    }),
  ).toEqual([
    {
      model: "astra",
      effort: null,
      contextBand: "under32k",
      samples: 8,
      observedAt: null,
      outputTokensPerHour: 1200,
      quotaRate: null,
    },
  ]);
});

it("does not present stale or future-dated account rates as current confidence", () => {
  const observedAt = "2026-10-24T12:00:00.000Z";
  const window = {
    id: "week",
    label: "Weekly",
    kind: "weekly" as const,
    usedPoints: 30,
    checkedAt: observedAt,
    resetsAt: null,
    cycleStartedAt: null,
    durationHours: 168,
    ratePointsPerHour: 2,
    samples: 8,
    rateAgeMinutes: 2,
  };
  expect(
    allocationRateEvidence(window, observedAt, defaultAllocationPolicy, Date.parse(observedAt)),
  ).toEqual({ ageMinutes: 2, confidence: "medium" });
  expect(
    allocationRateEvidence(
      window,
      observedAt,
      defaultAllocationPolicy,
      Date.parse(observedAt) + 11 * 60_000,
    ),
  ).toEqual({ ageMinutes: 13, confidence: "low" });
  expect(
    allocationRateEvidence(window, observedAt, defaultAllocationPolicy, Date.parse(observedAt) - 1),
  ).toEqual({ ageMinutes: null, confidence: "low" });
});

it("collapses accounts that cannot take a setting and reads usage from the newest computer", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const weekly = (usedPoints: number, checkedAt: string, id = "seven_day") => ({
    id,
    label: "Weekly",
    kind: "weekly" as const,
    usedPoints,
    checkedAt,
    resetsAt: "2026-10-28T12:00:00.000Z",
    cycleStartedAt: "2026-10-21T12:00:00.000Z",
    durationHours: 168,
    ratePointsPerHour: null,
    samples: 0,
    rateAgeMinutes: null,
  });
  const unsupported = { usageLimitsUnavailableReason: "unsupported" as const };
  const state = snapshot([
    { ...accounts[0]!, windows: [weekly(40, "2026-10-24T10:00:00.000Z")] },
    { ...accounts[1]!, windows: [weekly(55, "2026-10-24T11:57:00.000Z")] },
    { ...account("acer", "codex_ara", "ARA", "ara"), availableForWorkers: false },
    { ...account("acer", "codex_off", "OFF", "off"), enabled: false },
    { ...account("acer", "grok", "Grok", null, "grok"), ...unsupported },
    { ...account("acer", "pi", "Pi", null, "pi"), ...unsupported },
  ]);
  const pi = allocationAccountGroups(state).find((group) => group.label === "Pi")!;
  const policy = {
    ...defaultAllocationPolicy,
    accountRules: [{ key: pi.key, kind: "exclude" as const }],
  };
  const rows = allocationAccountRows({ ...state, policy }, policy, now);
  expect(rows.map((row) => [row.label, row.other])).toEqual([
    ["ARA", false],
    ["OFF", true],
    ["SL", false],
    ["Grok", true],
    // A saved rule keeps a quota-less account with the rest.
    ["Pi", false],
  ]);
  const sl = rows.find((row) => row.label === "SL")!;
  expect(sl.usage.weekly?.usedPoints).toBe(55);
  expect(rows.find((row) => row.label === "ARA")?.workersOffOn).toEqual(["acer"]);
  expect(rows.find((row) => row.label === "Pi")?.rules.exclude).toBeDefined();

  // A temporary budget covers each weekly window and leaves a use-by plan in place when it ends.
  const two = allocationAccountRows(
    snapshot([
      {
        ...accounts[0]!,
        windows: [
          weekly(40, "2026-10-24T11:00:00.000Z"),
          weekly(10, "2026-10-24T11:00:00.000Z", "seven_day_opus"),
        ],
      },
    ]),
    defaultAllocationPolicy,
    now,
  )[0]!;
  const plan = {
    accountKey: "sl",
    windowId: "seven_day",
    createdAt: "2026-10-24T09:00:00.000Z",
    expiresAt: "2026-10-27T09:00:00.000Z",
    useBy: "2026-10-26T09:00:00.000Z",
    baselineUsedPoints: 30,
  };
  const set = withAllocationTarget(
    { ...defaultAllocationPolicy, overrides: [plan] },
    two,
    { dailyPoints: 25 },
    now,
  );
  const curve = { ...defaultAllocationPolicy.codex, preset: "custom", dailyPoints: 25 };
  expect(set.overrides).toEqual([
    { ...plan, expiresAt: "2026-10-28T12:00:00.000Z", curve },
    {
      accountKey: "sl",
      windowId: "seven_day_opus",
      createdAt: "2026-10-24T12:00:00.000Z",
      baselineUsedPoints: 10,
      expiresAt: "2026-10-28T12:00:00.000Z",
      curve,
    },
  ]);
  const row = allocationAccountRows(snapshot(), set, now);
  expect(row.find((r) => r.label === "SL")?.target).toBeUndefined();
  const ended = withAllocationTarget(set, { ...two, target: set.overrides[0] }, undefined, now);
  expect(ended.overrides).toEqual([{ ...plan, expiresAt: "2026-10-28T12:00:00.000Z" }]);
});
