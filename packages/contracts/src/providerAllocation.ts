import * as Schema from "effect/Schema";
import {
  AssignmentAssessment,
  AssignmentScore,
  ModelRoutingPolicy,
  ModelRoutingRequest,
  RoutingProfile,
  routingEffortOptionId,
} from "./modelRouting.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerCapacity } from "./computers.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionSelection, ModelCapabilities } from "./model.ts";
import { AllocationLearned } from "./allocationLearning.ts";

const Points = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Hours = Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 168 }));
const Names = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100));
const OptionalCapPercent = Schema.NullOr(Points);
export const WORKER_ACCOUNT_DISABLED_REASON =
  "Turned off for workers in Provider allocation settings";
export const AllocationRequest = Schema.Struct({
  /** Unspecified requests are worker recommendations; human starts set session on the server. */
  kind: Schema.optional(Schema.Literals(["worker", "session"])),
  selection: Schema.optional(Schema.Literal("explicit")),
  assignmentId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionSelection),
  /** A pinned account is exact: a start is refused when the model is drained there. */
  explicitInstanceId: Schema.optional(ProviderInstanceId),
  allowedInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  // A native resume can only stay on its bound instance. Reselection is opt-in.
  nativeInstanceId: Schema.optional(ProviderInstanceId),
  /** How long the job is expected to run: the projection's horizon. */
  expectedHours: Schema.optional(Hours),
  /** A start queued for a limit's reset: decided as of then. */
  startAt: Schema.optional(IsoDateTime),
  workClass: Schema.optional(Schema.Literals(["interactive", "batch", "long"])),
  contextTokens: Schema.optional(NonNegativeInt),
});
export type AllocationRequest = typeof AllocationRequest.Type;

const accountCapFields = {
  weeklyPercent: OptionalCapPercent,
  fiveHourPercent: OptionalCapPercent,
  stopWorkers: Schema.Boolean,
  stopMasters: Schema.Boolean,
};
/**
 * Optional hard usage thresholds for one account identity. Weekly applies to
 * an account-wide weekly window; Claude also reports a five-hour session.
 * Missing thresholds are disabled. A reached cap that stops workers counts as drained.
 */
export const AllocationAccountCap = Schema.Struct({
  key: TrimmedNonEmptyString,
  ...accountCapFields,
});
export type AllocationAccountCap = typeof AllocationAccountCap.Type;
/** Two accounts whose room differs by at most this many points are close. */
export const DEFAULT_CLOSE_MARGIN_POINTS = 10;
/** A limited worker waits for a reset this near before it changes model. */
export const DEFAULT_LONG_WAIT_HOURS = 3;
/**
 * Pacing, forecast and rule settings from before smart allocation. Nothing here reads them, but
 * builds from before it require them, so every saved policy carries these values while the
 * computers are released one at a time. Stored policies that hold other values still load.
 */
export const legacyAllocationPolicyFields = {
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
  coldShortPointsPerHour: 15,
  coldLongPointsPerHour: 5,
  uncertaintyMultiplier: 1.5,
  defaultHours: 1,
  maxForecastHours: 8,
  minimumSamples: 5,
  hysteresisPoints: 1,
  overrides: [],
} as const;
const Legacy = Schema.optional(Schema.Unknown);
export const AllocationPolicy = Schema.Struct({
  version: NonNegativeInt,
  /** Legacy mode retained for saved policy compatibility; explicit Start always submits work. */
  mode: Schema.Literals(["observation", "automatic"]),
  coordinatorEnvironmentId: Schema.NullOr(TrimmedNonEmptyString),
  maxReadingAgeMinutes: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  reservationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15 })),
  /** Hard stops keyed by `allocationPreferenceKey`; absent or null caps are disabled. */
  accountCaps: Schema.optional(Schema.Array(AllocationAccountCap).check(Schema.isMaxLength(100))),
  /**
   * Accounts by `allocationPreferenceKey`, most preferred first. It decides only between
   * accounts whose room is close; unlisted accounts come after listed ones.
   */
  accountOrder: Schema.optional(Names),
  closeMarginPoints: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  ),
  /** A running worker that hits a limit waits for a reset within this time; else it changes model. */
  longWaitHours: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 168 })),
  ),
  /** False: no worker starts on or moves to a Fable model. Absent means allowed. */
  fableWorkers: Schema.optional(Schema.Boolean),
  /**
   * Daily goals by `allocationPreferenceKey`: the percentage of the account's weekly (or
   * monthly) window to use per day. An account without one takes its family's stored
   * `dailyPoints` (`claude`, `codex`, `other`). A goal only ranks accounts; it never refuses,
   * queues or changes a start.
   */
  accountGoals: Schema.optional(
    Schema.Array(Schema.Struct({ key: TrimmedNonEmptyString, percentPerDay: Points })).check(
      Schema.isMaxLength(100),
    ),
  ),
  // See `legacyAllocationPolicyFields`. Rules and worker models are dropped on save; the rest
  // is kept. `dailyPoints` of `claude`, `codex` and `other` are the family daily goals.
  claude: Legacy,
  codex: Legacy,
  other: Legacy,
  coldShortPointsPerHour: Legacy,
  coldLongPointsPerHour: Legacy,
  uncertaintyMultiplier: Legacy,
  defaultHours: Legacy,
  maxForecastHours: Legacy,
  minimumSamples: Legacy,
  hysteresisPoints: Legacy,
  overrides: Legacy,
  accountRules: Legacy,
  workerModels: Legacy,
});
export type AllocationPolicy = typeof AllocationPolicy.Type;
export const defaultAllocationPolicy: AllocationPolicy = {
  version: 0,
  mode: "observation",
  coordinatorEnvironmentId: null,
  maxReadingAgeMinutes: 10,
  reservationMinutes: 5,
  accountCaps: [],
  accountOrder: [],
  closeMarginPoints: DEFAULT_CLOSE_MARGIN_POINTS,
  longWaitHours: DEFAULT_LONG_WAIT_HOURS,
  ...legacyAllocationPolicyFields,
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
  // Measured only for accounts opted into usage measurements, so decisions do not rank on them.
  ratePointsPerHour: Schema.NullOr(Schema.Number),
  predictionErrorPointsPerHour: Schema.optional(Schema.NullOr(Schema.Number)),
  samples: NonNegativeInt,
  rateAgeMinutes: Schema.NullOr(Schema.Number),
});
export type AllocationWindow = typeof AllocationWindow.Type;
export const AllocationAccount = Schema.Struct({
  /** Missing on older environments means available for workers. */
  availableForWorkers: Schema.optional(Schema.Boolean),
  retainHistory: Schema.optional(Schema.Boolean),
  /** The provider is turned on in settings. Missing on older environments means enabled. */
  enabled: Schema.optional(Schema.Boolean),
  /** The plan the provider reports, such as `Claude Max Subscription`. */
  plan: Schema.optional(Schema.String),
  environmentId: Schema.String,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  accountKey: Schema.NullOr(Schema.String),
  label: Schema.String,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(Schema.String),
  /** Why this account has no currently verified subscription quota source. */
  usageLimitsUnavailableReason: Schema.optional(
    Schema.Literals(["unsupported", "unverified", "probeFailed"]),
  ),
  limitedUntil: Schema.NullOr(IsoDateTime),
  /**
   * Provider limit rejections still in force, by usage window; a null window is account-wide.
   * Absent on older computers, which report only `limitedUntil`.
   */
  limits: Schema.optional(
    Schema.Array(Schema.Struct({ windowId: Schema.NullOr(Schema.String), until: IsoDateTime })),
  ),
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
  /** A managed worker. Absent from older computers. */
  worker: Schema.optional(Schema.Boolean),
  /** The session's current context. Absent when unknown or from older computers. */
  contextTokens: Schema.optional(NonNegativeInt),
  /** Between turns, still counted as working; not a running session. */
  recent: Schema.optional(Schema.Boolean),
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
const GiB = Schema.NullOr(Schema.Number);
/** One computer's load as numbers. A part that could not be measured is null, never zero. */
export const ComputerNumbers = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  /** False when the computer did not answer this read. */
  reachable: Schema.Boolean,
  cpuThreadsIdle: Schema.NullOr(Schema.Number),
  cpuThreads: Schema.NullOr(Schema.Number),
  memoryFreeGiB: GiB,
  memoryTotalGiB: GiB,
  /** Free space on the disk that holds new agent work. */
  workDiskFreeGiB: GiB,
  /** Running and starting agent sessions. */
  sessions: Schema.NullOr(NonNegativeInt),
  /** The asked project's ID on this computer; null when it has no checkout or none was asked. */
  projectId: Schema.NullOr(ProjectId),
});
export type ComputerNumbers = typeof ComputerNumbers.Type;
export const ComputersRequest = Schema.Struct({
  /** A project on the computer receiving the request; its repository finds the same checkout elsewhere. */
  projectId: Schema.optional(ProjectId),
});
export type ComputersRequest = typeof ComputersRequest.Type;
export const ComputersReport = Schema.Struct({
  at: IsoDateTime,
  computers: Schema.Array(ComputerNumbers),
  notes: Schema.Array(Schema.String),
});
export type ComputersReport = typeof ComputersReport.Type;
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
/** What builds before smart allocation require of every candidate; constant here. */
export const legacyAllocationCandidateFields = {
  behindPoints: 0,
  confidence: "medium",
  windows: [],
} as const;
export const AllocationCandidate = Schema.Struct({
  environmentId: Schema.String,
  instanceId: ProviderInstanceId,
  accountKey: Schema.NullOr(Schema.String),
  label: Schema.optional(Schema.String),
  /** Usable for this request and not drained. */
  eligible: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  /**
   * Present when this model is drained here: an applicable usage window is used up, a provider
   * limit rejection is still in force, or a hard cap is reached. Null when the reset is unknown.
   */
  drainedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Percentage points left on the tightest applicable window; null without a reading. */
  roomPoints: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Hours until that window resets. */
  resetInHours: Schema.NullOr(Schema.Number),
  /** Active workers on this login, on every computer that was read. */
  workers: Schema.optional(NonNegativeInt),
  /** No limit or hard cap runs out before the job ends or the window resets. */
  fits: Schema.optional(Schema.Boolean),
  /** Inside its daily goal at the job's end; absent without a goal. */
  withinGoal: Schema.optional(Schema.Boolean),
  /** How many more workers like this one the tightest limit has room for until its reset. */
  roomWorkers: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Hours until the first limit runs out at the projected load; null when none does. */
  lastsHours: Schema.optional(Schema.NullOr(Schema.Number)),
  /** When it does not fit: the reset that clears the limit in its way; null when unknown. */
  fitsFrom: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** The numbers above as one line. */
  line: Schema.optional(Schema.String),
  // Only in decisions from before smart allocation, or required by those builds.
  warnings: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number),
  behindPoints: Schema.Number,
  confidence: Schema.Literals(["low", "medium"]),
  windows: Schema.Array(AllocationWindowDecision),
});
export type AllocationCandidate = typeof AllocationCandidate.Type;
export const AllocationDecision = Schema.Struct({
  at: IsoDateTime,
  policyVersion: NonNegativeInt,
  request: AllocationRequest,
  /** `wait`: the model is drained on every usable account until `waitUntil`. */
  outcome: Schema.Literals(["selected", "unavailable", "wait"]),
  selectedInstanceId: Schema.NullOr(ProviderInstanceId),
  /** Accounts of the requested provider family on the requested computer. */
  candidates: Schema.Array(AllocationCandidate),
  /** The first reason is the one-line explanation of the choice or refusal. */
  reasons: Schema.Array(Schema.String),
  confidence: Schema.Literals(["low", "medium"]),
  /** The earliest reset of a drained account; null when none is known. */
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
  /** The table's or pinned profile, when a drained model moved the choice along the ladder. */
  wanted: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
    }),
  ),
  /** Without a choice because everything is drained: the earliest reset, null when unknown. */
  drainedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** One line per account of the wanted family on the computer. */
  accounts: Schema.optional(Schema.Array(Schema.String)),
  /** The start waits for a limit's reset and begins then. */
  startAt: Schema.optional(IsoDateTime),
  /** What else shaped the choice: the Fable switch, a settings copy used without the coordinator. */
  notes: Schema.optional(Schema.Array(Schema.String)),
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
/** One login in the accounts table: what its meters say, its size and its runway. */
export const AccountRunway = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  /** How long it lasts at the current load, and its size, in words. */
  line: Schema.String,
  windows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      /** What the provider's meter says, everyone's use included. */
      meterPercent: Schema.Number,
      /** The daily goal's budget now; null for windows without a goal. */
      goalPercent: Schema.NullOr(Schema.Number),
      /** Dollars of use the whole window holds, from the learned share per dollar. */
      sizeDollars: Schema.NullOr(Schema.Number),
      source: Schema.NullOr(Schema.Literals(["measured", "estimated"])),
    }),
  ),
});
export type AccountRunway = typeof AccountRunway.Type;
export const AllocationSnapshot = Schema.Struct({
  accountCapsSupported: Schema.optional(Schema.Boolean),
  /** The coordinator ranks by room and keeps `accountOrder`; absent on older coordinators. */
  accountOrderSupported: Schema.optional(Schema.Boolean),
  policy: AllocationPolicy,
  inventories: Schema.Array(AllocationInventory),
  reservations: Schema.Array(AllocationReservation),
  history: Schema.Array(AllocationDecision),
  authorityAvailable: Schema.Boolean,
  notices: Schema.Array(Schema.String),
  learned: Schema.optional(AllocationLearned),
  /** Each login's measured size, its use and how long it lasts at the current load. */
  runways: Schema.optional(Schema.Array(AccountRunway)),
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
export const RecommendedChoice = Schema.Struct({
  /** What the table and the ranking give without the user's pin; null when nothing had room. */
  recommended: Schema.NullOr(Schema.String),
  chosen: Schema.String,
});
export type RecommendedChoice = typeof RecommendedChoice.Type;
/** Stored with each worker start: the server's own choice next to the one that ran. */
export const WorkerRecommendation = Schema.Struct({
  at: IsoDateTime,
  assessment: AssignmentAssessment,
  /** `model / effort`. */
  model: RecommendedChoice,
  /** Provider instance ID. */
  account: RecommendedChoice,
});
export type WorkerRecommendation = typeof WorkerRecommendation.Type;
export const AllocationStart = Schema.Struct({
  request: Schema.Union([AllocationRequest, ModelRoutingRequest]),
  kind: Schema.Literals(["session", "worker"]),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100000)),
});
export type AllocationStart = typeof AllocationStart.Type;
export const AllocationStartResult = Schema.Struct({
  allocation: Schema.NullOr(AllocationResult),
  selection: Schema.optional(ModelRoutingDecision),
  threadId: ThreadId,
  state: Schema.Literals(["observation", "unavailable", "submitted"]),
});
export type AllocationStartResult = typeof AllocationStartResult.Type;
const workerChoiceFields = {
  /** The computer the worker runs on. */
  environmentId: TrimmedNonEmptyString,
  difficulty: AssignmentScore,
  stakes: AssignmentScore,
  /** `codex` only when the start asks for Codex; Claude otherwise. */
  driver: Schema.optional(ProviderDriverKind),
  /** Pins, only for what the user named: an account's instance ID, a model ID, an effort. */
  account: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  effort: Schema.optional(TrimmedNonEmptyString),
  /** The master's estimate of the job's length in hours. */
  hours: Schema.optional(Hours),
};
/** What a master gives to preview a worker's account, model and effort. */
export const WorkerChoiceInput = Schema.Struct(workerChoiceFields);
export type WorkerChoiceInput = typeof WorkerChoiceInput.Type;
/** What a master gives to start a worker. */
export const WorkerStartInput = Schema.Struct({
  assignmentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  title: AllocationStart.fields.title,
  prompt: AllocationStart.fields.prompt,
  ...workerChoiceFields,
});
export type WorkerStartInput = typeof WorkerStartInput.Type;
/** The automatic request a worker choice stands for. */
export function workerChoiceRequest(
  input: WorkerChoiceInput & { assignmentId: string; threadId: ThreadId },
): ModelRoutingRequest {
  const driver = input.driver ?? ProviderDriverKind.make("claudeAgent");
  return {
    selection: "automatic",
    assignmentId: input.assignmentId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    assessment: { difficulty: input.difficulty, stakes: input.stakes },
    allowedDrivers: [driver],
    ...(input.hours ? { expectedHours: input.hours } : {}),
    ...(input.account ? { explicitInstanceId: input.account } : {}),
    ...(input.model
      ? {
          override: {
            driver,
            model: input.model,
            ...(input.effort
              ? { options: [{ id: routingEffortOptionId(driver), value: input.effort }] }
              : {}),
          },
        }
      : {}),
  };
}
/** The result of a worker preview or start: one choice, its reason and a line per account. */
export const WorkerChoice = Schema.Struct({
  /** `drained`: nothing has room until `drainedUntil`. `unavailable`: no account can run it. */
  state: Schema.Literals(["chosen", "drained", "unavailable"]),
  chosen: Schema.NullOr(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      model: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  ),
  /** The table's or pinned `model / effort`, only when the chosen one differs. */
  wanted: Schema.optional(Schema.String),
  reason: Schema.String,
  /** The earliest reset when drained; null when unknown. */
  drainedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Chosen but waiting for a limit's reset: the worker begins then. */
  startAt: Schema.optional(IsoDateTime),
  notes: Schema.optional(Schema.Array(Schema.String)),
  accounts: Schema.Array(Schema.String),
});
export type WorkerChoice = typeof WorkerChoice.Type;
export const WorkerStartResult = Schema.Struct({
  threadId: ThreadId,
  started: Schema.Boolean,
  ...WorkerChoice.fields,
});
export type WorkerStartResult = typeof WorkerStartResult.Type;
const effortOf = (driver: string, options: ReadonlyArray<ProviderOptionSelection>) => {
  const value = options.find((option) => option.id === routingEffortOptionId(driver))?.value;
  return typeof value === "string" ? value : null;
};
/** `model / effort`, the way choices and records name a profile. */
export const profileLabel = (
  driver: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
) => `${model} / ${effortOf(driver, options) ?? "default"}`;
export function workerChoice(selection: ModelRoutingDecision): WorkerChoice {
  const decision = selection.allocation?.decision;
  const request = decision?.request;
  const chosen =
    request && decision.selectedInstanceId
      ? {
          instanceId: decision.selectedInstanceId,
          driver: request.driver,
          model: request.model,
          effort: effortOf(request.driver, request.options),
        }
      : null;
  const drained = !chosen && selection.drainedUntil !== undefined;
  return {
    state: chosen ? "chosen" : drained ? "drained" : "unavailable",
    chosen,
    ...(chosen && selection.wanted
      ? {
          wanted: profileLabel(
            selection.wanted.driver,
            selection.wanted.model,
            selection.wanted.options,
          ),
        }
      : {}),
    reason: selection.reasons[0] ?? decision?.reasons[0] ?? "No reason was recorded.",
    ...(drained ? { drainedUntil: selection.drainedUntil ?? null } : {}),
    ...(chosen && selection.startAt ? { startAt: selection.startAt } : {}),
    ...(selection.notes?.length ? { notes: selection.notes } : {}),
    accounts:
      selection.accounts ??
      (decision?.candidates ?? []).map((candidate) => candidate.line ?? candidate.instanceId),
  };
}
/** An account by display label such as `ES`, or by instance ID; both name the shared login. */
const AccountRef = TrimmedNonEmptyString;
const TableName = Schema.Literals(["claudeAgent", "codex"]);
/**
 * Changes to the allocation and model policies; with none, they are only read. Every value is
 * stored policy on the coordinator and applies to the next start on every computer.
 */
export const AllocationPolicyEdit = Schema.Struct({
  /** The whole preference order, most preferred first. It decides only between close accounts. */
  accountOrder: Schema.optional(Schema.Array(AccountRef).check(Schema.isMaxLength(100))),
  closeMarginPoints: AllocationPolicy.fields.closeMarginPoints,
  longWaitHours: AllocationPolicy.fields.longWaitHours,
  setCaps: Schema.optional(
    Schema.Array(Schema.Struct({ account: AccountRef, ...accountCapFields })),
  ),
  clearCaps: Schema.optional(Schema.Array(AccountRef)),
  /** Daily goals: percent of the weekly window per day. */
  setGoals: Schema.optional(
    Schema.Array(Schema.Struct({ account: AccountRef, percentPerDay: Points })),
  ),
  /** Back to the family's goal. */
  clearGoals: Schema.optional(Schema.Array(AccountRef)),
  fableWorkers: AllocationPolicy.fields.fableWorkers,
  /** The whole Claude ladder, weakest first. */
  ladder: ModelRoutingPolicy.fields.ladder,
  /** Null turns the fallback off. */
  fallback: ModelRoutingPolicy.fields.fallback,
  /** Table entries for a range of scores; `to` values default to the single score. */
  setCells: Schema.optional(
    Schema.Array(
      Schema.Struct({
        table: Schema.optional(TableName),
        difficulty: AssignmentScore,
        difficultyTo: Schema.optional(AssignmentScore),
        stakes: AssignmentScore,
        stakesTo: Schema.optional(AssignmentScore),
        ...RoutingProfile.fields,
      }),
    ).check(Schema.isMaxLength(121)),
  ),
  /** Also return this table, one row per difficulty. */
  showTable: Schema.optional(TableName),
});
export type AllocationPolicyEdit = typeof AllocationPolicyEdit.Type;
/** The policies as agents read them: accounts by label. */
export const AllocationPolicyView = Schema.Struct({
  version: NonNegativeInt,
  modelVersion: NonNegativeInt,
  accountOrder: Schema.Array(Schema.String),
  closeMarginPoints: Schema.Number,
  longWaitHours: Schema.Number,
  caps: Schema.Array(Schema.Struct({ account: Schema.String, ...accountCapFields })),
  /** Each account's daily goal in percent of its weekly window, and where it comes from. */
  goals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        account: Schema.String,
        percentPerDay: Schema.Number,
        from: Schema.Literals(["account", "family"]),
      }),
    ),
  ),
  fableWorkers: Schema.optional(Schema.Boolean),
  /** The learned numbers, one line each, and when they were learned. */
  learned: Schema.optional(
    Schema.Struct({
      at: Schema.String,
      costs: Schema.Array(Schema.String),
      limits: Schema.Array(Schema.String),
    }),
  ),
  /** `model / effort`, weakest first. */
  ladder: Schema.Array(Schema.String),
  fallback: Schema.NullOr(Schema.String),
  /** `table[difficulty]` lists `model / effort` for stakes 0 to 10. */
  table: Schema.optional(Schema.Array(Schema.Array(Schema.String))),
  /** Every account an edit can name. */
  accounts: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      driver: ProviderDriverKind,
      instanceIds: Schema.Array(ProviderInstanceId),
    }),
  ),
  /** What a save accepted but could not confirm, such as a model no connected account offers. */
  warnings: Schema.Array(Schema.String),
});
export type AllocationPolicyView = typeof AllocationPolicyView.Type;
export const AllocationOperation = Schema.TaggedUnion({
  modelSnapshot: {},
  modelPolicy: { expectedVersion: NonNegativeInt, policy: ModelRoutingPolicy },
  modelRevert: { expectedVersion: NonNegativeInt, version: NonNegativeInt },
  modelPreview: { request: ModelRoutingRequest, policy: Schema.optional(ModelRoutingPolicy) },
  modelAllocate: { request: ModelRoutingRequest },
  connections: {},
  /**
   * Policy-only read for background enforcement; it never collects quota or demand. With
   * `learnedAt`, the answer carries the learned numbers only when they are newer.
   */
  caps: { learnedAt: Schema.optional(Schema.String) },
  snapshot: {},
  preview: { request: AllocationRequest, policy: Schema.optional(AllocationPolicy) },
  allocate: { request: AllocationRequest },
  policy: { input: AllocationPolicyUpdate },
  lifecycle: { input: AllocationLifecycle },
  connect: { coordinatorEnvironmentId: TrimmedNonEmptyString },
});
export type AllocationOperation = typeof AllocationOperation.Type;
export const AllocationResponse = Schema.Struct({
  modelSnapshot: Schema.optional(ModelRoutingSnapshot),
  /** Also in a `caps` answer, so a computer can follow the coordinator's ladder. */
  modelPolicy: Schema.optional(ModelRoutingPolicy),
  /** In a `caps` answer when newer than the asker's copy. */
  learned: Schema.optional(AllocationLearned),
  /** What a model policy save accepted but could not confirm. */
  warnings: Schema.optional(Schema.Array(Schema.String)),
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
