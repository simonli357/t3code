import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import type { AllocationAccount, AllocationAccountCap, AllocationWindow } from "@t3tools/contracts";
import { allocationPreferenceKey } from "@t3tools/contracts";

type UsageCapWindowId = "weekly" | "fiveHour";

interface UsageCapWindowReading {
  readonly id: UsageCapWindowId;
  readonly label: string;
  readonly state:
    | "reached"
    | "below"
    | "stale"
    | "missing"
    | "reset"
    | "unsupported"
    | "unavailable"
    | "probeFailed";
  readonly usedPercent: number | null;
  readonly checkedAt: string | null;
  readonly resetsAt: string | null;
  readonly cycleKey: string | null;
}

export interface UsageCapReach {
  readonly accountKey: string;
  readonly driver: string;
  readonly windowId: UsageCapWindowId;
  readonly windowLabel: string;
  readonly capPercent: number;
  readonly usedPercent: number;
  readonly checkedAt: string;
  readonly resetsAt: string | null;
  readonly cycleKey: string;
  readonly latchId: string;
  readonly enforcedAt: string;
  readonly stopWorkers: boolean;
  readonly stopMasters: boolean;
}

export interface UsageCapLatch {
  readonly accountKey: string;
  readonly driver: string;
  readonly windowId: string;
  readonly cycleKey: string;
  readonly usedPercent: number;
  readonly thresholdPercent: number;
  readonly checkedAt: string;
  readonly resetsAt: string | null;
  readonly enforcedAt: string;
  readonly stopWorkers: boolean;
  readonly stopMasters: boolean;
}

export function usageCapLatchId(input: {
  readonly accountKey: string;
  readonly windowId: string;
  readonly cycleKey: string;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.accountKey, input.windowId, input.cycleKey]))
    .digest("hex")
    .slice(0, 32);
}

function resetAt(window: AllocationWindow): string | null {
  if (window.resetsAt) return window.resetsAt;
  if (window.cycleStartedAt && window.durationHours !== null)
    return DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(window.cycleStartedAt) + window.durationHours * 3_600_000),
    );
  return null;
}

function isWeeklyAccountWindow(window: AllocationWindow): boolean {
  return window.kind === "weekly" && (window.models === undefined || window.models.length === 0);
}

function isClaudeFiveHour(window: AllocationWindow): boolean {
  return window.id === "five_hour";
}

function candidateWindows(
  account: AllocationAccount,
  id: UsageCapWindowId,
): readonly AllocationWindow[] {
  return account.windows.filter((window) =>
    id === "weekly" ? isWeeklyAccountWindow(window) : isClaudeFiveHour(window),
  );
}

function preferredWindow(windows: readonly AllocationWindow[]): AllocationWindow | undefined {
  return [...windows].sort((left, right) => {
    const byCheck = Date.parse(right.checkedAt) - Date.parse(left.checkedAt);
    if (byCheck !== 0) return byCheck;
    return right.usedPoints - left.usedPoints;
  })[0];
}

/**
 * Reads one hard-cap window from every known alias of an account. A newer
 * reading wins so a new provider cycle is not held back by an older alias's
 * expired 100% reading. Missing, stale, and transient probe failures stay
 * distinct from authoritative unsupported or unverified provenance.
 */
function readUsageCapWindow(input: {
  readonly accounts: readonly AllocationAccount[];
  readonly accountKey: string;
  readonly driver: string;
  readonly id: UsageCapWindowId;
  readonly at: string;
  readonly maxReadingAgeMinutes: number;
}): UsageCapWindowReading {
  const atMs = Date.parse(input.at);
  const identityMatches = input.accounts.filter(
    (account) =>
      account.driver === input.driver && allocationPreferenceKey(account) === input.accountKey,
  );
  const matches = identityMatches.filter(
    (account) => account.available && account.usageLimitsUnavailableReason === undefined,
  );
  const windows = matches.flatMap((account) =>
    candidateWindows(account, input.id).map((window) => ({ account, window })),
  );
  if (!windows.length) {
    const unsupported = identityMatches.some(
      (account) => account.usageLimitsUnavailableReason === "unsupported",
    );
    const unverified = identityMatches.some(
      (account) => account.usageLimitsUnavailableReason === "unverified",
    );
    const probeFailed =
      identityMatches.length > 0 &&
      identityMatches.every((account) => account.usageLimitsUnavailableReason === "probeFailed");
    return {
      id: input.id,
      label: input.id === "weekly" ? "Weekly" : "5-hour",
      state: unsupported
        ? "unsupported"
        : unverified
          ? "unavailable"
          : probeFailed
            ? "probeFailed"
            : "missing",
      usedPercent: null,
      checkedAt: null,
      resetsAt: null,
      cycleKey: null,
    };
  }

  const current = windows.filter(({ window }) => {
    const reset = resetAt(window);
    return reset === null || Date.parse(reset) > atMs;
  });
  if (!current.length) {
    const latest = [...windows].sort(
      (left, right) => Date.parse(right.window.checkedAt) - Date.parse(left.window.checkedAt),
    )[0]!;
    return {
      id: input.id,
      label: latest.window.label,
      state: "reset",
      usedPercent: latest.window.usedPoints,
      checkedAt: latest.window.checkedAt,
      resetsAt: resetAt(latest.window),
      cycleKey: resetAt(latest.window),
    };
  }

  const selected = preferredWindow(current.map(({ window }) => window))!;
  const checkedAtMs = Date.parse(selected.checkedAt);
  const fresh =
    Number.isFinite(checkedAtMs) &&
    checkedAtMs <= atMs + 60_000 &&
    atMs - checkedAtMs <= input.maxReadingAgeMinutes * 60_000;
  const resetsAt = resetAt(selected);
  return {
    id: input.id,
    label: selected.label,
    state: fresh ? "below" : "stale",
    usedPercent: selected.usedPoints,
    checkedAt: selected.checkedAt,
    resetsAt,
    cycleKey: resetsAt ?? selected.cycleStartedAt ?? "unbounded",
  };
}

export function evaluateUsageCapWindows(input: {
  readonly accounts: readonly AllocationAccount[];
  readonly accountKey: string;
  readonly driver: string;
  readonly cap: AllocationAccountCap;
  readonly at: string;
  readonly maxReadingAgeMinutes: number;
}): readonly UsageCapWindowReading[] {
  const supported =
    input.driver === "claudeAgent" ? (["weekly", "fiveHour"] as const) : (["weekly"] as const);
  return supported.map((id) => {
    const threshold = id === "weekly" ? input.cap.weeklyPercent : input.cap.fiveHourPercent;
    const reading = readUsageCapWindow({ ...input, id });
    if (threshold === null || reading.usedPercent === null) return reading;
    if (reading.state !== "below") return reading;
    return {
      ...reading,
      state: reading.usedPercent >= threshold ? "reached" : "below",
    };
  });
}

/**
 * Reconciles one cap with its durable latch and latest provider reading.
 * Fresh crossings create latches. A latch survives stale/missing telemetry
 * until a reported reset, a below-cap reading, an action change, or removal.
 */
export function reconcileUsageCap(input: {
  readonly accounts: readonly AllocationAccount[];
  readonly accountKey: string;
  readonly driver: string;
  readonly cap: AllocationAccountCap;
  readonly latch: UsageCapLatch | undefined;
  readonly at: string;
  readonly maxReadingAgeMinutes: number;
}): {
  readonly latch: UsageCapLatch | null;
  readonly reach: UsageCapReach | null;
  readonly windows: readonly UsageCapWindowReading[];
} {
  const actionsEnabled = input.cap.stopWorkers || input.cap.stopMasters;
  const windows = evaluateUsageCapWindows(input);
  const active = windows.find(
    (window) =>
      (window.id === "weekly" ? input.cap.weeklyPercent : input.cap.fiveHourPercent) !== null &&
      window.usedPercent !== null &&
      window.checkedAt !== null &&
      window.cycleKey !== null &&
      window.state === "reached",
  );
  if (!actionsEnabled) return { latch: null, reach: null, windows };
  if (!active || active.usedPercent === null || !active.checkedAt || !active.cycleKey) {
    if (!input.latch) return { latch: null, reach: null, windows };
    const retained = readUsageCapLatch({
      latch: input.latch,
      accounts: input.accounts,
      cap: input.cap,
      at: input.at,
      maxReadingAgeMinutes: input.maxReadingAgeMinutes,
    });
    const nextLatch = retained
      ? {
          ...input.latch,
          thresholdPercent: retained.capPercent,
          stopWorkers: input.cap.stopWorkers,
          stopMasters: input.cap.stopMasters,
        }
      : null;
    return {
      latch: nextLatch,
      reach: retained,
      windows,
    };
  }

  const threshold = active.id === "weekly" ? input.cap.weeklyPercent : input.cap.fiveHourPercent;
  if (threshold === null) {
    if (!input.latch) return { latch: null, reach: null, windows };
    const retained = readUsageCapLatch({
      latch: input.latch,
      accounts: input.accounts,
      cap: input.cap,
      at: input.at,
      maxReadingAgeMinutes: input.maxReadingAgeMinutes,
    });
    return {
      latch: retained ? input.latch : null,
      reach: retained,
      windows,
    };
  }
  const latchId = usageCapLatchId({
    accountKey: input.accountKey,
    windowId: active.id,
    cycleKey: active.cycleKey,
  });
  const nextLatch: UsageCapLatch = {
    accountKey: input.accountKey,
    driver: input.driver,
    windowId: active.id,
    cycleKey: active.cycleKey,
    usedPercent: active.usedPercent,
    thresholdPercent: threshold,
    checkedAt: active.checkedAt,
    resetsAt: active.resetsAt,
    enforcedAt: input.latch?.cycleKey === active.cycleKey ? input.latch.enforcedAt : input.at,
    stopWorkers: input.cap.stopWorkers,
    stopMasters: input.cap.stopMasters,
  };
  const enforcedAt = nextLatch.enforcedAt;
  return {
    latch: nextLatch,
    reach: {
      accountKey: input.accountKey,
      driver: input.driver,
      windowId: active.id,
      windowLabel: active.label,
      capPercent: threshold,
      usedPercent: active.usedPercent,
      checkedAt: active.checkedAt,
      resetsAt: active.resetsAt,
      cycleKey: active.cycleKey,
      latchId,
      enforcedAt,
      stopWorkers: input.cap.stopWorkers,
      stopMasters: input.cap.stopMasters,
    },
    windows,
  };
}

/** Read a cap back from a durable latch without strengthening stale telemetry. */
export function readUsageCapLatch(input: {
  readonly latch: UsageCapLatch;
  readonly accounts: readonly AllocationAccount[];
  readonly cap: AllocationAccountCap;
  readonly at: string;
  readonly maxReadingAgeMinutes: number;
}): UsageCapReach | null {
  if (!input.cap.stopWorkers && !input.cap.stopMasters) return null;
  if (input.latch.resetsAt && Date.parse(input.latch.resetsAt) <= Date.parse(input.at)) return null;
  const threshold =
    input.latch.windowId === "weekly"
      ? input.cap.weeklyPercent
      : input.latch.windowId === "fiveHour"
        ? input.cap.fiveHourPercent
        : null;
  if (threshold === null || input.latch.usedPercent < threshold) return null;
  const window = evaluateUsageCapWindows({
    accounts: input.accounts,
    accountKey: input.latch.accountKey,
    driver: input.latch.driver,
    cap: input.cap,
    at: input.at,
    maxReadingAgeMinutes: input.maxReadingAgeMinutes,
  }).find((candidate) => candidate.id === input.latch.windowId);
  if (
    !window ||
    window.state === "reset" ||
    window.state === "unsupported" ||
    window.state === "unavailable"
  )
    return null;
  if (window.state === "below" && (window.usedPercent === null || window.usedPercent < threshold))
    return null;
  if (
    window.state !== "stale" &&
    window.cycleKey !== null &&
    window.cycleKey !== input.latch.cycleKey
  )
    return null;
  return {
    accountKey: input.latch.accountKey,
    driver: input.latch.driver,
    windowId: input.latch.windowId as UsageCapWindowId,
    windowLabel: window.label,
    capPercent: threshold,
    usedPercent: input.latch.usedPercent,
    checkedAt: input.latch.checkedAt,
    resetsAt: input.latch.resetsAt,
    cycleKey: input.latch.cycleKey,
    latchId: usageCapLatchId(input.latch),
    enforcedAt: input.latch.enforcedAt,
    stopWorkers: input.cap.stopWorkers,
    stopMasters: input.cap.stopMasters,
  };
}

export function usageCapDetail(reach: UsageCapReach): string {
  const reset = reach.resetsAt
    ? ` It resets at ${reach.resetsAt}.`
    : " The provider did not report a reset time.";
  return `${reach.windowLabel} usage is ${reach.usedPercent}% of the configured ${reach.capPercent}% cap.${reset} This hard cap stays active until the provider window resets or the cap is raised, disabled, or removed.`;
}
