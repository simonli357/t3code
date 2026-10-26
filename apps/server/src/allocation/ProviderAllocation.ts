import {
  AllocationError,
  AllocationInventory,
  AllocationOperation,
  AllocationResponse,
  AllocationRequest,
  ComputerPlacementProbe,
  ModelSelection,
  ThreadId,
  type AllocationSnapshot,
  type AllocationPolicy,
  type ComputerPlacement,
  type ComputerPlacementRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Store from "./AllocationStore.ts";
import * as Computers from "../computers/Computers.ts";
import * as Peers from "../orchestration/PeerLinks.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { quotaEvidenceInstances, readQuotaEvidenceRows } from "./quotaEvidence.ts";
import { allocationInventory } from "./inventory.ts";
import { decideAllocation } from "./decision.ts";
import { modelCandidates } from "./modelDecision.ts";
import { recommendPlacement } from "./placement.ts";

const PeerInput = Schema.TaggedUnion({
  allocation: { operation: AllocationOperation },
  // `placement` asks for the computer's capacity and checkouts too; ordinary reads never pay for it.
  allocationInventory: {
    request: Schema.optional(AllocationRequest),
    placement: Schema.optional(ComputerPlacementProbe),
  },
  allocationProbe: {
    threadId: ThreadId,
    assignmentId: Schema.String,
    since: Schema.String,
    startIntent: Schema.optional(Schema.String),
  },
});
const Probe = Schema.Struct({
  state: Schema.Literals(["pending", "running", "terminal", "unknown"]),
});
const unavailable = () =>
  new AllocationError({
    code: "unavailable",
    detail:
      "Allocation authority or execution environment is unavailable; capacity remains reserved.",
  });
const decodeResponse = Schema.decodeUnknownEffect(AllocationResponse);
const decodePeerInput = Schema.decodeUnknownEffect(PeerInput);
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const now = Clock.currentTimeMillis.pipe(
  Effect.map((n) => DateTime.formatIso(DateTime.makeUnsafe(n))),
);
/** A computer that could not be read for a placement: listed offline with its error, never left out or zero. */
const unreadInventory = (
  peer: { environmentId: string; label: string },
  observedAt: string,
  cause?: string,
): AllocationInventory => ({
  coordinatorEnvironmentId: null,
  environmentId: peer.environmentId,
  environmentLabel: peer.label,
  observedAt,
  accounts: [],
  demand: [],
  complete: false,
  notices: [`${peer.label}: load unavailable for this decision${cause ? `: ${cause}` : "."}`],
});

export class ProviderAllocation extends Context.Service<
  ProviderAllocation,
  {
    readonly execute: (
      operation: AllocationOperation,
    ) => Effect.Effect<AllocationResponse, AllocationError>;
    readonly receive: (from: string, request: unknown) => Effect.Effect<unknown, AllocationError>;
    /**
     * Computer advice plus the inventories it ranked, read on this computer. Placement needs no
     * allocation authority, so it never goes through the coordinator.
     */
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
  const peers = yield* Peers.PeerLinks;
  const providers = yield* ProviderRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const measurements = yield* UsageMeasurements;
  const settings = yield* ServerSettingsService;
  const computers = yield* Computers.Computers;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* peers.localEnvironment;

  const inventory = Effect.fn("ProviderAllocation.inventory")(function* (
    request: AllocationRequest | undefined,
    placement?: ComputerPlacementProbe,
  ) {
    const shell = yield* projection.getShellSnapshot();
    const threads = shell.threads;
    const currentProviders = yield* providers.getProviders;
    // A placement read also measures this computer and finds its checkouts of the repository.
    // It is sampled before the inventory is stamped, so the reading is never newer than it.
    const checkouts =
      placement?.repositoryKey === undefined
        ? undefined
        : shell.projects.filter(
            (project) => project.repositoryIdentity?.canonicalKey === placement.repositoryKey,
          );
    const computer = placement
      ? yield* computers
          .capacity({
            workPath:
              (yield* settings.getSettings).agentWorkRoot.trim() || checkouts?.[0]?.workspaceRoot,
          })
          .pipe(
            // A reading that outlasts a peer deadline leaves this computer unmeasured, not the
            // whole advice late.
            Effect.timeoutOption(Peers.PEER_CALL_TIMEOUT_MS),
            Effect.map(Option.getOrUndefined),
          )
      : undefined;
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const rows = threads.length
      ? yield* sql<{
          payload_json: string;
          created_at: string;
          kind: string;
          ordinal: number;
          thread_id: ThreadId;
          turn_id: string | null;
          historical_session_json: string | null;
          native_error_text: string | null;
        }>`SELECT payload_json, created_at, kind, rowid AS ordinal, thread_id, turn_id,
          (SELECT m.text FROM projection_turns t JOIN projection_thread_messages m
           ON m.message_id = t.assistant_message_id AND m.thread_id = t.thread_id AND m.turn_id = t.turn_id
           WHERE t.thread_id = a.thread_id AND t.turn_id = a.turn_id AND t.state = 'error'
             AND a.kind = 'runtime.error' AND m.role = 'assistant' AND m.updated_at <= a.created_at
             AND length(m.text) <= 256 AND m.text LIKE 'You''ve hit your % limit %' LIMIT 1) AS native_error_text,
          COALESCE((SELECT json_extract(e.payload_json, '$.session')
           FROM orchestration_events e
           WHERE e.aggregate_kind = 'thread' AND e.event_type = 'thread.session-set'
             AND e.stream_id = a.thread_id AND e.occurred_at <= a.created_at
             AND json_extract(e.payload_json, '$.session.activeTurnId') = a.turn_id
           ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1),
          (SELECT json_extract(e.payload_json, '$.session')
           FROM orchestration_events e
           WHERE e.aggregate_kind = 'thread' AND e.event_type = 'thread.session-set'
             AND e.stream_id = a.thread_id AND e.occurred_at <= a.created_at
           ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT 1)) AS historical_session_json
          FROM projection_thread_activities a INDEXED BY idx_projection_thread_activities_quota_evidence WHERE ${sql.in("thread_id", [...byThread.keys()])} AND kind IN ('account.quota-state', 'runtime.error', 'runtime.warning') AND (kind = 'account.quota-state' OR kind = 'runtime.error' OR (kind = 'runtime.warning' AND json_extract(payload_json, '$.detail.status') = 'rejected')) ORDER BY created_at DESC, rowid DESC`
      : [];
    const quotaEvidence = readQuotaEvidenceRows(
      rows.flatMap((row) => {
        const thread = byThread.get(row.thread_id)!;
        // Explicit receipt identity wins in the decoder. Legacy activities use the
        // session at their event time, not the account selected after a switch.
        return quotaEvidenceInstances(
          row.historical_session_json,
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
          currentProviders,
          row.payload_json,
        ).map((instanceId) => ({ ...row, instanceId }));
      }),
    );
    const current = allocationInventory({
      environmentId: local.environmentId,
      at: yield* now,
      providers: currentProviders,
      threads,
      quotaEvidence,
      maxReadingAgeMinutes: (yield* store.policy).maxReadingAgeMinutes,
      measurements: yield* measurements.read({ lookbackHours: 168, turnLimit: 1 }),
      ...(request ? { request } : {}),
    });
    const pending = yield* sql<{
      thread_id: string;
      selection_json: string;
    }>`SELECT DISTINCT w.thread_id, json_extract(w.plan_json, '$.modelSelection') AS selection_json FROM custom_workers w JOIN custom_worker_jobs j ON j.worker_id = w.thread_id WHERE j.kind = 'work' AND j.state IN ('queued', 'submitted') AND (json_extract(w.plan_json, '$.environmentId') IS NULL OR json_extract(w.plan_json, '$.environmentId') = ${local.environmentId})`;
    const demand = [...current.demand];
    for (const p of pending) {
      if (demand.some((d) => d.threadId === p.thread_id)) continue;
      const selection = yield* decodeSelection(p.selection_json);
      demand.push({
        environmentId: local.environmentId,
        threadId: ThreadId.make(p.thread_id),
        instanceId: selection.instanceId,
        accountKey:
          current.accounts.find((a) => a.instanceId === selection.instanceId)?.accountKey ?? null,
        model: selection.model,
        options: selection.options ?? [],
        state: "pending",
      });
    }
    return {
      ...current,
      environmentLabel: local.label,
      demand,
      coordinatorEnvironmentId: (yield* settings.getSettings).allocationCoordinatorEnvironmentId,
      ...(computer ? { computer } : {}),
      ...(checkouts
        ? { projects: checkouts.slice(0, 20).map(({ id, title }) => ({ id, title })) }
        : {}),
    };
  }, Effect.mapError(unavailable));
  const probe = Effect.fn("ProviderAllocation.probe")(function* (
    threadId: ThreadId,
    assignmentId: string,
    since: string,
    startIntent?: string,
  ) {
    const rejected =
      yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id IN (${`allocation:${assignmentId}`}, ${`allocation:${assignmentId}:create`}) AND aggregate_id = ${threadId} AND status = 'rejected'`;
    const failedStart =
      yield* sql`SELECT 1 FROM provider_allocation_failed_starts WHERE assignment_id = ${assignmentId} AND thread_id = ${threadId}`;
    const remoteRefusal = startIntent
      ? yield* sql`SELECT 1 FROM provider_allocation_start_rejections WHERE assignment_id = ${assignmentId} AND thread_id = ${threadId} AND start_intent = ${startIntent}`
      : [];
    if (rejected.length || failedStart.length || remoteRefusal.length)
      return { state: "terminal" as const };
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
    const thread = yield* projection.getThreadShellById(threadId);
    if (Option.isNone(thread)) return { state: "unknown" as const };
    const t = thread.value;
    if (
      t.session?.status === "running" ||
      t.latestTurn?.state === "running" ||
      t.backgroundLiveness === "working"
    )
      return { state: "running" as const };
    if (t.session?.status === "starting") return { state: "pending" as const };
    if (
      (t.latestTurn?.completedAt && t.latestTurn.completedAt >= since) ||
      (t.session?.status === "error" && t.session.updatedAt >= since) ||
      (jobs[0] && ["completed", "error", "interrupted", "cancelled"].includes(jobs[0].state))
    )
      return { state: "terminal" as const };
    return { state: "unknown" as const };
  }, Effect.mapError(unavailable));
  const collect = Effect.fn("ProviderAllocation.collect")(function* (
    request?: AllocationRequest,
    executionEnvironmentId = request?.environmentId,
    placement?: ComputerPlacementProbe,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const linked = yield* peers.list;
        const observed = new Map<string, AllocationInventory>();
        const read = (environmentId: string) =>
          peers
            .call(environmentId, {
              _tag: "allocationInventory",
              ...(request ? { request } : {}),
              ...(placement ? { placement } : {}),
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AllocationInventory)));
        // Inventory on other hosts is advisory. Give it the time spent reading
        // required hosts, then cancel unfinished reads instead of consuming the
        // caller's entire peer deadline. Missing load stays explicit, never zero.
        if (executionEnvironmentId !== undefined) {
          for (const peer of linked) {
            if (peer.environmentId === executionEnvironmentId) continue;
            yield* read(peer.environmentId).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  observed.set(peer.environmentId, value);
                }),
              ),
              Effect.ignore,
              Effect.forkScoped({ startImmediately: true }),
            );
          }
        }
        // A placement read has no required computer, so this one's reading and the linked ones'
        // run together: the caller waits for the slowest of them, not for their sum.
        if (executionEnvironmentId === undefined && placement !== undefined) {
          const [own, remote] = yield* Effect.all(
            [
              inventory(request, placement),
              Effect.forEach(linked, (peer) => Effect.result(read(peer.environmentId)), {
                concurrency: "unbounded",
              }),
            ],
            { concurrency: "unbounded" },
          );
          return [
            own,
            ...remote.map((result, index) =>
              result._tag === "Success"
                ? result.success
                : unreadInventory(linked[index]!, own.observedAt, result.failure.message),
            ),
          ];
        }
        const own = yield* inventory(request, placement);
        const missing = (peer: { environmentId: string; label: string }) =>
          unreadInventory(peer, own.observedAt);
        if (executionEnvironmentId === undefined) {
          const remote = yield* Effect.forEach(
            linked,
            (peer) =>
              read(peer.environmentId).pipe(Effect.catch(() => Effect.succeed(missing(peer)))),
            { concurrency: "unbounded" },
          );
          return [own, ...remote];
        }
        if (executionEnvironmentId !== local.environmentId) {
          const target = yield* read(executionEnvironmentId).pipe(
            Effect.mapError(
              (cause) =>
                new AllocationError({
                  code: "unavailable",
                  detail: `Execution environment ${executionEnvironmentId} inventory unavailable: ${cause.message}`,
                }),
            ),
          );
          observed.set(executionEnvironmentId, target);
        }
        return [own, ...linked.map((peer) => observed.get(peer.environmentId) ?? missing(peer))];
      }),
    );
  });
  const reconcile = Effect.fn("ProviderAllocation.reconcile")(function* (assignmentId?: string) {
    yield* store.expireUnused(yield* now);
    for (const r of yield* store.reservations) {
      // An unrelated uncertain execution must retain its shared-account demand,
      // not delay a new assignment. Full inspection still reconciles all receipts.
      if (assignmentId !== undefined && r.assignmentId !== assignmentId) continue;
      if (r.state !== "starting" && r.state !== "consumed") continue;
      const stateEffect =
        r.request.environmentId === local.environmentId
          ? probe(r.request.threadId, r.assignmentId, r.createdAt, r.startIntent ?? undefined)
          : peers
              .call(r.request.environmentId, {
                _tag: "allocationProbe",
                ...(r.startIntent ? { startIntent: r.startIntent } : {}),
                threadId: r.request.threadId,
                assignmentId: r.assignmentId,
                since: r.createdAt,
              })
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Probe)),
                Effect.mapError(unavailable),
              );
      const state = yield* stateEffect.pipe(
        Effect.catch(() => Effect.succeed({ state: "unknown" as const })),
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
  /** Advice only: it reads every linked computer, reserves nothing and gates nothing. */
  const placeLocal = Effect.fn("ProviderAllocation.placeLocal")(function* (
    request: ComputerPlacementRequest,
    policy: AllocationPolicy,
  ) {
    const inventories = yield* collect(
      undefined,
      undefined,
      request.repositoryKey === undefined ? {} : { repositoryKey: request.repositoryKey },
    );
    return {
      placement: recommendPlacement({ at: yield* now, policy, request, inventories }),
      inventories,
    };
  });
  const executeLocal = Effect.fn("ProviderAllocation.executeLocal")(function* (
    operation: AllocationOperation,
  ): Effect.fn.Return<AllocationResponse, AllocationError> {
    const policy = yield* store.policy;
    const authorityAvailable = policy.coordinatorEnvironmentId === local.environmentId;
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
      let inventories = yield* collect(
        undefined,
        selecting ? operation.request.environmentId : undefined,
      );
      const coordinated =
        authorityAvailable &&
        inventories.every((i) => i.complete && i.coordinatorEnvironmentId === local.environmentId);
      if (operation._tag === "modelSnapshot")
        return {
          modelSnapshot: {
            policy: modelPolicy,
            policies: yield* store.modelPolicies,
            history: yield* store.modelHistory,
            inventories,
            authorityAvailable,
          },
        };
      if (operation._tag === "modelPolicy" || operation._tag === "modelRevert") {
        if (!coordinated) return yield* unavailable();
        return {
          modelPolicy: yield* store.saveModelPolicy({
            expectedVersion: operation.expectedVersion,
            inventories,
            ...(operation._tag === "modelPolicy"
              ? { policy: operation.policy }
              : { revertVersion: operation.version }),
          }),
        };
      }
      if (operation._tag === "modelAllocate" && !authorityAvailable) return yield* unavailable();
      // Preserve the allocator's measured profile uncertainty for each eligible
      // family. Catalog/quota selection below still uses one shared snapshot.
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
        const measured = yield* collect(candidate.request);
        inventories = inventories.map((host) => ({
          ...host,
          complete:
            host.complete &&
            measured.some((i) => i.environmentId === host.environmentId && i.complete),
          accounts: host.accounts.map((account) => {
            const profile = measured
              .find((i) => i.environmentId === host.environmentId)
              ?.accounts.find((a) => a.instanceId === account.instanceId);
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
          authorityAvailable,
          reserve: operation._tag === "modelAllocate",
          expectedPolicyVersion: policy.version,
          expectedModelVersion: modelPolicy.version,
          ...(operation._tag === "modelPreview" && operation.policy
            ? { previewPolicy: operation.policy }
            : {}),
        }),
      };
    }
    if (operation._tag === "placement")
      return { placement: (yield* placeLocal(operation.request, policy)).placement };
    if (operation._tag === "policy") {
      if (operation.input.policy.coordinatorEnvironmentId !== local.environmentId)
        return yield* new AllocationError({
          code: "invalid",
          detail: "Save policies on their configured coordinator.",
        });
      if (policy.coordinatorEnvironmentId && !authorityAvailable) return yield* unavailable();
      return { policy: yield* store.savePolicy(operation.input) };
    }
    if (operation._tag === "lifecycle") {
      if (!authorityAvailable) return yield* unavailable();
      if (operation.input.action === "start") {
        const held = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
        );
        if (held?.state === "reserved") {
          const request = { ...held.request, explicitInstanceId: held.instanceId };
          const inventories = yield* collect(request);
          const decision = decideAllocation({
            at: yield* now,
            policy,
            request,
            inventories,
            reservations: yield* store.reservations,
            authorityAvailable,
          });
          if (!decision.selectedInstanceId)
            return yield* new AllocationError({
              code: "unavailable",
              detail:
                "Reserved account no longer supports the exact requested profile or identity constraints.",
            });
        }
      }
      if (operation.input.action === "release") {
        const r = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
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
    if (operation._tag === "connect" || operation._tag === "connections")
      return yield* new AllocationError({
        code: "invalid",
        detail: "Connect must run on the requesting environment.",
      });
    yield* reconcile(operation._tag === "snapshot" ? undefined : operation.request.assignmentId);
    const inventories = yield* collect(
      operation._tag === "snapshot" ? undefined : operation.request,
    );
    const coordinated =
      authorityAvailable &&
      inventories.every((i) => i.coordinatorEnvironmentId === local.environmentId);
    if (operation._tag === "snapshot")
      return {
        snapshot: {
          accountWeightsSupported: true,
          policy,
          inventories,
          reservations: yield* store.reservations,
          history: yield* store.history,
          authorityAvailable,
          notices: [
            ...inventories.flatMap((i) => i.notices),
            ...(!coordinated
              ? [
                  "Some linked environment observations or coordinator settings differ. Forecasts may be incomplete; managed starts retain their exact destination.",
                ]
              : []),
          ],
        } satisfies AllocationSnapshot,
      };
    if (operation._tag === "allocate" && !authorityAvailable) return yield* unavailable();
    return {
      result: yield* store.allocate({
        at: yield* now,
        request: operation.request,
        inventories,
        authorityAvailable,
        reserve: operation._tag === "allocate",
        expectedPolicyVersion: policy.version,
        ...(operation._tag === "preview" && operation.policy
          ? { previewPolicy: operation.policy }
          : {}),
      }),
    };
  });
  const withRepositoryKey = Effect.fn("ProviderAllocation.repositoryKey")(function* (
    request: ComputerPlacementRequest,
  ) {
    if (request.projectId === undefined || request.repositoryKey !== undefined) return request;
    const project = (yield* projection
      .getShellSnapshot()
      .pipe(Effect.mapError(unavailable))).projects.find(({ id }) => id === request.projectId);
    if (!project)
      return yield* new AllocationError({
        code: "invalid",
        detail: `Project ${request.projectId} was not found on this computer.`,
      });
    const repositoryKey = project.repositoryIdentity?.canonicalKey;
    return repositoryKey === undefined ? request : { ...request, repositoryKey };
  });
  // Only this computer knows its project IDs; checkouts elsewhere match by repository.
  const place = Effect.fn("ProviderAllocation.place")(function* (
    request: ComputerPlacementRequest,
  ) {
    return yield* placeLocal(yield* withRepositoryKey(request), yield* store.policy);
  });
  const execute = Effect.fn("ProviderAllocation.execute")(function* (
    operation: AllocationOperation,
  ): Effect.fn.Return<AllocationResponse, AllocationError> {
    if (operation._tag === "connections")
      return {
        connections: {
          coordinatorEnvironmentId: (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
            .allocationCoordinatorEnvironmentId,
          environments: [local, ...(yield* peers.list.pipe(Effect.mapError(unavailable)))].map(
            ({ environmentId, label }) => ({ environmentId, label }),
          ),
        },
      };
    if (operation._tag === "connect") {
      yield* store.expireUnused(yield* now);
      const id = operation.coordinatorEnvironmentId;
      const previous = (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
        .allocationCoordinatorEnvironmentId;
      if (previous && previous !== id) {
        const old =
          previous === local.environmentId
            ? yield* executeLocal({ _tag: "snapshot" })
            : yield* peers
                .call(previous, { _tag: "allocation", operation: { _tag: "snapshot" } })
                .pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
        if (
          !old.snapshot ||
          old.snapshot.reservations.some((r) =>
            ["reserved", "starting", "consumed"].includes(r.state),
          )
        )
          return yield* new AllocationError({
            code: "conflict",
            detail: "Drain the previous coordinator's reservations before moving authority.",
          });
      }
      if (id !== local.environmentId) {
        const remote = yield* peers
          .call(id, { _tag: "allocation", operation: { _tag: "snapshot" } })
          .pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
        if (remote.snapshot?.policy.coordinatorEnvironmentId !== id)
          return yield* new AllocationError({
            code: "invalid",
            detail: "Selected peer is not an allocation coordinator.",
          });
      }
      const active = (yield* store.reservations).some((r) =>
        ["reserved", "starting", "consumed"].includes(r.state),
      );
      if (active)
        return yield* new AllocationError({
          code: "conflict",
          detail: "Drain active reservations before changing coordinator.",
        });
      yield* settings
        .updateSettings({ allocationCoordinatorEnvironmentId: id })
        .pipe(Effect.mapError(unavailable));
      if (id === local.environmentId) {
        const current = yield* store.policy;
        if (!current.coordinatorEnvironmentId)
          yield* store.savePolicy({
            expectedVersion: current.version,
            policy: { ...current, coordinatorEnvironmentId: id },
          });
      }
      return {};
    }
    // Placement reads every linked computer itself and needs no authority, so it stays here:
    // an older coordinator that does not know the operation cannot fail the whole advice.
    if (operation._tag === "placement")
      return { placement: (yield* place(operation.request)).placement };
    const id = (yield* settings.getSettings.pipe(Effect.mapError(unavailable)))
      .allocationCoordinatorEnvironmentId;
    if (id && id !== local.environmentId)
      return yield* peers
        .call(id, { _tag: "allocation", operation })
        .pipe(Effect.flatMap(decodeResponse), Effect.mapError(unavailable));
    return yield* executeLocal(operation);
  });
  return ProviderAllocation.of({
    execute,
    place,
    receive: Effect.fn("ProviderAllocation.receive")(function* (from, raw) {
      if (Option.isNone(yield* peers.resolve(from)))
        return yield* new AllocationError({
          code: "invalid",
          detail: "Allocation traffic requires a linked environment.",
        });
      const request = yield* decodePeerInput(raw).pipe(
        Effect.mapError(
          () =>
            new AllocationError({ code: "invalid", detail: "Invalid allocation peer request." }),
        ),
      );
      switch (request._tag) {
        case "allocationInventory":
          return yield* inventory(request.request, request.placement);
        case "allocationProbe":
          return yield* probe(
            request.threadId,
            request.assignmentId,
            request.since,
            request.startIntent,
          );
        case "allocation":
          return yield* executeLocal(request.operation);
      }
    }),
  });
});
export const layer = Layer.effect(ProviderAllocation, make);
export const liveLayer = layer.pipe(Layer.provide(Store.layer), Layer.provide(Peers.layer));
