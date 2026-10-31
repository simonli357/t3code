import {
  allocationPreferenceKey,
  allocationPreferenceWeight,
  WORKER_ACCOUNT_DISABLED_REASON,
} from "@t3tools/contracts";
import type {
  AllocationAccount,
  AllocationCandidate,
  AllocationCurve,
  AllocationDecision,
  AllocationDemand,
  AllocationInventory,
  AllocationPolicy,
  AllocationRequest,
  AllocationReservation,
  AllocationWindow,
} from "@t3tools/contracts";
import { findCatalogModel } from "@t3tools/shared/model";

const HOUR = 3_600_000;
const bounded = (value: number, max = 100) => Math.max(0, Math.min(max, value));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function curveFor(policy: AllocationPolicy, driver: string): AllocationCurve {
  return driver === "codex"
    ? policy.codex
    : driver === "claudeAgent"
      ? policy.claude
      : policy.other;
}

/** Percentage points of the allowance, from the provider's cycle, never calendar days. */
export function targetPoints(window: AllocationWindow, curve: AllocationCurve, at: string): number {
  if (!window.cycleStartedAt || !window.durationHours || window.durationHours <= 0) return 0;
  const elapsed = Math.max(0, (Date.parse(at) - Date.parse(window.cycleStartedAt)) / HOUR);
  const usable = 100 - curve.reservePoints;
  if (curve.preset === "sustainable")
    return bounded((usable * elapsed) / window.durationHours, usable);
  const daily = curve.preset === "aggressive17" ? 17 : curve.dailyPoints;
  const burst = curve.preset === "aggressive17" ? 0 : curve.burstPoints;
  const releasedBurst =
    curve.burstHours === 0 ? burst : burst * bounded(elapsed / curve.burstHours, 1);
  return bounded(releasedBurst + (daily * elapsed) / 24, usable);
}

function compatible(account: AllocationAccount, request: AllocationRequest) {
  const model = findCatalogModel(account.models, request.model);
  if (!model) return false;
  return request.options.every((option) => {
    const descriptor = model.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
    return descriptor?.type === "boolean"
      ? typeof option.value === "boolean"
      : descriptor?.type === "select" && descriptor.options.some((c) => c.id === option.value);
  });
}

function activeDemand(
  inventories: readonly AllocationInventory[],
  reservations: readonly AllocationReservation[],
  at: string,
  maxReadingAgeMinutes: number,
): AllocationDemand[] {
  const keyFor = (d: { environmentId: string; threadId: string }) =>
    JSON.stringify([d.environmentId, d.threadId]);
  const bySession = new Map<string, AllocationDemand>();
  for (const host of [...inventories].sort((a, b) => compare(b.observedAt, a.observedAt)))
    for (const d of host.demand) if (!bySession.has(keyFor(d))) bySession.set(keyFor(d), d);
  for (const reservation of reservations) {
    if (
      reservation.state !== "starting" &&
      reservation.state !== "consumed" &&
      !(reservation.state === "reserved" && reservation.expiresAt > at)
    )
      continue;
    const request = reservation.request;
    const key = keyFor(request);
    if (bySession.has(key)) continue;
    // A fresh complete snapshot confirms that a consumed session is now idle.
    // Missing/stale hosts cannot release this accounting on their own.
    const observedIdle = inventories.some(
      (host) =>
        host.environmentId === request.environmentId &&
        host.complete &&
        host.observedAt >= reservation.createdAt &&
        host.observedAt <= at &&
        Date.parse(at) - Date.parse(host.observedAt) <= maxReadingAgeMinutes * 60_000,
    );
    if (reservation.state === "consumed" && observedIdle) continue;
    bySession.set(key, {
      environmentId: request.environmentId,
      threadId: request.threadId,
      instanceId: reservation.instanceId,
      accountKey: reservation.accountKey,
      model: request.model,
      options: request.options,
      state: reservation.state === "consumed" ? "uncertain" : "pending",
    });
  }
  return [...bySession.values()];
}

/** Weights and continuity can move a recommendation only within the live preference margin. */
export function allocationScore(
  candidate: AllocationCandidate,
  policy: AllocationPolicy,
  driver: string,
  previousAccountKey?: string,
): number {
  const headroom = candidate.windows.length
    ? Math.min(...candidate.windows.map((w) => w.budgetHeadroomPoints ?? w.headroomPoints))
    : -Infinity;
  const weight = allocationPreferenceWeight(
    policy,
    allocationPreferenceKey({ ...candidate, driver }),
  );
  return (
    headroom +
    policy.hysteresisPoints * (weight / 100 + (candidate.accountKey === previousAccountKey ? 1 : 0))
  );
}

/** Pure replay boundary. Callers persist the exact policy, inventories and timestamp. */
export function decideAllocation(input: {
  at: string;
  policy: AllocationPolicy;
  request: AllocationRequest;
  inventories: readonly AllocationInventory[];
  reservations: readonly AllocationReservation[];
  authorityAvailable: boolean;
  previousAccountKey?: string;
}): AllocationDecision {
  const { at, policy, request, inventories } = input;
  const now = Date.parse(at);
  const globalReasons: string[] = [];
  const globalWarnings: string[] = [];
  if (new Set(request.options.map((o) => o.id)).size !== request.options.length)
    globalReasons.push("Duplicate option IDs are ambiguous; supply each requested option once.");
  if (!input.authorityAvailable)
    globalWarnings.push("Allocation coordinator unavailable or not configured.");
  const incompleteLoad = inventories.some(
    (i) => !i.complete || now - Date.parse(i.observedAt) > policy.maxReadingAgeMinutes * 60_000,
  );
  if (incompleteLoad) {
    globalWarnings.push(
      "Linked environment load is unknown or stale; forecasts may be incomplete.",
    );
  }
  if (
    inventories.some(
      (i) => i.complete && i.coordinatorEnvironmentId !== policy.coordinatorEnvironmentId,
    )
  )
    globalWarnings.push(
      "Linked environment coordinator settings differ or are unknown; forecasts may be incomplete.",
    );
  if (!inventories.some((i) => i.environmentId === request.environmentId))
    globalReasons.push("Execution environment unavailable.");
  if ((request.expectedHours ?? 0) > policy.maxForecastHours)
    globalWarnings.push(
      "Expected duration exceeds the configured forecast horizon. Raise the horizon or split the assignment.",
    );
  const demand = activeDemand(inventories, input.reservations, at, policy.maxReadingAgeMinutes);
  if (demand.some((d) => d.state === "uncertain"))
    globalWarnings.push(
      "An active reservation has unconfirmed execution state; its forecast remains counted.",
    );
  if (demand.some((d) => !d.accountKey))
    globalWarnings.push(
      "An active assignment has unknown account identity; its demand cannot be reconciled safely.",
    );
  const duration = request.expectedHours ?? policy.defaultHours;
  const allAccounts = inventories
    .flatMap((i) => i.accounts)
    .sort(
      (a, b) => compare(a.environmentId, b.environmentId) || compare(a.instanceId, b.instanceId),
    );
  const candidates: AllocationCandidate[] = allAccounts
    .map((localAccount) => {
      const siblings = localAccount.accountKey
        ? allAccounts.filter((a) => a.accountKey === localAccount.accountKey)
        : [localAccount];
      // Windows describe one allowance, not one host. Use the newest observation;
      // equally timed disagreement takes the more conservative reading.
      const windowsById = new Map<string, AllocationWindow>();
      for (const sibling of siblings)
        for (const w of sibling.windows) {
          const old = windowsById.get(w.id);
          if (
            !old ||
            w.checkedAt > old.checkedAt ||
            (w.checkedAt === old.checkedAt && w.usedPoints > old.usedPoints)
          )
            windowsById.set(w.id, w);
        }
      for (const [id, observation] of windowsById) {
        // Observation and measurement clocks are independent; rates are aggregate
        // account burn, so choose one conservative same-cycle estimate, never sum hosts.
        const measured = siblings
          .flatMap((sibling) => {
            const hostAt = inventories.find(
              (i) => i.environmentId === sibling.environmentId,
            )?.observedAt;
            return sibling.windows
              .filter(
                (w) =>
                  w.id === id &&
                  observation.cycleStartedAt !== null &&
                  w.cycleStartedAt === observation.cycleStartedAt &&
                  w.resetsAt === observation.resetsAt &&
                  w.durationHours === observation.durationHours &&
                  w.samples >= policy.minimumSamples &&
                  w.ratePointsPerHour !== null &&
                  w.rateAgeMinutes !== null &&
                  hostAt,
              )
              .map((w) => ({
                ...w,
                rateAgeMinutes:
                  w.rateAgeMinutes! + Math.max(0, (now - Date.parse(hostAt!)) / 60_000),
              }));
          })
          .filter((w) => w.rateAgeMinutes >= 0 && w.rateAgeMinutes <= policy.maxReadingAgeMinutes)
          .sort(
            (a, b) =>
              (b.ratePointsPerHour ?? 0) +
                (b.predictionErrorPointsPerHour ?? 0) -
                ((a.ratePointsPerHour ?? 0) + (a.predictionErrorPointsPerHour ?? 0)) ||
              (b.ratePointsPerHour ?? 0) - (a.ratePointsPerHour ?? 0) ||
              a.rateAgeMinutes - b.rateAgeMinutes ||
              b.samples - a.samples ||
              compare(b.checkedAt, a.checkedAt),
          );
        const rate = measured[0];
        windowsById.set(id, {
          ...observation,
          ratePointsPerHour: rate?.ratePointsPerHour ?? null,
          predictionErrorPointsPerHour: rate?.predictionErrorPointsPerHour ?? null,
          rateAgeMinutes: rate?.rateAgeMinutes ?? null,
          samples: rate?.samples ?? 0,
        });
      }
      const account = {
        ...localAccount,
        windows: [...windowsById.values()].sort((a, b) => compare(a.id, b.id)),
      };
      const reasons: string[] = [];
      if (request.kind !== "session" && account.availableForWorkers === false)
        reasons.push(WORKER_ACCOUNT_DISABLED_REASON);
      if (account.environmentId !== request.environmentId)
        reasons.push("Different execution environment.");
      if (account.driver !== request.driver) reasons.push("Different provider family.");
      if (request.explicitInstanceId && account.instanceId !== request.explicitInstanceId)
        reasons.push("Explicit account selection.");
      if (request.nativeInstanceId && account.instanceId !== request.nativeInstanceId)
        reasons.push("Native session is bound to another account.");
      if (request.allowedInstanceIds && !request.allowedInstanceIds.includes(account.instanceId))
        reasons.push("Outside allowed accounts.");
      if (!compatible(account, request)) reasons.push("Exact model/options are not supported.");
      const warnings: string[] = [...globalWarnings];
      if (!account.available) warnings.push(account.unavailableReason ?? "Account unavailable.");
      if (account.limitedUntil && Date.parse(account.limitedUntil) > now)
        warnings.push(
          "Recorded provider usage-limit rejection; the next provider attempt may still fail.",
        );
      if (
        siblings.some(
          (a) =>
            (a.instanceId !== account.instanceId || a.environmentId !== account.environmentId) &&
            ((a.limitedUntil && Date.parse(a.limitedUntil) > now) ||
              a.unavailableReason?.startsWith("Provider rejected")),
        )
      )
        warnings.push("Another environment reported a rejection for this shared account.");
      if (!account.accountKey)
        warnings.push("Shared account identity is unknown; aliases are not identity.");
      if (account.shortWindow === "unknown") warnings.push("Short-window availability is unknown.");
      if (account.shortWindow === "known-absent") {
        const checked = Date.parse(account.shortWindowAbsentCheckedAt ?? "");
        if (!Number.isFinite(checked) || now - checked > policy.maxReadingAgeMinutes * 60_000)
          warnings.push("Evidence that no short window was reported is missing or stale.");
        else if (checked > now + 60_000)
          warnings.push("Evidence that no short window was reported is from the future.");
      }
      const existing = demand.filter(
        (d) =>
          (account.accountKey !== null
            ? d.accountKey === account.accountKey
            : d.environmentId === account.environmentId && d.instanceId === account.instanceId) &&
          !(d.threadId === request.threadId && d.environmentId === request.environmentId),
      );
      const model = findCatalogModel(account.models, request.model)?.slug ?? request.model;
      const relevant = account.windows.filter((w) => !w.models || w.models.includes(model));
      if (!relevant.length) warnings.push("No measured allowance for this assignment.");
      if (
        account.shortWindow === "reported" &&
        !relevant.some(
          (w) => w.kind === "session" || (w.durationHours !== null && w.durationHours <= 24),
        )
      )
        warnings.push("No applicable short-window reading for this model.");
      let confidence: "low" | "medium" =
        incompleteLoad ||
        demand.some((d) => d.state === "uncertain" || !d.accountKey) ||
        !account.accountKey ||
        !relevant.length ||
        account.shortWindow === "unknown"
          ? "low"
          : "medium";
      let behind = 0;
      const windows = relevant.map((window) => {
        const issues: string[] = [];
        const ageMinutes = Math.max(0, (now - Date.parse(window.checkedAt)) / 60_000);
        if (ageMinutes > policy.maxReadingAgeMinutes) issues.push("Quota reading is stale.");
        if (Date.parse(window.checkedAt) > now + 60_000)
          issues.push("Quota reading is from the future.");
        if (window.cycleStartedAt && Date.parse(window.cycleStartedAt) > now)
          issues.push("Allowance cycle has not started; replenishment is unconfirmed.");
        const resetHours = window.resetsAt ? (Date.parse(window.resetsAt) - now) / HOUR : null;
        if (resetHours !== null && resetHours <= 0)
          issues.push("Reset time passed; replenishment is not confirmed.");
        if (issues.length) confidence = "low";
        const short =
          window.kind === "session" ||
          (window.durationHours !== null && window.durationHours <= 24);
        const baseCurve = curveFor(policy, account.driver);
        const override = policy.overrides.findLast(
          (o) =>
            o.accountKey === account.accountKey &&
            o.windowId === window.id &&
            o.createdAt <= at &&
            o.expiresAt > at,
        );
        const curve = override?.curve ?? baseCurve;
        const usable = 100 - curve.reservePoints;
        let target = targetPoints(window, curve, at);
        if (override?.useBy && Date.parse(override.useBy) > Date.parse(override.createdAt)) {
          const fraction = bounded(
            (now - Date.parse(override.createdAt)) /
              (Date.parse(override.useBy) - Date.parse(override.createdAt)),
            1,
          );
          target = bounded(
            override.baselineUsedPoints + (usable - override.baselineUsedPoints) * fraction,
            usable,
          );
        }
        // Unknown cycles cannot claim a pacing deficit. Safe headroom still permits useful work.
        if (!short && window.cycleStartedAt) behind = Math.max(behind, target - window.usedPoints);
        const cold = short ? policy.coldShortPointsPerHour : policy.coldLongPointsPerHour;
        const comparable =
          window.samples >= policy.minimumSamples &&
          window.rateAgeMinutes !== null &&
          window.rateAgeMinutes <= policy.maxReadingAgeMinutes &&
          window.ratePointsPerHour !== null;
        if (!comparable || account.profileSamples < policy.minimumSamples) confidence = "low";
        const perAssignment =
          Math.max(0.1, cold) *
          policy.uncertaintyMultiplier *
          Math.max(1, Math.min(2, account.profileUncertainty));
        const bucketDemand = existing.filter(
          (d) => !window.models || window.models.includes(d.model),
        );
        // Use each ongoing model/effort's measured variability, never the incoming
        // assignment's profile. Missing profile evidence uses the existing fallback.
        const demandRate = (d: AllocationDemand) => {
          const effort =
            d.options.find((o) => o.id === "reasoningEffort" || o.id === "effort")?.value ?? null;
          const variability = siblings
            .flatMap((s) => s.usageProfiles ?? [])
            .filter(
              (p) =>
                p.model === d.model && p.effort === effort && p.samples >= policy.minimumSamples,
            )
            .reduce((margin, p) => Math.max(margin, p.uncertainty ?? 1), 1);
          return Math.max(0.1, cold) * policy.uncertaintyMultiplier * Math.min(2, variability);
        };
        const knownLoadRate = bucketDemand.reduce((sum, d) => sum + demandRate(d), 0);
        // The measured delta includes external hosts, terminals and subagents. It is an
        // aggregate floor, NOT another worker to add to observed local demand.
        const observedRate = comparable
          ? (Math.max(0, window.ratePointsPerHour ?? 0) +
              Math.max(0, window.predictionErrorPointsPerHour ?? 0)) *
            policy.uncertaintyMultiplier
          : 0;
        const horizonCap = Math.min(
          policy.maxForecastHours,
          resetHours !== null && resetHours > 0 ? resetHours : policy.maxForecastHours,
        );
        const horizon = Math.min(duration * policy.uncertaintyMultiplier, horizonCap);
        let ongoingHorizon = horizon;
        let runningForecastPoints = 0;
        let queuedForecastPoints = 0;
        const knownDemandPoints = bucketDemand.reduce((sum, d) => {
          const held = input.reservations.find(
            (r) =>
              r.request.threadId === d.threadId &&
              r.request.environmentId === d.environmentId &&
              (r.state === "starting" ||
                r.state === "consumed" ||
                (r.state === "reserved" && r.expiresAt > at)),
          );
          const expected = held?.request.expectedHours ?? policy.defaultHours;
          // Waiting for startup is not elapsed execution. Still-active work cannot
          // become free after its estimate: retain a default-sized tail, or its
          // own shorter estimate. Unknown durations never imply the maximum cap.
          const elapsed =
            held?.state === "consumed" ? Math.max(0, (now - Date.parse(held.createdAt)) / HOUR) : 0;
          const remaining = Math.min(
            horizonCap,
            Math.max(
              Math.min(expected, policy.defaultHours) * policy.uncertaintyMultiplier,
              expected * policy.uncertaintyMultiplier - elapsed,
            ),
          );
          ongoingHorizon = Math.max(ongoingHorizon, remaining);
          const points = demandRate(d) * remaining;
          if (d.state === "pending") queuedForecastPoints += points;
          else runningForecastPoints += points;
          return sum + points;
        }, 0);
        const incomingForecastPoints = perAssignment * horizon;
        const unobservedForecastPoints =
          Math.max(0, observedRate * ongoingHorizon - knownDemandPoints) +
          ((Math.max(knownLoadRate, observedRate) + perAssignment) * ageMinutes) / 60;
        const forecastPoints =
          knownDemandPoints + incomingForecastPoints + unobservedForecastPoints;
        const headroomPoints = usable - window.usedPoints - forecastPoints;
        const budgetPoints =
          !short && window.cycleStartedAt ? Math.min(usable, target + curve.borrowPoints) : usable;
        const budgetHeadroomPoints = budgetPoints - window.usedPoints - forecastPoints;
        if (headroomPoints < 0) {
          issues.push("Insufficient headroom for ongoing and incoming demand.");
        }
        // Preserve pacing debt in the recommendation, including explicit choices.
        // Forecasts explain risk; only actual capability/identity constraints block selection.
        if (
          !short &&
          window.cycleStartedAt &&
          window.usedPoints + forecastPoints > target + curve.borrowPoints
        ) {
          issues.push("Projected consumption exceeds the target plus bounded borrowing.");
        }
        warnings.push(...issues.map((r) => `${window.label}: ${r}`));
        return {
          id: window.id,
          actualPoints: window.usedPoints,
          targetPoints: target,
          forecastPoints,
          headroomPoints,
          budgetPoints,
          budgetHeadroomPoints,
          runningForecastPoints,
          queuedForecastPoints,
          incomingForecastPoints,
          unobservedForecastPoints,
          samples: window.samples,
          ageMinutes,
          resetsAt: window.resetsAt,
          reasons: issues,
        };
      });
      const resets = relevant
        .flatMap((w) => (w.resetsAt ? [(Date.parse(w.resetsAt) - now) / HOUR] : []))
        .filter((h) => h > 0);
      return {
        environmentId: account.environmentId,
        instanceId: account.instanceId,
        accountKey: account.accountKey,
        eligible: reasons.length === 0 && globalReasons.length === 0,
        reasons,
        warnings,
        behindPoints: behind,
        resetInHours: resets.length ? Math.min(...resets) : null,
        confidence,
        windows,
      };
    })
    .sort(
      (a, b) =>
        compare(a.environmentId, b.environmentId) ||
        compare(a.accountKey ?? "", b.accountKey ?? "") ||
        compare(a.instanceId, b.instanceId),
    );
  const eligible = candidates
    .filter((c) => c.eligible)
    .sort((a, b) => {
      return (
        (a.warnings?.length ?? 0) - (b.warnings?.length ?? 0) ||
        allocationScore(b, policy, request.driver, input.previousAccountKey) -
          allocationScore(a, policy, request.driver, input.previousAccountKey) ||
        (a.resetInHours ?? Infinity) - (b.resetInHours ?? Infinity) ||
        compare(a.accountKey ?? "", b.accountKey ?? "") ||
        compare(a.instanceId, b.instanceId)
      );
    });
  const selected = eligible[0];
  return {
    at,
    policyVersion: policy.version,
    request,
    outcome: selected ? "selected" : "unavailable",
    selectedInstanceId: selected?.instanceId ?? null,
    candidates,
    confidence: selected?.confidence ?? "low",
    reasons: selected
      ? [
          request.explicitInstanceId
            ? "Explicit compatible account selected. Forecasts are advisory; provider success is not guaranteed."
            : "Recommended compatible account. The master chooses whether to start.",
          "Comparable warnings are ranked by the tightest projected budget headroom, with bounded account preferences.",
          ...(selected.warnings ?? []),
        ]
      : [
          ...globalReasons,
          ...(request.explicitInstanceId
            ? (candidates.find(
                (c) =>
                  c.environmentId === request.environmentId &&
                  c.instanceId === request.explicitInstanceId,
              )?.reasons ?? [])
            : []),
          "No account matches the requested profile, host and identity constraints.",
        ],
    waitUntil: null,
  };
}
