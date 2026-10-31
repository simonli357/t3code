import {
  WS_METHODS,
  allocationPreferenceKey,
  allocationPreferenceWeight,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationWindow,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationRequest,
  type AllocationDecision,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Reusable query and command atoms for the allocation editor and worker settings. */
export function createAllocationAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:provider-allocation:start",
      tag: WS_METHODS.providerAllocationStart,
    }),
    /** Accounts, quota readings and policy of one computer. */
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider-allocation:snapshot",
      tag: WS_METHODS.providerAllocation,
      staleTimeMs: 5_000,
    }),
  };
}

export function createAllocationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation:start",
      tag: WS_METHODS.providerAllocationStart,
    }),
  };
}

/** A preview is tied to the exact editor content and request, not just its version. */
export function allocationPreviewKey(policy: AllocationPolicy, request: AllocationRequest): string {
  return JSON.stringify({ policy, request });
}

export function allocationChartPoints(
  snapshot: AllocationSnapshot,
  accountKey: string,
  windowId: string,
) {
  const points = [...snapshot.history]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .flatMap((decision) => {
      const candidate = decision.candidates.find(
        (c) => c.accountKey === accountKey && c.windows.some((w) => w.id === windowId),
      );
      const window = candidate?.windows.find((w) => w.id === windowId);
      return window
        ? [{ at: decision.at, actual: window.actualPoints, target: window.targetPoints }]
        : [];
    });
  const first = Date.parse(points[0]?.at ?? "");
  const last = Date.parse(points.at(-1)?.at ?? "");
  return points.map((p) => ({
    ...p,
    xPercent: last > first ? ((Date.parse(p.at) - first) * 100) / (last - first) : 0,
  }));
}
export function allocationSummary(decision: AllocationDecision) {
  return {
    choice: decision.selectedInstanceId ?? decision.outcome,
    reason: decision.reasons.join(" "),
    eligible: decision.candidates.filter((c) => c.eligible).length,
    excluded: decision.candidates.filter((c) => !c.eligible).length,
    confidence: decision.confidence,
  };
}

export function allocationAccountLabel(
  snapshot: AllocationSnapshot | null,
  environmentId: string,
  instanceId: string,
) {
  return (
    snapshot?.inventories
      .find((i) => i.environmentId === environmentId)
      ?.accounts.find((a) => a.instanceId === instanceId)?.label ?? "Unavailable account"
  );
}

export const allocationCurveFields = [
  {
    key: "burstPoints",
    label: "Initial weekly budget",
    unit: "% of allowance",
    max: 100,
    help: "Allowance available at the start of the provider cycle.",
  },

  {
    key: "dailyPoints",
    label: "Daily usage budget",
    unit: "points / 24h",
    max: 100,
    help: "Additional percentage points released per 24 hours since reset.",
  },

  {
    key: "burstHours",
    label: "Initial budget release time",
    unit: "hours",
    max: 168,
    help: "Spread the initial budget over this time; 0 makes it available immediately.",
  },

  {
    key: "reservePoints",
    label: "Target reserve",
    unit: "points",
    max: 100,
    help: "Leave this much of each allowance outside the target.",
  },

  {
    key: "borrowPoints",
    label: "Borrowing warning allowance",
    unit: "points",
    max: 100,
    help: "Warn when projected usage exceeds the target by more than this amount.",
  },
] as const;

export const allocationEstimateFields = [
  {
    key: "coldShortPointsPerHour",
    label: "Fallback short-window burn",
    unit: "points / hour",
    min: 0,
    max: 100,
    step: 0.1,
    help: "Per-assignment estimate for a short allowance window; fresh measured burn also contributes to forecasts.",
  },

  {
    key: "coldLongPointsPerHour",
    label: "Fallback weekly burn",
    unit: "points / hour",
    min: 0,
    max: 100,
    step: 0.1,
    help: "Per-assignment estimate for a weekly or longer allowance; not a measured model rate.",
  },

  {
    key: "uncertaintyMultiplier",
    label: "Forecast uncertainty",
    unit: "×",
    min: 1,
    max: 5,
    step: 0.1,
    help: "Multiplies forecast rates and durations to leave room for uncertainty.",
  },

  {
    key: "defaultHours",
    label: "Default forecast duration",
    unit: "hours",
    min: 0.01,
    max: 168,
    step: 0.01,
    help: "Expected assignment duration when none is supplied.",
  },

  {
    key: "maxForecastHours",
    label: "Forecast horizon",
    unit: "hours",
    min: 0.01,
    max: 168,
    step: 0.01,
    help: "Caps the forecast horizon and warns when a requested duration exceeds it.",
  },

  {
    key: "maxReadingAgeMinutes",
    label: "Maximum measurement age",
    unit: "minutes",
    min: 1,
    max: 60,
    step: 1,
    help: "Older usage readings warn; old burn estimates fall back to planning rates. Computer readings this old show as stale.",
  },

  {
    key: "minimumSamples",
    label: "Minimum rate samples",
    unit: "samples",
    min: 3,
    max: 100,
    step: 1,
    help: "Comparable observations required before using a measured allowance rate.",
  },

  {
    key: "reservationMinutes",
    label: "Unused reservation lifetime",
    unit: "minutes",
    min: 1,
    max: 15,
    step: 1,
    help: "How long an unstarted assignment keeps its accounting reservation.",
  },

  {
    key: "hysteresisPoints",
    label: "Account preference margin",
    unit: "points",
    min: 0,
    max: 5,
    step: 0.1,
    help: "Maximum budget headroom points added by account weights (weight / 100). The previous account gets this many extra points. Changes apply immediately.",
  },
] as const;

export function allocationAccountCap(
  policy: AllocationPolicy,
  key: string,
): AllocationAccountCap | undefined {
  return policy.accountCaps?.find((cap) => cap.key === key);
}

export function allocationSupportsFiveHourCap(driver: string): boolean {
  return driver === "claudeAgent";
}

export function allocationSubscriptionCapSource(
  accounts: readonly AllocationAccount[],
): "available" | "probeFailed" | "unsupported" | "unverified" {
  if (accounts.some((account) => account.usageLimitsUnavailableReason === undefined))
    return "available";
  if (accounts.some((account) => account.usageLimitsUnavailableReason === "unsupported"))
    return "unsupported";
  if (accounts.some((account) => account.usageLimitsUnavailableReason === "unverified"))
    return "unverified";
  return accounts.length > 0 &&
    accounts.every((account) => account.usageLimitsUnavailableReason === "probeFailed")
    ? "probeFailed"
    : "unverified";
}

export function allocationSupportsSubscriptionCaps(
  accounts: readonly AllocationAccount[],
): boolean {
  const source = allocationSubscriptionCapSource(accounts);
  return source === "available" || source === "probeFailed";
}

export function allocationAccountGroups(
  snapshot: AllocationSnapshot | null,
  policy: AllocationPolicy,
) {
  const groups = new Map<string, AllocationAccount[]>();

  for (const host of snapshot?.inventories ?? [])
    for (const account of host.accounts) {
      const key = allocationPreferenceKey(account);

      groups.set(key, [...(groups.get(key) ?? []), account]);
    }

  const rows = [...groups].map(([key, members]) => ({
    key,
    members,
    driver: members[0]!.driver,

    label: [...new Set(members.map((m) => m.label))].sort().join(" / "),

    weight: allocationPreferenceWeight(policy, key),

    hosts: [
      ...new Set(
        members.map(
          (m) =>
            snapshot?.inventories.find((i) => i.environmentId === m.environmentId)
              ?.environmentLabel ?? m.environmentId,
        ),
      ),
    ].sort(),
  }));

  return rows
    .sort(
      (a, b) =>
        a.driver.localeCompare(b.driver) ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key),
    )
    .map((row) => {
      const pool = rows.filter((r) => r.driver === row.driver);

      const total = pool.reduce((sum, r) => sum + r.weight, 0);

      return {
        ...row,
        share: total > 0 ? (row.weight * 100) / total : 100 / pool.length,
        equalFallback: total === 0,
      };
    });
}

/** Keep observations from each host visible; do not sum overlapping account samples. */

export function allocationModelRows(account: AllocationAccount) {
  const measured = account.usageProfiles ?? [];

  const observed = measured.map((p) => ({ ...p, quotaRate: null }));

  const missing = account.models.flatMap((model) => {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (d) => d.id === "reasoningEffort" || d.id === "effort",
    );

    const efforts = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [null];

    return efforts
      .filter((effort) => !measured.some((p) => p.model === model.slug && p.effort === effort))
      .map((effort) => ({
        model: model.slug,
        effort,
        contextBand: "unknown",
        samples: 0,
        observedAt: null,

        outputTokensPerHour: null,
        quotaRate: null,
      }));
  });

  return [...observed, ...missing];
}

export function allocationRateEvidence(
  window: AllocationWindow,
  observedAt: string,
  policy: AllocationPolicy,
  now: number,
) {
  const elapsed = (now - Date.parse(observedAt)) / 60_000;
  const ageMinutes =
    window.rateAgeMinutes !== null && elapsed >= 0 && Number.isFinite(elapsed)
      ? window.rateAgeMinutes + elapsed
      : null;
  return {
    ageMinutes,
    confidence:
      window.ratePointsPerHour !== null &&
      window.samples >= policy.minimumSamples &&
      ageMinutes !== null &&
      ageMinutes >= 0 &&
      ageMinutes <= policy.maxReadingAgeMinutes
        ? "medium"
        : "low",
  };
}
