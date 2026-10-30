import {
  AllocationError,
  compactAllocationStart,
  type AllocationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AllocationToolkit } from "./tools.ts";

const caller = (tool: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, tool)),
    Effect.map((scope) => scope.thread.threadId),
  );

const missing = (what: string) =>
  new AllocationError({ code: "invalid", detail: `Missing ${what}.` });

export const layer = McpToolAccess.toLayer(AllocationToolkit, {
  t3_recommend_computer: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const allocation = yield* Allocation.ProviderAllocation;
      const response = yield* allocation.execute({ _tag: "placement", request: input });
      return response.placement ?? (yield* missing("placement result"));
    }),
  ),
  t3_allocate_account: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const allocation = yield* Allocation.ProviderAllocation;
      const operation: AllocationOperation =
        input.request.selection === "automatic"
          ? input.preview
            ? { _tag: "modelPreview", request: input.request }
            : { _tag: "modelAllocate", request: input.request }
          : input.preview
            ? { _tag: "preview", request: input.request }
            : { _tag: "allocate", request: input.request };
      const response = yield* allocation.execute(operation);
      return response.selection ?? response.result ?? (yield* missing("allocation result"));
    }),
  ),
  t3_start_allocated_assignment: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const assignments = yield* Assignments.AllocationAssignments;
      const started = yield* assignments.start(
        input,
        yield* caller("t3_start_allocated_assignment"),
      );
      return compactAllocationStart(started);
    }),
  ),
});
