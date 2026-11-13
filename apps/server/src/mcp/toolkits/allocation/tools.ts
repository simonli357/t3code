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
  "Give difficulty and stakes (integers 0-10) and the computer (environmentId). The server picks account, model and effort together: the table's model for the scores on the account with the most room; when that model is drained on every account, the nearest ladder model that has room. Drained means a usage window is used up, a provider limit rejection is in force, or a hard cap is reached; nothing softer changes the model. Pin account, model or effort only when the user named one: a pinned model is the starting point and may still be replaced when drained; a pinned account is exact and is refused when drained. driver codex only when the user asked for Codex; it never changes model. The result has the chosen account/model/effort, `wanted` when the table's choice differs, one reason line, and one line per account. State drained means nothing has room until drainedUntil.";
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
    'Read or change the stored policy behind every worker choice, on the allocation coordinator; a change applies to the next start on every computer, with no restart. With no fields it returns the policy. accountOrder is the whole preference order of accounts (labels such as ES, or instance IDs; a label means that login on every computer): it decides only between accounts whose room is within closeMarginPoints of the best. longWaitHours is how long a running worker that hit a limit waits for a reset before it changes model. setCaps/clearCaps set hard usage caps {account, weeklyPercent, fiveHourPercent, stopWorkers, stopMasters}. ladder is the whole list of Claude {model, effort}, weakest first. fallback {model, effort, below} is used when no ladder model has room and the wanted one is below `below`; null turns it off. setCells writes table entries {table?, difficulty, difficultyTo?, stakes, stakesTo?, model, effort}; showTable returns a table. Any model ID is accepted; one that no connected account offers comes back in warnings. Turning an account off for workers is a Provider allocation setting. After "Policy changed", call again.',
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
