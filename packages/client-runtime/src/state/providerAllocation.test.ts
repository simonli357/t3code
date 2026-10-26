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
it("counts known aliases once across three hosts and normalizes within provider families", () => {
  const groups = allocationAccountGroups(snapshot(), defaultAllocationPolicy);
  expect(groups).toHaveLength(5);
  expect(groups.find((a) => a.label === "SL")?.hosts).toHaveLength(3);
  expect(groups.find((a) => a.label === "SL")?.share).toBeCloseTo(100 / 3);
  expect(groups.find((a) => a.label === "ES")?.share).toBe(50);
  const policy = {
    ...defaultAllocationPolicy,
    accountWeights: [{ key: allocationPreferenceKey(accounts[0]!), weight: 100 }],
  };
  expect(allocationAccountGroups(snapshot(), policy).find((a) => a.label === "SL")?.share).toBe(50);
  expect(allocationAccountGroups(snapshot(accounts.toReversed()), policy)).toEqual(
    allocationAccountGroups(snapshot(), policy),
  );
});
it("never merges unknown IDs by their human label and keeps all-zero pools usable", () => {
  const unknown = [account("alien", "codex", "SL", null), account("acer", "codex", "SL", null)];
  const policy = {
    ...defaultAllocationPolicy,
    accountWeights: unknown.map((a) => ({ key: allocationPreferenceKey(a), weight: 0 })),
  };
  const groups = allocationAccountGroups(snapshot(unknown), policy);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.key).not.toBe(groups[1]!.key);
  expect(groups.every((a) => a.share === 50 && a.equalFallback)).toBe(true);
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
