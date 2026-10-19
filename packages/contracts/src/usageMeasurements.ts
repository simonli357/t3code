import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";
import { TurnTokenUsage } from "./providerRuntime.ts";

export const UsageMeasurementsInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  threadId: Schema.optional(ThreadId),
  lookbackHours: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 336 }))),
  turnLimit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type UsageMeasurementsInput = typeof UsageMeasurementsInput.Type;

export const UsageTurnMeasurement = Schema.Struct({
  instanceId: Schema.String,
  accountKey: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  selectionSource: Schema.Literals(["provider", "thread", "unknown"]),
  sessionCreatedAt: Schema.NullOr(IsoDateTime),
  observedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  state: Schema.Literals(["running", "completed", "failed", "interrupted", "aborted"]),
  lastObservedAt: IsoDateTime,
  initialContextTokens: Schema.NullOr(NonNegativeInt),
  latestContextTokens: Schema.NullOr(NonNegativeInt),
  peakContextTokens: Schema.NullOr(NonNegativeInt),
  contextCapacityTokens: Schema.NullOr(NonNegativeInt),
  compactions: NonNegativeInt,
  mixedModels: Schema.Boolean,
  toolWallMs: NonNegativeInt,
  toolTimingComplete: Schema.Boolean,
  apiDurationMs: Schema.NullOr(NonNegativeInt),
  tokens: Schema.NullOr(TurnTokenUsage),
});
export type UsageTurnMeasurement = typeof UsageTurnMeasurement.Type;

const RateEstimate = Schema.Struct({
  sampleCount: NonNegativeInt,
  intervalMinutes: Schema.Number,
  percentagePointsPerHour: Schema.NullOr(Schema.Number),
  hoursUntilExhaustion: Schema.NullOr(Schema.Number),
  hoursUntilReset: Schema.NullOr(Schema.Number),
  projectedUsedPercentAtReset: Schema.NullOr(Schema.Number),
  reason: Schema.NullOr(Schema.String),
});

export const UsageMeasurementsReport = Schema.Struct({
  observedAt: IsoDateTime,
  monitoredInstanceIds: Schema.Array(Schema.String),
  retentionDays: NonNegativeInt,
  persistenceError: Schema.NullOr(Schema.String),
  accounts: Schema.Array(
    Schema.Struct({
      accountKey: Schema.String,
      instanceIds: Schema.Array(Schema.String),
      identityKnown: Schema.Boolean,
      windows: Schema.Array(
        Schema.Struct({
          window: ServerProviderUsageWindow,
          checkedAt: IsoDateTime,
          ageSeconds: Schema.Number,
          rate: RateEstimate,
        }),
      ),
    }),
  ),
  turns: Schema.Array(
    Schema.Struct({
      ...UsageTurnMeasurement.fields,
      elapsedMs: Schema.Number,
      sessionAgeMs: Schema.NullOr(Schema.Number),
      nonToolWallMs: Schema.NullOr(Schema.Number),
    }),
  ),
  totalMatchingTurns: NonNegativeInt,
  profiles: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      accountKey: Schema.String,
      model: Schema.String,
      effort: Schema.NullOr(Schema.String),
      contextBand: Schema.String,
      turns: NonNegativeInt,
      totalTurnWallMs: Schema.Number,
      medianInputTokensPerTurnHour: Schema.Number,
      p90InputTokensPerTurnHour: Schema.Number,
      medianOutputTokensPerTurnHour: Schema.Number,
      p90OutputTokensPerTurnHour: Schema.Number,
    }),
  ),
  limitations: Schema.Array(Schema.String),
});
export type UsageMeasurementsReport = typeof UsageMeasurementsReport.Type;
