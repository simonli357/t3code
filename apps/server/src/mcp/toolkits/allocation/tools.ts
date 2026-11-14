import {
  AllocationPolicyEdit,
  AllocationPolicyView,
  AllocationError,
  ComputersReport,
  ComputersRequest,
  ThreadId,
  WorkerChoice,
  WorkerChoiceInput,
  WorkerStartInput,
  WorkerStartResult,
  workerChoice,
  workerChoiceRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const CHOICE =
  "Give difficulty and stakes (integers 0-10), the computer (environmentId) and hours, your estimate of the job's length. The table gives the model and effort; the server projects every limit of each account to the job's end from learned costs (every working session on the login, on any computer, plus outside use) and picks the account with the most spare capacity per hour until its reset, within its daily goal first. When the model fits nowhere: a start waits for a limit that resets within 30 minutes (45 at stakes 8+), else takes the nearest ladder rung that fits (two at most), else the fallback, else the account that lasts longest. Only a real limit or hard cap refuses; a daily goal only ranks. Pin account, model or effort only when the user named one: a pinned account is exact. driver codex only when the user asked for Codex; it never changes model. The result has the chosen account/model/effort, `wanted` when it differs, `startAt` when the start waits for a reset, one reason line with the numbers, notes (Fable switches, settings copy used), and one line per account. State drained means everything is out until drainedUntil.";
const recommendComputer = Tool.make("t3_recommend_computer", {
  description:
    "Numbers for this computer and every linked one: idle and total CPU threads, free and total memory, free space on the work disk, running agent sessions, whether it answered, and (with projectId) the project's ID there. Unmeasured is null, never zero. Nothing is ranked: choose the computer yourself from these, what the task needs and where its data is, unless the user named one.",
  parameters: ComputersRequest,
  success: ComputersReport,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
const allocate = Tool.make("t3_allocate_account", {
  description: `Preview the account, model and effort a worker start would get, without reserving or starting anything. ${CHOICE}`,
  parameters: WorkerChoiceInput,
  success: WorkerChoice,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation, Invocation.McpInvocationContext],
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
    'Read or change the stored policy behind every worker choice, on the allocation coordinator; a change applies to the next start on every computer, with no restart. With no fields it returns the policy. It also returns the learned numbers (cost per working hour, how much use each limit holds), read-only. accountOrder is the whole preference order of accounts (labels such as ES, or instance IDs; a label means that login on every computer): it decides only between accounts whose spare capacity is within closeMarginPoints percent of the best. setGoals/clearGoals set daily goals {account, percentPerDay} in percent of the weekly window; a goal only ranks accounts and never refuses, queues or changes a start; without one an account uses the goal stored for its provider family. fableWorkers false keeps every worker off Fable models. fableOnly true is Fable mode: every worker runs on a Fable rung of the ladder (a table entry starts from the first Fable rung at or above it, only Fable rungs stand in, never the fallback); a pinned model is kept. Turning fableOnly on turns fableWorkers on; turning fableWorkers off turns fableOnly off. longWaitHours is how long a running worker that hit a limit waits for a reset before it changes model. setCaps/clearCaps set hard usage caps {account, weeklyPercent, fiveHourPercent, stopWorkers, stopMasters}, which count as the limit. ladder is the whole list of Claude {model, effort}, weakest first. fallback {model, effort, below} is used when no ladder model has room and the wanted one is below `below`; null turns it off. setCells writes table entries {table?, difficulty, difficultyTo?, stakes, stakesTo?, model, effort}; showTable returns a table. Any model ID is accepted; one that no connected account offers comes back in warnings. Turning an account off for workers is a Provider allocation setting. After "Policy changed", call again.',
  parameters: AllocationPolicyEdit,
  success: AllocationPolicyView,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
export const AllocationToolkit = Toolkit.make(recommendComputer, allocate, start, policy);
const missing = () =>
  new AllocationError({ code: "invalid", detail: "Missing allocation result." });
export const handlers = AllocationToolkit.toLayer(
  Effect.gen(function* () {
    const allocation = yield* Allocation.ProviderAllocation;
    const assignments = yield* Assignments.AllocationAssignments;
    return {
      t3_recommend_computer: (input) => allocation.computers(input),
      t3_allocate_account: (input) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          allocation
            .execute({
              _tag: "modelPreview",
              request: workerChoiceRequest({
                ...input,
                assignmentId: `preview:${caller.threadId}`,
                threadId: ThreadId.make(`preview:${caller.threadId}`),
              }),
            })
            .pipe(
              Effect.flatMap((response) =>
                response.selection
                  ? Effect.succeed(workerChoice(response.selection))
                  : Effect.fail(missing()),
              ),
            ),
        ),
      t3_allocation_policy: (input) => allocation.editPolicy(input),
      t3_start_allocated_assignment: ({ projectId, title, prompt, ...choice }) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          assignments
            .start(
              { kind: "worker", projectId, title, prompt, request: workerChoiceRequest(choice) },
              caller.threadId,
            )
            .pipe(
              Effect.flatMap((result) =>
                result.selection
                  ? Effect.succeed({
                      threadId: result.threadId,
                      started: result.state === "submitted",
                      ...workerChoice(result.selection),
                    })
                  : Effect.fail(missing()),
              ),
            ),
        ),
    };
  }),
);
