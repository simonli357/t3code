import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * `measured`: from this installation's recorded turns or limit readings. `estimated`: from a
 * measured entry scaled by model price or plan size; `basis` says which.
 */
export const LearnedSource = Schema.Literals(["measured", "estimated"]);
export type LearnedSource = typeof LearnedSource.Type;
/** Masters are every session that is not a managed worker. */
export const SessionKind = Schema.Literals(["worker", "master"]);
export type SessionKind = typeof SessionKind.Type;

/** What one working hour of a session costs at API prices, whole turns including subagents. */
export const LearnedCost = Schema.Struct({
  driver: ProviderDriverKind,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  kind: SessionKind,
  /** Dollars per working hour at `contextTokens`. */
  dollarsPerHour: Schema.Number,
  /** Dollars per hour added by each 100k tokens of context above `contextTokens`; 0 without a fit. */
  perHundredK: Schema.Number,
  /** The typical context of these sessions, used when a session's own is unknown. */
  contextTokens: NonNegativeInt,
  samples: NonNegativeInt,
  hours: Schema.Number,
  source: LearnedSource,
  basis: Schema.optional(Schema.String),
});
export type LearnedCost = typeof LearnedCost.Type;

/** How much of one account's limit a dollar of use takes. */
export const LearnedLimit = Schema.Struct({
  /** `allocationPreferenceKey` of the login. */
  key: Schema.String,
  label: Schema.String,
  driver: ProviderDriverKind,
  windowId: Schema.String,
  windowLabel: Schema.String,
  /** Plan as the provider reports it; learning restarts when it changes. */
  plan: Schema.NullOr(Schema.String),
  /** Percent of the limit one API-equivalent dollar uses. */
  percentPerDollar: Schema.Number,
  /** Use T3 does not see (other people, other tools), in percent per hour. */
  backgroundPercentPerHour: Schema.Number,
  /**
   * The same by time of day when the history supports it: four values for 00–06, 06–12, 12–18
   * and 18–24 UTC.
   */
  backgroundByQuarter: Schema.optional(Schema.Array(Schema.Number)),
  /** Standard error of `percentPerDollar` relative to it, from the fit's residuals. */
  relativeError: Schema.optional(Schema.Number),
  /** How much of the meter's movement T3's own spend explains; the rest is background. */
  explained: Schema.optional(Schema.Number),
  /** End of the newest reading pair the fit used. */
  lastPairAt: Schema.optional(IsoDateTime),
  /**
   * The share per dollar meets `ownShareRule`, so T3's own use can be told apart from the meter's
   * total and the daily goal is measured against it.
   */
  ownTrusted: Schema.optional(Schema.Boolean),
  /** What T3's own sessions used of the cycle that ends at `cycleResetsAt`, in percent. */
  ownPercent: Schema.optional(Schema.Number),
  cycleResetsAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Reading pairs the fit used. */
  samples: NonNegativeInt,
  hours: Schema.Number,
  source: LearnedSource,
  basis: Schema.optional(Schema.String),
});
export type LearnedLimit = typeof LearnedLimit.Type;

/** Numbers the coordinator learns from every computer's history. Nobody edits them. */
export const AllocationLearned = Schema.Struct({
  learnedAt: IsoDateTime,
  costs: Schema.Array(LearnedCost),
  limits: Schema.Array(LearnedLimit),
  /** Median length of a worker's job, for starts that give none. */
  workerHours: Schema.NullOr(Schema.Number),
  /** When a share per dollar is trusted enough to measure the goal against T3's own use. */
  ownShareRule: Schema.optional(
    Schema.Struct({
      minPairs: NonNegativeInt,
      maxRelativeError: Schema.Number,
      minExplained: Schema.Number,
      maxAgeHours: Schema.Number,
    }),
  ),
  /** Computers whose history could not be read, and similar gaps. */
  notes: Schema.Array(Schema.String),
});
export type AllocationLearned = typeof AllocationLearned.Type;

/** One finished turn, as a computer reports it for learning. */
export const EvidenceTurn = Schema.Struct({
  key: Schema.String,
  driver: ProviderDriverKind,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  kind: SessionKind,
  threadId: Schema.String,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  contextTokens: Schema.NullOr(NonNegativeInt),
  costUsd: Schema.Number,
  /** Tokens by price class, so another model's cost can be estimated from this one's mix. */
  tokens: Schema.optional(
    Schema.Struct({
      input: NonNegativeInt,
      cacheRead: NonNegativeInt,
      cacheWrite: NonNegativeInt,
      output: NonNegativeInt,
    }),
  ),
});
export type EvidenceTurn = typeof EvidenceTurn.Type;

/** One limit reading that differs from the previous one. */
export const EvidenceReading = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  driver: ProviderDriverKind,
  windowId: Schema.String,
  windowLabel: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  models: Schema.optional(Schema.Array(Schema.String)),
  usedPercent: Schema.Number,
  checkedAt: IsoDateTime,
  resetsAt: Schema.NullOr(IsoDateTime),
  durationHours: Schema.NullOr(Schema.Number),
  plan: Schema.NullOr(Schema.String),
});
export type EvidenceReading = typeof EvidenceReading.Type;

export const AllocationEvidence = Schema.Struct({
  environmentId: Schema.String,
  observedAt: IsoDateTime,
  turns: Schema.Array(EvidenceTurn),
  readings: Schema.Array(EvidenceReading),
});
export type AllocationEvidence = typeof AllocationEvidence.Type;

/**
 * Published plan sizes relative to the provider's smallest paid plan, for an account without
 * history (claude.com/pricing, OpenAI's Codex plan pages, November 2026). Claude: Pro 1, Max
 * 5x 5, Max 20x 20, a Team seat that runs Claude Code (Premium) 6.25; a plan reported only as
 * "Max" counts as 5x until its own readings say more. Codex: Plus 1, Pro 5x 5, Pro 20x 20,
 * Pro Max 25, Business and Team about Plus.
 */
const PLAN_SIZES: Record<string, readonly (readonly [RegExp, number])[]> = {
  claudeAgent: [
    [/20x/i, 20],
    [/5x/i, 5],
    [/\bmax\b/i, 5],
    [/team|enterprise/i, 6.25],
    [/\bpro\b/i, 1],
  ],
  codex: [
    [/pro\s*max|promax/i, 25],
    [/20x/i, 20],
    [/5x|prolite/i, 5],
    [/\bpro\b/i, 20],
    [/plus|team|business|enterprise|edu/i, 1],
    [/free|\bgo\b/i, 0.2],
  ],
};
export const publishedPlanSize = (driver: string, plan: string | null | undefined) =>
  plan ? (PLAN_SIZES[driver]?.find(([pattern]) => pattern.test(plan))?.[1] ?? null) : null;

/** A session counts as working until this long after its last turn ends. */
export const IDLE_AFTER_MINUTES = 15;
/** A start waits for a limit that resets this soon instead of changing model or account. */
export const START_WAIT_MINUTES = 30;
export const START_WAIT_MINUTES_HIGH_STAKES = 45;
export const HIGH_STAKES = 8;
/** The furthest ladder rung a start or a running worker may move to. */
export const MAX_RUNG_DISTANCE = 2;
