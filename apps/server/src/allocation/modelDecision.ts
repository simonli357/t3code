import {
  ProviderDriverKind,
  accountSupportsRoutingProfile,
  modelFallback,
  modelLadder,
  profileLabel,
  routingEffortOptionId,
  type AllocationDecision,
  type AllocationInventory,
  type AllocationPolicy,
  type AllocationRequest,
  type AllocationReservation,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type RoutingProfile,
} from "@t3tools/contracts";
import { findCatalogModel } from "@t3tools/shared/model";
import { decideAllocation } from "./decision.ts";

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
export function nearestRungs(ladder: readonly RoutingProfile[], profile: RoutingProfile) {
  const position = ladderPosition(ladder, profile);
  if (position === undefined) return [];
  return ladder
    .map((rung, index) => ({ rung, index }))
    .filter(({ index }) => index !== position)
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

export interface ProfileChoice {
  /** The decision that selected an account; absent when nothing has room. */
  readonly decision?: AllocationDecision;
  /** Every profile that was tried for a family, the wanted one first. */
  readonly tried: readonly { request: AllocationRequest; reason: string; chosen: boolean }[];
  /** The table's or pinned profile, when the chosen one differs. */
  readonly wanted?: AllocationRequest;
  readonly rule: string;
  readonly reason: string;
  /** Present when the start is refused because everything is drained. */
  readonly drainedUntil?: string | null;
  /** One line per account of the wanted family on the computer. */
  readonly accounts: readonly string[];
}

/**
 * Picks account, model and effort together. The wanted model on the account with the most
 * room; when it is drained on every account, the nearest ladder rung that has room; when no
 * Claude rung has room and the wanted rung is below the fallback's threshold, the fallback
 * model. Codex and a pinned account never change model: drained there is a refusal.
 */
export function chooseProfile(input: {
  readonly at: string;
  readonly policy: AllocationPolicy;
  readonly modelPolicy: ModelRoutingPolicy;
  readonly request: ModelRoutingRequest;
  readonly inventories: readonly AllocationInventory[];
  readonly reservations: readonly AllocationReservation[];
  readonly authorityAvailable: boolean;
}): ProfileChoice {
  const { modelPolicy, request, inventories } = input;
  const resolved = wantedProfiles(modelPolicy, request, inventories);
  const decide = (candidate: AllocationRequest) =>
    decideAllocation({ ...input, request: candidate });
  const tried: { request: AllocationRequest; reason: string; chosen: boolean }[] = [];
  let refusal: { reason: string; drainedUntil: string | null; accounts: string[] } | undefined;
  const failures: string[] = [...resolved.reasons];
  // With a pinned account, the others are not part of the choice.
  const lines = (decision: AllocationDecision) =>
    decision.candidates
      .filter((c) => !request.explicitInstanceId || c.instanceId === request.explicitInstanceId)
      .map((c) => c.line ?? c.instanceId);
  for (const wanted of resolved.candidates) {
    const first = decide(wanted.request);
    const label = (r: AllocationRequest) => profileLabel(r.driver, r.model, r.options);
    if (first.selectedInstanceId) {
      tried.push({ ...wanted, chosen: true });
      return {
        decision: first,
        tried,
        rule: resolved.rule,
        reason: first.reasons[0]!,
        accounts: lines(first),
      };
    }
    tried.push({ ...wanted, chosen: false });
    if (first.outcome !== "wait") {
      failures.push(...first.reasons, ...first.candidates.flatMap((c) => c.reasons));
      continue;
    }
    const resets = first.waitUntil ? [first.waitUntil] : [];
    const substitute = (candidate: AllocationRequest, why: string) => {
      const decision = decide(candidate);
      if (decision.waitUntil) resets.push(decision.waitUntil);
      if (!decision.selectedInstanceId) return undefined;
      tried.push({ request: candidate, reason: why, chosen: true });
      return {
        decision,
        tried,
        wanted: wanted.request,
        rule: resolved.rule,
        reason: `${label(wanted.request)} is drained on every account (earliest reset ${first.waitUntil ?? "unknown"}); ${why} ${decision.reasons[0]}`,
        accounts: lines(first),
      } satisfies ProfileChoice;
    };
    if (wanted.request.driver === "claudeAgent" && !request.explicitInstanceId) {
      const ladder = modelLadder(modelPolicy);
      const profile = requestProfile(wanted.request);
      for (const rung of nearestRungs(ladder, profile)) {
        const chosen = substitute(
          {
            ...wanted.request,
            model: rung.model,
            options: [{ id: routingEffortOptionId("claudeAgent"), value: rung.effort }],
          },
          `the nearest ladder rung with room is ${rung.model} / ${rung.effort}.`,
        );
        if (chosen) return chosen;
      }
      const fallback = modelFallback(modelPolicy);
      const position = ladderPosition(ladder, profile);
      const threshold = fallback ? ladderPosition(ladder, fallback.below) : undefined;
      if (fallback && position !== undefined && threshold !== undefined && position < threshold) {
        const drivers = new Set(
          inventories
            .flatMap((i) => i.accounts)
            .filter(
              (a) =>
                a.environmentId === request.environmentId &&
                findCatalogModel(a.models, fallback.model),
            )
            .map((a) => a.driver),
        );
        for (const driver of [...drivers].sort()) {
          const chosen = substitute(
            {
              ...wanted.request,
              driver,
              model: fallback.model,
              options: [{ id: routingEffortOptionId(driver), value: fallback.effort }],
            },
            `no Claude rung has room, and below ${fallback.below.model} / ${fallback.below.effort} the fallback ${fallback.model} / ${fallback.effort} applies.`,
          );
          if (chosen) return chosen;
        }
      }
    }
    const drainedUntil = resets.sort()[0] ?? null;
    refusal ??= {
      drainedUntil,
      reason: request.explicitInstanceId
        ? first.reasons[0]!
        : `Drained: ${label(wanted.request)} and every model that may stand in for it have no room; earliest reset ${drainedUntil ?? "unknown"}.`,
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
