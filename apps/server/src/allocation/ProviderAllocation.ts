import {
  AllocationError,
  AllocationInventory as AllocationInventorySchema,
  AssignmentAssessment,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ThreadId,
  WORKER_ACCOUNT_DISABLED_REASON,
  type AllocationInventory,
  type AllocationOperation,
  type AllocationPolicy,
  type AllocationRequest,
  type AllocationResponse,
  type AllocationSnapshot,
  type ComputerPlacement,
  type ComputerPlacementRequest,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerRequests from "../peer/PeerRequests.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import * as Store from "./AllocationStore.ts";
import { decideAllocation } from "./decision.ts";
import { allocationInventory, type AllocationThread } from "./inventory.ts";
import { modelCandidates } from "./modelDecision.ts";
import { recommendPlacement } from "./placement.ts";

const unavailable = (cause?: unknown) =>
  new AllocationError({
    code: "unavailable",
    detail:
      cause instanceof Error && cause.message
        ? cause.message
        : "Allocation could not read this computer's accounts or sessions.",
  });

const NO_MEASUREMENTS: UsageMeasurementsReport = {
  observedAt: "1970-01-01T00:00:00.000Z",
  monitoredInstanceIds: [],
  retentionDays: 0,
  persistenceError: null,
  accounts: [],
  turns: [],
  totalMatchingTurns: 0,
  profiles: [],
  limitations: [],
};

const decodeInventory = Schema.decodeUnknownEffect(AllocationInventorySchema);
/** Each linked computer gets this long to describe itself before advice goes on without it. */
const PEER_INVENTORY_TIMEOUT = Duration.seconds(15);

const decodeAssessment = Schema.decodeUnknownEffect(Schema.fromJsonString(AssignmentAssessment));
const decodeSelection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      instanceId: Schema.String,
      model: Schema.String,
      options: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);

/** Where an allocation sees a thread: the account it runs on and whether it is using it. */
const allocationThread = (shell: OrchestrationV2ThreadShell): AllocationThread => ({
  id: shell.id,
  instanceId: shell.providerInstanceId,
  model: shell.modelSelection.model,
  options: shell.modelSelection.options ?? [],
  state:
    shell.status === "running" || shell.status === "waiting"
      ? "running"
      : shell.status === "starting" || shell.status === "preparing"
        ? "starting"
        : shell.status === "failed"
          ? "failed"
          : "idle",
  lastError: shell.lastError ?? null,
  lastErrorClass: shell.lastErrorClass ?? null,
  updatedAt: DateTime.formatIso(shell.updatedAt),
  usageLimitResetAt: shell.usageLimitResetAt ?? null,
});

export class ProviderAllocation extends Context.Service<
  ProviderAllocation,
  {
    readonly execute: (
      operation: AllocationOperation,
    ) => Effect.Effect<AllocationResponse, AllocationError>;
    /** A local replacement with observed quota headroom; same profile and family first. */
    readonly replacement: (
      threadId: ThreadId,
      current: ModelSelection,
    ) => Effect.Effect<ModelSelection | null, AllocationError>;
    /** Computer advice and the inventories it ranked: this server's and each linked computer's. */
    readonly place: (request: ComputerPlacementRequest) => Effect.Effect<
      {
        readonly placement: ComputerPlacement;
        readonly inventories: readonly AllocationInventory[];
      },
      AllocationError
    >;
  }
>()("t3/allocation/ProviderAllocation") {}

const make = Effect.gen(function* () {
  const store = yield* Store.AllocationStore;
  const providers = yield* ProviderRegistry;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const peers = yield* Effect.serviceOption(PeerRequests.PeerRequests);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const localEnvironmentId = yield* environment.getEnvironmentId;
  const local = {
    environmentId: localEnvironmentId,
    label: (yield* environment.getDescriptor).label,
  };
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const inventory = Effect.fn("ProviderAllocation.inventory")(function* (
    request: AllocationRequest | undefined,
  ) {
    const shell = yield* threads.getShellSnapshot();
    const current = yield* settings.getSettings;
    // Look this up at call time. The measurement collector also reads this service's environment,
    // so making it a layer dependency here would create a needless initialization cycle.
    const measurements = yield* Effect.serviceOption(UsageMeasurements);
    const measurementReport = Option.isSome(measurements)
      ? yield* measurements.value.read({}).pipe(Effect.orElseSucceed(() => NO_MEASUREMENTS))
      : NO_MEASUREMENTS;
    const snapshot = allocationInventory({
      environmentId: local.environmentId,
      at: yield* now,
      providers: yield* providers.getProviders,
      workerDisabledInstanceIds: current.workerDisabledInstanceIds,
      threads: shell.threads.map(allocationThread),
      maxReadingAgeMinutes: (yield* store.policy).maxReadingAgeMinutes,
      measurements: measurementReport,
      ...(request ? { request } : {}),
    });
    // A worker that was assigned but has not started yet still holds its account.
    const pending = yield* sql<{
      thread_id: string;
      selection_json: string;
    }>`SELECT DISTINCT w.thread_id, json_extract(w.plan_json, '$.modelSelection') AS selection_json FROM custom_workers w JOIN custom_worker_jobs j ON j.worker_id = w.thread_id WHERE j.kind = 'work' AND j.state IN ('queued', 'submitted')`;
    const demand = [...snapshot.demand];
    for (const row of pending) {
      if (demand.some((d) => d.threadId === row.thread_id)) continue;
      const selection = yield* decodeSelection(row.selection_json);
      demand.push({
        environmentId: local.environmentId,
        threadId: ThreadId.make(row.thread_id),
        instanceId: selection.instanceId as ModelSelection["instanceId"],
        accountKey:
          snapshot.accounts.find((a) => a.instanceId === selection.instanceId)?.accountKey ?? null,
        model: selection.model,
        options: (selection.options ?? []) as ModelSelection["options"] & object,
        state: "pending",
      });
    }
    return {
      ...snapshot,
      maxActiveAgentSessions: current.maxActiveAgentSessions,
      environmentLabel: local.label,
      demand,
      coordinatorEnvironmentId: local.environmentId,
    } satisfies AllocationInventory;
  }, Effect.mapError(unavailable));

  /**
   * What each linked computer reports about its accounts and load. One that does not answer is an
   * offline entry, so advice ranks it last instead of waiting on it or dropping it silently.
   */
  const peerInventories = Effect.fn("ProviderAllocation.peerInventories")(function* () {
    if (Option.isNone(peers) || Option.isNone(links)) return [] as AllocationInventory[];
    const linked = yield* links.value.list.pipe(Effect.orElseSucceed(() => []));
    const at = yield* now;
    return yield* Effect.forEach(
      linked,
      (peer) =>
        peers.value
          .call(peer.environmentId, "allocationInventory", {}, PEER_INVENTORY_TIMEOUT)
          .pipe(
            Effect.flatMap((raw) => decodeInventory(raw)),
            Effect.flatMap((reported) =>
              reported.environmentId === peer.environmentId
                ? Effect.succeed({ ...reported, environmentLabel: peer.label })
                : Effect.fail(unavailable("The computer answered as a different environment.")),
            ),
            Effect.catch((cause): Effect.Effect<AllocationInventory> =>
              Effect.succeed({
                environmentId: peer.environmentId,
                environmentLabel: peer.label,
                observedAt: at,
                accounts: [],
                demand: [],
                complete: false,
                notices: [
                  `Could not read ${peer.label}: ${"detail" in cause ? cause.detail : cause.message}.`,
                ],
              }),
            ),
          ),
      { concurrency: "unbounded" },
    );
  });

  const replacement = Effect.fn("ProviderAllocation.replacement")(function* (
    threadId: ThreadId,
    current: ModelSelection,
  ) {
    const policy = yield* store.policy;
    const at = yield* now;
    const localInventory = yield* inventory(undefined);
    const currentAccount = localInventory.accounts.find((a) => a.instanceId === current.instanceId);
    const driver = currentAccount?.driver;
    if (driver !== "codex" && driver !== "claudeAgent") return null;
    // Unknown or expired readings cannot establish headroom for an automatic retry.
    const accounts = localInventory.accounts.filter(
      (a) =>
        a.available &&
        a.availableForWorkers !== false &&
        a.instanceId !== current.instanceId &&
        (!currentAccount?.accountKey || a.accountKey !== currentAccount.accountKey) &&
        a.windows.length > 0 &&
        a.windows.every(
          (w) =>
            w.usedPoints < 100 &&
            Date.parse(at) - Date.parse(w.checkedAt) <= policy.maxReadingAgeMinutes * 60_000 &&
            (w.resetsAt === null || w.resetsAt > at),
        ),
    );
    const inventories = [{ ...localInventory, accounts }];
    const base = {
      assignmentId: `usage-switch:${threadId}`,
      environmentId: local.environmentId,
      threadId,
    };
    const decide = (request: AllocationRequest) =>
      decideAllocation({
        at,
        policy,
        request,
        inventories,
        reservations: [],
        authorityAvailable: true,
      }).selectedInstanceId;
    const sameInstance = decide({
      ...base,
      driver,
      model: current.model,
      options: current.options ?? [],
    });
    if (sameInstance) return { ...current, instanceId: sameInstance };
    const rows = yield* sql<{
      assessment: string | null;
    }>`SELECT json_extract(record_json, '$.recommendation.assessment') AS assessment FROM worker_recommendations WHERE thread_id = ${threadId}`;
    // Workers without a recorded assessment use the middle routing-table cell.
    const assessment = rows[0]?.assessment
      ? yield* decodeAssessment(rows[0].assessment)
      : {
          difficulty: 5,
          stakes: 5,
          difficultyReason: "Usage recovery without a recorded assessment",
          stakesReason: "Usage recovery without a recorded assessment",
        };
    const modelPolicy = yield* store.modelPolicy;
    for (const family of [
      driver,
      ProviderDriverKind.make(driver === "codex" ? "claudeAgent" : "codex"),
    ]) {
      const candidates = modelCandidates(
        modelPolicy,
        { ...base, selection: "automatic", assessment, allowedDrivers: [family] },
        inventories,
      ).candidates;
      for (const { request } of candidates) {
        const instanceId = decide(request);
        if (instanceId) return { instanceId, model: request.model, options: request.options };
      }
    }
    return null;
  }, Effect.mapError(unavailable));

  /** What an allocation's startup did: its worker job, or its thread, tell whether capacity is free. */
  const probe = Effect.fn("ProviderAllocation.probe")(function* (
    threadId: ThreadId,
    assignmentId: string,
  ) {
    const failedStart =
      yield* sql`SELECT 1 FROM provider_allocation_failed_starts WHERE assignment_id = ${assignmentId} AND thread_id = ${threadId}`;
    if (failedStart.length) return { state: "terminal" as const };
    const jobs = yield* sql<{
      state: string;
    }>`SELECT state FROM custom_worker_jobs WHERE id = ${`spawn:${threadId}`} AND target_id = ${threadId} AND kind = 'work'`;
    if (jobs[0]?.state === "queued" || jobs[0]?.state === "submitted")
      return { state: "pending" as const };
    if (jobs[0] && ["completed", "error", "interrupted", "cancelled"].includes(jobs[0].state))
      return { state: "terminal" as const };
    const failed =
      yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId} AND state = 'error'`;
    if (failed.length) return { state: "terminal" as const };
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null) return { state: "unknown" as const };
    return allocationThread(thread).state === "running"
      ? { state: "running" as const }
      : allocationThread(thread).state === "starting"
        ? { state: "pending" as const }
        : { state: "unknown" as const };
  }, Effect.mapError(unavailable));

  const reconcile = Effect.fn("ProviderAllocation.reconcile")(function* (assignmentId?: string) {
    yield* store.expireUnused(yield* now);
    for (const r of yield* store.reservations) {
      // An unrelated uncertain startup keeps its demand; only a full inspection reconciles it.
      if (assignmentId !== undefined && r.assignmentId !== assignmentId) continue;
      if (r.state !== "starting" && r.state !== "consumed") continue;
      const state = yield* probe(r.request.threadId, r.assignmentId).pipe(
        Effect.orElseSucceed(() => ({ state: "unknown" as const })),
      );
      if (state.state === "terminal" || (state.state === "running" && r.state === "starting")) {
        yield* store.lifecycle(
          {
            assignmentId: r.assignmentId,
            environmentId: r.request.environmentId,
            threadId: r.request.threadId,
            action: state.state === "terminal" ? "release" : "consume",
          },
          yield* now,
        );
      }
    }
  });

  const place = Effect.fn("ProviderAllocation.place")(function* (
    request: ComputerPlacementRequest,
  ) {
    const policy = yield* store.policy;
    const inventories = [yield* inventory(undefined), ...(yield* peerInventories())];
    return {
      placement: recommendPlacement({ at: yield* now, policy, request, inventories }),
      inventories,
    };
  });

  const execute = Effect.fn("ProviderAllocation.execute")(function* (
    operation: AllocationOperation,
  ): Effect.fn.Return<AllocationResponse, AllocationError> {
    const policy = yield* store.policy;
    if (operation._tag === "caps") return { policy };
    if (operation._tag === "placement")
      return { placement: (yield* place(operation.request)).placement };
    if (operation._tag === "connections")
      return {
        connections: {
          coordinatorEnvironmentId: local.environmentId,
          environments: [
            local,
            ...(Option.isSome(links)
              ? yield* links.value.list.pipe(Effect.orElseSucceed(() => []))
              : []
            ).map((peer) => ({ environmentId: peer.environmentId, label: peer.label })),
          ],
        },
      };
    if (operation._tag === "connect")
      return yield* new AllocationError({
        code: "invalid",
        detail: "Allocation runs on this computer; linking another coordinator needs peer routing.",
      });
    if (operation._tag === "policy")
      return {
        policy: yield* store.savePolicy({
          ...operation.input,
          policy: { ...operation.input.policy, coordinatorEnvironmentId: local.environmentId },
        }),
      };
    if (
      operation._tag === "modelSnapshot" ||
      operation._tag === "modelPolicy" ||
      operation._tag === "modelRevert" ||
      operation._tag === "modelPreview" ||
      operation._tag === "modelAllocate"
    ) {
      const modelPolicy = yield* store.modelPolicy;
      const selecting = operation._tag === "modelPreview" || operation._tag === "modelAllocate";
      yield* reconcile(selecting ? operation.request.assignmentId : undefined);
      let inventories: AllocationInventory[] = [yield* inventory(undefined)];
      // A preview may rank accounts on linked computers; a reservation is only ever made here.
      if (operation._tag === "modelPreview") inventories.push(...(yield* peerInventories()));
      if (operation._tag === "modelSnapshot")
        return {
          modelSnapshot: {
            policy: modelPolicy,
            policies: yield* store.modelPolicies,
            history: yield* store.modelHistory,
            inventories,
            authorityAvailable: true,
          },
        };
      if (operation._tag === "modelPolicy" || operation._tag === "modelRevert")
        return {
          modelPolicy: yield* store.saveModelPolicy({
            expectedVersion: operation.expectedVersion,
            inventories,
            ...(operation._tag === "modelPolicy"
              ? { policy: operation.policy }
              : { revertVersion: operation.version }),
          }),
        };
      // Keep the measured profile uncertainty of each eligible family; catalog and quota
      // selection below still uses one shared snapshot.
      const effectiveModelPolicy =
        operation._tag === "modelPreview" ? (operation.policy ?? modelPolicy) : modelPolicy;
      const prior =
        operation._tag === "modelAllocate" || !operation.policy
          ? yield* store.modelDecisionById(operation.request.assignmentId)
          : undefined;
      const retained =
        prior &&
        Store.withoutAccountChoice(prior.request) === Store.withoutAccountChoice(operation.request)
          ? prior
          : undefined;
      for (const candidate of modelCandidates(
        effectiveModelPolicy,
        operation.request,
        inventories,
        retained,
      ).candidates) {
        const measured = [yield* inventory(candidate.request)];
        inventories = inventories.map((host) => ({
          ...host,
          accounts: host.accounts.map((account) => {
            const profile = measured[0]?.accounts.find((a) => a.instanceId === account.instanceId);
            return profile && account.driver === candidate.request.driver
              ? {
                  ...account,
                  profileSamples: profile.profileSamples,
                  profileUncertainty: profile.profileUncertainty,
                }
              : account;
          }),
        }));
      }
      return {
        selection: yield* store.selectModel({
          at: yield* now,
          request: operation.request,
          inventories,
          authorityAvailable: true,
          reserve: operation._tag === "modelAllocate",
          expectedPolicyVersion: policy.version,
          expectedModelVersion: modelPolicy.version,
          ...(operation._tag === "modelPreview" && operation.policy
            ? { previewPolicy: operation.policy }
            : {}),
        }),
      };
    }
    if (operation._tag === "lifecycle") {
      if (operation.input.action === "start") {
        const held = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
        );
        if (held?.state === "reserved") {
          const request = { ...held.request, explicitInstanceId: held.instanceId };
          const decision = decideAllocation({
            at: yield* now,
            policy,
            request,
            inventories: [yield* inventory(request)],
            reservations: yield* store.reservations,
            authorityAvailable: true,
          });
          if (!decision.selectedInstanceId)
            return yield* new AllocationError({
              code: "unavailable",
              detail: decision.reasons.includes(WORKER_ACCOUNT_DISABLED_REASON)
                ? WORKER_ACCOUNT_DISABLED_REASON
                : "Reserved account no longer supports the exact requested profile or identity constraints.",
            });
        }
      }
      if (operation.input.action === "release") {
        const r = (yield* store.reservations).find(
          (v) => v.assignmentId === operation.input.assignmentId,
        );
        if (r && ["starting", "consumed"].includes(r.state)) {
          yield* reconcile(r.assignmentId);
          const updated = (yield* store.reservations).find(
            (v) => v.assignmentId === r.assignmentId,
          );
          if (updated?.state !== "released")
            return yield* new AllocationError({
              code: "conflict",
              detail:
                "Cancel or stop the assignment first. Capacity stays reserved until its execution receipt confirms completion.",
            });
        }
      }
      return { reservation: yield* store.lifecycle(operation.input, yield* now) };
    }
    yield* reconcile(operation._tag === "snapshot" ? undefined : operation.request.assignmentId);
    const request = operation._tag === "snapshot" ? undefined : operation.request;
    const inventories = [yield* inventory(request)];
    if (operation._tag === "snapshot")
      return {
        snapshot: {
          accountWeightsSupported: true,
          accountCapsSupported: true,
          policy,
          inventories,
          reservations: yield* store.reservations,
          history: yield* store.history,
          authorityAvailable: true,
          notices: inventories.flatMap((i) => i.notices),
        } satisfies AllocationSnapshot,
      };
    return {
      result: yield* store.allocate({
        at: yield* now,
        request: operation.request,
        inventories,
        authorityAvailable: true,
        reserve: operation._tag === "allocate",
        expectedPolicyVersion: policy.version,
        ...(operation._tag === "preview" && operation.policy
          ? { previewPolicy: operation.policy satisfies AllocationPolicy }
          : {}),
      }),
    };
  });

  if (Option.isSome(peers))
    yield* peers.value.register("allocationInventory", () =>
      inventory(undefined).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.detail }),
        ),
      ),
    );
  return ProviderAllocation.of({ execute, replacement, place });
});

export const layer = Layer.effect(ProviderAllocation, make);
