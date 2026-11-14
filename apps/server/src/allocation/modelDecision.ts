import {
  HIGH_STAKES,
  MAX_RUNG_DISTANCE,
  ProviderDriverKind,
  START_WAIT_MINUTES,
  START_WAIT_MINUTES_HIGH_STAKES,
  accountSupportsRoutingProfile,
  modelFallback,
  modelLadder,
  profileLabel,
  routingEffortOptionId,
  type AllocationDecision,
  type AllocationInventory,
  type AllocationLearned,
  type AllocationPolicy,
  type AllocationRequest,
  type AllocationReservation,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingProfile,
} from "@t3tools/contracts";
import { findCatalogModel } from "@t3tools/shared/model";
import { decideAllocation } from "./decision.ts";
import { span } from "./runway.ts";

/**
 * The profile each allowed provider family wants before quota is looked at: the pinned model,
 * or the table's entry for the scores. A table alternative applies only when no account on the
 * computer offers the entry itself.
 */
export function wantedProfiles(
  policy: ModelRoutingPolicy,
  request: ModelRoutingRequest,
  inventories: readonly AllocationInventory[],
) {
  const { difficulty, stakes } = request.assessment;
  const rule = `Difficulty ${difficulty}, stakes ${stakes}`;
  const reasons: string[] = [];
  const candidates: { request: AllocationRequest; reason: string }[] = [];
  const {
    selection: _selection,
    assessment: _assessment,
    policyVersion: _policyVersion,
    allowedDrivers,
    override,
    reassessment: _reassessment,
    ...constraints
  } = request;
  if (new Set(allowedDrivers).size !== allowedDrivers.length)
    return { rule, candidates, reasons: ["Allowed provider families must be unique."] };
  if (override) {
    if (!allowedDrivers.includes(override.driver))
      return {
        rule,
        candidates,
        reasons: ["The pinned model's provider family is not among the allowed ones."],
      };
    let options = override.options;
    if (!options) {
      // A model-only pin keeps the table's effort for this score pair.
      if (override.driver !== "codex" && override.driver !== "claudeAgent")
        return {
          rule,
          candidates,
          reasons: [`${override.driver}: the table has no effort for this provider; pin one.`],
        };
      const table = override.driver === "codex" ? policy.codex : policy.claudeAgent;
      const cell = table.cells[difficulty]![stakes]!;
      options = [{ id: routingEffortOptionId(override.driver), value: cell.effort }];
    }
    candidates.push({
      request: { ...constraints, driver: override.driver, model: override.model, options },
      reason: `${override.driver}: pinned model.`,
    });
    return { rule: `${rule}; model pinned`, candidates, reasons };
  }
  // Claude first: Codex is used only when a start asks for it.
  for (const driver of [...allowedDrivers].sort()) {
    if (driver !== "codex" && driver !== "claudeAgent") {
      reasons.push(`${driver}: the table covers Claude and Codex only; pin a model.`);
      continue;
    }
    const table = driver === "codex" ? policy.codex : policy.claudeAgent;
    const cell = table.cells[difficulty]![stakes]!;
    const profiles: readonly RoutingProfile[] = [cell, ...(cell.alternatives ?? [])];
    const accounts = inventories
      .flatMap((i) => i.accounts)
      .filter(
        (a) =>
          a.environmentId === request.environmentId &&
          a.driver === driver &&
          (!request.explicitInstanceId || a.instanceId === request.explicitInstanceId) &&
          (!request.nativeInstanceId || a.instanceId === request.nativeInstanceId) &&
          (!request.allowedInstanceIds || request.allowedInstanceIds.includes(a.instanceId)),
      );
    const index = profiles.findIndex((profile) =>
      accounts.some((a) => accountSupportsRoutingProfile(a, profile)),
    );
    const profile = profiles[index];
    if (!profile) {
      reasons.push(
        `${driver}: no account on this computer offers ${profiles.map((p) => `${p.model} / ${p.effort}`).join(" or ")}.`,
      );
      continue;
    }
    candidates.push({
      request: {
        ...constraints,
        driver: ProviderDriverKind.make(driver),
        model: profile.model,
        options: [{ id: routingEffortOptionId(driver), value: profile.effort }],
      },
      reason:
        index === 0
          ? `${driver}: table choice for difficulty ${difficulty}, stakes ${stakes}.`
          : `${driver}: table alternative for difficulty ${difficulty}, stakes ${stakes}; the entry itself is not offered here.`,
    });
  }
  return { rule, candidates, reasons };
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const effortRank = (effort: string) => {
  const index = EFFORTS.indexOf(effort);
  return index < 0 ? EFFORTS.length : index;
};
/** `claude-opus-5-5` and `claude-opus-4-8` are both `opus`. */
const family = (model: string) => model.replace(/^claude-/, "").split("-")[0];

/**
 * Where a profile stands on the ladder. One that is not a rung stands between the rungs of
 * its model (or of its model family) by effort; undefined when the ladder has none of those.
 */
export function ladderPosition(ladder: readonly RoutingProfile[], profile: RoutingProfile) {
  const exact = ladder.findIndex((r) => r.model === profile.model && r.effort === profile.effort);
  if (exact >= 0) return exact;
  const indexed = ladder.map((rung, index) => ({ rung, index }));
  const sameModel = indexed.filter(({ rung }) => rung.model === profile.model);
  const same = sameModel.length
    ? sameModel
    : indexed.filter(({ rung }) => family(rung.model) === family(profile.model));
  if (!same.length) return undefined;
  const equal = same.find(({ rung }) => rung.effort === profile.effort);
  if (equal) return equal.index;
  const below = same.filter(({ rung }) => effortRank(rung.effort) < effortRank(profile.effort));
  return below.length ? below.at(-1)!.index + 0.5 : same[0]!.index - 0.5;
}

/** The other rungs, nearest first; a tie goes to the lower rung. */
export function nearestRungs(
  ladder: readonly RoutingProfile[],
  profile: RoutingProfile,
  maxDistance = Infinity,
) {
  const position = ladderPosition(ladder, profile);
  if (position === undefined) return [];
  return ladder
    .map((rung, index) => ({ rung, index }))
    .filter(({ index }) => index !== position && Math.abs(index - position) <= maxDistance)
    .sort(
      (a, b) => Math.abs(a.index - position) - Math.abs(b.index - position) || a.index - b.index,
    )
    .map(({ rung }) => rung);
}

export const isFable = (model: string) => /fable/i.test(model);

const requestProfile = (request: AllocationRequest): RoutingProfile => ({
  model: request.model,
  effort: String(
    request.options.find((o) => o.id === routingEffortOptionId(request.driver))?.value ?? "",
  ),
});
const onRung = (request: AllocationRequest, rung: RoutingProfile): AllocationRequest => ({
  ...request,
  model: rung.model,
  options: [{ id: routingEffortOptionId(request.driver), value: rung.effort }],
});

export interface ProfileChoice {
  /** The decision that selected an account; absent when nothing can run it. */
  readonly decision?: AllocationDecision;
  /** Every profile that was tried for a family, the wanted one first. */
  readonly tried: readonly { request: AllocationRequest; reason: string; chosen: boolean }[];
  /** The table's or pinned profile, when the chosen one differs. */
  readonly wanted?: AllocationRequest;
  readonly rule: string;
  readonly reason: string;
  /** Present when the start is refused because everything is drained. */
  readonly drainedUntil?: string | null;
  /** The start waits for a limit's reset and begins then. */
  readonly startAt?: string;
  /** One line per account of the wanted family on the computer. */
  readonly accounts: readonly string[];
  readonly notes: readonly string[];
}

const fits = (decision: AllocationDecision) =>
  decision.selectedInstanceId !== null &&
  decision.candidates.find((c) => c.instanceId === decision.selectedInstanceId)?.fits !== false;

/**
 * Picks account, model and effort together. The wanted model on the account with the most
 * spare capacity, when it fits the job somewhere. Otherwise: wait for a limit that resets
 * within 30 minutes (45 at high stakes); else the nearest ladder rung that fits, at most two
 * away; else the fallback model below its threshold; else the wanted model on the account
 * that lasts longest. When every candidate is out, the same choice as of a reset within the
 * wait, queued for it; refused only when nothing comes back within the wait. With Fable
 * workers off, no worker gets a Fable model. In Fable mode a worker's table entry starts from
 * the first Fable rung at or above it and only Fable rungs stand in; a pinned model is kept.
 * Codex and a pinned account never change model.
 */
export function chooseProfile(input: {
  readonly at: string;
  readonly policy: AllocationPolicy;
  readonly modelPolicy: ModelRoutingPolicy;
  readonly request: ModelRoutingRequest;
  readonly inventories: readonly AllocationInventory[];
  readonly reservations: readonly AllocationReservation[];
  readonly authorityAvailable: boolean;
  readonly learned?: AllocationLearned | undefined;
}): ProfileChoice {
  const { modelPolicy, request, inventories, policy } = input;
  const resolved = wantedProfiles(modelPolicy, request, inventories);
  const decide = (candidate: AllocationRequest, startAt?: string) =>
    decideAllocation({ ...input, request: startAt ? { ...candidate, startAt } : candidate });
  const label = (r: AllocationRequest) => profileLabel(r.driver, r.model, r.options);
  const ladder = modelLadder(modelPolicy);
  const workers = request.kind !== "session";
  const fableOff = workers && policy.fableWorkers === false;
  const fableOnly = workers && policy.fableOnly === true;
  const fableRungs = ladder.filter((r) => isFable(r.model));
  const allowed = (r: RoutingProfile) => (isFable(r.model) ? !fableOff : !fableOnly);
  /** Fable mode's rung for a profile: the first Fable rung at or above it, else the top one. */
  const fableRung = (profile: RoutingProfile) => {
    const position = ladderPosition(ladder, profile) ?? -1;
    return ladder.find((r, i) => isFable(r.model) && i >= position) ?? fableRungs.at(-1);
  };
  const notes: string[] = [];
  const tried: { request: AllocationRequest; reason: string; chosen: boolean }[] = [];
  let refusal: { reason: string; drainedUntil: string | null; accounts: string[] } | undefined;
  const failures: string[] = [...resolved.reasons];
  const waitMinutes =
    request.assessment.stakes >= HIGH_STAKES ? START_WAIT_MINUTES_HIGH_STAKES : START_WAIT_MINUTES;
  // With a pinned account, the others are not part of the choice.
  const lines = (decision: AllocationDecision) =>
    decision.candidates
      .filter((c) => !request.explicitInstanceId || c.instanceId === request.explicitInstanceId)
      .map((c) => c.line ?? c.instanceId);
  for (const asked of resolved.candidates) {
    let wanted = asked;
    const profile = requestProfile(asked.request);
    if (fableOnly && request.override) {
      if (!fableRungs.some((r) => r.model === profile.model && r.effort === profile.effort))
        notes.push(
          `Fable mode is on, but ${label(asked.request)} is pinned for this worker and runs as pinned.`,
        );
    } else if (fableOnly) {
      const rung = asked.request.driver === "claudeAgent" ? fableRung(profile) : undefined;
      if (!rung) {
        failures.push(
          `${asked.request.driver}: Fable mode is on and ${asked.request.driver === "claudeAgent" ? "the ladder has no Fable rung" : "only Claude runs Fable"}.`,
        );
        continue;
      }
      if (rung.model !== profile.model || rung.effort !== profile.effort) {
        notes.push(
          `Fable mode: ${label(asked.request)} starts from ${rung.model} / ${rung.effort}, the first Fable rung at or above it.`,
        );
        wanted = { request: onRung(asked.request, rung), reason: `${asked.reason} Fable mode.` };
      }
    } else if (fableOff && isFable(asked.request.model)) {
      const rung = nearestRungs(ladder, profile).find(allowed);
      if (!rung) {
        failures.push(
          `${asked.request.driver}: Fable workers are off and the ladder has no other rung.`,
        );
        continue;
      }
      notes.push(
        `Fable workers are off: ${label(asked.request)} starts from ${rung.model} / ${rung.effort}, the nearest rung without Fable.`,
      );
      wanted = {
        request: onRung(asked.request, rung),
        reason: `${asked.reason} Fable workers are off.`,
      };
    }
    const first = decide(wanted.request);
    const chosen = (
      decision: AllocationDecision,
      candidate: AllocationRequest,
      why: string | undefined,
      extra: Partial<ProfileChoice> = {},
    ): ProfileChoice => {
      const same =
        candidate.driver === wanted.request.driver && label(candidate) === label(wanted.request);
      if (candidate !== wanted.request) tried.push({ ...wanted, chosen: false });
      tried.push({ request: candidate, reason: why ?? wanted.reason, chosen: true });
      return {
        decision,
        tried,
        ...(same && wanted === asked ? {} : { wanted: asked.request }),
        rule: resolved.rule,
        reason: why ? `${why} ${decision.reasons[0]}` : decision.reasons[0]!,
        accounts: lines(first),
        notes,
        ...extra,
      };
    };
    if (fits(first)) return chosen(first, wanted.request, undefined);
    if (first.outcome === "unavailable") {
      tried.push({ ...wanted, chosen: false });
      failures.push(...first.reasons, ...first.candidates.flatMap((c) => c.reasons));
      continue;
    }
    // The limit in the way resets soon: wait for it rather than change model or account.
    const soon = Date.parse(input.at) + waitMinutes * 60_000;
    const resets = [
      ...new Set(
        first.candidates.flatMap((c) =>
          c.reasons.length
            ? []
            : [c.fitsFrom, c.drainedUntil].filter((t): t is string => !!t && Date.parse(t) <= soon),
        ),
      ),
    ].sort();
    for (const reset of resets) {
      const later = decide(wanted.request, reset);
      if (fits(later))
        return chosen(
          later,
          { ...wanted.request, startAt: reset },
          `${label(wanted.request)} fits on no account now; a limit in its way resets in ${span(
            (Date.parse(reset) - Date.parse(input.at)) / 3_600_000,
          )}, so the start waits for it.`,
          { startAt: reset },
        );
    }
    const claude = wanted.request.driver === "claudeAgent" && !request.explicitInstanceId;
    const rungs = claude
      ? nearestRungs(
          fableOnly ? fableRungs : ladder,
          requestProfile(wanted.request),
          MAX_RUNG_DISTANCE,
        ).filter(allowed)
      : [];
    const fallback = modelFallback(modelPolicy);
    const position = ladderPosition(ladder, requestProfile(wanted.request));
    const threshold = fallback ? ladderPosition(ladder, fallback.below) : undefined;
    const fallbacks =
      claude &&
      fallback &&
      position !== undefined &&
      threshold !== undefined &&
      position < threshold &&
      allowed(fallback)
        ? [
            ...new Set(
              inventories
                .flatMap((i) => i.accounts)
                .filter(
                  (a) =>
                    a.environmentId === request.environmentId &&
                    findCatalogModel(a.models, fallback.model),
                )
                .map((a) => a.driver),
            ),
          ]
            .sort()
            .map((driver) => ({
              ...wanted.request,
              driver,
              model: fallback.model,
              options: [{ id: routingEffortOptionId(driver), value: fallback.effort }],
            }))
        : [];
    /** The nearest rung, the fallback, then the account that lasts longest, as of `startAt`. */
    const standIn = (base: AllocationDecision, startAt?: string) => {
      const why = base.selectedInstanceId
        ? `${label(wanted.request)} fits on no account for this job;`
        : `${label(wanted.request)} is drained on every account (earliest reset ${base.waitUntil ?? "unknown"});`;
      for (const rung of rungs) {
        const candidate = onRung(wanted.request, rung);
        const decision = decide(candidate, startAt);
        if (fits(decision))
          return {
            decision,
            candidate,
            why: `${why} the nearest ladder rung that fits is ${rung.model} / ${rung.effort}.`,
          };
      }
      for (const candidate of fallbacks) {
        const decision = decide(candidate, startAt);
        if (fits(decision))
          return {
            decision,
            candidate,
            why: `${why} no Claude rung within ${MAX_RUNG_DISTANCE} fits, and below ${fallback!.below.model} / ${fallback!.below.effort} the fallback ${fallback!.model} / ${fallback!.effort} applies.`,
          };
      }
      // Nothing fits the whole job: the account that lasts longest, as long as one is not out.
      if (base.selectedInstanceId)
        return { decision: base, candidate: wanted.request, why: undefined };
      for (const rung of rungs) {
        const candidate = onRung(wanted.request, rung);
        const decision = decide(candidate, startAt);
        if (decision.selectedInstanceId)
          return {
            decision,
            candidate,
            why: `${label(wanted.request)} is out on every account; ${rung.model} / ${rung.effort} is the nearest rung that is not.`,
          };
      }
      for (const candidate of fallbacks) {
        const decision = decide(candidate, startAt);
        if (decision.selectedInstanceId)
          return {
            decision,
            candidate,
            why: `${label(wanted.request)} and its nearest rungs are out on every account; the fallback ${candidate.model} is not.`,
          };
      }
      return undefined;
    };
    const now = standIn(first);
    if (now) return chosen(now.decision, now.candidate, now.why);
    // Everything is out now: decide as of a reset within the wait by the same rules, and queue.
    for (const reset of resets) {
      const then = standIn(decide(wanted.request, reset), reset);
      if (then)
        return chosen(
          then.decision,
          { ...then.candidate, startAt: reset },
          `Every account is out now and a limit resets in ${span(
            (Date.parse(reset) - Date.parse(input.at)) / 3_600_000,
          )}, so the start waits for it. ${then.why ?? `Then ${label(wanted.request)} runs on the account that lasts longest.`}`,
          { startAt: reset },
        );
    }
    tried.push({ ...wanted, chosen: false });
    const drainedUntil = first.waitUntil;
    refusal ??= {
      drainedUntil,
      reason: request.explicitInstanceId
        ? first.reasons[0]!
        : `Drained: ${label(wanted.request)} and every model that may stand in for it are out; earliest reset ${drainedUntil ?? "unknown"}.${fableOnly ? " Fable mode is on: only Fable rungs may stand in." : ""}`,
      accounts: lines(first),
    };
  }
  return {
    tried,
    rule: resolved.rule,
    reason:
      refusal?.reason ??
      ([...new Set(failures)].join(" ") || "No account can run the wanted model on this computer."),
    ...(refusal ? { drainedUntil: refusal.drainedUntil } : {}),
    accounts: refusal?.accounts ?? [],
    notes,
  };
}

/**
 * What a saved model policy names that no connected account offers. A warning, never a
 * refusal: a model can be configured before its account is connected.
 */
export function modelPolicyWarnings(
  policy: ModelRoutingPolicy,
  inventories: readonly AllocationInventory[],
) {
  const warnings = new Set<string>();
  const accounts = inventories.flatMap((i) => i.accounts);
  const check = (profile: RoutingProfile, where: string, driver?: string) => {
    const offering = accounts.flatMap((a) => {
      const model = findCatalogModel(a.models, profile.model);
      return model && (driver === undefined || a.driver === driver) ? [{ a, model }] : [];
    });
    if (!offering.length) warnings.add(`${where}: no connected account offers ${profile.model}.`);
    else if (
      !offering.some(({ a, model }) =>
        accountSupportsRoutingProfile(a, { ...profile, model: model.slug }),
      )
    )
      warnings.add(`${where}: no connected account offers ${profile.model} at ${profile.effort}.`);
  };
  for (const driver of ["codex", "claudeAgent"] as const) {
    const table = policy[driver];
    for (const cell of table.cells.flat()) {
      for (const choice of [cell, ...(cell.alternatives ?? [])]) {
        check(choice, `${driver} table`, driver);
        if (!table.allowedModels.includes(choice.model))
          warnings.add(`${driver} table: ${choice.model} is not in the table's model list.`);
      }
    }
  }
  for (const rung of modelLadder(policy)) check(rung, "Ladder", "claudeAgent");
  const fallback = modelFallback(policy);
  if (fallback) {
    check(fallback, "Fallback");
    if (ladderPosition(modelLadder(policy), fallback.below) === undefined)
      warnings.add(
        `Fallback: ${fallback.below.model} / ${fallback.below.effort} is not on the ladder, so the fallback never applies.`,
      );
  }
  return [...warnings];
}
