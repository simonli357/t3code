import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection, type ModelCapabilities } from "./model.ts";

const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const Score = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }));
export const AssignmentAssessment = Schema.Struct({
  difficulty: Score,
  difficultyReason: Reason,
  stakes: Score,
  stakesReason: Reason,
});
export type AssignmentAssessment = typeof AssignmentAssessment.Type;
export const MODEL_SCORING_RUBRIC =
  "Score the scoped assignment, not its project. Difficulty: reasoning, uncertainty and interactions. Stakes: failure impact, reversibility and detectability. Each axis is an integer 0–10 with a concise reason: 0–3 routine/low; 4–6 moderate; 7 demanding/high; 8 very demanding/very high; 9 extreme; 10 exceptional. Supply both assessments; the service never invents them.";
/** The table has one entry for every (difficulty, stakes) score pair. */
export const MODEL_SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const RoutingProfile = Schema.Struct({
  model: TrimmedNonEmptyString,
  effort: TrimmedNonEmptyString,
});
export type RoutingProfile = typeof RoutingProfile.Type;
/**
 * One table entry. `alternatives` are ordered, explicit capability alternatives used only
 * when the primary choice is unavailable in the target catalogs; quota pressure never
 * activates them.
 */
export const RoutingCell = Schema.Struct({
  ...RoutingProfile.fields,
  alternatives: Schema.optional(Schema.Array(RoutingProfile).check(Schema.isMaxLength(5))),
});
export type RoutingCell = typeof RoutingCell.Type;
const Allowed = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100));
const Sized = <S extends Schema.Top>(schema: S, length: number) =>
  Schema.Array(schema).check(Schema.isLengthBetween(length, length));
const ExactRoutingTable = Schema.Struct({
  /** `cells[difficulty][stakes]`: the exact choice for that score pair. */
  cells: Sized(Sized(RoutingCell, MODEL_SCORES.length), MODEL_SCORES.length),
  allowedModels: Allowed,
});
/**
 * Tables saved before exact-score editing grouped scores into six bands (0–3, 4–6, 7, 8, 9,
 * 10) and referenced six shared profiles by number. They still decode, expanded so every
 * score pair keeps the choice it had, and nothing is rewritten until the next save. Saving
 * writes the exact shape, which older builds cannot read. Downgrading to a band-only build
 * after an exact save is unsupported; preserve all policy versions and assignment history.
 */
const LegacyProfileId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }));
const LegacyRoutingTable = Schema.Struct({
  profiles: Sized(RoutingProfile, 6),
  grid: Sized(Sized(LegacyProfileId, 6), 6),
  allowedModels: Allowed,
  alternatives: Sized(Schema.Array(LegacyProfileId).check(Schema.isMaxLength(5)), 6),
});
const legacyBand = (score: number) => (score <= 3 ? 0 : score <= 6 ? 1 : score - 5);
function expandLegacyTable(legacy: typeof LegacyRoutingTable.Type): typeof ExactRoutingTable.Type {
  const cell = (id: number): RoutingCell => {
    const { model, effort } = legacy.profiles[id - 1]!;
    const alternatives = legacy.alternatives[id - 1]!.map((alternative) => ({
      ...legacy.profiles[alternative - 1]!,
    }));
    return alternatives.length ? { model, effort, alternatives } : { model, effort };
  };
  return {
    cells: MODEL_SCORES.map((difficulty) =>
      MODEL_SCORES.map((stakes) => cell(legacy.grid[legacyBand(difficulty)]![legacyBand(stakes)]!)),
    ),
    allowedModels: legacy.allowedModels,
  };
}
export const RoutingTable = Schema.Union([
  ExactRoutingTable,
  LegacyRoutingTable.pipe(
    Schema.decodeTo(
      ExactRoutingTable,
      SchemaTransformation.transform({
        decode: expandLegacyTable,
        encode: (): never => {
          throw new Error("Band tables are read-only; save the exact table.");
        },
      }),
    ),
  ),
]);
export type RoutingTable = typeof RoutingTable.Type;
export const ModelRoutingPolicy = Schema.Struct({
  version: NonNegativeInt,
  codex: RoutingTable,
  claudeAgent: RoutingTable,
  maxReassessments: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
});
export type ModelRoutingPolicy = typeof ModelRoutingPolicy.Type;
const defaultBands = [
  [1, 2, 2, 4, 5, 5],
  [2, 2, 3, 4, 5, 5],
  [3, 3, 4, 5, 5, 6],
  [3, 4, 5, 5, 6, 6],
  [5, 5, 5, 6, 6, 6],
  [6, 6, 6, 6, 6, 6],
];
const defaultTable = (models: readonly [string, string]): RoutingTable =>
  expandLegacyTable({
    profiles: ["medium", "high", "max", "medium", "high", "xhigh"].map((effort, i) => ({
      model: models[i < 3 ? 0 : 1],
      effort,
    })),
    grid: defaultBands,
    allowedModels: models,
    alternatives: [[], [], [], [], [], []],
  });
export const defaultModelRoutingPolicy: ModelRoutingPolicy = {
  version: 0,
  codex: defaultTable(["gpt-6.1-sol", "gpt-6-astra"]),
  claudeAgent: defaultTable(["claude-sonnet-5-5", "claude-opus-5-5"]),
  maxReassessments: 2,
};
/** Luna, Haiku and Fable are never chosen automatically; exact user instructions still can. */
export const automaticModelAllowed = (model: string) => !/luna|haiku|fable/i.test(model);
/** The provider option that carries a profile's effort. */
export const routingEffortOptionId = (driver: string) =>
  driver === "codex" ? "reasoningEffort" : "effort";
/** True when this account advertises the profile's exact model and effort. */
export function accountSupportsRoutingProfile(
  account: {
    readonly driver: string;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly capabilities?: ModelCapabilities | null | undefined;
    }>;
  },
  profile: RoutingProfile,
) {
  const descriptor = account.models
    .find((m) => m.slug === profile.model)
    ?.capabilities?.optionDescriptors?.find((o) => o.id === routingEffortOptionId(account.driver));
  return descriptor?.type === "select" && descriptor.options.some((o) => o.id === profile.effort);
}
export const ModelRoutingRequest = Schema.Struct({
  selection: Schema.Literal("automatic"),
  assignmentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  assessment: AssignmentAssessment,
  policyVersion: Schema.optional(NonNegativeInt),
  allowedDrivers: Schema.Array(ProviderDriverKind).check(Schema.isLengthBetween(1, 2)),
  explicitInstanceId: Schema.optional(ProviderInstanceId),
  allowedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  nativeInstanceId: Schema.optional(ProviderInstanceId),
  expectedHours: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 168 })),
  ),
  contextTokens: Schema.optional(NonNegativeInt),
  // Exact user instructions remain exact, even outside the automatic allowlist.
  override: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      model: TrimmedNonEmptyString,
      options: Schema.Array(ProviderOptionSelection),
      reason: Reason,
    }),
  ),
  reassessment: Schema.optional(
    Schema.Struct({
      previousAssignmentId: TrimmedNonEmptyString,
      cause: Schema.Literals(["substantive-failure", "scope-change"]),
      reason: Reason,
      allowFreshProviderSession: Schema.Boolean,
    }),
  ),
});
export type ModelRoutingRequest = typeof ModelRoutingRequest.Type;
