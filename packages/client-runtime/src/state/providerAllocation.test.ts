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
  allocationModelRows,
  allocationRateEvidence,
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
