import {
  AllocationRequest,
  AllocationResult,
  AllocationStart,
  AllocationStartResult,
  AllocationError,
  ModelRoutingRequest,
  ModelRoutingDecision,
  MODEL_SCORING_RUBRIC,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const allocate = Tool.make("t3_allocate_account", {
  description:
    "Request deterministic account allocation for an exact model/options and execution environment. Supply a stable assignmentId and destination threadId. preview=true evaluates only; otherwise automatic mode reserves capacity and observation mode records the proposal. Never change effort, speed, family or computer to obtain capacity. Use t3_start_allocated_assignment to start a fresh managed worker using the same request. Existing explicit forks/retries remain unchanged. No reset credits are redeemed. For automatic model selection use request.selection=automatic with allowedDrivers and assessment. Only configured profiles and capability alternatives are eligible; quota pressure never weakens them. " +
    MODEL_SCORING_RUBRIC,
  parameters: Schema.Struct({
    request: Schema.Union([AllocationRequest, ModelRoutingRequest]),
    preview: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([AllocationResult, ModelRoutingDecision]),
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
const start = Tool.make("t3_start_allocated_assignment", {
  description:
    "Create a fresh managed worker through deterministic allocation. Use kind=worker. An exact request preserves model/options. A request with selection=automatic requires assessment and allowedDrivers; policy resolves the exact model/effort before account admission. Reuse the entire input and IDs after a lost response. Observation does not start. Reassessment requires a new assignment/thread identity, previousAssignmentId, substantive-failure or scope-change reason, and explicit consent for a fresh provider family. Transport or installation failures do not justify escalation. Does not fork or mutate native sessions. " +
    MODEL_SCORING_RUBRIC,
  parameters: Schema.Struct({ ...AllocationStart.fields, kind: Schema.Literal("worker") }),
  success: AllocationStartResult,
  failure: AllocationError,
  dependencies: [Assignments.AllocationAssignments, Invocation.McpInvocationContext],
});
export const AllocationToolkit = Toolkit.make(allocate, start);
export const handlers = AllocationToolkit.toLayer(
  Effect.gen(function* () {
    const allocation = yield* Allocation.ProviderAllocation;
    const assignments = yield* Assignments.AllocationAssignments;
    return {
      t3_allocate_account: (input) =>
        allocation
          .execute(
            input.request.selection === "automatic"
              ? input.preview
                ? { _tag: "modelPreview", request: input.request }
                : { _tag: "modelAllocate", request: input.request }
              : input.preview
                ? { _tag: "preview", request: input.request }
                : { _tag: "allocate", request: input.request },
          )
          .pipe(
            Effect.flatMap((response) =>
              response.selection || response.result
                ? Effect.succeed(response.selection ?? response.result!)
                : Effect.fail(
                    new AllocationError({ code: "invalid", detail: "Missing allocation result." }),
                  ),
            ),
          ),
      t3_start_allocated_assignment: (input) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          assignments.start(input, caller.threadId),
        ),
    };
  }),
);
