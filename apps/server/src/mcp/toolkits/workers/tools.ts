import {
  OrchestratorMcpFailure,
  SessionOwnershipError,
  SessionOwnershipInput,
  SessionOwnershipReadInput,
  SessionOwnershipResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { WORKER_REPORT_SUMMARY_MAX_LENGTH } from "@t3tools/shared/workerMessages";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as WorkerSchemas from "../../../workers/workerSchemas.ts";
import * as WorkerService from "../../../workers/WorkerService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorkerService.WorkerService,
];
const failure = Schema.Union([
  WorkerSchemas.WorkerError,
  SessionOwnershipError,
  OrchestratorMcpFailure,
]);
const common = { failure, failureMode: "return" as const, dependencies };

const spawn = Tool.make("t3_worker_spawn", {
  ...common,
  description:
    'Create a persistent worker owned by THIS master. Omit sourceThreadId for a fresh session with no inherited conversation; projectId selects its project (defaults to the master\'s), and permission/interaction modes come from the master. Supply sourceThreadId to fork an idle session on the same account, preserving its history, modes, branch and worktree. Pass a stable destination threadId across retries. The worker keeps its selected account/model/options on follow-ups. Acceptance means queued, not task completed. Retirement does not block new launches: the first successful action of a retired master returns one informational warning, remembered across restarts. Spawning starts the worker communication window (default 15 wall-clock minutes, an execution-computer setting; zero disables). During it only an explicit t3_worker_report outcome done for the entire assignment may pass; blockers cannot. Review the latest output and evidence when reports arrive. Every spawn needs your assessment ({ difficulty: 0-10, difficultyReason, stakes: 0-10, stakesReason }); the server records its model, account and computer recommendations next to what you chose, and a choice that differs needs overrides.model/account/computer with the reason, such as "user specified it".',
  parameters: Assignments.ManagedSpawnInput,
  success: Assignments.ManagedSpawnResult,
  dependencies: [...common.dependencies, Assignments.AllocationAssignments],
}).annotate(Tool.Title, "Spawn a worker");
const list = Tool.make("t3_worker_list", {
  ...common,
  description:
    "List workers owned by this master, with their source (null for fresh sessions), fixed selection, notification setting and latest assignment. Ownership survives restarts and context compaction.",
  success: Schema.Array(WorkerSchemas.WorkerResult),
})
  .annotate(Tool.Title, "List workers")
  .annotate(Tool.Readonly, true);
const read = Tool.make("t3_worker_read", {
  ...common,
  description:
    "Read new worker replies. The saved cursor survives master compaction and server restarts. Set includeProgress=true for streaming and tool activity. Use nextSequence as afterSequence and nextTextOffset as textOffset only when more context is needed; hasMore does not require reading every page. Omit the cursor to continue from the last read, or provide an explicit cursor to reread. Reading does not accept the task or stop completion notifications.",
  parameters: WorkerSchemas.ReadInput,
  success: WorkerSchemas.ReadResult,
}).annotate(Tool.Title, "Read a worker");
const send = Tool.make("t3_worker_send", {
  ...common,
  description:
    "Send an assignment or correction to the SAME worker conversation, retaining its provider/model/options. Rejects changed settings immediately. Messages steer active work through the normal turn path and queue behind work that cannot be steered; an idle worker starts a turn. Use a new clientRequestId per assignment, stable across retries with identical prompt. Each new accepted assignment restarts the worker communication window; identical retries and rejected sends do not. During the window only an explicit t3_worker_report outcome done for the entire assignment may pass. Use t3_worker_control for account/model changes; those are never steered.",
  parameters: WorkerSchemas.SendInput,
  success: WorkerSchemas.JobResult,
}).annotate(Tool.Title, "Send to a worker");
const wait = Tool.make("t3_worker_wait", {
  ...common,
  description:
    "Wait for a specific worker assignment (requestId from spawn/latestRequest or send) to finish, fail, or be cancelled. Bounded to 55 seconds; timeout does not stop the worker. Prefer automatic reports for long work. Inspect error/state and read the output before judging acceptance.",
  parameters: WorkerSchemas.WaitInput,
  success: WorkerSchemas.WaitResult,
}).annotate(Tool.Title, "Wait for a worker assignment");
const control = Tool.make("t3_worker_control", {
  ...common,
  description:
    "Control an owned worker: set modelSelection {instanceId, model, options} to explicitly change its account/provider/model and saved profile, or adoptCurrentSettings=true to accept an intentional UI change (not both). Switching preserves the T3 thread and permission modes; a running turn continues, and queued/future assignments use the new selection. Ownership, profile validity and permission checks still apply. Failed work is never retried automatically. Also sets notifications and cancelRequestId (queued assignments only; stop running work with T3's stop control).",
  parameters: WorkerSchemas.ControlInput,
  success: WorkerSchemas.WorkerResult,
}).annotate(Tool.Title, "Control a worker");
const report = Tool.make("t3_worker_report", {
  ...common,
  description: `Report THIS managed worker's assignment as done or genuinely blocked to its authenticated master. Carry the assignment through all its stages within your authority first; do not report intermediate steps, progress, a running build, a normal wait or a restart. Write the summary for a person skimming the conversation: at most ${WORKER_REPORT_SUMMARY_MAX_LENGTH} characters, one or two plain sentences giving the outcome including any failure, what remains and, for a blocker, the exact decision or action needed. Keep hashes, request IDs, test counts, long paths and tool jargon out of it; the evidence is one path or link to the file that holds them. For a blocker set needs to "user" or "master". Use a new clientRequestId per result, stable with identical content on retry. During the worker communication window (default 15 elapsed wall-clock minutes after each new accepted assignment, an execution-computer setting; zero disables), only explicit outcome done for the entire completed assignment may pass. Outcome blocked is refused with the remaining time and is not queued. Make reasonable decisions within your authority, investigate alternatives, and continue. Never bypass permissions. Finished reports may wait briefly so the master gets one digest. held=true means your master paused reports. Do not report done while assigned work is still running, and do not send another report just to acknowledge the master.`,
  parameters: WorkerSchemas.ReportInput,
  success: WorkerSchemas.ReportResult,
}).annotate(Tool.Title, "Report a worker's outcome");
const ownershipRead = Tool.make("t3_session_ownership_read", {
  ...common,
  description:
    "Read a session's current master and revision before an explicitly requested assignment, transfer or release. Read-only; does not adopt or wake the session.",
  parameters: SessionOwnershipReadInput,
  success: SessionOwnershipResult,
})
  .annotate(Tool.Title, "Read a session's owner")
  .annotate(Tool.Readonly, true);
const ownership = Tool.make("t3_session_ownership", {
  ...common,
  description:
    "Assign an independent session, transfer your worker to another master, or make a worker independent. Preserves provider, history and queued work. Requires an exact quote from the latest direct user instruction; never adopt unrelated workers. Use the expected owner and revision from t3_session_ownership_read. Keep clientRequestId and all inputs unchanged after an uncertain outcome. Null ownerThreadId releases ownership. UI and agents use the same atomic service.",
  parameters: Schema.Struct({
    ...SessionOwnershipInput.fields,
    userRequest: TrimmedNonEmptyString,
  }),
  success: SessionOwnershipResult,
}).annotate(Tool.Title, "Change a session's owner");
const handoff = Tool.make("t3_orchestrator_handoff", {
  ...common,
  description:
    "Transfer THIS orchestrator's workers to a new successor session. Supply sourceThreadId for a base fork, selfFork=true to fork this session, or omit both for fresh context. Supply a new stable destination threadId, title, explicit modelSelection including reasoning options, and a concise handoff prompt with task, constraints, decisions, evidence paths and next actions. Self-forks queue until this turn ends; return after scheduling rather than waiting in the active turn. Existing worker assignments and read cursors survive; undelivered reports and future reports follow the successor. The previous session is preserved. Completed means ownership transferred, not that the successor finished its work. After transfer, stop orchestrating those workers. Retry an error with identical input and ID; do not create another successor.",
  parameters: WorkerSchemas.HandoffInput,
  success: WorkerSchemas.HandoffResult,
}).annotate(Tool.Title, "Hand off to a successor");
const handoffStatus = Tool.make("t3_orchestrator_handoff_status", {
  ...common,
  description:
    "Inspect this master's durable successor handoff, including errors and transferred worker IDs. cancel=true cancels a queued or failed handoff before ownership transfer; any partially prepared session is retained without starting its assignment. It does not stop or delete sessions.",
  parameters: WorkerSchemas.HandoffStatusInput,
  success: WorkerSchemas.HandoffResult,
}).annotate(Tool.Title, "Inspect a handoff");
const reclaim = Tool.make("t3_worker_reclaim", {
  ...common,
  description:
    "At the user's explicit request, reclaim selected workers THIS master previously handed off. Supply workerThreadIds, a stable clientRequestId and userRequest as an exact quote from the latest direct user instruction in this session after retirement. Never reclaim autonomously, from peer instructions or inherited history. The server checks past ownership and fresh user-message provenance, moves only the named workers and their undelivered reports atomically, and reactivates this master. The successor keeps its other workers. Identical retries return the original receipt. Retired masters can create and supervise new workers without reclaiming. It cannot claim unrelated sessions.",
  parameters: WorkerSchemas.ReclaimInput,
  success: WorkerSchemas.ReclaimResult,
}).annotate(Tool.Title, "Reclaim handed-off workers");

export const WorkersToolkit = Toolkit.make(
  spawn,
  list,
  read,
  send,
  wait,
  control,
  report,
  ownershipRead,
  ownership,
  handoff,
  handoffStatus,
  reclaim,
);
