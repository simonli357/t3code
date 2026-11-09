import {
  AllocationPolicyEdit,
  AllocationPolicyView,
  AllocationRequest,
  AllocationResult,
  AllocationStart,
  AllocationWorkerStartResult,
  compactAllocationStart,
  AllocationError,
  ComputerPlacement,
  ComputerPlacementRequest,
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

const recommendComputer = Tool.make("t3_recommend_computer", {
  description:
    "Compare ALL connected computers (this one and every linked peer) for a new worker using fresh CPU, memory, work-disk and job telemetry, and say why each ranks where it does. Call it before choosing an execution environment when the user did not name a computer. Optional needs (memoryBytes, cpuThreads, diskBytes as extra peak load; os for a native runtime), projectId (finds the same repository's checkout and project ID on each computer), and driver/model/instanceId (the provider runtime the worker needs) refine the order; an environmentId the user already chose is always the recommendedEnvironmentId, even when it is offline or short (null when it is not connected), reported with its own warnings; a better computer is only described in reasons, never put in its place. Every computer is listed with its reading age and state (fresh, stale, unknown, offline); unknown or offline is never zero, and a computer that does not answer is listed offline after about 15 seconds. Advice only: it reserves nothing and never blocks t3_allocate_account or t3_start_allocated_assignment, so quota and resource forecasts are not an admission veto. Use the returned environmentId and that computer's project ID with those tools, keeping the exact model, options and account. It is a first-pass estimate, not a reservation; heavy work should still be checked with the workstation's own capacity tool on the chosen computer.",
  parameters: ComputerPlacementRequest,
  success: ComputerPlacement,
  failure: AllocationError,
  dependencies: [Allocation.ProviderAllocation],
});
const allocate = Tool.make("t3_allocate_account", {
  description:
    "Recommend compatible accounts and profiles with visible quota, pacing and load warnings. The master decides; forecasts and historical rejection projections never veto managed startup. Supply stable assignmentId/threadId and exact execution environment (when the user named no computer, choose it first with t3_recommend_computer). preview=true recommends without reserving or starting; otherwise records accounting for the proposed account. For model recommendations use selection=automatic with allowedDrivers and assessment; only configured capability alternatives apply, never quota-driven downgrades. Preview does not promise runtime success. t3_start_allocated_assignment runs every recommendation itself; preview is optional." +
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
    "Start a fresh managed worker (kind=worker) on the recommendation: model/effort from the difficulty/stakes table, account from allocation and its account rules, and computer advice. Optional tier routine | normal | hard (default normal) picks the table entry; assessment {difficulty, difficultyReason, stakes, stakesReason} (request.assessment with selection=automatic) gives exact 0-10 scores instead. Pin only what the user specified: selection=automatic with explicitInstanceId pins the account, override {driver, model, reason} pins the model with the table's effort, and override options pin the effort too; selection=explicit pins model and options. environmentId is always the chosen computer; compare computers first with t3_recommend_computer unless the user named one. A pinned choice that differs from its recommendation starts as it is and the difference is recorded; overrides.model/account/computer may note why. A standing account preference belongs in t3_allocation_policy, not in each start. Quota, pacing and stale/unknown warnings are advice, never an admission veto; unavailable advice is recorded and the start proceeds. Refused: a pinned account that an account rule excludes or that is at its worker limit (the error names the rule), unsupported requests, ownership conflicts, transport and provider errors. After an attempted startup, retry the entire input unchanged to prevent duplicates. Does not replace native sessions. Returns the chosen profile and a compact recommended-vs-chosen summary.",
  parameters: Schema.Struct({ ...AllocationStart.fields, kind: Schema.Literal("worker") }),
  success: AllocationWorkerStartResult,
  failure: AllocationError,
  dependencies: [Assignments.AllocationAssignments, Invocation.McpInvocationContext],
});
const policy = Tool.make("t3_allocation_policy", {
  description:
    'Read or change the allocation policy that every worker start obeys, on the allocation coordinator. With no fields it returns the policy with accounts by label. When the user states a standing allocation rule, set it here once instead of repeating it per start. setRules entries are {account, kind, value?, expiresAt?, note?}: kind exclude keeps workers off the account ("never XL"); maxWorkers with value N allows at most N concurrent workers ("1 ARA max"); priority with value -100..100 (unset accounts are 0) prefers the higher account while it has quota headroom, and headroom orders equal priorities ("prefer ES"). Excluded accounts and accounts at their limit are never recommended, and a start pinned to one is refused. Give expiresAt (an ISO time) when the rule is for a duration; it then stops applying by itself. account is a display label such as ES or an instance ID and means that login on every computer. Each set replaces the account\'s rule of that kind; clearRules {account, kind?} removes them. curves {claude, codex, other} set pacing curves (null restores the default), setCaps/clearCaps set hard usage caps, and setOverrides/clearOverrides set a timed pacing override for one usage window (windowIds are listed per account). After "Policy changed", call again.',
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
      t3_recommend_computer: (input) =>
        allocation
          .execute({ _tag: "placement", request: input })
          .pipe(
            Effect.flatMap((response) =>
              response.placement
                ? Effect.succeed(response.placement)
                : Effect.fail(
                    new AllocationError({ code: "invalid", detail: "Missing placement result." }),
                  ),
            ),
          ),
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
      t3_allocation_policy: (input) => allocation.editPolicy(input),
      t3_start_allocated_assignment: (input) =>
        Effect.flatMap(Invocation.McpInvocationContext, (caller) =>
          assignments.start(input, caller.threadId).pipe(Effect.map(compactAllocationStart)),
        ),
    };
  }),
);
