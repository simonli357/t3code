/* oxlint-disable t3code/no-em-dash-copy -- Report headers are a wire format V1 already wrote into stored messages. */
import {
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** `code` lets callers tell a refusal they can retry later (the communication window) from a rejection. */
export class WorkerError extends Schema.TaggedError<WorkerError>()("WorkerError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  successorThreadId: Schema.optional(ThreadId),
}) {}

export const SpawnInput = Schema.Struct({
  sourceThreadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  prompt: TrimmedNonEmptyString,
});
export const SendInput = Schema.Struct({
  threadId: ThreadId,
  clientRequestId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
/** `environment` names the linked computer (label or ID) that holds the recipient. */
export const MessageInput = Schema.Struct({
  ...SendInput.fields,
  environment: Schema.optional(TrimmedNonEmptyString),
  confirmationToken: Schema.optional(TrimmedNonEmptyString),
});
const SessionAddress = Schema.Struct({ environmentId: Schema.String, threadId: ThreadId });
export const SessionInfo = Schema.Struct({
  ...SessionAddress.fields,
  title: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  owner: Schema.NullOr(SessionAddress),
  revision: Schema.Number,
});
export const MessagePolicy = Schema.Struct({ sender: SessionInfo, recipient: SessionInfo });
export const SessionMessageResult = Schema.Struct({
  warning: Schema.optional(Schema.String),
  requestId: Schema.String,
  threadId: ThreadId,
  state: Schema.Literals(["confirmation_required", "queued", "dispatched", "error"]),
  error: Schema.NullOr(Schema.String),
  confirmation: Schema.optional(
    Schema.Struct({
      token: Schema.String,
      expiresAt: Schema.String,
      warning: Schema.String,
      sender: SessionInfo,
      recipient: SessionInfo,
      messagePreview: Schema.String,
    }),
  ),
});
export const ReclaimInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  workerThreadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  /** Exact quote from the latest direct user message requesting this reclaim. */
  userRequest: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
});
export const ReclaimResult = Schema.Struct({
  ownerThreadId: ThreadId,
  workerThreadIds: Schema.Array(ThreadId),
  userMessageId: MessageId,
});
export const ReportInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  outcome: Schema.Literals(["done", "blocked"]),
  /** Who must act on a blocker. Defaults to the master. */
  needs: Schema.optional(Schema.Literals(["user", "master"])),
  /** New reports should stay within 300; retain the wire bound for accepted legacy retries. */
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  evidence: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
});
export const ReadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optional(NonNegativeInt),
  textOffset: Schema.optional(NonNegativeInt),
  includeProgress: Schema.optional(Schema.Boolean),
});
export const WaitInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  timeoutMs: Schema.optional(NonNegativeInt),
});
export const ControlInput = Schema.Struct({
  threadId: ThreadId,
  notifications: Schema.optional(Schema.Boolean),
  cancelRequestId: Schema.optional(TrimmedNonEmptyString),
  adoptCurrentSettings: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
});
export const HandoffInput = Schema.Struct({
  ...SpawnInput.fields,
  selfFork: Schema.optional(Schema.Boolean),
});
export const HandoffStatusInput = Schema.Struct({
  threadId: ThreadId,
  cancel: Schema.optional(Schema.Boolean),
});
export const HandoffResult = Schema.Struct({
  warning: Schema.optional(Schema.String),
  threadId: ThreadId,
  previousOwnerThreadId: ThreadId,
  state: Schema.Literals(["queued", "completed", "error", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  transferredWorkerIds: Schema.Array(ThreadId),
  startupState: Schema.NullOr(Schema.String),
  startupError: Schema.NullOr(Schema.String),
});

export const JobState = Schema.Literals([
  "queued",
  "submitted",
  "completed",
  "error",
  "interrupted",
  "cancelled",
]);
export const JobResult = Schema.Struct({
  warning: Schema.optional(Schema.String),
  requestId: Schema.String,
  threadId: ThreadId,
  state: JobState,
  /** The V2 run that carries the assignment; the field name is the wire name V1 used. */
  turnId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
/** `held` means the master paused reports; the report is delivered when they resume. */
export const ReportResult = Schema.Struct({ ...JobResult.fields, held: Schema.Boolean });
export const WorkerResult = Schema.Struct({
  warning: Schema.optional(Schema.String),
  threadId: ThreadId,
  ownerThreadId: ThreadId,
  sourceThreadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  modelSelection: ModelSelection,
  state: Schema.String,
  error: Schema.NullOr(Schema.String),
  notifications: Schema.Boolean,
  latestRequest: Schema.NullOr(JobResult),
  pendingReports: Schema.Number,
  deliveryError: Schema.NullOr(Schema.String),
  /** Label of the peer environment that runs this worker; absent when local. */
  environment: Schema.optional(Schema.String),
});
export const ReadResult = Schema.Struct({
  worker: WorkerResult,
  items: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      kind: Schema.String,
      text: Schema.String,
      streaming: Schema.Boolean,
    }),
  ),
  nextSequence: Schema.Number,
  nextTextOffset: Schema.Number,
  hasMore: Schema.Boolean,
});
export const WaitResult = Schema.Struct({ request: JobResult, timedOut: Schema.Boolean });

/** What a worker was created with. Unknown keys written by other builds are preserved on update. */
export const Plan = Schema.Struct({
  ...SpawnInput.fields,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  /** On a master's record of a worker that runs on a linked computer: that computer. */
  environmentId: Schema.optional(Schema.String),
  /** On a linked computer's worker: the permission mode of the remote master that owns it. */
  ownerRuntimeMode: Schema.optional(RuntimeMode),
  /** On a master's record of a remote worker: the owner the other computer was last told of. */
  syncedOwnerId: Schema.optional(Schema.String),
});

/** A session on a linked computer is addressed as `peer:<environmentId>:<threadId>` wherever a local thread ID goes. */
export const peerRef = (environmentId: string, threadId: string) =>
  `peer:${environmentId}:${threadId}`;
export const parsePeerRef = (id: string | null | undefined) => {
  if (id === null || id === undefined || !id.startsWith("peer:")) return undefined;
  const at = id.indexOf(":", 5);
  return at < 0
    ? undefined
    : { environmentId: id.slice(5, at), threadId: ThreadId.make(id.slice(at + 1)) };
};

/** What a linked computer needs to know about the master that owns a worker there. */
export const PeerOwner = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});

/** Requests the `worker` peer topic carries; both computers run the same service. */
export const WorkerPeerRequest = Schema.Union([
  Schema.TaggedStruct("spawn", { owner: PeerOwner, input: SpawnInput }),
  Schema.TaggedStruct("worker", {
    owner: PeerOwner,
    workerThreadId: ThreadId,
    action: Schema.Literals(["describe", "read", "send", "wait", "control"]),
    input: Schema.Unknown,
  }),
  Schema.TaggedStruct("owner", { owner: PeerOwner, workerThreadId: ThreadId }),
  Schema.TaggedStruct("sessionInfo", { threadId: ThreadId }),
  Schema.TaggedStruct("deliver", {
    jobId: TrimmedNonEmptyString,
    kind: Schema.Literals(["message", "notice", "done", "blocked"]),
    senderThreadId: ThreadId,
    recipientThreadId: ThreadId,
    prompt: TrimmedNonEmptyString,
    /** For a message: what the sender confirmed, and the sender's title for the recipient's header. */
    policy: Schema.optional(MessagePolicy),
    senderTitle: Schema.optional(Schema.String),
  }),
]);

export interface WorkerRow {
  thread_id: string;
  owner_id: string | null;
  source_id: string | null;
  plan_json: string;
  baseline: number;
  state: string;
  error: string | null;
  notify: number;
  read_seq: number;
  read_offset: number;
  communication_anchor_at: string | null;
}
export interface JobRow {
  id: string;
  worker_id: string;
  target_id: string;
  kind: string;
  prompt: string;
  created_at: string;
  state: typeof JobState.Type;
  attempt: number;
  turn_id: string | null;
  error: string | null;
  reported: number;
  dispatched_at: string | null;
  policy_json: string | null;
  report_ids_json: string | null;
  communication_delivered_at: string | null;
}
export interface AuthorityRow {
  active: number;
  retirement_warned: number;
  successor_id: string | null;
  retired_sequence: number;
  revision: number;
}
export interface HandoffRow {
  thread_id: string;
  owner_id: string;
  plan_json: string;
  state: (typeof HandoffResult.Type)["state"];
  error: string | null;
  transferred_json: string;
  startup_state?: string | null;
  startup_error?: string | null;
  ownership_started?: number;
}

export const selectionKey = (value: ModelSelection) =>
  JSON.stringify({
    ...value,
    options: [...(value.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  });

export const isTerminalJobState = (state: string) =>
  ["completed", "error", "interrupted", "cancelled"].includes(state);

export const jobResult = (job: JobRow): typeof JobResult.Type => ({
  requestId: job.id,
  threadId: ThreadId.make(job.worker_id),
  state: job.state,
  turnId: job.turn_id,
  error: job.error,
});

const reportTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});
export const reportClock = (createdAt: string) =>
  DateTime.formatIntl(DateTime.makeUnsafe(createdAt), reportTime);
export const reportHeader = (title: string, createdAt?: string) =>
  `[T3 worker report — ${title}${createdAt ? ` — ${reportClock(createdAt)}` : ""}]`;

export const communicationRefusal = (remainingMs: number, pendingDelivery: boolean) =>
  `Worker communication window: ${Math.ceil(remainingMs / 1000)} seconds remaining${pendingDelivery ? " after the queued assignment starts" : ""}. What would you do if you were the master or user? Make reasonable decisions within your authority, investigate alternatives, and continue. Report done only when the entire assignment is finished. Only an explicit t3_worker_report outcome done may pass during this window; blockers and requests for the user or master cannot pass.`;

export const retirementWarning = (successor: string | null) =>
  `This session previously handed off to ${successor ?? "a successor"}. This action is proceeding; no confirmation or reclaim is needed to create and supervise new workers. Previously transferred workers remain with their current master. Reclaim them only if the user requests it. This informational warning is shown once per session.`;
