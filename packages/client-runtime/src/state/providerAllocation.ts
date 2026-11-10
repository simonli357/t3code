import {
  WS_METHODS,
  allocationAccountRule,
  allocationPreferenceKey,
  routingEffortOptionId,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationCurve,
  type AllocationWindow,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationRequest,
  type AllocationDecision,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

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
    help: "Budget headroom points added to the previous account, so close choices do not alternate. Changes apply immediately.",
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

export function allocationAccountGroups(snapshot: AllocationSnapshot | null) {
  const groups = new Map<string, AllocationAccount[]>();

  for (const host of snapshot?.inventories ?? [])
    for (const account of host.accounts) {
      // An account with no known login is one account per driver and label on every computer.
      const key =
        account.accountKey === null
          ? JSON.stringify([account.driver, "label", account.label])
          : allocationPreferenceKey(account);

      groups.set(key, [...(groups.get(key) ?? []), account]);
    }

  const rows = [...groups.values()].map((members) => {
    // Rules and caps are stored per computer for an unknown login; edits write every key.
    const keys = [...new Set(members.map(allocationPreferenceKey))].sort();
    return {
      key: keys[0]!,
      keys,
      members,
      driver: members[0]!.driver,

      label: [...new Set(members.map((m) => m.label))].sort().join(" / "),

      hosts: [
        ...new Set(
          members.map(
            (m) =>
              snapshot?.inventories.find((i) => i.environmentId === m.environmentId)
                ?.environmentLabel ?? m.environmentId,
          ),
        ),
      ].sort(),
    };
  });

  return rows.sort(
    (a, b) =>
      a.driver.localeCompare(b.driver) ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );
}

/** The provider families that have their own pacing curve and default worker model. */
export const allocationFamilies = [
  { family: "claude", driver: "claudeAgent", label: "Claude" },
  { family: "codex", driver: "codex", label: "Codex" },
] as const;

const isoTime = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A curve field as it applies: null when the preset derives it from each cycle. */
export function allocationCurveValue(
  curve: AllocationCurve,
  key: (typeof allocationCurveFields)[number]["key"],
): number | null {
  const paced = key === "dailyPoints" || key === "burstPoints" || key === "burstHours";
  if (curve.preset === "sustainable" && paced) return null;
  if (curve.preset === "aggressive17" && paced) return key === "dailyPoints" ? 17 : 0;
  return curve[key];
}

/** "4 min", "3 h" or "2 d": how old a reading is. */
export function allocationReadingAge(checkedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 60_000));
  if (!Number.isFinite(minutes)) return "age unknown";
  return minutes < 60
    ? `${minutes} min`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`;
}

/**
 * One row per account for the settings table: what the account reads now and every policy value
 * that applies to it. `other` accounts cannot usefully take a setting: their provider is turned
 * off, or it reports no subscription quota and nothing is saved for it.
 */
export function allocationAccountRows(
  snapshot: AllocationSnapshot | null,
  policy: AllocationPolicy,
  now: number,
) {
  const at = isoTime(now);
  return allocationAccountGroups(snapshot).map((group) => {
    const login = group.members[0]!.accountKey;
    const windows = group.members
      .filter((account) => account.usageLimitsUnavailableReason === undefined)
      .flatMap((account) => account.windows)
      .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));
    const rule = (source: AllocationPolicy, kind: "exclude" | "maxWorkers" | "priority") =>
      group.keys.map((key) => allocationAccountRule(source, key, kind, at)).find(Boolean);
    // A temporary budget replaces the family curve on the weekly windows of a known login.
    const targetWindows =
      login === null
        ? []
        : [
            ...new Map(
              windows.filter((w) => w.kind === "weekly").map((w) => [w.id, w] as const),
            ).values(),
          ];
    const targets = (source: AllocationPolicy) =>
      source.overrides.filter(
        (o) =>
          o.accountKey === login &&
          targetWindows.some((w) => w.id === o.windowId) &&
          Date.parse(o.expiresAt) > now,
      );
    const supportsCaps = allocationSupportsSubscriptionCaps(group.members);
    const saved = snapshot?.policy ?? policy;
    return {
      ...group,
      login,
      // An account with no known login is told apart by its computers.
      name: `${group.label}${login === null ? ` (${group.hosts.join(", ")})` : ""}`,
      family:
        allocationFamilies.find((family) => family.driver === group.driver)?.family ??
        ("other" as const),
      usage: {
        weekly: windows.find((w) => w.kind === "weekly" && !w.models?.length),
        short: windows.find((w) => w.kind === "session"),
      },
      supportsCaps,
      capSource: allocationSubscriptionCapSource(group.members),
      /** Computers whose own settings keep workers off this account. */
      workersOffOn: group.members.flatMap((member) =>
        member.availableForWorkers === false
          ? [
              snapshot?.inventories.find((i) => i.environmentId === member.environmentId)
                ?.environmentLabel ?? member.environmentId,
            ]
          : [],
      ),
      rules: {
        exclude: rule(policy, "exclude"),
        maxWorkers: rule(policy, "maxWorkers"),
        priority: rule(policy, "priority"),
      },
      cap: group.keys.map((key) => allocationAccountCap(policy, key)).find(Boolean),
      targetWindows,
      target: targets(policy).findLast((o) => o.curve !== undefined),
      // Decided from the saved policy, so a row does not move while it is being edited.
      other:
        group.members.every((member) => member.enabled === false) ||
        (!supportsCaps &&
          !(["exclude", "maxWorkers", "priority"] as const).some((kind) => rule(saved, kind)) &&
          !group.keys.some((key) => allocationAccountCap(saved, key)) &&
          !targets(saved).length),
    };
  });
}
export type AllocationAccountRow = ReturnType<typeof allocationAccountRows>[number];

/**
 * The policy with this account's temporary budget changed, or removed when `patch` is undefined.
 * A new one copies the family curve and ends at the weekly reset, or in a week.
 */
export function withAllocationTarget(
  policy: AllocationPolicy,
  row: Pick<AllocationAccountRow, "login" | "family" | "target" | "targetWindows">,
  patch:
    | { readonly burstPoints?: number; readonly dailyPoints?: number; readonly expiresAt?: string }
    | undefined,
  now: number,
): AllocationPolicy {
  const mine = (o: AllocationPolicy["overrides"][number]) =>
    o.accountKey === row.login && row.targetWindows.some((w) => w.id === o.windowId);
  if (row.login === null || !row.targetWindows.length) return policy;
  if (!patch)
    return {
      ...policy,
      // A use-by plan on the same window is a separate instruction and stays.
      overrides: policy.overrides.flatMap((o) => {
        if (!mine(o) || !o.curve) return [o];
        const { curve: _curve, ...plan } = o;
        return plan.useBy ? [plan] : [];
      }),
    };
  const { expiresAt, ...points } = patch;
  const family = policy[row.family];
  const curve = {
    ...(row.target?.curve ?? {
      ...family,
      preset: "custom" as const,
      dailyPoints: family.preset === "aggressive17" ? 17 : family.dailyPoints,
      burstPoints: family.preset === "aggressive17" ? 0 : family.burstPoints,
      burstHours: family.preset === "aggressive17" ? 0 : family.burstHours,
    }),
    ...points,
  };
  const reset = Date.parse(row.targetWindows[0]!.resetsAt ?? "");
  const until =
    expiresAt ?? row.target?.expiresAt ?? isoTime(reset > now ? reset : now + 7 * 86_400_000);
  const createdAt = isoTime(now);
  return {
    ...policy,
    overrides: [
      ...policy.overrides.filter((o) => !mine(o)),
      ...row.targetWindows.map((window) => {
        const existing = policy.overrides.findLast(
          (o) => o.accountKey === row.login && o.windowId === window.id,
        );
        return {
          accountKey: row.login!,
          windowId: window.id,
          createdAt: existing?.createdAt ?? createdAt,
          baselineUsedPoints: existing?.baselineUsedPoints ?? window.usedPoints,
          ...(existing?.useBy ? { useBy: existing.useBy } : {}),
          ...(existing?.resetPlan ? { resetPlan: existing.resetPlan } : {}),
          expiresAt: until,
          curve,
        };
      }),
    ],
  };
}

/** The models a provider family's accounts offer, each with the efforts it can run at. */
export function allocationWorkerModelChoices(snapshot: AllocationSnapshot | null, driver: string) {
  const choices = new Map<string, Set<string>>();
  for (const account of snapshot?.inventories.flatMap((i) => i.accounts) ?? []) {
    if (account.driver !== driver) continue;
    for (const model of account.models) {
      const effort = model.capabilities?.optionDescriptors?.find(
        (option) => option.id === routingEffortOptionId(driver),
      );
      if (effort?.type !== "select") continue;
      const efforts = choices.get(model.slug) ?? new Set<string>();
      for (const option of effort.options) efforts.add(option.id);
      choices.set(model.slug, efforts);
    }
  }
  return [...choices].map(([model, efforts]) => ({ model, efforts: [...efforts] }));
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
