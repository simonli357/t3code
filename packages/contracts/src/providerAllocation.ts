import * as Schema from "effect/Schema";
import { AssignmentAssessment, ModelRoutingPolicy, ModelRoutingRequest } from "./modelRouting.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerCapacity } from "./computers.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection, ModelCapabilities } from "./model.ts";

const Points = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Hours = Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 168 }));
const Names = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100));
export const AllocationRequest = Schema.Struct({
  selection: Schema.optional(Schema.Literal("explicit")),
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
  /** Legacy mode retained for saved policy compatibility; explicit Start always submits work. */
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
  /** Relative recommendation preference only; missing entries use equal weight 50. */
  accountWeights: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: TrimmedNonEmptyString,
        weight: Points,
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  overrides: Schema.Array(Override).check(Schema.isMaxLength(100)),
});
export type AllocationPolicy = typeof AllocationPolicy.Type;
export const defaultAllocationPolicy: AllocationPolicy = {
  version: 0,
  mode: "observation",
  coordinatorEnvironmentId: null,
  claude: {
    preset: "custom",
    dailyPoints: 17,
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

/** Known login identity is shared; unknown aliases stay scoped to their environment. */
export function allocationPreferenceKey(account: {
  driver: string;
  accountKey: string | null;
  environmentId: string;
  instanceId: string;
}): string {
  return JSON.stringify([
    account.driver,
    account.accountKey === null
      ? ["instance", account.environmentId, account.instanceId]
      : ["account", account.accountKey],
  ]);
}
export function allocationPreferenceWeight(policy: AllocationPolicy, key: string): number {
  return policy.accountWeights?.find((entry) => entry.key === key)?.weight ?? 50;
}

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
  shortWindowAbsentCheckedAt: Schema.optional(IsoDateTime),
  windows: Schema.Array(AllocationWindow),
  resetCredits: Schema.NullOr(
    Schema.Struct({
      count: NonNegativeInt,
      expiresAt: Schema.NullOr(IsoDateTime),
      scope: Schema.String,
    }),
  ),
  /** Existing opt-in token measurements, never interpreted as subscription quota. */
  usageProfiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        effort: Schema.NullOr(Schema.String),
        contextBand: Schema.String,
        samples: NonNegativeInt,
        observedAt: Schema.NullOr(IsoDateTime),
        outputTokensPerHour: Schema.Number,
        /** Token variability margin only, never a conversion to quota points. */
        uncertainty: Schema.optional(Schema.Number),
      }),
    ),
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
  /** Live advisory cap owned by this environment. Older computers default to six. */
  maxActiveAgentSessions: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  environmentLabel: Schema.optional(Schema.String),
  coordinatorEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  environmentId: Schema.String,
  observedAt: IsoDateTime,
  accounts: Schema.Array(AllocationAccount),
  demand: Schema.Array(AllocationDemand),
  complete: Schema.Boolean,
  notices: Schema.Array(Schema.String),
  /** Only in a placement read. Absent from a server that predates it: unknown, never zero. */
  computer: Schema.optional(ComputerCapacity),
  /** Only when a placement read named a repository: this computer's checkouts of it, possibly none. */
  projects: Schema.optional(
    Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })).check(
      Schema.isMaxLength(20),
    ),
  ),
});
export type AllocationInventory = typeof AllocationInventory.Type;

/** What a placement read asks of each computer, beyond its allocation inventory. */
export const ComputerPlacementProbe = Schema.Struct({
  repositoryKey: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerPlacementProbe = typeof ComputerPlacementProbe.Type;
/** Extra peak load of the task, like a Workenv needs file. Omitted entries are not compared. */
const ComputerPlacementNeeds = Schema.Struct({
  memoryBytes: Schema.optional(NonNegativeInt),
  cpuThreads: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
  /** Space on the disk that holds new agent work. */
  diskBytes: Schema.optional(NonNegativeInt),
  /** The native operating system the task requires. */
  os: Schema.optional(ExecutionEnvironmentPlatformOs),
});
/**
 * Everything is optional advice for choosing where a worker runs; no field blocks a start. The
 * computer, provider, model and account the user already chose stay exact.
 */
export const ComputerPlacementRequest = Schema.Struct({
  needs: Schema.optional(ComputerPlacementNeeds),
  /** A project on the computer receiving the request; its repository finds the same checkout elsewhere. */
  projectId: Schema.optional(ProjectId),
  /** The repository key behind `projectId`; filled in by the receiving server. */
  repositoryKey: Schema.optional(TrimmedNonEmptyString),
  /** The provider runtime the worker needs. */
  driver: Schema.optional(ProviderDriverKind),
  model: Schema.optional(TrimmedNonEmptyString),
  /** An account the user chose; the same login on another computer counts. */
  instanceId: Schema.optional(ProviderInstanceId),
  /** A computer the user already chose: kept, even when offline, and reported with its own warnings. */
  environmentId: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerPlacementRequest = typeof ComputerPlacementRequest.Type;
export const ComputerPlacementHost = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  /** 1 is the best order for this request. Every connected computer is listed. */
  rank: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /**
   * `fresh`: measured within the allocation policy's reading age; `stale`: older; `unknown`:
   * reachable but not measured; `offline`: could not be reached for this read.
   */
  state: Schema.Literals(["fresh", "stale", "unknown", "offline"]),
  ageSeconds: Schema.NullOr(NonNegativeInt),
  /** The computer the request already chose. */
  chosen: Schema.Boolean,
  /** Running or starting agent sessions; null when unknown. */
  sessions: Schema.NullOr(NonNegativeInt),
  /** Checkouts of the requested repository on this computer; absent when none was requested. */
  projects: Schema.optional(
    Schema.Array(Schema.Struct({ id: ProjectId, title: Schema.String })).check(
      Schema.isMaxLength(20),
    ),
  ),
  /** `none`: no needs were declared; `unknown`: they could not be compared. */
  fit: Schema.Literals(["fits", "short", "unknown", "none"]),
  computer: Schema.NullOr(ComputerCapacity),
  reasons: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type ComputerPlacementHost = typeof ComputerPlacementHost.Type;
export const ComputerPlacement = Schema.Struct({
  at: IsoDateTime,
  request: ComputerPlacementRequest,
  /**
   * The computer the request named, whatever its state; null when it names none that is connected,
   * never a substitute. Without a name, the best reachable computer, or null when none is.
   */
  recommendedEnvironmentId: Schema.NullOr(Schema.String),
  hosts: Schema.Array(ComputerPlacementHost),
  reasons: Schema.Array(Schema.String),
});
export type ComputerPlacement = typeof ComputerPlacement.Type;
const AllocationWindowDecision = Schema.Struct({
  id: Schema.String,
  actualPoints: Points,
  targetPoints: Points,
  forecastPoints: Schema.Number,
  headroomPoints: Schema.Number,
  /** Optional for decisions saved before projected-budget ranking. */
  budgetPoints: Schema.optional(Schema.Number),
  budgetHeadroomPoints: Schema.optional(Schema.Number),
  runningForecastPoints: Schema.optional(Schema.Number),
  queuedForecastPoints: Schema.optional(Schema.Number),
  incomingForecastPoints: Schema.optional(Schema.Number),
  unobservedForecastPoints: Schema.optional(Schema.Number),
  samples: NonNegativeInt,
  ageMinutes: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  reasons: Schema.Array(Schema.String),
});
export const AllocationCandidate = Schema.Struct({
  /** Advisory estimates and observed health; never an admission veto. Optional for old history. */
  warnings: Schema.optional(Schema.Array(Schema.String)),
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
  accountKey: Schema.NullOr(Schema.String),
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
export const ModelRoutingDecision = Schema.Struct({
  at: IsoDateTime,
  policyVersion: NonNegativeInt,
  request: ModelRoutingRequest,
  revision: NonNegativeInt,
  selectedProfile: Schema.NullOr(Schema.Int),
  rule: Schema.String,
  profiles: Schema.Array(
    Schema.Struct({
      driver: ProviderDriverKind,
      profile: Schema.NullOr(Schema.Int),
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
      reason: Schema.String,
      eligible: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(2)),
  reasons: Schema.Array(Schema.String),
  allocation: Schema.NullOr(AllocationResult),
});
export type ModelRoutingDecision = typeof ModelRoutingDecision.Type;
export const ModelRoutingSnapshot = Schema.Struct({
  policy: ModelRoutingPolicy,
  policies: Schema.Array(ModelRoutingPolicy),
  history: Schema.Array(ModelRoutingDecision),
  inventories: Schema.Array(AllocationInventory),
  authorityAvailable: Schema.Boolean,
});
export type ModelRoutingSnapshot = typeof ModelRoutingSnapshot.Type;
export const AllocationSnapshot = Schema.Struct({
  accountWeightsSupported: Schema.optional(Schema.Boolean),
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
  /** Atomic check against a concurrent pre-start account choice. */
  expectedRequest: Schema.optional(AllocationRequest),
  startIntent: Schema.optional(Schema.String),
  assignmentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  action: Schema.Literals(["start", "consume", "release"]),
});
const OverrideReason = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
/**
 * Why the master chose differently from a recommendation, per dimension, such as "user
 * specified ES Opus xhigh". Required only for a pinned choice that differs.
 */
export const RecommendationOverrides = Schema.Struct({
  model: Schema.optional(OverrideReason),
  account: Schema.optional(OverrideReason),
  computer: Schema.optional(OverrideReason),
});
export type RecommendationOverrides = typeof RecommendationOverrides.Type;
export const RecommendedChoice = Schema.Struct({
  /** Null when no recommendation could be computed; `unavailable` says why. */
  recommended: Schema.NullOr(Schema.String),
  chosen: Schema.String,
  overrideReason: Schema.optional(Schema.String),
  unavailable: Schema.optional(Schema.String),
});
export type RecommendedChoice = typeof RecommendedChoice.Type;
/** Recommended-vs-chosen record for one worker creation. Advice only; never an admission veto. */
export const WorkerRecommendation = Schema.Struct({
  at: IsoDateTime,
  assessment: AssignmentAssessment,
  /** `model / effort` from the difficulty/stakes table. */
  model: RecommendedChoice,
  /** Provider instance ID from allocation. */
  account: RecommendedChoice,
  /** Environment ID from computer advice. */
  computer: RecommendedChoice,
  /** Advisory warnings for the chosen account and computer. */
  warnings: Schema.Array(Schema.String),
});
export type WorkerRecommendation = typeof WorkerRecommendation.Type;
/** One computer in stored advice. `unknown` is reachable but unmeasured; never zero load. */
export const ComputerAdviceHost = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  rank: NonNegativeInt,
  state: Schema.Literals(["fresh", "stale", "unknown", "offline"]),
  sessions: Schema.NullOr(NonNegativeInt),
  warnings: Schema.Array(Schema.String),
});
export type ComputerAdviceHost = typeof ComputerAdviceHost.Type;
export const AllocationStart = Schema.Struct({
  request: Schema.Union([AllocationRequest, ModelRoutingRequest]),
  kind: Schema.Literals(["session", "worker"]),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100000)),
  /** Required for workers with an exact request; automatic requests carry their own. */
  assessment: Schema.optional(AssignmentAssessment),
  overrides: Schema.optional(RecommendationOverrides),
});
export type AllocationStart = typeof AllocationStart.Type;
export const AllocationStartResult = Schema.Struct({
  allocation: Schema.NullOr(AllocationResult),
  selection: Schema.optional(ModelRoutingDecision),
  recommendation: Schema.optional(WorkerRecommendation),
  threadId: ThreadId,
  state: Schema.Literals(["observation", "unavailable", "submitted"]),
});
export type AllocationStartResult = typeof AllocationStartResult.Type;
/** What a managed worker start returns to agents: the choice and its recommendation, no candidate lists. */
export const AllocationWorkerStartResult = Schema.Struct({
  threadId: ThreadId,
  state: AllocationStartResult.fields.state,
  chosen: Schema.NullOr(
    Schema.Struct({
      environmentId: Schema.String,
      instanceId: Schema.NullOr(ProviderInstanceId),
      driver: ProviderDriverKind,
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
    }),
  ),
  recommendation: Schema.optional(WorkerRecommendation),
  reasons: Schema.Array(Schema.String),
});
export type AllocationWorkerStartResult = typeof AllocationWorkerStartResult.Type;
export function compactAllocationStart(result: AllocationStartResult): AllocationWorkerStartResult {
  const decision = result.allocation?.decision ?? result.selection?.allocation?.decision;
  return {
    threadId: result.threadId,
    state: result.state,
    chosen: decision
      ? {
          environmentId: decision.request.environmentId,
          instanceId: decision.selectedInstanceId,
          driver: decision.request.driver,
          model: decision.request.model,
          options: decision.request.options,
        }
      : null,
    ...(result.recommendation ? { recommendation: result.recommendation } : {}),
    reasons:
      result.state === "submitted"
        ? []
        : [...(result.selection?.reasons ?? []), ...(decision?.reasons ?? [])].slice(0, 10),
  };
}
export const AllocationOperation = Schema.TaggedUnion({
  modelSnapshot: {},
  modelPolicy: { expectedVersion: NonNegativeInt, policy: ModelRoutingPolicy },
  modelRevert: { expectedVersion: NonNegativeInt, version: NonNegativeInt },
  modelPreview: { request: ModelRoutingRequest, policy: Schema.optional(ModelRoutingPolicy) },
  modelAllocate: { request: ModelRoutingRequest },
  connections: {},
  snapshot: {},
  preview: { request: AllocationRequest, policy: Schema.optional(AllocationPolicy) },
  allocate: { request: AllocationRequest },
  policy: { input: AllocationPolicyUpdate },
  lifecycle: { input: AllocationLifecycle },
  connect: { coordinatorEnvironmentId: TrimmedNonEmptyString },
  /** Advice only: reads every connected computer and reserves nothing. */
  placement: { request: ComputerPlacementRequest },
});
export type AllocationOperation = typeof AllocationOperation.Type;
export const AllocationResponse = Schema.Struct({
  modelSnapshot: Schema.optional(ModelRoutingSnapshot),
  modelPolicy: Schema.optional(ModelRoutingPolicy),
  selection: Schema.optional(ModelRoutingDecision),
  connections: Schema.optional(
    Schema.Struct({
      coordinatorEnvironmentId: Schema.NullOr(Schema.String),
      environments: Schema.Array(
        Schema.Struct({
          environmentId: Schema.String,
          label: Schema.String,
        }),
      ),
    }),
  ),
  snapshot: Schema.optional(AllocationSnapshot),
  result: Schema.optional(AllocationResult),
  policy: Schema.optional(AllocationPolicy),
  reservation: Schema.optional(AllocationReservation),
  placement: Schema.optional(ComputerPlacement),
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
