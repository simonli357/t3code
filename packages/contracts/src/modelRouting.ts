import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection } from "./model.ts";

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
export const MODEL_SCORE_BANDS = ["0–3", "4–6", "7", "8", "9", "10"] as const;
const ProfileId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }));
export const RoutingProfile = Schema.Struct({
  model: TrimmedNonEmptyString,
  effort: TrimmedNonEmptyString,
});
export type RoutingProfile = typeof RoutingProfile.Type;
const Six = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isLengthBetween(6, 6));
export const RoutingTable = Schema.Struct({
  profiles: Six(RoutingProfile),
  grid: Six(Six(ProfileId)),
  allowedModels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  // Ordered, explicit capability alternatives. Quota pressure never activates these.
  alternatives: Six(Schema.Array(ProfileId).check(Schema.isMaxLength(5))),
});
export type RoutingTable = typeof RoutingTable.Type;
export const ModelRoutingPolicy = Schema.Struct({
  version: NonNegativeInt,
  codex: RoutingTable,
  claudeAgent: RoutingTable,
  maxReassessments: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
});
export type ModelRoutingPolicy = typeof ModelRoutingPolicy.Type;
const grid = [
  [1, 2, 2, 4, 5, 5],
  [2, 2, 3, 4, 5, 5],
  [3, 3, 4, 5, 5, 6],
  [3, 4, 5, 5, 6, 6],
  [5, 5, 5, 6, 6, 6],
  [6, 6, 6, 6, 6, 6],
];
const table = (models: readonly [string, string]): RoutingTable => ({
  profiles: ["medium", "high", "max", "medium", "high", "xhigh"].map((effort, i) => ({
    model: models[i < 3 ? 0 : 1],
    effort,
  })),
  grid,
  allowedModels: models,
  alternatives: [[], [], [], [], [], []],
});
export const defaultModelRoutingPolicy: ModelRoutingPolicy = {
  version: 0,
  codex: table(["gpt-6.1-sol", "gpt-6-astra"]),
  claudeAgent: table(["claude-sonnet-5-5", "claude-opus-5-5"]),
  maxReassessments: 2,
};
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
