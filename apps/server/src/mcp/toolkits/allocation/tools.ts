import {
  AllocationPolicyEdit,
  AllocationPolicyView,
  AllocationError,
  ComputersReport,
  ComputersRequest,
  WorkerChoice,
  WorkerChoiceInput,
  WorkerStartInput,
  WorkerStartResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const CHOICE =
  "Give difficulty and stakes (integers 0-10), hours (your estimate of the job's length) and projectId, the project on your own computer. The server chooses the computer: of the linked computers that answer, are measured and have a checkout of the project, the one with the most room, which is free memory less the expected memory of each session that started there too recently to show it and less a reserve for each session already working there; computers with room above the minimum and an idle CPU thread come first, then those with no idle CPU, then those under the minimum, and last those where the system killed a session for lack of memory recently. The start is never refused for lack of room: the reason says when the best computer is under the minimum. The worker gets the project's ID on that computer. Give environmentId (an ID or label) only when the user named a computer or the work needs one (tooling or data on one machine): it is used as given, whatever its numbers. If no account on the chosen computer can start the worker and one on another can, that computer is used and a note says so. The table gives the model and effort; the server projects every limit of each account to the job's end from learned costs (every working session on the login, on any computer, plus outside use) and picks, of the accounts that last the job, the one furthest behind its daily goal in points. When the model fits nowhere: a start waits for a limit that resets within 30 minutes (45 at stakes 8+), else takes the nearest ladder rung that fits (two at most), else the fallback, else the account that lasts longest. Only a real limit or hard cap refuses; a daily goal only ranks. Pin account, model or effort only when the user named one: a pinned account is exact. driver codex only when the user asked for Codex; it never changes model. The result has the chosen account/model/effort, `wanted` when it differs, `startAt` when the start waits for a reset, one reason line with the numbers, notes (Fable switches and Fable mode, settings copy used, another computer used), one line per account, the chosen `computer` (its ID, label, the project's ID there and one reason line with the numbers) and one line per computer in `computers`. State drained means everything is out until drainedUntil.";
const recommendComputer = Tool.make("t3_recommend_computer", {
  description:
    "Numbers for this computer and every linked one: idle and total CPU threads, free and total memory, free space on the work disk, running agent sessions, whether it answered, and (with projectId) the project's ID there. Unmeasured is null, never zero. Read-only and unranked: a worker start chooses its computer itself, so call this only to look at the numbers, for example before naming a computer.",
  parameters: ComputersRequest,
  success: ComputersReport,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
const allocate = Tool.make("t3_allocate_account", {
  description: `Preview the computer, account, model and effort a worker start would get, without reserving or starting anything. ${CHOICE}`,
  parameters: WorkerChoiceInput,
  success: WorkerChoice,
  failure: AllocationError,
  dependencies: [Assignments.AllocationAssignments, Invocation.McpInvocationContext],
});
const start = Tool.make("t3_start_allocated_assignment", {
  description: `Start a fresh managed worker. ${CHOICE} started=false means no worker was created. After an attempted startup, retry the entire input unchanged to prevent duplicates.`,
  parameters: WorkerStartInput,
  success: WorkerStartResult,
  failure: AllocationError,
  dependencies: [Assignments.AllocationAssignments, Invocation.McpInvocationContext],
});
const policy = Tool.make("t3_allocation_policy", {
  description:
    'Read or change the stored policy behind every worker choice, on the allocation coordinator; a change applies to the next start on every computer, with no restart. With no fields it returns the policy. It also returns the learned numbers (cost per working hour, how much use each limit holds), read-only. accountOrder is the whole preference order of accounts (labels such as ES, or instance IDs; a label means that login on every computer): it decides only between accounts on one side of their goal, within closeMarginPoints points. setGoals/clearGoals set daily goals {account, percentPerDay} in percent of the weekly window; a goal only ranks accounts and never refuses, queues or changes a start; without one an account uses the goal stored for its provider family. fableWorkers false keeps every worker off Fable models. fableAccounts is the whole list of Claude accounts in Fable mode (labels or instance IDs; [] for none): a worker on one of them runs on a Fable rung of the ladder (its table entry starts from the first Fable rung at or above it; only Fable rungs stand in, never the fallback; drained Fable keeps that account out until it resets), a worker on any other account runs the table choice, and every account is judged on what it would run; a pinned model is kept. Turning Fable mode on for an account turns fableWorkers on; turning fableWorkers off empties fableAccounts. longWaitHours is how long a running worker that hit a limit waits for a reset before it changes model. Five values decide which computer a worker starts on: workerMemoryGiB is the memory a worker is expected to take once it builds or runs a dev server, startSettleMinutes is how long a started session counts as not showing that memory yet (each such session takes workerMemoryGiB off the free memory of its computer), minFreeMemoryGiB is the room a computer needs to be chosen while another has it, sessionReserveGiB is kept back for each session already working on a computer (their builds and dev servers come and go), and memoryKillHoldMinutes is how long a computer counts as full after the system killed a session there for lack of memory. setCaps/clearCaps set hard usage caps {account, weeklyPercent, fiveHourPercent, stopWorkers, stopMasters}, which count as the limit. ladder is the whole list of Claude {model, effort}, weakest first. fallback {model, effort, below} is used when no ladder model has room and the wanted one is below `below`; null turns it off. setCells writes table entries {table?, difficulty, difficultyTo?, stakes, stakesTo?, model, effort}; showTable returns a table. Any model ID is accepted; one that no connected account offers comes back in warnings. Turning an account off for workers is a Provider allocation setting. After "Policy changed", call again.',
  parameters: AllocationPolicyEdit,
  success: AllocationPolicyView,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
export const AllocationToolkit = Toolkit.make(recommendComputer, allocate, start, policy);
export const handlers = AllocationToolkit.toLayer(
  Effect.gen(function* () {
    const allocation = yield* Allocation.ProviderAllocation;
    const assignments = yield* Assignments.AllocationAssignments;
    return {
      t3_recommend_computer: (input) => allocation.computers(input),
      t3_allocate_account: (input) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          assignments.previewWorker(input, caller.threadId),
        ),
      t3_allocation_policy: (input) => allocation.editPolicy(input),
      t3_start_allocated_assignment: (input) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          assignments.startWorker(input, caller.threadId),
        ),
    };
  }),
);
