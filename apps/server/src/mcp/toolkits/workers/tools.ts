import { AgentTaskStopError } from "@t3tools/contracts";
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
    "Create a persistent worker owned by THIS master. Omit sourceThreadId for a fresh session with no inherited conversation; projectId selects its project (defaults to the master's), and permission/interaction modes come from the master. Supply sourceThreadId to fork an idle session on the selected account, preserving its native and visible history, modes, branch and worktree. Use the project's worker skill to resolve the title, explicit provider/model, and fixed reasoning options. Pass a stable destination UUID across retries. The worker keeps its selected account/model/options on follow-ups. Set environment to a linked peer's label to run the worker on that machine: give its projectId or sourceThreadId there, and its account/model. Ownership, reports and the other worker tools then work across machines. Acceptance means queued, not task completed. Workers must call t3_worker_report only when the assignment is done or genuinely blocked. Reports reach the master immediately, steering an active turn or waking an idle master unless stopped; review the latest output and evidence and give a disposition.",
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
    "Send user-authorized coordination to another T3 session, including peers, other masters or their workers. Resolve its exact threadId with the T3 skill first. For a session on a linked machine, also set environment to that machine's label; the message is held and retried while it is unreachable. The authenticated sender is attached automatically; do not impersonate the user or another session. Use a fresh clientRequestId per message, and identical input on retries. Appears immediately and steers a running recipient or wakes an idle one; stopped/snoozed sessions remain paused until resumed. No active native session is required. Dispatched means handed to orchestration, not read or completed; queued means saved and delivered automatically, once a stopped or snoozed recipient resumes or the current delivery pass finishes. Preserves recipient account/model and ownership. Report your work through this tool only when done or genuinely blocked. Do not send progress, intermediate findings, expected waits, or failures you are still recovering from; general permission to coordinate does not waive this rule. Masters may send concrete assignments, corrections or blocker resolutions. Never send acknowledgment loops. Use t3_worker_send for assignments to your own workers.",
  parameters: Workers.MessageInput,
  success: Workers.SessionMessageResult,
  failure,
  dependencies,
});
const report = Tool.make("t3_worker_report", {
  description:
    "Report THIS managed worker's assignment as done or genuinely blocked to its authenticated master. Do not use for progress, intermediate findings, a running build, a normal wait, or a restart. The same restriction applies to t3_session_send and any other channel. First resolve what you can within your authority. Supply a concise summary with evidence for completion or the exact blocker, attempted remedies, and needed action. Use a new clientRequestId per result, stable with identical content on retry. The report is saved and delivered immediately; held=true means your master has paused reports and it is delivered when they resume, so use t3_session_send if someone must act sooner. Do not report done while assigned work is still running. A stopped master sees the report without being restarted. Normal progress stays in your own conversation. Do not send another report just to acknowledge the master.",
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
      t3_worker_spawn: (input) => owner.pipe(Effect.flatMap((id) => service.spawn(id, input))),
      t3_worker_list: () => owner.pipe(Effect.flatMap((id) => service.list(id))),
      t3_worker_read: (input) => owner.pipe(Effect.flatMap((id) => service.read(id, input))),
      t3_worker_send: (input) => owner.pipe(Effect.flatMap((id) => service.send(id, input))),
      t3_worker_wait: (input) => owner.pipe(Effect.flatMap((id) => service.wait(id, input))),
      t3_worker_control: (input) => owner.pipe(Effect.flatMap((id) => service.control(id, input))),
    };
  }),
);
