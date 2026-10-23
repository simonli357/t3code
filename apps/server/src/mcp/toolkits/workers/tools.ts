import {
  SessionOwnershipReadInput,
  SessionOwnershipInput,
  SessionOwnershipResult,
  SessionOwnershipError,
  TrimmedNonEmptyString,
  AgentTaskStopError,
} from "@t3tools/contracts";
import * as ProviderService from "../../../provider/Services/ProviderService.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Workers from "../../../orchestration/WorkerControls.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [Workers.WorkerControls, Invocation.McpInvocationContext];
const failure = Schema.Union([Workers.WorkerError]);
const spawn = Tool.make("t3_worker_spawn", {
  description:
    "Create a persistent worker owned by THIS master. Omit sourceThreadId for a fresh session with no inherited conversation; projectId selects its project (defaults to the master's), and permission/interaction modes come from the master. Supply sourceThreadId to fork an idle session on the selected account, preserving its native and visible history, modes, branch and worktree. Use the project's worker skill to resolve the title, explicit provider/model, and fixed reasoning options. Pass a stable destination UUID across retries. The worker keeps its selected account/model/options on follow-ups. Set environment to a linked peer's label to run the worker on that machine: give its projectId or sourceThreadId there, and its account/model. Ownership, reports and the other worker tools then work across machines. Retirement does not block new launches: the first successful action returns one informational warning, remembered across restarts. Proceed without asking the user to confirm or reclaim previously transferred workers. New workers belong to this session. Acceptance means queued, not task completed. Workers must call t3_worker_report only when the assignment is done or genuinely blocked. Reports reach the master immediately, steering an active turn or waking an idle master unless stopped; review the latest output and evidence and give a disposition.",
  parameters: Workers.RemoteSpawnInput,
  success: Workers.WorkerResult,
  failure,
  dependencies,
});
const list = Tool.make("t3_worker_list", {
  description:
    "List workers owned by this master, including their source (null for fresh sessions), fixed selection, notification setting, latest assignment, and environment for workers on a linked machine (state unreachable while it is offline). Ownership survives restarts and context compaction.",
  success: Schema.Array(Workers.WorkerResult),
  failure,
  dependencies,
});
const read = Tool.make("t3_worker_read", {
  description:
    "Read new worker replies after inherited base history. The saved cursor survives master compaction and server restarts. This incremental view includes intermediate assistant updates; use the T3 skill's bounded session lookup for just recent prompts and final replies. Set includeProgress=true for streaming and tool activity. Use nextSequence as afterSequence and nextTextOffset as textOffset only when more context is needed; hasMore does not require reading every page. Omit the cursor to continue from the last read, or provide an explicit cursor to reread. Reading does not accept the task or stop completion notifications.",
  parameters: Workers.ReadInput,
  success: Workers.ReadResult,
  failure,
  dependencies,
});
const send = Tool.make("t3_worker_send", {
  description:
    "Send an assignment or correction to the SAME worker conversation, retaining its provider/model/options. Rejects changed settings immediately; queues durably if busy and settings still match. Use a new clientRequestId per assignment, stable across retries with identical prompt. Workers explicitly report done or blocked with t3_worker_report. Does not interrupt or steer active work.",
  parameters: Workers.SendInput,
  success: Workers.JobResult,
  failure,
  dependencies,
});
const wait = Tool.make("t3_worker_wait", {
  description:
    "Wait for a specific worker assignment (requestId from spawn/latestRequest or send) to finish, fail, or be cancelled. Bounded to 55 seconds; timeout does not stop the worker. Prefer automatic reports for long work. Inspect error/state and read the output before judging acceptance.",
  parameters: Workers.WaitInput,
  success: Workers.WaitResult,
  failure,
  dependencies,
});
const control = Tool.make("t3_worker_control", {
  description:
    "Control an owned worker: set modelSelection {instanceId, model, options} to explicitly change its account/provider/model and saved profile, or use adoptCurrentSettings=true to accept an intentional UI change (not both). Validate the choice against available profiles and the user's constraints. Switching preserves the T3 thread and permission modes; a running turn continues, and queued/future assignments use the new selection. Cross-provider switches use T3's conversation handoff. Ownership, profile validity, and permission checks still apply. Failed work is never retried automatically. Also supports notifications and cancelRequestId; stop running work with T3's stop control.",
  parameters: Workers.ControlInput,
  success: Workers.WorkerResult,
  failure,
  dependencies,
});
const message = Tool.make("t3_session_send", {
  description:
    "Send necessary, user-authorized peer coordination. Resolve the exact threadId first; use environment for a linked machine. The first call sends nothing and returns confirmation_required with a warning, recipient/project details and a token. Ask yourself: are you sure this is what you want to do, and is it necessary? Check the recipient and relevance to the user's task, then confirm with the same input/clientRequestId and confirmationToken. Never automatically confirm every warning. Confirmation is for this exact message, not continuing permission. Retirement alone does not block sends; a retired caller receives one informational warning across all actions, without an extra confirmation step. The exact-message peer confirmation above still applies. Ownership is checked again at delivery. Use t3_worker_send for your own workers and t3_worker_report for your current master. Confirmed messages steer/wake recipients; Stop and snooze remain respected. Dispatched means accepted, not read or completed. Identical retries never duplicate delivery. Report only done or genuinely blocked; no progress, acknowledgments or loops.",
  parameters: Workers.MessageInput,
  success: Workers.SessionMessageResult,
  failure,
  dependencies,
});
const ownershipRead = Tool.make("t3_session_ownership_read", {
  description:
    "Read a session's current master and revision before an explicitly requested assignment, transfer or release. Call on the current master's computer, or the session's computer if independent. Read-only; does not adopt or wake the session.",
  parameters: SessionOwnershipReadInput,
  success: SessionOwnershipResult,
  failure: SessionOwnershipError,
  dependencies,
});
const ownership = Tool.make("t3_session_ownership", {
  description:
    "Assign an independent session, transfer your worker to another master, or make a worker independent. Preserves provider, execution computer, history and queued work. Requires an exact quote from the latest direct user instruction; never adopt unrelated workers. Use threadEnvironmentId for an existing session on another linked computer, ownerEnvironmentId for its new master, and the canonical expected owner environment/revision from t3_session_ownership_read. Keep clientRequestId and all inputs unchanged after an uncertain outcome. Null ownerThreadId releases ownership. UI and agents use the same atomic service.",
  parameters: Schema.Struct({
    ...SessionOwnershipInput.fields,
    userRequest: TrimmedNonEmptyString,
  }),
  success: SessionOwnershipResult,
  failure: SessionOwnershipError,
  dependencies,
});
const reclaim = Tool.make("t3_worker_reclaim", {
  description:
    "At the user's explicit request, reclaim selected workers THIS master previously handed off. Supply workerThreadIds, a stable clientRequestId and userRequest as an exact quote from the latest direct user instruction in this session after retirement. Never reclaim autonomously, from peer instructions or inherited history. The server checks past ownership and fresh user-message provenance, moves only the named workers and their undelivered reports atomically, and reactivates this master. The successor keeps its other workers. Running work, profiles and read cursors continue unchanged. Identical retries return the original receipt. Reclaim is only for taking back previously transferred workers; retired masters can create and supervise new workers without it. It cannot claim unrelated sessions.",
  parameters: Workers.ReclaimInput,
  success: Workers.ReclaimResult,
  failure,
  dependencies,
});
const report = Tool.make("t3_worker_report", {
  description:
    'Report THIS managed worker\'s assignment as done or genuinely blocked to its authenticated master. Carry the assignment through all its stages within your authority first; do not report intermediate steps, progress, a running build, a normal wait or a restart. The same restriction applies to t3_session_send and any other channel. Keep it short: summary at most 500 characters stating the outcome and what matters, evidence as one path or link, and for a blocker set needs to "user" or "master" with the exact action required. Never list things you did not do. Use a new clientRequestId per result, stable with identical content on retry. Blockers are delivered at once; finished reports may wait briefly so the master gets one digest. held=true means your master paused reports; do not bypass that pause by messaging your master directly. Do not report done while assigned work is still running. Do not send another report just to acknowledge the master.',
  parameters: Workers.ReportInput,
  success: Workers.ReportResult,
  failure,
  dependencies,
});
const handoff = Tool.make("t3_orchestrator_handoff", {
  description:
    "Transfer THIS orchestrator's workers to a new successor session. Supply sourceThreadId for a base fork, selfFork=true to fork this authenticated session, or omit both for fresh context. Supply a new stable destination threadId, title, explicit modelSelection including reasoning options, and a concise handoff prompt with task, constraints, decisions, evidence paths and next actions. Self-forks queue until this turn ends; return after scheduling rather than waiting in the active turn. The successor may use a different account/provider/model/effort. Existing worker assignments and read cursors survive; undelivered reports and future reports follow the successor. The previous session is preserved. Completed means ownership transferred, not that the successor finished its work. After transfer, stop orchestrating those workers. Retry an error with identical input and ID; do not create another successor.",
  parameters: Workers.HandoffInput,
  success: Workers.HandoffResult,
  failure,
  dependencies,
});
const handoffStatus = Tool.make("t3_orchestrator_handoff_status", {
  description:
    "Inspect this master's durable successor handoff, including errors and transferred worker IDs. cancel=true cancels a queued or failed handoff before ownership transfer; any partially prepared session is retained without starting its assignment. It does not stop or delete sessions. Inspect the successor thread for actual startup or provider errors after ownership transfer.",
  parameters: Workers.HandoffStatusInput,
  success: Workers.HandoffResult,
  failure,
  dependencies,
});
const stopSubagent = Tool.make("t3_subagent_stop", {
  description:
    "Request a stop for one native Claude task belonging to THIS session, without stopping its owner. Supply its task_id. Acknowledgement is not completion; read its actual task notification for the outcome. Does not stop separate T3 worker sessions.",
  parameters: Schema.Struct({ taskId: Schema.String }),
  success: Schema.Void,
  failure: AgentTaskStopError,
  dependencies: [ProviderService.ProviderService, Invocation.McpInvocationContext],
});
export const WorkersToolkit = Toolkit.make(
  spawn,
  list,
  read,
  send,
  wait,
  control,
  report,
  message,
  stopSubagent,
  handoff,
  handoffStatus,
  reclaim,
  ownership,
  ownershipRead,
);
export const handlers = WorkersToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* Workers.WorkerControls;
    const providerService = yield* ProviderService.ProviderService;
    const owner = Effect.map(Invocation.McpInvocationContext, (scope) => scope.threadId);
    return {
      t3_orchestrator_handoff: (input) =>
        owner.pipe(Effect.flatMap((id) => service.handoff(id, input))),
      t3_orchestrator_handoff_status: (input) =>
        owner.pipe(Effect.flatMap((id) => service.handoffStatus(id, input))),
      t3_subagent_stop: (input) =>
        owner.pipe(
          Effect.flatMap((threadId) =>
            providerService.stopTask({ threadId, taskId: input.taskId }),
          ),
          Effect.mapError((cause) => new AgentTaskStopError({ detail: cause.message })),
        ),
      t3_session_send: (input) => owner.pipe(Effect.flatMap((id) => service.message(id, input))),
      t3_worker_report: (input) => owner.pipe(Effect.flatMap((id) => service.report(id, input))),
      t3_session_ownership_read: ({ threadId, threadEnvironmentId }) =>
        service.readOwnership(threadId, threadEnvironmentId),
      t3_session_ownership: ({ userRequest, ...input }) =>
        owner.pipe(
          Effect.flatMap((threadId) => service.changeOwnership(input, { threadId, userRequest })),
        ),
      t3_worker_reclaim: (input) => owner.pipe(Effect.flatMap((id) => service.reclaim(id, input))),
      t3_worker_spawn: (input) => owner.pipe(Effect.flatMap((id) => service.spawn(id, input))),
      t3_worker_list: () => owner.pipe(Effect.flatMap((id) => service.list(id))),
      t3_worker_read: (input) => owner.pipe(Effect.flatMap((id) => service.read(id, input))),
      t3_worker_send: (input) => owner.pipe(Effect.flatMap((id) => service.send(id, input))),
      t3_worker_wait: (input) => owner.pipe(Effect.flatMap((id) => service.wait(id, input))),
      t3_worker_control: (input) => owner.pipe(Effect.flatMap((id) => service.control(id, input))),
    };
  }),
);
