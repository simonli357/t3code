import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ServerProvider, type UsageMeasurementsReport } from "@t3tools/contracts";
import { allocationIdentity, allocationInventory } from "./inventory.ts";

const at = "2026-10-23T18:00:00.000Z";
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const provider = (email?: string, profileId?: string) =>
  decodeProvider({
    instanceId: "alias",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      ...(email ? { email } : {}),
      ...(profileId ? { profileId } : {}),
    },
    checkedAt: at,
    models: [
      { slug: "gpt-test-codex-spark", name: "Spark", isCustom: false, capabilities: null },
      { slug: "astra", name: "Astra", isCustom: false, capabilities: null },
    ],
    usageLimits: {
      checkedAt: at,
      windows: [
        {
          id: "week",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 0,
          resetsAt: "2026-10-30T17:00:00.000Z",
          windowDurationMins: 10080,
        },
        {
          id: "short",
          kind: "session",
          label: "Short",
          usedPercent: 10,
          checkedAt: "2026-10-23T17:00:00.000Z",
          resetsAt: "2026-10-23T22:00:00.000Z",
          windowDurationMins: 300,
        },
        {
          id: "spark",
          kind: "weekly",
          label: "Spark",
          modelScope: "codex_spark",
          usedPercent: 100,
        },
      ],
    },
  });
const measurements: UsageMeasurementsReport = {
  observedAt: at,
  monitoredInstanceIds: [],
  retentionDays: 14,
  persistenceError: null,
  accounts: [],
  turns: [],
  totalMatchingTurns: 0,
  profiles: [],
  limitations: [],
};
it("uses login identity across host-specific profiles, never the alias", () => {
  expect(allocationIdentity(provider())).toBeNull();
  expect(allocationIdentity(provider("USER@example.test", "machine-one"))).toBe(
    allocationIdentity(provider("user@example.test", "machine-two")),
  );
  expect(allocationIdentity(provider("a@example.test"))).not.toBe(
    allocationIdentity(provider("b@example.test")),
  );
});
it("retains per-window age, scopes reported model buckets and does not opt shared accounts into history", () => {
  const result = allocationInventory({
    environmentId: "host",
    at,
    providers: [provider("a@example.test")],
    threads: [],
    measurements,
  });
  const a = result.accounts[0]!;
  expect(a.retainHistory).toBe(false);
  expect(a.windows.find((w) => w.id === "short")?.checkedAt).toBe("2026-10-23T17:00:00.000Z");
  expect(a.windows.find((w) => w.id === "spark")?.models).toEqual(["gpt-test-codex-spark"]);
  expect(a.windows.find((w) => w.id === "week")?.cycleStartedAt).toBe("2026-10-23T17:00:00.000Z");
  expect(a.profileSamples).toBe(0);
});

it("does not transplant retained rate evidence from a prior cycle onto a refreshed quota window", () => {
  const p = provider("a@example.test");
  const quota = p.usageLimits!.windows[0]!;
  const report: UsageMeasurementsReport = {
    ...measurements,
    accounts: [
      {
        accountKey: "a",
        instanceIds: [p.instanceId],
        identityKnown: true,
        windows: [
          {
            window: quota,
            checkedAt: at,
            ageSeconds: 1,
            rate: {
              sampleCount: 8,
              intervalMinutes: 10,
              percentagePointsPerHour: 20,
              predictionErrorPointsPerHour: 2,
              hoursUntilExhaustion: 4,
              hoursUntilReset: 167,
              projectedUsedPercentAtReset: 100,
              reason: null,
            },
          },
        ],
      },
    ],
  };
  const read = (m: UsageMeasurementsReport) =>
    allocationInventory({ environmentId: "host", at, providers: [p], threads: [], measurements: m })
      .accounts[0]!.windows[0]!;
  expect(read(report).ratePointsPerHour).toBe(20);
  const oldCycle = {
    ...report,
    accounts: report.accounts.map((a) => ({
      ...a,
      windows: a.windows.map((w) => ({
        ...w,
        window: { ...w.window, resetsAt: "2026-10-23T17:00:00.000Z" },
      })),
    })),
  };
  expect(read(oldCycle).ratePointsPerHour).toBeNull();
  expect(read(oldCycle).samples).toBe(0);
});
