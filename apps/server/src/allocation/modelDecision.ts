import {
  HIGH_STAKES,
  MAX_RUNG_DISTANCE,
  ProviderDriverKind,
  START_WAIT_MINUTES,
  START_WAIT_MINUTES_HIGH_STAKES,
  accountSupportsRoutingProfile,
  allocationFableMode,
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
import { decideAllocation, fableGoalStandings } from "./decision.ts";
import { isFable, span } from "./runway.ts";

/**
 * The profile each allowed provider family wants before quota is looked at: the pinned model,
 * or the table's entry for the scores. A table alternative applies only when no account on the
 * computer offers the entry itself. With two families allowed, a pinned account asks only its
 * own family, a pinned model goes to the family that offers it, and `unoffered` has the table
 * entry of a family no account offers, so its accounts can still be listed.
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
  const unoffered: AllocationRequest[] = [];
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
    return {
      rule,
      candidates,
      unoffered,
      reasons: ["Allowed provider families must be unique."],
    };
  const local = inventories
    .flatMap((i) => i.accounts)
    .filter((a) => a.environmentId === request.environmentId);
  const sorted = [...allowedDrivers].sort();
  const pinned = local.find((a) => a.instanceId === request.explicitInstanceId);
  const drivers = !request.explicitInstanceId
    ? sorted
    : pinned && sorted.includes(pinned.driver)
      ? [pinned.driver]
      : [sorted[0]!];
  if (override) {
    if (!allowedDrivers.includes(override.driver))
      return {
        rule,
        candidates,
        unoffered,
        reasons: ["The pinned model's provider family is not among the allowed ones."],
      };
    const driver =
      [override.driver, ...drivers].find(
        (d) =>
          drivers.includes(d) &&
          local.some((a) => a.driver === d && findCatalogModel(a.models, override.model)),
      ) ?? (drivers.includes(override.driver) ? override.driver : drivers[0]!);
    // The pinned effort keeps its value under the other family's option ID.
    let options = override.options?.map((o) =>
      o.id === routingEffortOptionId(override.driver)
        ? { ...o, id: routingEffortOptionId(driver) }
        : o,
    );
    if (!options) {
      // A model-only pin keeps the table's effort for this score pair.
      if (driver !== "codex" && driver !== "claudeAgent")
        return {
          rule,
          candidates,
          unoffered,
          reasons: [`${driver}: the table has no effort for this provider; pin one.`],
        };
      const table = driver === "codex" ? policy.codex : policy.claudeAgent;
      const cell = table.cells[difficulty]![stakes]!;
      options = [{ id: routingEffortOptionId(driver), value: cell.effort }];
    }
    candidates.push({
      request: { ...constraints, driver, model: override.model, options },
      reason: `${driver}: pinned model.`,
    });
    return { rule: `${rule}; model pinned`, candidates, unoffered, reasons };
  }
  for (const driver of drivers) {
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
      if (drivers.length > 1 && local.some((a) => a.driver === driver))
        unoffered.push({
          ...constraints,
          driver: ProviderDriverKind.make(driver),
          model: cell.model,
          options: [{ id: routingEffortOptionId(driver), value: cell.effort }],
        });
      // A pin that names no account here is the problem, not the model.
      const pin = request.explicitInstanceId;
      const named = local.find((a) => a.label.toLowerCase() === pin?.toLowerCase());
      reasons.push(
        pin && !local.some((a) => a.instanceId === pin)
          ? `${driver}: the pinned account ${pin} is not an account ID on this computer${named ? `; ${named.label} is ${named.instanceId}, pin it by that ID` : ""}.`
          : `${driver}: no account on this computer offers ${profiles.map((p) => `${p.model} / ${p.effort}`).join(" or ")}.`,
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
  return { rule, candidates, unoffered, reasons };
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
  /** One line per account of the judged families on the computer. */
  readonly accounts: readonly string[];
  readonly notes: readonly string[];
}

const fits = (decision: AllocationDecision) =>
  decision.selectedInstanceId !== null &&
  decision.candidates.find((c) => c.instanceId === decision.selectedInstanceId)?.fits !== false;

/**
 * Whether a worker on this account runs in Fable mode by the stored list; never while Fable
 * workers are off. An account's Fable goal can add it for one start (`chooseProfile`).
 */
export const fableModeAccount = (
  policy: AllocationPolicy,
  account: Parameters<typeof allocationFableMode>[1],
) => policy.fableWorkers !== false && allocationFableMode(policy, account);

/**
 * Picks account, model and effort together. The wanted model on the account furthest behind
 * its daily goal, when it fits the job somewhere. Otherwise: wait for a limit that resets
 * within 30 minutes (45 at high stakes); else the nearest ladder rung that fits, at most two
 * away; else the fallback model below its threshold; else the wanted model on the account
 * that lasts longest. When every candidate is out, the same choice as of a reset within the
 * wait, queued for it; refused only when nothing comes back within the wait. With Fable
 * workers off, no worker gets a Fable model. On an account in Fable mode a worker starts from
 * the first Fable rung at or above the table entry and only Fable rungs stand in, never the
 * fallback; every account is judged on what it would run. An account with a Fable goal is in
 * Fable mode for an unpinned worker when, on that Fable rung, it would end the job at or behind
 * its Fable line and the rung lasts the job there, so the goal never refuses or delays a start.
 * A pinned model is kept. Codex and a pinned account never change model. A worker start that
 * names no provider family judges the accounts of both families together, each on its own
 * family's table entry, by the same ranking; only the Claude accounts step through stand-ins.
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
  const label = (r: AllocationRequest) => profileLabel(r.driver, r.model, r.options);
  const rungLabel = (r: AllocationRequest) => {
    const { model, effort } = requestProfile(r);
    return `${model} / ${effort}`;
  };
  const ladder = modelLadder(modelPolicy);
  const workers = request.kind !== "session";
  // No family named: the accounts of every family are ranked together.
  const together = workers && resolved.candidates.length + resolved.unoffered.length > 1;
  const fableOff = workers && policy.fableWorkers === false;
  const fableRungs = ladder.filter((r) => isFable(r.model));
  const allowed = (r: RoutingProfile) => !(fableOff && isFable(r.model));
  /** Fable mode's rung for a profile: the first Fable rung at or above it, else the top one. */
  const fableRung = (profile: RoutingProfile) => {
    const position = ladderPosition(ladder, profile) ?? -1;
    return ladder.find((r, i) => isFable(r.model) && i >= position) ?? fableRungs.at(-1);
  };
  const here = inventories
    .flatMap((i) => i.accounts)
    .filter((a) => a.environmentId === request.environmentId);
  // Workers on these Claude accounts run in Fable mode.
  const listed = workers ? here.filter((a) => fableModeAccount(policy, a)) : [];
  const notes: string[] = [];
  const tried: { request: AllocationRequest; reason: string; chosen: boolean }[] = [];
  let refusal: { reason: string; drainedUntil: string | null; accounts: string[] } | undefined;
  const failures: string[] = [...resolved.reasons];
  const waitMinutes =
    request.assessment.stakes >= HIGH_STAKES ? START_WAIT_MINUTES_HIGH_STAKES : START_WAIT_MINUTES;
  for (const [index, asked] of resolved.candidates.entries()) {
    let wanted = asked;
    // The other families, whose accounts are judged on their own table entry.
    const rest = together ? resolved.candidates.slice(index + 1) : [];
    const others = together ? [...rest.map((c) => c.request), ...resolved.unoffered] : [];
    const profile = requestProfile(asked.request);
    // Accounts with a Fable goal, judged on the Fable rung their table entry would start from.
    const goalRung =
      asked.request.driver === "claudeAgent" &&
      workers &&
      !fableOff &&
      !request.override &&
      policy.fableGoals?.length
        ? fableRung(profile)
        : undefined;
    const standings = goalRung
      ? fableGoalStandings({ ...input, request: onRung(asked.request, goalRung) }).filter(
          (s) => !listed.some((a) => a.instanceId === s.instanceId),
        )
      : [];
    const behind = standings.filter((s) => s.fits && s.slack >= 0);
    const fableIds = [...listed, ...behind].map((a) => a.instanceId);
    const fableNames = [...new Set([...listed, ...behind].map((a) => a.label))].join(", ");
    /** Where an account stands against its Fable goal, then what it runs: `rung` or `table`. */
    const goalText = (s: (typeof standings)[number], rung: string, table: string) => {
      const points = `${Math.round(Math.abs(s.slack))} points`;
      const fable = `${goalRung!.model} / ${goalRung!.effort}`;
      return s.slack < 0
        ? `${points} ahead of its Fable goal, so ${table}`
        : s.fits
          ? `${points} behind its Fable goal, so ${rung} ${fable}`
          : `${points} behind its Fable goal, but ${fable} does not fit there, so ${table}`;
    };
    // With a pinned account, the others are not part of the choice.
    const lines = (decision: AllocationDecision) =>
      decision.candidates
        .filter((c) => !request.explicitInstanceId || c.instanceId === request.explicitInstanceId)
        .map((c) => {
          const standing = standings.find((s) => s.instanceId === c.instanceId);
          // The line already says it when the Fable window is the account's tightest.
          const said = standing && c.goalSlackPoints === standing.slack;
          return `${c.line ?? c.instanceId}${
            standing && !said
              ? `; ${goalText(standing, "Fable mode on", "the table's choice")}`
              : ""
          }`;
        });
    if (fableOff && isFable(asked.request.model)) {
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
    // What Fable-mode accounts start from: the first Fable rung at or above the table entry, or
    // a pinned model as pinned. Undefined when there are none; null when no Fable rung exists.
    let fableWanted: AllocationRequest | null | undefined;
    if (asked.request.driver === "claudeAgent" && fableIds.length) {
      const start = request.override ? profile : fableRung(profile);
      fableWanted = !start
        ? null
        : start.model === profile.model && start.effort === profile.effort
          ? wanted.request
          : onRung(asked.request, start);
      if (!start)
        failures.push(
          `claudeAgent: Fable mode is on for ${fableNames} and the ladder has no Fable rung.`,
        );
    }
    const split = !!fableWanted && fableWanted !== wanted.request;
    const elsewhere = [
      ...(fableWanted && split ? [`${label(fableWanted)} in Fable mode`] : []),
      ...rest.map(
        (c) =>
          `${label(c.request)} on ${c.request.driver === "codex" ? "Codex" : "Claude"} accounts`,
      ),
    ];
    const wantedText = `${label(wanted.request)}${elsewhere.length ? ` (${elsewhere.join(", ")})` : ""}`;
    /**
     * One step: Fable-mode accounts run `fable`, the others `normal`; null leaves them out.
     * The other families take part only next to the wanted profile, since they have no stand-in.
     */
    const decide = (
      normal: AllocationRequest | null,
      fable: AllocationRequest | null | undefined,
      startAt?: string,
      families = false,
    ) => {
      const when = (r: AllocationRequest) => (startAt ? { ...r, startAt } : r);
      const mixed = families && others.length ? { others: others.map(when) } : {};
      if (fable === undefined)
        return decideAllocation({ ...input, ...mixed, request: when(normal!) });
      // Only Fable-mode accounts take part.
      const only = normal
        ? undefined
        : {
            ...when(fable!),
            allowedInstanceIds: fableIds.filter(
              (id) => !request.allowedInstanceIds || request.allowedInstanceIds.includes(id),
            ),
          };
      return decideAllocation({
        ...input,
        ...mixed,
        request: only ?? when(normal!),
        fableMode: { instanceIds: fableIds, request: only ?? (fable && when(fable)) },
      });
    };
    const start = (startAt?: string) => decide(wanted.request, fableWanted, startAt, true);
    const first = start();
    const chosen = (
      decision: AllocationDecision,
      why: string | undefined,
      extra: Partial<ProfileChoice> = {},
    ): ProfileChoice => {
      const candidate = decision.request;
      // An account of another family runs its own table entry.
      const other = rest.find((c) => c.request.driver === candidate.driver);
      if (
        candidate.driver !== wanted.request.driver ||
        label(candidate) !== label(wanted.request) ||
        candidate.startAt !== wanted.request.startAt
      )
        tried.push({ ...wanted, chosen: false });
      tried.push({ request: candidate, reason: why ?? (other ?? wanted).reason, chosen: true });
      const account = decision.candidates.find((c) => c.instanceId === decision.selectedInstanceId);
      const same =
        !!other ||
        (candidate.driver === asked.request.driver && label(candidate) === label(asked.request));
      const standing = standings.find((s) => s.instanceId === account?.instanceId);
      if (standing)
        notes.push(
          `Fable goal: ${standing.label} would end ${goalText(
            standing,
            "this worker starts on",
            same ? "this worker runs the table's choice" : "it is not in Fable mode",
          )}.`,
        );
      else if (account && fableWanted && fableIds.includes(account.instanceId)) {
        if (
          request.override &&
          !fableRungs.some((r) => r.model === profile.model && r.effort === profile.effort)
        )
          notes.push(
            `Fable mode is on for ${account.label}, but ${label(asked.request)} is pinned for this worker and runs as pinned.`,
          );
        else if (split)
          notes.push(
            `Fable mode on ${account.label}: ${label(asked.request)} starts from ${rungLabel(fableWanted)}, the first Fable rung at or above it.`,
          );
      }
      return {
        decision,
        tried,
        ...(same ? {} : { wanted: asked.request }),
        rule: resolved.rule,
        reason: why ? `${why} ${decision.reasons[0]}` : decision.reasons[0]!,
        accounts: lines(first),
        notes,
        ...extra,
      };
    };
    if (fits(first)) return chosen(first, undefined);
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
      const later = start(reset);
      if (fits(later))
        return chosen(
          later,
          `${wantedText} fits on no account now; a limit in its way resets in ${span(
            (Date.parse(reset) - Date.parse(input.at)) / 3_600_000,
          )}, so the start waits for it.`,
          { startAt: reset },
        );
    }
    const claude = wanted.request.driver === "claudeAgent" && !request.explicitInstanceId;
    const rungs = claude
      ? nearestRungs(ladder, requestProfile(wanted.request), MAX_RUNG_DISTANCE).filter(allowed)
      : [];
    // On a Fable-mode account only another Fable rung stands in.
    const fableStandIns =
      claude && fableWanted
        ? nearestRungs(fableRungs, requestProfile(fableWanted), MAX_RUNG_DISTANCE)
        : [];
    // Every account's nearest stand-in, then every account's next one.
    const steps = Array.from({ length: Math.max(rungs.length, fableStandIns.length) }, (_, i) => {
      const normal = rungs[i];
      const fable = fableStandIns[i];
      return {
        normal: normal ? onRung(wanted.request, normal) : null,
        fable:
          fableWanted === undefined
            ? undefined
            : fableWanted && fable
              ? onRung(fableWanted, fable)
              : null,
      };
    });
    const fallback = modelFallback(modelPolicy);
    const position = ladderPosition(ladder, requestProfile(wanted.request));
    const threshold = fallback ? ladderPosition(ladder, fallback.below) : undefined;
    // The fallback stands in for the other accounts, never for a Fable-mode one.
    const normalHere = here.some(
      (a) => a.driver === wanted.request.driver && !fableIds.includes(a.instanceId),
    );
    const fallbacks =
      claude &&
      normalHere &&
      fallback &&
      position !== undefined &&
      threshold !== undefined &&
      position < threshold &&
      allowed(fallback)
        ? [
            ...new Set(
              here.filter((a) => findCatalogModel(a.models, fallback.model)).map((a) => a.driver),
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
    const noFable = fableWanted === undefined ? undefined : null;
    /** The nearest rung, the fallback, then the account that lasts longest, as of `startAt`. */
    const standIn = (base: AllocationDecision, startAt?: string) => {
      const why = base.selectedInstanceId
        ? `${wantedText} fits on no account for this job;`
        : `${wantedText} is drained on every account (earliest reset ${base.waitUntil ?? "unknown"});`;
      for (const step of steps) {
        const decision = decide(step.normal, step.fable, startAt);
        if (fits(decision))
          return {
            decision,
            why: `${why} the nearest ladder rung that fits is ${rungLabel(decision.request)}.`,
          };
      }
      for (const candidate of fallbacks) {
        const decision = decide(candidate, noFable, startAt);
        if (fits(decision))
          return {
            decision,
            why: `${why} no Claude rung within ${MAX_RUNG_DISTANCE} fits, and below ${fallback!.below.model} / ${fallback!.below.effort} the fallback ${fallback!.model} / ${fallback!.effort} applies.`,
          };
      }
      // Nothing fits the whole job: the account that lasts longest, as long as one is not out.
      if (base.selectedInstanceId) return { decision: base, why: undefined };
      for (const step of steps) {
        const decision = decide(step.normal, step.fable, startAt);
        if (decision.selectedInstanceId)
          return {
            decision,
            why: `${wantedText} is out on every account; ${rungLabel(decision.request)} is the nearest rung that is not.`,
          };
      }
      for (const candidate of fallbacks) {
        const decision = decide(candidate, noFable, startAt);
        if (decision.selectedInstanceId)
          return {
            decision,
            why: `${wantedText} and its nearest rungs are out on every account; the fallback ${candidate.model} is not.`,
          };
      }
      return undefined;
    };
    const now = standIn(first);
    if (now) return chosen(now.decision, now.why);
    // Everything is out now: decide as of a reset within the wait by the same rules, and queue.
    for (const reset of resets) {
      const then = standIn(start(reset), reset);
      if (then)
        return chosen(
          then.decision,
          `Every account is out now and a limit resets in ${span(
            (Date.parse(reset) - Date.parse(input.at)) / 3_600_000,
          )}, so the start waits for it. ${then.why ?? `Then ${label(then.decision.request)} runs on the account that lasts longest.`}`,
          { startAt: reset },
        );
    }
    tried.push({ ...wanted, chosen: false });
    const drainedUntil = first.waitUntil;
    refusal ??= {
      drainedUntil,
      reason: request.explicitInstanceId
        ? first.reasons[0]!
        : `Drained: ${wantedText} and every model that may stand in for it are out; earliest reset ${drainedUntil ?? "unknown"}.${fableWanted === undefined ? "" : ` Fable mode on ${fableNames}: only Fable rungs stand in there.`}`,
      accounts: lines(first),
    };
    // The other families were judged with this one.
    if (rest.length) break;
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
