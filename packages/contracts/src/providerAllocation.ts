import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection, ModelCapabilities } from "./model.ts";

const Points = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Hours = Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 168 }));
const Names = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100));
export const AllocationRequest = Schema.Struct({
  assignmentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionSelection),
  explicitInstanceId: Schema.optional(ProviderInstanceId),
  allowedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  expectedHours: Schema.optional(Hours),
  workClass: Schema.optional(Schema.Literals(["interactive", "batch", "long"])),
  contextTokens: Schema.optional(NonNegativeInt),
  // A native resume can only stay on its bound instance. Reselection is opt-in.
  nativeInstanceId: Schema.optional(ProviderInstanceId),
});
export type AllocationRequest = typeof AllocationRequest.Type;

export const AllocationCurve = Schema.Struct({
  preset: Schema.Literals(["sustainable", "aggressive17", "burst", "custom"]),
  dailyPoints: Points,
  burstPoints: Points,
  burstHours: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 168 })),
  reservePoints: Points,
  borrowPoints: Points,
});
export type AllocationCurve = typeof AllocationCurve.Type;
const Override = Schema.Struct({
  accountKey: TrimmedNonEmptyString,
  windowId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  curve: Schema.optional(AllocationCurve),
  useBy: Schema.optional(IsoDateTime),
  baselineUsedPoints: Points,
  // Informational only: neither a plan nor a banked credit replenishes quota.
  resetPlan: Schema.optional(Schema.Literals(["possible", "planned", "manual-confirmed"])),
});
export const AllocationPolicy = Schema.Struct({
  version: NonNegativeInt,
  mode: Schema.Literals(["observation", "automatic"]),
  coordinatorEnvironmentId: Schema.NullOr(TrimmedNonEmptyString),
  claude: AllocationCurve,
  codex: AllocationCurve,
  other: AllocationCurve,
  maxReadingAgeMinutes: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  coldShortPointsPerHour: Points,
  coldLongPointsPerHour: Points,
  uncertaintyMultiplier: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  defaultHours: Hours,
  maxForecastHours: Hours,
  minimumSamples: Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 100 })),
  reservationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 })),
  hysteresisPoints: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  overrides: Schema.Array(Override).check(Schema.isMaxLength(100)),
});
export type AllocationPolicy = typeof AllocationPolicy.Type;
export const defaultAllocationPolicy: AllocationPolicy = {
  version: 0,
  mode: "observation",
  coordinatorEnvironmentId: null,
  claude: {
    preset: "sustainable",
    dailyPoints: 100 / 7,
    burstPoints: 0,
    burstHours: 0,
    reservePoints: 5,
    borrowPoints: 15,
  },
  codex: {
    preset: "burst",
    dailyPoints: 10,
    burstPoints: 30,
    burstHours: 0,
    reservePoints: 5,
    borrowPoints: 15,
  },
  other: {
    preset: "sustainable",
    dailyPoints: 100 / 7,
    burstPoints: 0,
    burstHours: 0,
    reservePoints: 10,
    borrowPoints: 15,
  },
  maxReadingAgeMinutes: 10,
  coldShortPointsPerHour: 15,
  coldLongPointsPerHour: 5,
  uncertaintyMultiplier: 1.5,
  defaultHours: 1,
  maxForecastHours: 8,
  minimumSamples: 5,
  reservationMinutes: 5,
  hysteresisPoints: 1,
  overrides: [],
};

export const AllocationWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  usedPoints: Points,
  checkedAt: IsoDateTime,
  resetsAt: Schema.NullOr(IsoDateTime),
  cycleStartedAt: Schema.NullOr(IsoDateTime),
  durationHours: Schema.NullOr(Schema.Number),
  models: Schema.optional(Names),
  ratePointsPerHour: Schema.NullOr(Schema.Number),
  predictionErrorPointsPerHour: Schema.optional(Schema.NullOr(Schema.Number)),
  samples: NonNegativeInt,
  rateAgeMinutes: Schema.NullOr(Schema.Number),
});
export type AllocationWindow = typeof AllocationWindow.Type;
export const AllocationAccount = Schema.Struct({
  retainHistory: Schema.optional(Schema.Boolean),
  environmentId: Schema.String,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  accountKey: Schema.NullOr(Schema.String),
  label: Schema.String,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
  limitedUntil: Schema.NullOr(IsoDateTime),
  models: Schema.Array(
    Schema.Struct({ slug: Schema.String, capabilities: Schema.NullOr(ModelCapabilities) }),
  ),
  shortWindow: Schema.Literals(["reported", "known-absent", "unknown"]),
  windows: Schema.Array(AllocationWindow),
  resetCredits: Schema.NullOr(
    Schema.Struct({
      count: NonNegativeInt,
      expiresAt: Schema.NullOr(IsoDateTime),
      scope: Schema.String,
    }),
  ),
  profileSamples: NonNegativeInt,
  profileUncertainty: Schema.Number,
});
export type AllocationAccount = typeof AllocationAccount.Type;
export const AllocationDemand = Schema.Struct({
  environmentId: Schema.String,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  accountKey: Schema.NullOr(Schema.String),
  model: Schema.String,
  options: Schema.Array(ProviderOptionSelection),
  state: Schema.Literals(["running", "pending", "uncertain"]),
});
export type AllocationDemand = typeof AllocationDemand.Type;
export const AllocationInventory = Schema.Struct({
  coordinatorEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  environmentId: Schema.String,
  observedAt: IsoDateTime,
  accounts: Schema.Array(AllocationAccount),
  demand: Schema.Array(AllocationDemand),
  complete: Schema.Boolean,
  notices: Schema.Array(Schema.String),
});
export type AllocationInventory = typeof AllocationInventory.Type;
const AllocationWindowDecision = Schema.Struct({
  id: Schema.String,
  actualPoints: Points,
  targetPoints: Points,
  forecastPoints: Schema.Number,
  headroomPoints: Schema.Number,
  samples: NonNegativeInt,
  ageMinutes: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  reasons: Schema.Array(Schema.String),
});
export const AllocationCandidate = Schema.Struct({
  environmentId: Schema.String,
  instanceId: ProviderInstanceId,
  accountKey: Schema.NullOr(Schema.String),
  eligible: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  behindPoints: Schema.Number,
  resetInHours: Schema.NullOr(Schema.Number),
  confidence: Schema.Literals(["low", "medium"]),
  windows: Schema.Array(AllocationWindowDecision),
});
export type AllocationCandidate = typeof AllocationCandidate.Type;
export const AllocationDecision = Schema.Struct({
  at: IsoDateTime,
  policyVersion: NonNegativeInt,
  request: AllocationRequest,
  outcome: Schema.Literals(["selected", "unavailable", "wait"]),
  selectedInstanceId: Schema.NullOr(ProviderInstanceId),
  candidates: Schema.Array(AllocationCandidate),
  reasons: Schema.Array(Schema.String),
  confidence: Schema.Literals(["low", "medium"]),
  waitUntil: Schema.NullOr(IsoDateTime),
});
export type AllocationDecision = typeof AllocationDecision.Type;
export const AllocationReservation = Schema.Struct({
  startIntent: Schema.optional(Schema.String),
  assignmentId: Schema.String,
  request: AllocationRequest,
  accountKey: Schema.String,
  instanceId: ProviderInstanceId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  state: Schema.Literals(["reserved", "starting", "consumed", "released", "expired"]),
  decision: AllocationDecision,
});
export type AllocationReservation = typeof AllocationReservation.Type;
export const AllocationResult = Schema.Struct({
  decision: AllocationDecision,
  reservation: Schema.NullOr(AllocationReservation),
  mode: Schema.Literals(["observation", "automatic"]),
});
export type AllocationResult = typeof AllocationResult.Type;
export const AllocationSnapshot = Schema.Struct({
  policy: AllocationPolicy,
  inventories: Schema.Array(AllocationInventory),
  reservations: Schema.Array(AllocationReservation),
  history: Schema.Array(AllocationDecision),
  authorityAvailable: Schema.Boolean,
  notices: Schema.Array(Schema.String),
});
export type AllocationSnapshot = typeof AllocationSnapshot.Type;
export const AllocationPolicyUpdate = Schema.Struct({
  expectedVersion: NonNegativeInt,
  policy: AllocationPolicy,
});
export const AllocationLifecycle = Schema.Struct({
  startIntent: Schema.optional(Schema.String),
  assignmentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  action: Schema.Literals(["start", "consume", "release"]),
});
export const AllocationStart = Schema.Struct({
  request: AllocationRequest,
  kind: Schema.Literals(["session", "worker"]),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100000)),
});
export type AllocationStart = typeof AllocationStart.Type;
export const AllocationStartResult = Schema.Struct({
  allocation: AllocationResult,
  threadId: ThreadId,
  state: Schema.Literals(["observation", "unavailable", "submitted"]),
});
export type AllocationStartResult = typeof AllocationStartResult.Type;
export const AllocationOperation = Schema.TaggedUnion({
  snapshot: {},
  preview: { request: AllocationRequest, policy: Schema.optional(AllocationPolicy) },
  allocate: { request: AllocationRequest },
  policy: { input: AllocationPolicyUpdate },
  lifecycle: { input: AllocationLifecycle },
  connect: { coordinatorEnvironmentId: TrimmedNonEmptyString },
});
export type AllocationOperation = typeof AllocationOperation.Type;
export const AllocationResponse = Schema.Struct({
  snapshot: Schema.optional(AllocationSnapshot),
  result: Schema.optional(AllocationResult),
  policy: Schema.optional(AllocationPolicy),
  reservation: Schema.optional(AllocationReservation),
});
export type AllocationResponse = typeof AllocationResponse.Type;
export class AllocationError extends Schema.TaggedError<AllocationError>()("AllocationError", {
  code: Schema.Literals(["conflict", "unavailable", "invalid", "persistence"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
