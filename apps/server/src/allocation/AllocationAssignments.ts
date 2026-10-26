import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  AllocationError,
  AssignmentAssessment,
  RecommendationOverrides,
  WorkerRecommendation,
  ComputerAdviceHost,
  ProviderDriverKind,
  ProviderOptionSelection,
  ProviderInstanceId,
  type ProjectId,
  type ComputerPlacementRequest,
  type AllocationInventory,
  type AllocationStart,
  type AllocationStartResult,
  type AllocationRequest,
  type ModelRoutingDecision,
  CommandId,
  MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Allocation from "./ProviderAllocation.ts";
import * as Workers from "../orchestration/WorkerControls.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PeerLinks } from "../orchestration/PeerLinks.ts";
import {
  computerAdvice,
  compareRecommendation,
  MISSING_ASSESSMENT,
  missingOverridesMessage,
  profileLabel,
  type Dimension,
} from "./recommendation.ts";

/** `t3_worker_spawn` input: the worker plus the master's assessment and override reasons. */
export const ManagedSpawnInput = Schema.Struct({
  ...Workers.RemoteSpawnInput.fields,
  assessment: Schema.optional(AssignmentAssessment),
  overrides: Schema.optional(RecommendationOverrides),
});
export const ManagedSpawnResult = Schema.Struct({
  ...Workers.WorkerResult.fields,
  recommendation: Schema.optional(WorkerRecommendation),
});
/** Stored with each worker creation; the start/spawn response carries only `recommendation`. */
const StoredRecommendation = Schema.Struct({
  recommendation: WorkerRecommendation,
  computers: Schema.Array(ComputerAdviceHost),
  /** The exact request a start resolved, so a retry repeats it. */
  request: Schema.optional(
    Schema.Struct({
      driver: ProviderDriverKind,
      model: Schema.String,
      options: Schema.Array(ProviderOptionSelection),
    }),
  ),
});
type StoredRecommendation = typeof StoredRecommendation.Type;
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredRecommendation));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredRecommendation));
const intentOf = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(stableStringify(value)).digest("hex");
const ADVICE_DEADLINE = "20 seconds";
const FORK_CONTINUITY = "Fork keeps the source session's account and model for native continuity.";

export class AllocationAssignments extends Context.Service<
  AllocationAssignments,
  {
    readonly start: (
      input: AllocationStart,
      owner?: ThreadId,
    ) => Effect.Effect<AllocationStartResult, AllocationError>;
    /** Creates a fork or legacy fresh worker after recording its recommendation. */
    readonly spawn: (
      owner: ThreadId,
      input: typeof ManagedSpawnInput.Type,
    ) => Effect.Effect<typeof ManagedSpawnResult.Type, Workers.WorkerError>;
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
  const now = Clock.currentTimeMillis.pipe(
    Effect.map((n) => DateTime.formatIso(DateTime.makeUnsafe(n))),
  );
  const persistence = () =>
    new AllocationError({
      code: "persistence",
      detail: "Could not access the worker recommendation.",
    });
  const readStored = (threadId: string) =>
    sql<{
      intent: string;
      record_json: string;
    }>`SELECT intent, record_json FROM worker_recommendations WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(persistence),
    );
  /** Keeps the first record once a worker exists; the worker itself rejects changed input. */
  const saveStored = (threadId: string, intent: string, stored: StoredRecommendation) =>
    Effect.gen(function* () {
      const prior = yield* readStored(threadId);
      if (prior?.intent === intent) return;
      if (prior && (yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId}`).length)
        return;
      yield* sql`INSERT INTO worker_recommendations (thread_id, intent, record_json, created_at)
        VALUES (${threadId}, ${intent}, ${encodeStored(stored)}, ${stored.recommendation.at})
        ON CONFLICT(thread_id) DO UPDATE SET intent = excluded.intent,
          record_json = excluded.record_json, created_at = excluded.created_at`;
    }).pipe(Effect.mapError(persistence));
  /** Placement matches checkouts by the project when it can; an unknown project only loses that. */
  const placeAdvice = (request: ComputerPlacementRequest, projectId?: ProjectId) =>
    projectId
      ? allocation
          .place({ ...request, projectId })
          .pipe(Effect.catch(() => allocation.place(request)))
      : allocation.place(request);
  /**
   * Runs all three recommendations: the table's model/effort and allocation's account for
   * that profile (one model preview), and computer placement read on this server from every
   * linked computer.
   * Each degrades to a recorded reason; none blocks a start.
   */
  const advise = Effect.fn("AllocationAssignments.advise")(function* (input: {
    readonly environment: string;
    readonly threadId: ThreadId;
    readonly assignmentId: string;
    readonly assessment: AssignmentAssessment;
    readonly drivers?: readonly ProviderDriverKind[] | undefined;
    readonly instanceId?: string | undefined;
    readonly model?: string | undefined;
    /** A project on this computer, so placement can find the same checkout elsewhere. */
    readonly projectId?: ProjectId | undefined;
  }) {
    const preview = (environmentId: string, drivers: readonly ProviderDriverKind[]) =>
      allocation
        .execute({
          _tag: "modelPreview",
          request: {
            selection: "automatic",
            assignmentId: `${input.assignmentId}:recommendation`,
            environmentId,
            threadId: input.threadId,
            assessment: input.assessment,
            allowedDrivers: drivers,
          },
        })
        .pipe(
          Effect.flatMap((response) =>
            response.selection
              ? Effect.succeed(response.selection)
              : Effect.fail(new AllocationError({ code: "invalid", detail: "No decision." })),
          ),
          Effect.result,
        );
    const [read, early] = yield* Effect.all(
      [
        placeAdvice(
          {
            ...(input.drivers?.length === 1 ? { driver: input.drivers[0] } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.instanceId ? { instanceId: ProviderInstanceId.make(input.instanceId) } : {}),
          },
          input.projectId,
        ).pipe(
          // Placement gives each computer one peer deadline; never hold a start much longer.
          Effect.timeoutOrElse({
            duration: ADVICE_DEADLINE,
            orElse: () =>
              Effect.fail(
                new AllocationError({ code: "unavailable", detail: "no answer within 20 s." }),
              ),
          }),
          Effect.result,
        ),
        input.drivers ? preview(input.environment, input.drivers) : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    );
    const inventories: readonly AllocationInventory[] = Result.isSuccess(read)
      ? read.success.inventories
      : [];
    const environment = input.environment.toLowerCase();
    const environmentId =
      inventories.find(
        (i) =>
          i.environmentId === input.environment ||
          (i.environmentLabel ?? i.environmentId).toLowerCase() === environment,
      )?.environmentId ?? input.environment;
    const driver =
      input.drivers?.length === 1
        ? input.drivers[0]
        : inventories
            .flatMap((i) => i.accounts)
            .find((a) => a.environmentId === environmentId && a.instanceId === input.instanceId)
            ?.driver;
    const selected = early ?? (driver ? yield* preview(environmentId, [driver]) : undefined);
    const selection = selected && Result.isSuccess(selected) ? selected.success : undefined;
    const profile =
      selection?.allocation?.decision.request ?? selection?.profiles.find((p) => p.eligible);
    const reasons = (list: readonly string[] | undefined) => list?.join(" ") || undefined;
    const unavailable = !selected
      ? `The provider of account ${input.instanceId ?? "(none)"} could not be found on ${environmentId}.`
      : Result.isFailure(selected)
        ? `Recommendation unavailable: ${selected.failure.message}`
        : undefined;
    return {
      environmentId,
      driver,
      selection,
      model: profile
        ? { ...profile, label: profileLabel(profile.driver, profile.model, profile.options) }
        : undefined,
      modelUnavailable: unavailable ?? reasons(selection?.reasons) ?? "No table profile applies.",
      account: selection?.allocation?.decision.selectedInstanceId ?? undefined,
      accountUnavailable:
        unavailable ??
        reasons(selection?.allocation?.decision.reasons) ??
        reasons(selection?.reasons) ??
        "No account is available for the recommended profile.",
      computers: Result.isSuccess(read) ? computerAdvice(read.success.placement) : undefined,
      computersUnavailable: Result.isFailure(read)
        ? `Advice unavailable: ${read.failure.message}`
        : undefined,
    };
  });
  type Advice = Effect.Success<ReturnType<typeof advise>>;
  const compare = (
    advice: Advice,
    chosen: Record<
      "model" | "account" | "computer",
      Omit<Dimension, "recommended" | "unavailable">
    >,
    context: {
      readonly at: string;
      readonly assessment: AssignmentAssessment;
      readonly overrides?: RecommendationOverrides | undefined;
      readonly automatic?: RecommendationOverrides | undefined;
      readonly warnings?: readonly string[];
    },
  ) =>
    compareRecommendation({
      ...context,
      model: {
        ...chosen.model,
        recommended: advice.model?.label ?? null,
        unavailable: advice.modelUnavailable,
      },
      account: {
        ...chosen.account,
        recommended: advice.account ?? null,
        unavailable: advice.accountUnavailable,
      },
      computer: {
        ...chosen.computer,
        recommended: advice.computers?.recommendedEnvironmentId ?? null,
        unavailable:
          advice.computersUnavailable ?? "Advice unavailable: no connected computer is reachable.",
      },
      warnings: [
        ...(context.warnings ??
          advice.selection?.allocation?.decision.candidates.find(
            (c) => c.instanceId === chosen.account.chosen,
          )?.warnings ??
          []),
        ...(advice.computers?.hosts.find((h) => h.environmentId === chosen.computer.chosen)
          ?.warnings ?? []),
      ],
    });
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
      const managed = raw.kind === "worker";
      const automatic = raw.request.selection === "automatic" ? raw.request : undefined;
      const assessment = automatic?.assessment ?? raw.assessment;
      if (managed && !assessment) return yield* invalid(MISSING_ASSESSMENT);
      if (
        automatic &&
        raw.assessment &&
        stableStringify(raw.assessment) !== stableStringify(automatic.assessment)
      )
        return yield* invalid(
          "assessment and request.assessment differ. Give the assessment once, in request.assessment.",
        );
      // Hash the complete start intent, including the authenticated owner. Prompt
      // bodies never enter allocation logs or replay snapshots.
      const startIntent = intentOf({ input: raw, owner: owner ?? null });
      const prior = managed ? yield* readStored(raw.request.threadId) : undefined;
      const reused = prior?.intent === startIntent ? decodeStored(prior.record_json) : undefined;
      const advice =
        managed && assessment && !reused
          ? yield* advise({
              environment: raw.request.environmentId,
              ...(raw.request.environmentId === local.environmentId
                ? { projectId: raw.projectId }
                : {}),
              threadId: raw.request.threadId,
              assignmentId: raw.request.assignmentId,
              assessment,
              drivers:
                raw.request.selection === "automatic"
                  ? raw.request.allowedDrivers
                  : [raw.request.driver],
              instanceId: raw.request.explicitInstanceId,
              model:
                raw.request.selection === "automatic"
                  ? raw.request.override?.model
                  : raw.request.model,
            })
          : undefined;
      let routed = raw.request;
      // A model-only pin takes the table's effort, resolved here so older coordinators
      // still receive the exact override they understand.
      if (automatic?.override && !automatic.override.options) {
        const override = automatic.override;
        const options =
          reused?.request?.options ??
          advice?.selection?.profiles.find((p) => p.driver === override.driver)?.options;
        if (options) routed = { ...automatic, override: { ...override, options } };
      }
      const pinnedModel =
        routed.selection === "automatic"
          ? routed.override &&
            profileLabel(
              routed.override.driver,
              routed.override.model,
              routed.override.options ?? [],
            )
          : profileLabel(routed.driver, routed.model, routed.options);
      const pins = (model: string, account: string) => ({
        model: { chosen: pinnedModel ?? model, pinned: pinnedModel !== undefined },
        account: {
          chosen: raw.request.explicitInstanceId ?? account,
          pinned: raw.request.explicitInstanceId !== undefined,
        },
        computer: { chosen: raw.request.environmentId, pinned: true },
      });
      const context = assessment && {
        at: yield* now,
        assessment,
        overrides: raw.overrides,
      };
      if (advice && context) {
        const { missing } = compare(
          advice,
          pins(advice.model?.label ?? "", advice.account ?? ""),
          context,
        );
        if (missing.length) return yield* invalid(missingOverridesMessage(missing));
      }
      let selectionDecision: ModelRoutingDecision | undefined;
      let request: AllocationRequest;
      if (routed.selection === "automatic") {
        const response = yield* allocation.execute({ _tag: "modelAllocate", request: routed });
        selectionDecision = response.selection;
        if (!selectionDecision) return yield* invalid("Model selection returned no decision.");
        if (!selectionDecision.allocation)
          return {
            allocation: selectionDecision.allocation,
            selection: selectionDecision,
            ...(advice && context
              ? {
                  recommendation: compare(advice, pins("(none)", "(none)"), context).recommendation,
                }
              : {}),
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
      const response = yield* allocation.execute({ _tag: "allocate", request: input.request });
      const result = response.result;
      if (!result) return yield* invalid("Allocation returned no decision.");
      const chosenModel = profileLabel(request.driver, request.model, request.options);
      if (!result.reservation || !result.decision.selectedInstanceId)
        return {
          allocation: result,
          ...(selectionDecision ? { selection: selectionDecision } : {}),
          ...(advice && context
            ? {
                recommendation: compare(advice, pins(chosenModel, "(none)"), context)
                  .recommendation,
              }
            : {}),
          threadId: input.request.threadId,
          state: "unavailable" as const,
        };
      const reservation = result.reservation;
      const stored =
        reused ??
        (advice && context
          ? {
              recommendation: compare(advice, pins(chosenModel, reservation.instanceId), {
                ...context,
                warnings:
                  result.decision.candidates.find((c) => c.instanceId === reservation.instanceId)
                    ?.warnings ?? [],
              }).recommendation,
              computers: advice.computers?.hosts ?? [],
              request: { driver: request.driver, model: request.model, options: request.options },
            }
          : undefined);
      if (stored) yield* saveStored(input.request.threadId, startIntent, stored);
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
        ...(stored ? { recommendation: stored.recommendation } : {}),
        threadId: input.request.threadId,
        state: "submitted" as const,
      };
    }, starts.withPermit),
    spawn: Effect.fn("AllocationAssignments.spawn")(
      function* (owner, input) {
        const { assessment, overrides, ...spawnInput } = input;
        if (!assessment) return yield* new Workers.WorkerError({ message: MISSING_ASSESSMENT });
        const intent = intentOf({ spawn: input, owner });
        const prior = yield* readStored(input.threadId);
        let stored = prior?.intent === intent ? decodeStored(prior.record_json) : undefined;
        if (!stored) {
          const advice = yield* advise({
            environment: input.environment ?? local.environmentId,
            ...(input.environment === undefined && input.projectId
              ? { projectId: input.projectId }
              : {}),
            threadId: input.threadId,
            assignmentId: `spawn:${input.threadId}`,
            assessment,
            instanceId: input.modelSelection.instanceId,
            model: input.modelSelection.model,
          });
          const fork = input.sourceThreadId !== undefined;
          const { recommendation, missing } = compare(
            advice,
            {
              model: {
                chosen: profileLabel(
                  advice.driver ?? "",
                  input.modelSelection.model,
                  input.modelSelection.options ?? [],
                ),
                pinned: true,
              },
              account: { chosen: input.modelSelection.instanceId, pinned: true },
              computer: { chosen: advice.environmentId, pinned: true },
            },
            {
              at: yield* now,
              assessment,
              overrides,
              ...(fork
                ? {
                    automatic: {
                      model: FORK_CONTINUITY,
                      account: FORK_CONTINUITY,
                      computer: "Fork runs on the source session's computer.",
                    },
                  }
                : {}),
            },
          );
          if (missing.length)
            return yield* new Workers.WorkerError({ message: missingOverridesMessage(missing) });
          stored = { recommendation, computers: advice.computers?.hosts ?? [] };
          yield* saveStored(input.threadId, intent, stored);
        }
        const worker = yield* workers.spawn(owner, spawnInput);
        return { ...worker, recommendation: stored.recommendation };
      },
      Effect.catchTag("AllocationError", (error) =>
        Effect.fail(new Workers.WorkerError({ message: error.detail })),
      ),
    ),
  });
});
export const layer = Layer.effect(AllocationAssignments, make);
