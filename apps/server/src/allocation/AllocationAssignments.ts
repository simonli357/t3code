import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  AllocationError,
  type AllocationStart,
  type AllocationStartResult,
  type AllocationRequest,
  type ModelRoutingDecision,
  CommandId,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Allocation from "./ProviderAllocation.ts";
import * as Workers from "../orchestration/WorkerControls.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PeerLinks } from "../orchestration/PeerLinks.ts";

export class AllocationAssignments extends Context.Service<
  AllocationAssignments,
  {
    readonly start: (
      input: AllocationStart,
      owner?: ThreadId,
    ) => Effect.Effect<AllocationStartResult, AllocationError>;
  }
>()("t3/allocation/AllocationAssignments") {}

const make = Effect.gen(function* () {
  const allocation = yield* Allocation.ProviderAllocation;
  const workers = yield* Workers.WorkerControls;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const peers = yield* PeerLinks;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* peers.localEnvironment;
  const starts = yield* Semaphore.make(1);
  return AllocationAssignments.of({
    start: Effect.fn("AllocationAssignments.start")(function* (raw, owner) {
      const invalid = (detail: string) => new AllocationError({ code: "invalid", detail });
      if (raw.kind === "worker" && !owner)
        return yield* invalid("Managed allocation requires the authenticated master.");
      if (raw.kind === "session" && raw.request.environmentId !== local.environmentId)
        return yield* invalid("Create a human session through its execution environment.");
      if (raw.request.nativeInstanceId)
        return yield* invalid(
          "Fresh automatic startup cannot replace a bound native session. Use the explicit resume path.",
        );
      let selectionDecision: ModelRoutingDecision | undefined;
      let request: AllocationRequest;
      if (raw.request.selection === "automatic") {
        const response = yield* allocation.execute({ _tag: "modelAllocate", request: raw.request });
        selectionDecision = response.selection;
        if (!selectionDecision) return yield* invalid("Model selection returned no decision.");
        if (!selectionDecision.allocation)
          return {
            allocation: selectionDecision.allocation,
            selection: selectionDecision,
            threadId: raw.request.threadId,
            state: "unavailable" as const,
          };
        request = selectionDecision.allocation.decision.request;
      } else request = raw.request;
      const input = { ...raw, request };
      if (input.request.environmentId === local.environmentId) {
        const existing = yield* projection
          .getThreadShellById(input.request.threadId)
          .pipe(Effect.mapError(() => invalid("Could not inspect destination session.")));
        if (Option.isSome(existing) && input.kind === "session") {
          const receipt =
            yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id IN (${`allocation:${input.request.assignmentId}`}, ${`allocation:${input.request.assignmentId}:create`}) AND aggregate_id = ${input.request.threadId} AND status = 'accepted'`.pipe(
              Effect.mapError(() => invalid("Could not inspect allocation receipt.")),
            );
          if (!receipt.length)
            return yield* invalid(
              "This destination already has a session. Fresh allocation cannot replace native identity or an existing assignment.",
            );
        }
      }
      const response = yield* allocation.execute({ _tag: "allocate", request: input.request });
      const result = response.result;
      if (!result) return yield* invalid("Allocation returned no decision.");
      if (!result.reservation || !result.decision.selectedInstanceId)
        return {
          allocation: result,
          ...(selectionDecision ? { selection: selectionDecision } : {}),
          threadId: input.request.threadId,
          state: "unavailable" as const,
        };
      const reservation = result.reservation;
      // Hash the complete start intent, including the authenticated owner. Prompt
      // bodies never enter allocation logs or replay snapshots.
      const intentJson = stableStringify({
        input: raw,
        owner: owner ?? null,
      });
      const startIntent = NodeCrypto.createHash("sha256").update(intentJson).digest("hex");
      yield* allocation.execute({
        _tag: "lifecycle",
        input: {
          assignmentId: input.request.assignmentId,
          environmentId: input.request.environmentId,
          threadId: input.request.threadId,
          action: "start",
          expectedRequest: input.request,
          startIntent,
        },
      });
      const selection = {
        instanceId: reservation.instanceId,
        model: input.request.model,
        options: input.request.options,
      };
      const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const start =
        input.kind === "worker" && owner
          ? workers
              .spawn(owner, {
                allocation: { assignmentId: input.request.assignmentId, startIntent },
                threadId: input.request.threadId,
                projectId: input.projectId,
                title: input.title,
                prompt: input.prompt,
                modelSelection: selection,
                ...(input.request.environmentId !== local.environmentId
                  ? { environment: input.request.environmentId }
                  : {}),
              })
              .pipe(
                Effect.flatMap((worker) =>
                  worker.error || worker.latestRequest?.state === "error"
                    ? Effect.fail(
                        invalid("Worker startup failed. Inspect the worker's retained error."),
                      )
                    : Effect.void,
                ),
                Effect.mapError(() =>
                  invalid("Worker startup failed; inspect its durable receipt."),
                ),
              )
          : Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`allocation:${input.request.assignmentId}:create`),
                threadId: input.request.threadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: selection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              });
              yield* engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(`allocation:${input.request.assignmentId}`),
                threadId: input.request.threadId,
                message: {
                  messageId: MessageId.make(`allocation:${input.request.assignmentId}`),
                  role: "user",
                  text: input.prompt,
                  attachments: [],
                },
                modelSelection: selection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                createdAt,
              });
            }).pipe(
              Effect.asVoid,
              Effect.mapError(() =>
                invalid("Session startup failed; inspect its durable receipt."),
              ),
            );
      // Worker spawn and orchestration command IDs are themselves durable and
      // idempotent. A disconnect retains starting capacity until receipt recovery.
      yield* start.pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            if (input.kind !== "worker" || input.request.environmentId !== local.environmentId)
              return;
            // A local spawn that returned an error before its durable worker row
            // exists cannot have queued provider work. Remote errors remain uncertain.
            const rows =
              yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${input.request.threadId}`;
            if (!rows.length)
              yield* sql`INSERT OR IGNORE INTO provider_allocation_failed_starts (assignment_id, thread_id) VALUES (${input.request.assignmentId}, ${input.request.threadId})`;
          }).pipe(Effect.mapError(() => invalid("Could not preserve startup failure receipt."))),
        ),
        Effect.mapError(
          () =>
            new AllocationError({
              code: "unavailable",
              detail:
                "Startup did not confirm success. The same assignment can reconcile its durable receipt; capacity remains protected.",
            }),
        ),
      );
      return {
        allocation: result,
        ...(selectionDecision ? { selection: selectionDecision } : {}),
        threadId: input.request.threadId,
        state: "submitted" as const,
      };
    }, starts.withPermit),
  });
});
export const layer = Layer.effect(AllocationAssignments, make);
