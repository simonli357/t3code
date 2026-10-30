import {
  ProviderDriverKind,
  accountSupportsRoutingProfile,
  automaticModelAllowed,
  routingEffortOptionId,
  type AllocationInventory,
  type AllocationRequest,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type ModelRoutingDecision,
  type RoutingProfile,
} from "@t3tools/contracts";

/** Resolves capabilities only. Allowance pressure cannot activate an alternative profile. */
export function modelCandidates(
  policy: ModelRoutingPolicy,
  request: ModelRoutingRequest,
  inventories: readonly AllocationInventory[],
  retained?: ModelRoutingDecision,
) {
  const { difficulty, stakes } = request.assessment;
  const rule = `Difficulty ${difficulty}, stakes ${stakes}`;
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
        request: selected
          ? {
              ...constraints,
              driver: selected.driver,
              model: selected.model,
              options: selected.options,
            }
          : {
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
    let options = override.options;
    if (!options) {
      // A model-only pin keeps the table's effort for this score pair.
      if (override.driver !== "codex" && override.driver !== "claudeAgent")
        return {
          rule,
          candidates,
          reasons: [
            `${override.driver}: the table has no effort for this provider; give the override's options.`,
          ],
        };
      const table = override.driver === "codex" ? policy.codex : policy.claudeAgent;
      const cell = table.cells[difficulty]![stakes]!;
      options = [{ id: routingEffortOptionId(override.driver), value: cell.effort }];
    }
    candidates.push({
      request: {
        ...constraints,
        driver: override.driver,
        model: override.model,
        options,
      },
      profile: null,
      reason: override.options
        ? `Exact user override: ${override.reason}`
        : `Exact user model override with table effort: ${override.reason}`,
    });
    return {
      rule: override.options ? "Exact user override" : `${rule}; model pinned`,
      candidates,
      reasons,
    };
  }
  for (const driver of [...allowedDrivers].sort()) {
    if (driver !== "codex" && driver !== "claudeAgent") {
      reasons.push(
        `${driver}: automatic model selection is unsupported; use exact explicit selection.`,
      );
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
    let found = false;
    for (const [index, profile] of profiles.entries()) {
      const label = `${profile.model} / ${profile.effort}`;
      if (!table.allowedModels.includes(profile.model) || !automaticModelAllowed(profile.model)) {
        reasons.push(`${driver}: ${label} is excluded from automatic selection.`);
        continue;
      }
      if (!accounts.some((a) => accountSupportsRoutingProfile(a, profile))) {
        reasons.push(
          `${driver}: ${label} is unavailable in the constrained target catalogs. Refresh the target catalog or configure an approved alternative.`,
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
        profile: null,
        reason:
          index === 0
            ? `${driver}: table choice for difficulty ${difficulty}, stakes ${stakes}.`
            : `${driver}: configured capability alternative for difficulty ${difficulty}, stakes ${stakes}; no profile ranking is implied.`,
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

/** Validate edits without destroying retained choices that a catalog no longer offers. */
export function modelPolicyIssues(
  next: ModelRoutingPolicy,
  previous: ModelRoutingPolicy,
  inventories: readonly AllocationInventory[],
) {
  const issues = new Set<string>();
  const accounts = inventories.flatMap((i) => i.accounts);
  for (const driver of ["codex", "claudeAgent"] as const) {
    const table = next[driver];
    const prior = previous[driver];
    const ofDriver = accounts.filter((a) => a.driver === driver);
    if (table.allowedModels.some((m) => !automaticModelAllowed(m)))
      issues.add(`${driver}: Luna, Haiku and Fable are excluded from automatic selection.`);
    if (new Set(table.allowedModels).size !== table.allowedModels.length)
      issues.add(`${driver}: approved models must be unique.`);
    for (const model of table.allowedModels)
      if (
        !prior.allowedModels.includes(model) &&
        !ofDriver.some((a) => a.models.some((m) => m.slug === model))
      )
        issues.add(`${driver}: ${model} is not advertised by a connected account.`);
    table.cells.forEach((row, difficulty) =>
      row.forEach((cell, stakes) => {
        const old = prior.cells[difficulty]![stakes]!;
        const choices = [cell, ...(cell.alternatives ?? [])];
        const known = [old, ...(old.alternatives ?? [])];
        for (const choice of choices) {
          if (!automaticModelAllowed(choice.model) || !table.allowedModels.includes(choice.model))
            issues.add(`${driver}: ${choice.model} must be an approved automatic model.`);
          if (
            !known.some((k) => k.model === choice.model && k.effort === choice.effort) &&
            !ofDriver.some((a) => accountSupportsRoutingProfile(a, choice))
          )
            issues.add(
              `${driver}: ${choice.model} / ${choice.effort} is not advertised by a connected account. Refresh catalogs before saving this edit.`,
            );
        }
        if (
          new Set(choices.map((c) => JSON.stringify([c.model, c.effort]))).size !== choices.length
        )
          issues.add(`${driver}: alternatives must be unique and cannot repeat the table choice.`);
      }),
    );
  }
  return [...issues];
}
