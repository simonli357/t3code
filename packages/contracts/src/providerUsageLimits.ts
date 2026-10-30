import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  /** Complete provider probe explicitly reports an empty, inactive rolling window. */
  inactive: Schema.optional(Schema.Literal(true)),
  /** Proven enforcement-to-numeric bucket association from a complete provider probe. */
  enforcement: Schema.optional(
    Schema.Struct({ windowId: TrimmedNonEmptyString, checkedAt: IsoDateTime }),
  ),
  /** Provider-reported bucket name; unresolved scope is conservatively account-wide. */
  modelScope: Schema.optional(TrimmedNonEmptyString),
  checkedAt: Schema.optional(IsoDateTime),
  applicableModels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** `unavailable` separates never-reporting, unverified and failed-probe accounts; failed probes keep the last good bars. */
export const ServerProviderUsageLimits = Schema.Struct({
  /** No short window in a complete provider read; sparse updates cannot renew this evidence. */
  shortWindowAbsent: Schema.optional(Schema.Boolean),
  shortWindowAbsentCheckedAt: Schema.optional(IsoDateTime),
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  /** Opaque credential identity when the provider does not report an account. */
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  /** Provider-owned usage settings when quota windows are not available to the client. */
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "unverified", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/**
 * What an adapter reports when its runtime pushes a rate-limit update during
 * a turn. Sparse by contract: Claude's `rate_limit_event` names one window at
 * a time and Codex documents its notification as a partial. Windows merge by
 * `id` onto the instance's published snapshot; omitted windows are unchanged.
 */
export const ProviderQuotaState = Schema.Struct({
  windowId: TrimmedNonEmptyString,
  /** Exact numeric bucket identity already established when this event arrived. */
  usageWindowId: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals(["rejected", "allowed"]),
  resetsAt: Schema.optional(IsoDateTime),
});
export type ProviderQuotaState = typeof ProviderQuotaState.Type;

export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
  states: Schema.optional(Schema.Array(ProviderQuotaState)),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

/**
 * One account a usage-limit source reports on. `driver` is the provider the
 * account belongs to, for the icon and colour clients already have; the
 * account itself is not something this environment can run turns on.
 */
export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  /** The signed-in address, when the source names one; clients blur it like provider auth. */
  email: Schema.optional(TrimmedNonEmptyString),
  /** Plan as the matching provider would label it (`ChatGPT Pro 20x Subscription`). */
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

/**
 * The published state of one configured `usageLimitSources` entry. A source
 * that could not be read keeps `error` beside an empty account list rather
 * than vanishing, so the user can see it is configured but failing.
 */
export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Mirrors Codex's own outcome set; other providers map onto it. */
export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  /** Redemption succeeded, but a follow-up such as clearing the hub cooldown failed. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

/** A point-in-time view of one provider's limits, built for the /usage-limits panel. */
export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
