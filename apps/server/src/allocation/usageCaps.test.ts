import { expect, it } from "@effect/vitest";
import {
  allocationPreferenceKey,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationWindow,
} from "@t3tools/contracts";
import {
  evaluateUsageCapWindows,
  readUsageCapLatch,
  reconcileUsageCap,
  usageCapLatchId,
  type UsageCapLatch,
} from "./usageCaps.ts";

const at = "2026-10-30T12:00:00.000Z";
const resetsAt = "2026-11-02T12:00:00.000Z";
const weekly = (patch: Partial<AllocationWindow> = {}): AllocationWindow => ({
  id: "seven_day",
  label: "Weekly",
  kind: "weekly",
  usedPoints: 20,
  checkedAt: at,
  resetsAt,
  cycleStartedAt: "2026-10-26T12:00:00.000Z",
  durationHours: 168,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
  ...patch,
});
const fiveHour = (patch: Partial<AllocationWindow> = {}): AllocationWindow => ({
  id: "five_hour",
  label: "5-hour",
  kind: "session",
  usedPoints: 20,
  checkedAt: at,
  resetsAt: "2026-10-30T16:00:00.000Z",
  cycleStartedAt: "2026-10-30T11:00:00.000Z",
  durationHours: 5,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
  ...patch,
});
const account = (
  patch: Partial<AllocationAccount> = {},
  windows: readonly AllocationWindow[] = [weekly(), fiveHour()],
): AllocationAccount => ({
  environmentId: "host-a",
  instanceId: ProviderInstanceId.make("claude-a"),
  driver: ProviderDriverKind.make("claudeAgent"),
  accountKey: "claude-login",
  label: "Claude",
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [{ slug: "claude", capabilities: null }],
  shortWindow: "reported",
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  windows,
  ...patch,
});
const keyFor = (value: AllocationAccount) => allocationPreferenceKey(value);
const cap = (patch: Partial<AllocationAccountCap> = {}): AllocationAccountCap => ({
  key: keyFor(account()),
  weeklyPercent: 80,
  fiveHourPercent: null,
  stopWorkers: true,
  stopMasters: false,
  ...patch,
});

it("uses an inclusive threshold and evaluates the weekly and Claude 5-hour windows", () => {
  const value = account({}, [weekly({ usedPoints: 80 }), fiveHour({ usedPoints: 80 })]);
  const readings = evaluateUsageCapWindows({
    accounts: [value],
    accountKey: keyFor(value),
    driver: value.driver,
    cap: cap({ fiveHourPercent: 80 }),
    at,
    maxReadingAgeMinutes: 10,
  });

  expect(readings.map((reading) => [reading.id, reading.state])).toEqual([
    ["weekly", "reached"],
    ["fiveHour", "reached"],
  ]);
  const fiveHourOnly = evaluateUsageCapWindows({
    accounts: [account({}, [weekly({ usedPoints: 79 }), fiveHour({ usedPoints: 80 })])],
    accountKey: keyFor(value),
    driver: value.driver,
    cap: cap({ fiveHourPercent: 80 }),
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(fiveHourOnly.map((reading) => [reading.id, reading.state])).toEqual([
    ["weekly", "below"],
    ["fiveHour", "reached"],
  ]);
});

it("does not treat disabled, unsupported, stale, or missing readings as reached", () => {
  const codex = account(
    {
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex-a"),
    },
    [weekly({ usedPoints: 10 }), fiveHour({ usedPoints: 100 })],
  );
  const codexReadings = evaluateUsageCapWindows({
    accounts: [codex],
    accountKey: keyFor(codex),
    driver: codex.driver,
    cap: cap({ key: keyFor(codex), weeklyPercent: null, fiveHourPercent: 50 }),
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(codexReadings.map((reading) => reading.id)).toEqual(["weekly"]);
  expect(codexReadings[0]?.state).toBe("below");

  const stale = account({}, [weekly({ usedPoints: 100, checkedAt: "2026-10-30T11:00:00.000Z" })]);
  expect(
    evaluateUsageCapWindows({
      accounts: [stale],
      accountKey: keyFor(stale),
      driver: stale.driver,
      cap: cap({ key: keyFor(stale) }),
      at,
      maxReadingAgeMinutes: 10,
    })[0]?.state,
  ).toBe("stale");
  expect(
    evaluateUsageCapWindows({
      accounts: [],
      accountKey: keyFor(stale),
      driver: stale.driver,
      cap: cap({ key: keyFor(stale) }),
      at,
      maxReadingAgeMinutes: 10,
    })[0],
  ).toMatchObject({ state: "missing", usedPercent: null });

  const unsupportedApiKey = account(
    {
      available: false,
      usageLimitsUnavailableReason: "unsupported",
      unavailableReason: "Provider does not report subscription quota for an API key.",
    },
    [weekly({ usedPoints: 100 })],
  );
  const unsupportedCap = cap({ key: keyFor(unsupportedApiKey) });
  expect(
    evaluateUsageCapWindows({
      accounts: [unsupportedApiKey],
      accountKey: keyFor(unsupportedApiKey),
      driver: unsupportedApiKey.driver,
      cap: unsupportedCap,
      at,
      maxReadingAgeMinutes: 10,
    })[0],
  ).toMatchObject({ state: "unsupported", usedPercent: null });
  expect(
    readUsageCapLatch({
      latch: {
        accountKey: keyFor(unsupportedApiKey),
        driver: unsupportedApiKey.driver,
        windowId: "weekly",
        cycleKey: resetsAt,
        usedPercent: 100,
        thresholdPercent: 80,
        checkedAt: at,
        resetsAt,
        enforcedAt: at,
        stopWorkers: true,
        stopMasters: false,
      },
      accounts: [unsupportedApiKey],
      cap: unsupportedCap,
      at,
      maxReadingAgeMinutes: 10,
    }),
  ).toBeNull();

  const unverified = {
    ...unsupportedApiKey,
    usageLimitsUnavailableReason: "unverified" as const,
  };
  expect(
    evaluateUsageCapWindows({
      accounts: [unverified],
      accountKey: keyFor(unverified),
      driver: unverified.driver,
      cap: unsupportedCap,
      at,
      maxReadingAgeMinutes: 10,
    })[0],
  ).toMatchObject({ state: "unavailable", usedPercent: null });
  expect(
    readUsageCapLatch({
      latch: {
        accountKey: keyFor(unverified),
        driver: unverified.driver,
        windowId: "weekly",
        cycleKey: resetsAt,
        usedPercent: 100,
        thresholdPercent: 80,
        checkedAt: at,
        resetsAt,
        enforcedAt: at,
        stopWorkers: true,
        stopMasters: false,
      },
      accounts: [unverified],
      cap: unsupportedCap,
      at,
      maxReadingAgeMinutes: 10,
    }),
  ).toBeNull();

  for (const reason of ["unsupported", "unverified", "probeFailed"] as const) {
    const verifiedAlias = account({ instanceId: ProviderInstanceId.make(`verified-${reason}`) }, [
      weekly({ usedPoints: 10 }),
    ]);
    const excludedAlias = account(
      {
        instanceId: ProviderInstanceId.make(`excluded-${reason}`),
        available: false,
        usageLimitsUnavailableReason: reason,
      },
      [weekly({ usedPoints: 100 })],
    );
    expect(
      evaluateUsageCapWindows({
        accounts: [excludedAlias, verifiedAlias],
        accountKey: keyFor(verifiedAlias),
        driver: verifiedAlias.driver,
        cap: cap({ key: keyFor(verifiedAlias) }),
        at,
        maxReadingAgeMinutes: 10,
      })[0],
    ).toMatchObject({ state: "below", usedPercent: 10 });
  }
});

it("creates one stable latch at a crossing and keeps it across stale, missing, or failed telemetry", () => {
  const value = account({}, [weekly({ usedPoints: 91 })]);
  const first = reconcileUsageCap({
    accounts: [value],
    accountKey: keyFor(value),
    driver: value.driver,
    cap: cap({ key: keyFor(value) }),
    latch: undefined,
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(first.reach?.windowId).toBe("weekly");
  expect(first.reach?.usedPercent).toBe(91);

  const staleValue = account({}, [
    weekly({ usedPoints: 5, checkedAt: "2026-10-30T11:00:00.000Z" }),
  ]);
  const stale = reconcileUsageCap({
    accounts: [staleValue],
    accountKey: keyFor(staleValue),
    driver: staleValue.driver,
    cap: cap({ key: keyFor(staleValue) }),
    latch: first.latch ?? undefined,
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(stale.reach?.usedPercent).toBe(91);

  const probeFailedValue = account(
    {
      available: false,
      usageLimitsUnavailableReason: "probeFailed",
    },
    [],
  );
  const probeFailed = reconcileUsageCap({
    accounts: [probeFailedValue],
    accountKey: keyFor(probeFailedValue),
    driver: probeFailedValue.driver,
    cap: cap({ key: keyFor(probeFailedValue) }),
    latch: first.latch ?? undefined,
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(probeFailed.windows[0]?.state).toBe("probeFailed");
  expect(probeFailed.reach?.usedPercent).toBe(91);
  expect(probeFailed.latch).toEqual(first.latch);

  const missing = reconcileUsageCap({
    accounts: [],
    accountKey: keyFor(staleValue),
    driver: staleValue.driver,
    cap: cap({ key: keyFor(staleValue) }),
    latch: first.latch ?? undefined,
    at,
    maxReadingAgeMinutes: 10,
  });
  expect(missing.reach?.usedPercent).toBe(91);
  expect(missing.latch).toEqual(first.latch);
  expect(usageCapLatchId(first.latch!)).toBe(first.reach?.latchId);
});

it("releases a latch on reset, a fresh below-cap reading, a cap raise, or disabled actions", () => {
  const value = account({}, [weekly({ usedPoints: 90 })]);
  const reached = reconcileUsageCap({
    accounts: [value],
    accountKey: keyFor(value),
    driver: value.driver,
    cap: cap({ key: keyFor(value) }),
    latch: undefined,
    at,
    maxReadingAgeMinutes: 10,
  }).latch!;
  const evaluate = (input: {
    readonly accounts?: readonly AllocationAccount[];
    readonly cap?: AllocationAccountCap;
    readonly latch?: UsageCapLatch;
    readonly at?: string;
  }) =>
    reconcileUsageCap({
      accounts: input.accounts ?? [value],
      accountKey: keyFor(value),
      driver: value.driver,
      cap: input.cap ?? cap({ key: keyFor(value) }),
      latch: input.latch ?? reached,
      at: input.at ?? at,
      maxReadingAgeMinutes: 10,
    });

  expect(
    evaluate({
      at: resetsAt,
    }).reach,
  ).toBeNull();
  expect(
    evaluate({
      accounts: [account({}, [weekly({ usedPoints: 10 })])],
      latch: reached,
    }).reach,
  ).toBeNull();
  expect(
    evaluate({
      cap: cap({ key: keyFor(value), weeklyPercent: 95 }),
      latch: reached,
    }).reach,
  ).toBeNull();
  expect(
    evaluate({
      cap: cap({ key: keyFor(value), stopWorkers: false, stopMasters: false }),
      latch: reached,
    }).reach,
  ).toBeNull();
});

it("selects the newest linked alias and keeps unrelated identities and unknown aliases isolated", () => {
  const original = account(
    {
      instanceId: ProviderInstanceId.make("claude-a"),
      environmentId: "host-a",
    },
    [weekly({ usedPoints: 100, checkedAt: "2026-10-30T11:30:00.000Z" })],
  );
  const newerAlias = account(
    {
      instanceId: ProviderInstanceId.make("claude-b"),
      environmentId: "host-b",
    },
    [weekly({ usedPoints: 20, checkedAt: at })],
  );
  const unrelated = account(
    {
      accountKey: "other-login",
      instanceId: ProviderInstanceId.make("claude-c"),
      environmentId: "host-c",
    },
    [weekly({ usedPoints: 100 })],
  );
  expect(
    evaluateUsageCapWindows({
      accounts: [original, unrelated, newerAlias],
      accountKey: keyFor(original),
      driver: original.driver,
      cap: cap({ key: keyFor(original) }),
      at,
      maxReadingAgeMinutes: 10,
    })[0]?.usedPercent,
  ).toBe(20);

  const unknownA = { ...original, accountKey: null };
  const unknownB = { ...newerAlias, accountKey: null };
  expect(keyFor(unknownA)).not.toBe(keyFor(unknownB));
  expect(
    readUsageCapLatch({
      latch: {
        accountKey: keyFor(original),
        driver: original.driver,
        windowId: "weekly",
        cycleKey: resetsAt,
        usedPercent: 100,
        thresholdPercent: 80,
        checkedAt: at,
        resetsAt,
        enforcedAt: at,
        stopWorkers: true,
        stopMasters: false,
      },
      accounts: [unrelated],
      cap: cap({ key: keyFor(original) }),
      at,
      maxReadingAgeMinutes: 10,
    }),
  ).not.toBeNull();
});
