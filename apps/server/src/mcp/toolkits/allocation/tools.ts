import {
  AllocationError,
  AllocationRequest,
  AllocationResult,
  AllocationStart,
  AllocationWorkerStartResult,
  ComputerPlacement,
  ComputerPlacementRequest,
  MODEL_SCORING_RUBRIC,
  ModelRoutingDecision,
  ModelRoutingRequest,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const failure = Schema.Union([AllocationError, OrchestratorMcpFailure]);
const common = {
  failure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const recommendComputer = Tool.make("t3_recommend_computer", {
  ...common,
  description:
    "Compare ALL connected computers (this one and every linked peer) for a new worker using fresh CPU, memory, work-disk and job telemetry, and say why each ranks where it does. Call it before choosing an execution environment when the user did not name a computer. Optional needs (memoryBytes, cpuThreads, diskBytes as extra peak load; os for a native runtime), projectId (finds the same repository's checkout and project ID on each computer), and driver/model/instanceId (the provider runtime the worker needs) refine the order; an environmentId the user already chose is always the recommendedEnvironmentId, even when it is offline or short (null when it is not connected), reported with its own warnings; a better computer is only described in reasons, never put in its place. Every computer is listed with its reading age and state (fresh, stale, unknown, offline); unknown or offline is never zero, and a computer that does not answer is listed offline after about 15 seconds. Advice only: it reserves nothing and never blocks t3_allocate_account or t3_start_allocated_assignment, so quota and resource forecasts are not an admission veto. Use the returned environmentId and that computer's project ID with those tools, keeping the exact model, options and account. It is a first-pass estimate, not a reservation; heavy work should still be checked with the workstation's own capacity tool on the chosen computer.",
  parameters: ComputerPlacementRequest,
  success: ComputerPlacement,
  dependencies: [...common.dependencies, Allocation.ProviderAllocation],
})
  .annotate(Tool.Title, "Recommend a computer")
  .annotate(Tool.Readonly, true);
const allocate = Tool.make("t3_allocate_account", {
  ...common,
  description:
    "Recommend compatible accounts and profiles with visible quota, pacing and load warnings. The master decides; forecasts and historical rejection projections never veto managed startup. Supply stable assignmentId/threadId and exact execution environment (when the user named no computer, choose it first with t3_recommend_computer). preview=true recommends without reserving or starting; otherwise records accounting for the proposed account. For model recommendations use selection=automatic with allowedDrivers and assessment; only configured capability alternatives apply, never quota-driven downgrades. Preview does not promise runtime success. t3_start_allocated_assignment runs every recommendation itself; preview is optional." +
    MODEL_SCORING_RUBRIC,
  parameters: Schema.Struct({
    request: Schema.Union([AllocationRequest, ModelRoutingRequest]),
    preview: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([AllocationResult, ModelRoutingDecision]),
  dependencies: [...common.dependencies, Allocation.ProviderAllocation],
}).annotate(Tool.Title, "Allocate an account");
const start = Tool.make("t3_start_allocated_assignment", {
  ...common,
  description:
    'Start a fresh managed worker (kind=worker). Always score the assignment: request.assessment with selection=automatic, otherwise top-level assessment. Every start runs all three recommendations, model/effort from the difficulty/stakes table, account from allocation and computer advice, and records them next to the actual choice. Pin only what the user specified: selection=automatic with explicitInstanceId pins the account, override {driver, model, reason} pins the model with the table\'s effort, and override options pin the effort too; selection=explicit pins model and options. environmentId is always the chosen computer; compare computers first with t3_recommend_computer unless the user named one. A pinned choice that differs from its recommendation needs overrides.model/account/computer with the reason, such as "user specified ES Opus xhigh"; the error lists what differs. Recommendations, quota, pacing and stale/unknown warnings are advice, never an admission veto; unavailable advice is recorded and the start proceeds. Actual unsupported requests, ownership conflicts, transport and provider errors remain errors. After an attempted startup, retry the entire input unchanged to prevent duplicates. Does not replace native sessions. Returns the chosen profile and a compact recommended-vs-chosen summary.' +
    MODEL_SCORING_RUBRIC,
  parameters: Schema.Struct({ ...AllocationStart.fields, kind: Schema.Literal("worker") }),
  success: AllocationWorkerStartResult,
  dependencies: [...common.dependencies, Assignments.AllocationAssignments],
}).annotate(Tool.Title, "Start an allocated worker");

export const AllocationToolkit = Toolkit.make(recommendComputer, allocate, start);
