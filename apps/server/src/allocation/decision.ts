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
  const model = account.models.find((m) => m.slug === request.model);
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
): AllocationDemand[] {
  const demand = inventories.flatMap((host) => host.demand);
  const keys = new Set(demand.map((d) => `${d.environmentId}:${d.threadId}`));
  for (const reservation of reservations) {
    if (
      reservation.state !== "starting" &&
      reservation.state !== "consumed" &&
      !(reservation.state === "reserved" && reservation.expiresAt > at)
    )
      continue;
    const request = reservation.request;
    const key = `${request.environmentId}:${request.threadId}`;
    if (keys.has(key)) continue;
    keys.add(key);
    demand.push({
      environmentId: request.environmentId,
      threadId: request.threadId,
      instanceId: reservation.instanceId,
      accountKey: reservation.accountKey,
      model: request.model,
      options: request.options,
      state: "pending",
    });
  }
  return demand;
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
  if (new Set(request.options.map((o) => o.id)).size !== request.options.length)
    globalReasons.push("Duplicate option IDs are ambiguous; supply each requested option once.");
  if (!input.authorityAvailable)
    globalReasons.push("Allocation coordinator unavailable or not configured.");
  if (
    inventories.some(
      (i) => !i.complete || now - Date.parse(i.observedAt) > policy.maxReadingAgeMinutes * 60_000,
    )
  ) {
    globalReasons.push("Load from a required environment is unknown or stale.");
  }
  if (!inventories.some((i) => i.environmentId === request.environmentId))
    globalReasons.push("Execution environment unavailable.");
  if ((request.expectedHours ?? 0) > policy.maxForecastHours)
    globalReasons.push(
      "Expected duration exceeds the configured forecast horizon. Raise the horizon or split the assignment.",
    );
  const demand = activeDemand(inventories, input.reservations, at);
  if (demand.some((d) => !d.accountKey))
    globalReasons.push(
      "An active assignment has unknown account identity; its demand cannot be reconciled safely.",
    );
  const duration = Math.max(
    policy.defaultHours,
    request.expectedHours ??
      (request.workClass === "long" ? policy.maxForecastHours : policy.defaultHours),
  );
  const allAccounts = inventories
    .flatMap((i) => i.accounts)
    .sort(
      (a, b) => compare(a.environmentId, b.environmentId) || compare(a.instanceId, b.instanceId),
    );
  const candidateWaits: string[] = [];
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
      if (!account.available) reasons.push(account.unavailableReason ?? "Account unavailable.");
      if (account.limitedUntil && Date.parse(account.limitedUntil) > now)
        reasons.push("Provider usage-limit rejection remains authoritative.");
      if (
        siblings.some(
          (a) =>
            (a.instanceId !== account.instanceId || a.environmentId !== account.environmentId) &&
            ((a.limitedUntil && Date.parse(a.limitedUntil) > now) ||
              a.unavailableReason?.startsWith("Provider rejected")),
        )
      )
        reasons.push("Another environment reported a rejection for this shared account.");
      if (!account.accountKey)
        reasons.push("Shared account identity is unknown; aliases are not identity.");
      if (account.shortWindow === "unknown") reasons.push("Short-window availability is unknown.");
      if (account.shortWindow === "known-absent") {
        const checked = Date.parse(account.shortWindowAbsentCheckedAt ?? "");
        if (!Number.isFinite(checked) || now - checked > policy.maxReadingAgeMinutes * 60_000)
          reasons.push("Evidence that no short window was reported is missing or stale.");
        else if (checked > now + 60_000)
          reasons.push("Evidence that no short window was reported is from the future.");
      }
      const existing = demand.filter(
        (d) =>
          d.accountKey === account.accountKey &&
          account.accountKey !== null &&
          !(d.threadId === request.threadId && d.environmentId === request.environmentId),
      );
      const relevant = account.windows.filter((w) => !w.models || w.models.includes(request.model));
      if (!relevant.length) reasons.push("No measured allowance for this assignment.");
      if (
        account.shortWindow === "reported" &&
        !relevant.some(
          (w) => w.kind === "session" || (w.durationHours !== null && w.durationHours <= 24),
        )
      )
        reasons.push("No applicable short-window reading for this model.");
      let confidence: "low" | "medium" = "medium";
      let behind = 0;
      // Only measured headroom blockers have an actionable reset estimate. Identity,
      // compatibility, health, unknown evidence and pacing need another observation
      // or action; the passage of an unrelated reset does not resolve them.
      let canWait = reasons.length === 0;
      const blockedUntil: string[] = [];
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
        const knownLoadRate = bucketDemand.length * perAssignment;
        // The measured delta includes external hosts, terminals and subagents. It is an
        // aggregate floor, NOT another worker to add to observed local demand.
        const observedRate = comparable
          ? (Math.max(0, window.ratePointsPerHour ?? 0) +
              Math.max(0, window.predictionErrorPointsPerHour ?? 0)) *
            policy.uncertaintyMultiplier
          : 0;
        const horizon = Math.min(
          Math.max(
            policy.defaultHours,
            Math.min(duration * policy.uncertaintyMultiplier, policy.maxForecastHours),
          ),
          resetHours !== null && resetHours > 0 ? resetHours : policy.maxForecastHours,
        );
        const ongoingHorizon = Math.min(
          policy.maxForecastHours,
          resetHours !== null && resetHours > 0 ? resetHours : policy.maxForecastHours,
        );
        const knownDemandPoints = bucketDemand.reduce((sum, d) => {
          const held = input.reservations.find(
            (r) =>
              r.request.threadId === d.threadId &&
              r.request.environmentId === d.environmentId &&
              ["reserved", "starting", "consumed"].includes(r.state),
          );
          const remainingHours = held?.request.expectedHours
            ? Math.max(
                policy.defaultHours,
                held.request.expectedHours * policy.uncertaintyMultiplier -
                  (now - Date.parse(held.createdAt)) / HOUR,
              )
            : policy.maxForecastHours;
          return sum + perAssignment * Math.min(remainingHours, ongoingHorizon);
        }, 0);
        const forecastPoints =
          Math.max(knownDemandPoints, observedRate * ongoingHorizon) +
          perAssignment * horizon +
          ((Math.max(knownLoadRate, observedRate) + perAssignment) * ageMinutes) / 60;
        const headroomPoints = usable - window.usedPoints - forecastPoints;
        if (issues.length > 0) canWait = false;
        if (headroomPoints < 0) {
          issues.push("Insufficient headroom for ongoing and incoming demand.");
          if (forecastPoints <= usable && window.resetsAt && Date.parse(window.resetsAt) > now)
            blockedUntil.push(window.resetsAt);
          else canWait = false;
        }
        // Borrowing includes already consumed debt plus committed demand. Completing
        // work cannot renew that allowance. Explicit selection overrides pacing only.
        if (
          !short &&
          window.cycleStartedAt &&
          !request.explicitInstanceId &&
          window.usedPoints + forecastPoints > target + curve.borrowPoints
        ) {
          canWait = false;
          issues.push(
            "Projected consumption exceeds the target plus bounded borrowing. Reduce the assignment or tune borrowing.",
          );
        }
        reasons.push(...issues.map((r) => `${window.label}: ${r}`));
        return {
          id: window.id,
          actualPoints: window.usedPoints,
          targetPoints: target,
          forecastPoints,
          headroomPoints,
          samples: window.samples,
          ageMinutes,
          resetsAt: window.resetsAt,
          reasons: issues,
        };
      });
      const resets = relevant
        .flatMap((w) => (w.resetsAt ? [(Date.parse(w.resetsAt) - now) / HOUR] : []))
        .filter((h) => h > 0);
      if (canWait && blockedUntil.length > 0) candidateWaits.push(blockedUntil.sort().at(-1)!);
      return {
        environmentId: account.environmentId,
        instanceId: account.instanceId,
        accountKey: account.accountKey,
        eligible: reasons.length === 0 && globalReasons.length === 0,
        reasons,
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
      const score = (c: AllocationCandidate) =>
        c.behindPoints + (c.accountKey === input.previousAccountKey ? policy.hysteresisPoints : 0);
      return (
        score(b) - score(a) ||
        (a.resetInHours ?? Infinity) - (b.resetInHours ?? Infinity) ||
        compare(a.accountKey ?? "", b.accountKey ?? "") ||
        compare(a.instanceId, b.instanceId)
      );
    });
  const selected = eligible[0];
  const waitUntil = !selected && !globalReasons.length ? (candidateWaits.sort()[0] ?? null) : null;
  return {
    at,
    policyVersion: policy.version,
    request,
    outcome: selected ? "selected" : waitUntil ? "wait" : "unavailable",
    selectedInstanceId: selected?.instanceId ?? null,
    candidates,
    confidence: selected?.confidence ?? "low",
    reasons: selected
      ? [
          request.explicitInstanceId
            ? "Explicit compatible account has safe headroom."
            : selected.behindPoints > 0
              ? "Safe account furthest behind its allowance target."
              : "All safe accounts are at or ahead of target; admitting bounded useful work.",
        ]
      : [
          ...globalReasons,
          waitUntil
            ? "Recheck after the estimated reset; fresh provider confirmation is required before admission."
            : "No safe compatible account. Resolve the reported blockers and refresh readings; no reliable wait estimate is available.",
        ],
    waitUntil,
  };
}
