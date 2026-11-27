import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  WORKER_ACCOUNT_DISABLED_REASON,
  AllocationError,
  MAX_START_SETTLE_MINUTES,
  ThreadId,
  WorkerRecommendation,
  ProviderDriverKind,
  ProviderOptionSelection,
  profileLabel,
  workerChoice,
  workerChoiceRequest,
  type AllocationDecision,
  type AllocationStart,
  type AllocationStartResult,
  type AllocationRequest,
  type ModelRoutingDecision,
  type WorkerChoice,
  type WorkerChoiceInput,
  type WorkerStartInput,
  type WorkerStartResult,
  CommandId,
  MessageId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
import type { PlacedStart } from "./placement.ts";

/** Stored with each worker start. Records from before smart allocation hold more; it is ignored. */
const StoredRecommendation = Schema.Struct({
  recommendation: WorkerRecommendation,
  /** The exact request a start resolved. */
  request: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
    }),
  ),
});
type StoredRecommendation = typeof StoredRecommendation.Type;
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredRecommendation));
const intentOf = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");

export class AllocationAssignments extends Context.Service<
  AllocationAssignments,
  {
    readonly start: (
      input: AllocationStart,
      owner?: ThreadId,
    ) => Effect.Effect<AllocationStartResult, AllocationError>;
    /**
     * Starts a master's worker. Without `environmentId` the server chooses the computer by
     * room; `projectId` is the master's own and is replaced by the project's ID there.
     */
    readonly startWorker: (
      input: WorkerStartInput,
      owner: ThreadId,
    ) => Effect.Effect<WorkerStartResult, AllocationError>;
    /** What `startWorker` would choose, without reserving or starting anything. */
    readonly previewWorker: (
      input: WorkerChoiceInput,
      owner: ThreadId,
    ) => Effect.Effect<WorkerChoice, AllocationError>;
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
  /** Keeps the first record once a worker exists; the worker itself rejects changed input. */
  const saveStored = (threadId: string, intent: string, stored: StoredRecommendation) =>
    Effect.gen(function* () {
      const prior = (yield* sql<{
        intent: string;
      }>`SELECT intent FROM worker_recommendations WHERE thread_id = ${threadId}`)[0];
      if (prior?.intent === intent) return;
      if (prior && (yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId}`).length)
        return;
      yield* sql`INSERT INTO worker_recommendations (thread_id, intent, record_json, created_at)
        VALUES (${threadId}, ${intent}, ${encodeStored(stored)}, ${stored.recommendation.at})
        ON CONFLICT(thread_id) DO UPDATE SET intent = excluded.intent,
          record_json = excluded.record_json, created_at = excluded.created_at`;
    }).pipe(
      Effect.mapError(
        () =>
          new AllocationError({
            code: "persistence",
            detail: "Could not access the worker recommendation.",
          }),
      ),
    );
  /** What the table and the ranking give for these scores when nothing is pinned. */
  const unpinned = (selection: ModelRoutingDecision) => {
    const { explicitInstanceId: _account, override: _model, ...request } = selection.request;
    return allocation
      .execute({
        _tag: "modelPreview",
        request: { ...request, assignmentId: `${request.assignmentId}:recommendation` },
      })
      .pipe(
        Effect.map((response) => response.selection),
        Effect.catch(() => Effect.succeed(undefined)),
      );
  };
  const label = (request: Pick<AllocationRequest, "driver" | "model" | "options">) =>
    profileLabel(request.driver, request.model, request.options);
  const invalid = (detail: string) => new AllocationError({ code: "invalid", detail });
  /**
   * Worker starts this computer placed, by assignment. A computer reports a worker only once
   * its session exists there, so the next choice counts these too, and a retry keeps its computer.
   */
  const placed = new Map<string, PlacedStart>();
  /**
   * The computer and the choice a worker would get there. An automatic choice takes the first
   * computer, best room first, where an account can start the worker.
   */
  const settle = Effect.fn("AllocationAssignments.settle")(function* (
    input: WorkerChoiceInput,
    owner: ThreadId,
    worker?: { readonly assignmentId: string; readonly threadId: ThreadId },
  ) {
    const at = yield* Clock.currentTimeMillis;
    for (const [assignmentId, start] of placed)
      if (at - Date.parse(start.at) > MAX_START_SETTLE_MINUTES * 60_000)
        placed.delete(assignmentId);
    // A retry of a start stays on the computer its first attempt chose.
    const retained =
      worker && input.environmentId === undefined
        ? (placed.get(worker.assignmentId)?.environmentId ??
          (yield* sql<{
            environment_id: string | null;
          }>`SELECT json_extract(plan_json, '$.environmentId') AS environment_id FROM custom_workers WHERE thread_id = ${worker.threadId}`.pipe(
            Effect.map((rows) =>
              rows[0] ? (rows[0].environment_id ?? local.environmentId) : undefined,
            ),
            Effect.mapError(() => invalid("Could not inspect the worker's earlier start.")),
          )))
        : undefined;
    const placement = yield* allocation.place({
      projectId: input.projectId,
      environmentId: input.environmentId ?? retained,
      ...(retained ? { namedBecause: "this assignment already started there" } : {}),
      threadId: worker?.threadId,
      placed: [...placed.values()],
    });
    const best = placement.ranked[0];
    if (!best)
      return yield* invalid(placement.refusal ?? "No computer could be chosen for this worker.");
    const preview = (environmentId: string) =>
      allocation
        .execute({
          _tag: "modelPreview",
          request: workerChoiceRequest({
            ...input,
            environmentId,
            assignmentId: `preview:${owner}`,
            threadId: ThreadId.make(`preview:${owner}`),
          }),
        })
        .pipe(Effect.map((response) => response.selection));
    const startable = (selection: ModelRoutingDecision | undefined) =>
      selection?.allocation?.decision.selectedInstanceId !== undefined &&
      selection.allocation.decision.selectedInstanceId !== null;
    // Only the last candidate's failure is the caller's: an earlier one just moves on.
    const first = yield* placement.ranked.length > 1
      ? preview(best.environmentId).pipe(Effect.orElseSucceed(() => undefined))
      : preview(best.environmentId);
    let computer = best;
    let selection = first;
    if (!startable(first))
      for (const candidate of placement.ranked.slice(1)) {
        const next = yield* preview(candidate.environmentId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        if (!startable(next)) continue;
        computer = candidate;
        selection = next;
        break;
      }
    selection ??= yield* preview(best.environmentId);
    if (!selection) return yield* invalid("Model selection returned no decision.");
    return {
      selection,
      computer,
      computers: placement.lines,
      notes: [
        ...(computer === best
          ? []
          : [
              `${best.label} has the most room, but no account there can start this worker (${first?.reasons[0] ?? "it could not be read"}); ${computer.label} is used instead.`,
            ]),
        ...placement.notes,
      ],
    };
  });
  /**
   * One choice and its start. A local spawn that refuses the reserved account because it was
   * switched off after the choice gives the reservation back and answers `rechoose`.
   */
  const startOnce = Effect.fn("AllocationAssignments.startOnce")(function* (
    raw: AllocationStart,
    owner: ThreadId | undefined,
    rechosen: boolean,
    computerSelection?: AllocationDecision["computerSelection"],
  ) {
    if (raw.kind === "worker" && !owner)
      return yield* invalid("Managed allocation requires the authenticated master.");
    if (raw.kind === "session" && raw.request.environmentId !== local.environmentId)
      return yield* invalid("Create a human session through its execution environment.");
    if (raw.request.nativeInstanceId)
      return yield* invalid(
        "Fresh automatic startup cannot replace a bound native session. Use the explicit resume path.",
      );
    const managed = raw.kind === "worker";
    // Hash the complete start intent, including the authenticated owner. Prompt
    // bodies never enter allocation logs or replay snapshots.
    const startIntent = intentOf({ input: raw, owner: owner ?? null });
    let routed = { ...raw.request };
    if (managed) delete routed.kind;
    else routed = { ...routed, kind: "session" };
    let selectionDecision: ModelRoutingDecision | undefined;
    let request: AllocationRequest;
    if (routed.selection === "automatic") {
      const response = yield* allocation.execute({
        _tag: "modelAllocate",
        request: routed,
        computerSelection,
      });
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
    } else request = routed;
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
    const response = yield* allocation.execute({
      _tag: "allocate",
      request: input.request,
      computerSelection,
    });
    const result = response.result;
    if (!result) return yield* invalid("Allocation returned no decision.");
    if (
      managed &&
      request.explicitInstanceId &&
      !result.decision.selectedInstanceId &&
      result.decision.reasons.includes(WORKER_ACCOUNT_DISABLED_REASON)
    )
      return yield* invalid(WORKER_ACCOUNT_DISABLED_REASON);
    if (!result.reservation || !result.decision.selectedInstanceId)
      return {
        allocation: result,
        ...(selectionDecision ? { selection: selectionDecision } : {}),
        threadId: input.request.threadId,
        state: "unavailable" as const,
      };
    const reservation = result.reservation;
    if (managed && selectionDecision) {
      const pinned =
        selectionDecision.request.explicitInstanceId !== undefined ||
        selectionDecision.request.override !== undefined;
      const own = pinned ? yield* unpinned(selectionDecision) : selectionDecision;
      const recommended = own?.allocation?.decision;
      yield* saveStored(input.request.threadId, startIntent, {
        recommendation: {
          at: selectionDecision.at,
          assessment: selectionDecision.request.assessment,
          model: {
            recommended: recommended ? label(own.wanted ?? recommended.request) : null,
            chosen: label(request),
          },
          account: {
            recommended: recommended?.selectedInstanceId ?? null,
            chosen: reservation.instanceId,
          },
        },
        request: { driver: request.driver, model: request.model, options: request.options },
      });
    }
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
    const start: Effect.Effect<void, Workers.WorkerError | AllocationError> =
      input.kind === "worker" && owner
        ? workers
            .spawn(owner, {
              allocation: { assignmentId: input.request.assignmentId, startIntent },
              threadId: input.request.threadId,
              projectId: input.projectId,
              title: input.title,
              prompt: input.prompt,
              modelSelection: selection,
              ...(selectionDecision?.startAt ? { startAt: selectionDecision.startAt } : {}),
              ...(input.request.environmentId !== local.environmentId
                ? { environment: input.request.environmentId }
                : {}),
            })
            .pipe(
              Effect.flatMap((worker) =>
                worker.error || worker.latestRequest?.state === "error"
                  ? Effect.fail(
                      new Workers.WorkerError({
                        message: "Worker startup failed. Inspect the worker's retained error.",
                      }),
                    )
                  : Effect.void,
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
            Effect.mapError(() => invalid("Session startup failed; inspect its durable receipt.")),
          );
    // Worker spawn and orchestration command IDs are themselves durable and
    // idempotent. A disconnect retains starting capacity until receipt recovery.
    const unconfirmed = new AllocationError({
      code: "unavailable",
      detail:
        "Startup did not confirm success. The same assignment can reconcile its durable receipt; capacity remains protected.",
    });
    const failure = yield* start.pipe(
      Effect.as(undefined),
      Effect.catch((cause) => Effect.succeed(cause)),
    );
    if (failure) {
      if (input.kind !== "worker") return yield* unconfirmed;
      const here = input.request.environmentId === local.environmentId;
      // A local spawn that returned an error before its durable worker row exists cannot have
      // queued provider work. Another computer proves the same with its typed refusal.
      const created = here
        ? (yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${input.request.threadId}`.pipe(
            Effect.mapError(() => invalid("Could not preserve startup failure receipt.")),
          )).length > 0
        : failure.code !== "allocation_start_rejected";
      if (created) return yield* unconfirmed;
      const accountOff =
        failure.message.includes(WORKER_ACCOUNT_DISABLED_REASON) ||
        failure.message.includes(Workers.PROVIDER_UNAVAILABLE_REASON);
      if (here && accountOff && !rechosen) {
        const reopened = yield* allocation
          .execute({
            _tag: "lifecycle",
            input: {
              assignmentId: input.request.assignmentId,
              environmentId: input.request.environmentId,
              threadId: input.request.threadId,
              action: "reopen",
              startIntent,
            },
          })
          .pipe(
            Effect.andThen(
              sql`DELETE FROM worker_recommendations WHERE thread_id = ${input.request.threadId}`,
            ),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (reopened) return { rechoose: reservation.instanceId, reason: failure.message };
      }
      if (here)
        yield* sql`INSERT OR IGNORE INTO provider_allocation_failed_starts (assignment_id, thread_id) VALUES (${input.request.assignmentId}, ${input.request.threadId})`.pipe(
          Effect.mapError(() => invalid("Could not preserve startup failure receipt.")),
        );
      return yield* invalid(
        `No worker was created: ${failure.message.replace(/\.$/, "")}. This assignment is finished; start again with a new assignmentId and threadId.`,
      );
    }
    return {
      allocation: result,
      ...(selectionDecision ? { selection: selectionDecision } : {}),
      threadId: input.request.threadId,
      state: "submitted" as const,
    };
  });
  const start = Effect.fn("AllocationAssignments.start")(function* (
    raw: AllocationStart,
    owner?: ThreadId,
    computerSelection?: AllocationDecision["computerSelection"],
  ) {
    const first = yield* startOnce(raw, owner, false, computerSelection);
    if (!("rechoose" in first)) return first;
    const second = yield* startOnce(raw, owner, true, computerSelection);
    // The second attempt never asks again.
    if ("rechoose" in second) return yield* invalid("The choice could not be made again.");
    const note = `${first.rechoose} was reserved for this start and then switched off (${first.reason}); its reservation was released and the choice made again.`;
    return {
      ...second,
      ...(second.selection
        ? { selection: { ...second.selection, notes: [note, ...(second.selection.notes ?? [])] } }
        : {}),
    };
  });
  return AllocationAssignments.of({
    start: (raw, owner) => starts.withPermit(start(raw, owner)),
    previewWorker: (input, owner) =>
      settle(input, owner).pipe(
        Effect.map(({ selection, ...placement }) => workerChoice(selection, placement)),
      ),
    // One start at a time, so the next one sees where this one went.
    startWorker: ({ assignmentId, threadId, title, prompt, ...choice }, owner) =>
      Effect.gen(function* () {
        const placement = yield* settle(choice, owner, { assignmentId, threadId });
        const { computer } = placement;
        placed.set(assignmentId, {
          environmentId: computer.environmentId,
          threadId,
          at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        });
        const result = yield* start(
          {
            kind: "worker",
            projectId: computer.projectId ?? choice.projectId,
            title,
            prompt,
            request: workerChoiceRequest({
              ...choice,
              environmentId: computer.environmentId,
              assignmentId,
              threadId,
            }),
          },
          owner,
          choice.environmentId === undefined ? "automatic" : "named",
        );
        // No worker was created, so it takes no room.
        if (result.state !== "submitted") placed.delete(assignmentId);
        if (!result.selection) return yield* invalid("Missing allocation result.");
        return {
          threadId: result.threadId,
          started: result.state === "submitted",
          ...workerChoice(result.selection, placement),
        };
      }).pipe(starts.withPermit),
  });
});
export const layer = Layer.effect(AllocationAssignments, make);
