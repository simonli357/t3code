import {
  ProviderDriverKind,
  MODEL_SCORE_BANDS,
  type AllocationAccount,
  type AllocationInventory,
  type AllocationRequest,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type ModelRoutingDecision,
  type RoutingProfile,
} from "@t3tools/contracts";

export const scoreBand = (score: number) => (score <= 3 ? 0 : score <= 6 ? 1 : score - 5);
const automaticModelAllowed = (model: string) => !/luna|haiku|fable/i.test(model);
const optionId = (driver: string) => (driver === "codex" ? "reasoningEffort" : "effort");
function supportsProfile(account: AllocationAccount, profile: RoutingProfile) {
  const descriptor = account.models
    .find((m) => m.slug === profile.model)
    ?.capabilities?.optionDescriptors?.find((o) => o.id === optionId(account.driver));
  return descriptor?.type === "select" && descriptor.options.some((o) => o.id === profile.effort);
}

/** Resolves capabilities only. Allowance pressure cannot activate an alternative profile. */
export function modelCandidates(
  policy: ModelRoutingPolicy,
  request: ModelRoutingRequest,
  inventories: readonly AllocationInventory[],
  retained?: ModelRoutingDecision,
) {
  const row = scoreBand(request.assessment.difficulty);
  const column = scoreBand(request.assessment.stakes);
  const rule = `Difficulty ${MODEL_SCORE_BANDS[row]}, stakes ${MODEL_SCORE_BANDS[column]}`;
  const reasons: string[] = [];
  const candidates: { request: AllocationRequest; profile: number | null; reason: string }[] = [];
  const {
    selection: _selection,
    assessment: _assessment,
    policyVersion: _policyVersion,
    allowedDrivers,
    override,
    reassessment: _reassessment,
    ...constraints
  } = request;
  // Admission retries reuse the resolved exact capabilities, even after policy or
  // catalog changes. The allocator still validates today's account capabilities.
  if (retained) {
    const selected = retained.allocation?.decision.request;
    const profiles = selected
      ? retained.profiles.filter((p) => p.driver === selected.driver)
      : retained.profiles;
    return {
      rule: retained.rule,
      reasons: profiles.length ? [] : [...retained.reasons],
      candidates: profiles.map((p) => ({
        request: selected ?? {
          ...constraints,
          driver: p.driver,
          model: p.model,
          options: p.options,
        },
        profile: p.profile,
        reason: p.reason,
      })),
    };
  }
  if (new Set(allowedDrivers).size !== allowedDrivers.length)
    return { rule, candidates, reasons: ["Allowed provider families must be unique."] };
  if (override) {
    if (!allowedDrivers.includes(override.driver))
      return {
        rule,
        candidates,
        reasons: [
          "Exact user override conflicts with allowed provider families. Resolve the instruction explicitly.",
        ],
      };
    candidates.push({
      request: {
        ...constraints,
        driver: override.driver,
        model: override.model,
        options: override.options,
      },
      profile: null,
      reason: `Exact user override: ${override.reason}`,
    });
    return { rule: "Exact user override", candidates, reasons };
  }
  for (const driver of [...allowedDrivers].sort()) {
    if (driver !== "codex" && driver !== "claudeAgent") {
      reasons.push(
        `${driver}: automatic model selection is unsupported; use exact explicit selection.`,
      );
      continue;
    }
    const table = driver === "codex" ? policy.codex : policy.claudeAgent;
    const selected = table.grid[row]![column]!;
    const profiles = [selected, ...table.alternatives[selected - 1]!];
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
    let found = false;
    for (const id of profiles) {
      const profile = table.profiles[id - 1]!;
      if (!table.allowedModels.includes(profile.model) || !automaticModelAllowed(profile.model)) {
        reasons.push(
          `${driver}: profile ${id} (${profile.model} / ${profile.effort}) is excluded from automatic selection.`,
        );
        continue;
      }
      if (!accounts.some((a) => supportsProfile(a, profile))) {
        reasons.push(
          `${driver}: profile ${id} (${profile.model} / ${profile.effort}) is unavailable in the constrained target catalogs. Refresh the target catalog or configure an approved alternative.`,
        );
        continue;
      }
      candidates.push({
        request: {
          ...constraints,
          driver: ProviderDriverKind.make(driver),
          model: profile.model,
          options: [{ id: optionId(driver), value: profile.effort }],
        },
        profile: id,
        reason:
          id === selected
            ? `${driver}: table profile ${id}.`
            : `${driver}: configured capability alternative ${selected} → ${id}; no profile ranking is implied.`,
      });
      found = true;
      break;
    }
    if (!found)
      reasons.push(
        `${driver}: no approved capability is available; no quota-based downgrade is permitted.`,
      );
  }
  return { rule, candidates, reasons };
}

/** Validate edits without destroying retained profiles that a catalog no longer offers. */
export function modelPolicyIssues(
  next: ModelRoutingPolicy,
  previous: ModelRoutingPolicy,
  inventories: readonly AllocationInventory[],
) {
  const issues: string[] = [];
  for (const driver of ["codex", "claudeAgent"] as const) {
    const table = next[driver];
    if (table.allowedModels.some((m) => !automaticModelAllowed(m)))
      issues.push(`${driver}: Luna, Haiku and Fable are excluded from automatic selection.`);
    if (new Set(table.allowedModels).size !== table.allowedModels.length)
      issues.push(`${driver}: approved models must be unique.`);
    for (const model of table.allowedModels) {
      if (
        !previous[driver].allowedModels.includes(model) &&
        !inventories
          .flatMap((v) => v.accounts)
          .some((a) => a.driver === driver && a.models.some((m) => m.slug === model))
      )
        issues.push(`${driver}: ${model} is not advertised by a connected account.`);
    }
    table.profiles.forEach((profile, i) => {
      if (!automaticModelAllowed(profile.model) || !table.allowedModels.includes(profile.model))
        issues.push(`${driver}: profile ${i + 1} must use an approved automatic model.`);
      const old = previous[driver].profiles[i]!;
      if (
        (profile.model !== old.model || profile.effort !== old.effort) &&
        !inventories
          .flatMap((v) => v.accounts)
          .some((a) => a.driver === driver && supportsProfile(a, profile))
      )
        issues.push(
          `${driver}: ${profile.model} / ${profile.effort} is not advertised by a connected account. Refresh catalogs before saving this edit.`,
        );
      const alternatives = table.alternatives[i]!;
      if (new Set(alternatives).size !== alternatives.length || alternatives.includes(i + 1))
        issues.push(`${driver}: alternatives must be unique and cannot reference themselves.`);
    });
  }
  return issues;
}
