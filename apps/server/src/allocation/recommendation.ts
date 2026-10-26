import {
  routingEffortOptionId,
  type AssignmentAssessment,
  type ComputerPlacement,
  type ComputerAdviceHost,
  type ProviderOptionSelection,
  type RecommendationOverrides,
  type WorkerRecommendation,
} from "@t3tools/contracts";

export interface ComputerAdvice {
  readonly recommendedEnvironmentId: string | null;
  readonly hosts: readonly ComputerAdviceHost[];
}

/** The stored, compact form of placement advice: rank, state and warnings per computer. */
export const computerAdvice = (placement: ComputerPlacement): ComputerAdvice => ({
  recommendedEnvironmentId: placement.recommendedEnvironmentId,
  hosts: placement.hosts.map(({ environmentId, label, rank, state, sessions, warnings }) => ({
    environmentId,
    label,
    rank,
    state,
    sessions,
    warnings,
  })),
});

/** The profile a recommendation compares: the model and its effort option. */
export const profileLabel = (
  driver: string,
  model: string,
  options: readonly ProviderOptionSelection[],
) =>
  `${model} / ${options.find((o) => o.id === routingEffortOptionId(driver))?.value ?? "default"}`;

export interface Dimension {
  readonly recommended: string | null;
  readonly unavailable?: string | undefined;
  readonly chosen: string;
  /** The master chose this value; an unpinned value follows the other choices. */
  readonly pinned: boolean;
}
type Key = "model" | "account" | "computer";

/**
 * Records each recommended value next to the actual choice. A pinned choice that differs
 * needs a reason; `automatic` supplies reasons the server knows itself, such as fork
 * continuity. `missing` lists what the master must still explain.
 */
export function compareRecommendation(input: {
  readonly at: string;
  readonly assessment: AssignmentAssessment;
  readonly model: Dimension;
  readonly account: Dimension;
  readonly computer: Dimension;
  readonly overrides?: RecommendationOverrides | undefined;
  readonly automatic?: RecommendationOverrides | undefined;
  readonly warnings: readonly string[];
}): { readonly recommendation: WorkerRecommendation; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const choice = (key: Key) => {
    const d = input[key];
    const differs = d.recommended !== null && d.recommended !== d.chosen;
    const reason = !differs
      ? undefined
      : (input.overrides?.[key] ??
        input.automatic?.[key] ??
        (d.pinned ? undefined : "Not pinned; follows the chosen model and computer."));
    if (differs && !reason)
      missing.push(`overrides.${key} (recommended ${d.recommended}, chosen ${d.chosen})`);
    return {
      recommended: d.recommended,
      chosen: d.chosen,
      ...(reason ? { overrideReason: reason } : {}),
      ...(d.recommended === null
        ? { unavailable: d.unavailable ?? "No recommendation was computed." }
        : {}),
    };
  };
  return {
    recommendation: {
      at: input.at,
      assessment: input.assessment,
      model: choice("model"),
      account: choice("account"),
      computer: choice("computer"),
      warnings: [...new Set(input.warnings)].slice(0, 10),
    },
    missing,
  };
}

export const missingOverridesMessage = (missing: readonly string[]) =>
  `Your choice differs from the recommendation. Add a reason for each, for example "user specified it", then retry: ${missing.join("; ")}. Recommendations are advice; any choice with a reason is accepted.`;

export const MISSING_ASSESSMENT =
  "Every worker creation needs the master's assessment. Add assessment: { difficulty: 0-10, difficultyReason, stakes: 0-10, stakesReason } scoring this assignment (selection=automatic requests carry it as request.assessment).";
