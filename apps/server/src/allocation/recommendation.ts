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
 * Records each recommended value next to the actual choice. A choice that differs is
 * accepted as it is; its reason is the master's optional note, or one the server knows
 * itself (`automatic`), such as fork continuity.
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
}): WorkerRecommendation {
  const choice = (key: Key) => {
    const d = input[key];
    const differs = d.recommended !== null && d.recommended !== d.chosen;
    const reason = !differs
      ? undefined
      : (input.overrides?.[key] ??
        input.automatic?.[key] ??
        (d.pinned ? undefined : "Not pinned; follows the chosen model and computer."));
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
    at: input.at,
    assessment: input.assessment,
    model: choice("model"),
    account: choice("account"),
    computer: choice("computer"),
    warnings: [...new Set(input.warnings)].slice(0, 10),
  };
}
