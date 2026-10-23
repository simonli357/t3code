import {
  AllocationRequest,
  AllocationResult,
  AllocationStart,
  AllocationStartResult,
  AllocationError,
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
    "Request deterministic account allocation for an exact model/options and execution environment. Supply a stable assignmentId and destination threadId. preview=true evaluates only; otherwise automatic mode reserves capacity and observation mode records the proposal. Never change effort, speed, family or computer to obtain capacity. Use t3_start_allocated_assignment to start a fresh managed worker using the same request. Existing explicit forks/retries remain unchanged. No reset credits are redeemed.",
  parameters: Schema.Struct({
    request: AllocationRequest,
    preview: Schema.optional(Schema.Boolean),
  }),
  success: AllocationResult,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
const start = Tool.make("t3_start_allocated_assignment", {
  description:
    "Create a fresh managed worker through deterministic allocation. Choose model/options, host, project and task; the service chooses only the account, reserves shared capacity and preserves the profile. Use kind=worker. Reuse the entire input and IDs after a lost response. Observation records a proposal without starting. Startup receipt recovery never substitutes another account or model. Does not fork native sessions.",
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
            input.preview
              ? { _tag: "preview", request: input.request }
              : { _tag: "allocate", request: input.request },
          )
          .pipe(
            Effect.flatMap((response) =>
              response.result
                ? Effect.succeed(response.result)
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
