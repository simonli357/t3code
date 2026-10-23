import {
  AllocationError,
  AllocationInventory,
  AllocationOperation,
  AllocationResponse,
  AllocationRequest,
  ModelSelection,
  ThreadId,
  type AllocationSnapshot,
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
import * as Peers from "../orchestration/PeerLinks.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readQuotaEvidence, type QuotaEvidence } from "./quotaEvidence.ts";
import { allocationInventory } from "./inventory.ts";
import { decideAllocation } from "./decision.ts";
import { modelCandidates } from "./modelDecision.ts";

const PeerInput = Schema.TaggedUnion({
  allocation: { operation: AllocationOperation },
  allocationInventory: { request: Schema.optional(AllocationRequest) },
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

export class ProviderAllocation extends Context.Service<
  ProviderAllocation,
  {
    readonly execute: (
      operation: AllocationOperation,
    ) => Effect.Effect<AllocationResponse, AllocationError>;
    readonly receive: (from: string, request: unknown) => Effect.Effect<unknown, AllocationError>;
  }
>()("t3/allocation/ProviderAllocation") {}

const make = Effect.gen(function* () {
  const store = yield* Store.AllocationStore;
  const peers = yield* Peers.PeerLinks;
  const providers = yield* ProviderRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const measurements = yield* UsageMeasurements;
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const local = yield* peers.localEnvironment;

  const inventory = Effect.fn("ProviderAllocation.inventory")(function* (
    request: AllocationRequest | undefined,
  ) {
    const threads = (yield* projection.getShellSnapshot()).threads;
    const quotaEvidence: QuotaEvidence[] = [];
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const rows = threads.length
      ? yield* sql<{
          payload_json: string;
          created_at: string;
          kind: string;
          ordinal: number;
          thread_id: ThreadId;
        }>`SELECT payload_json, created_at, kind, rowid AS ordinal, thread_id FROM projection_thread_activities WHERE ${sql.in("thread_id", [...byThread.keys()])} AND (kind = 'account.quota-state' OR kind = 'runtime.error' OR (kind = 'runtime.warning' AND json_extract(payload_json, '$.detail.status') = 'rejected')) ORDER BY created_at DESC, rowid DESC`
      : [];
    for (const row of rows) {
      const thread = byThread.get(row.thread_id)!;
      quotaEvidence.push(
        ...readQuotaEvidence(
          row,
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
        ).map((e) => ({ ...e, threadId: thread.id })),
      );
    }
    const current = allocationInventory({
      environmentId: local.environmentId,
      at: yield* now,
      providers: yield* providers.getProviders,
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
  const collect = Effect.fn("ProviderAllocation.collect")(function* (request?: AllocationRequest) {
    const own = yield* inventory(request);
    const remote = yield* Effect.forEach(yield* peers.list, (peer) =>
      peers
        .call(peer.environmentId, { _tag: "allocationInventory", ...(request ? { request } : {}) })
        .pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AllocationInventory)),
          Effect.catch(() =>
            Effect.succeed({
              coordinatorEnvironmentId: null,
              environmentId: peer.environmentId,
              environmentLabel: peer.label,
              observedAt: own.observedAt,
              accounts: [],
              demand: [],
              complete: false,
              notices: [`${peer.label}: load unavailable.`],
            } satisfies AllocationInventory),
          ),
        ),
    );
    return [own, ...remote];
  });
  const reconcile = Effect.fn("ProviderAllocation.reconcile")(function* () {
    yield* store.expireUnused(yield* now);
    for (const r of yield* store.reservations) {
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
      yield* reconcile();
      let inventories = yield* collect();
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
            authorityAvailable: coordinated,
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
      if (operation._tag === "modelAllocate" && !coordinated) return yield* unavailable();
      // Preserve the allocator's measured profile uncertainty for each eligible
      // family. Catalog/quota selection below still uses one shared snapshot.
      const effectiveModelPolicy =
        operation._tag === "modelPreview" ? (operation.policy ?? modelPolicy) : modelPolicy;
      for (const candidate of modelCandidates(effectiveModelPolicy, operation.request, inventories)
        .candidates) {
        const measured = yield* collect(candidate.request);
        inventories = inventories.map((host) => ({
          ...host,
          complete:
            host.complete &&
            measured.every((i) => i.complete && i.coordinatorEnvironmentId === local.environmentId),
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
          authorityAvailable: coordinated,
          reserve: operation._tag === "modelAllocate",
          expectedPolicyVersion: policy.version,
          expectedModelVersion: modelPolicy.version,
          ...(operation._tag === "modelPreview" && operation.policy
            ? { previewPolicy: operation.policy }
            : {}),
        }),
      };
    }
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
            authorityAvailable: inventories.every(
              (i) => i.coordinatorEnvironmentId === local.environmentId,
            ),
          });
          if (!decision.selectedInstanceId)
            return yield* new AllocationError({
              code: "unavailable",
              detail:
                "Reserved account is no longer safe to start. Refresh the proposal; the account and requested profile are unchanged.",
            });
        }
      }
      if (operation.input.action === "release") {
        const r = (yield* store.reservations).find(
          (r) => r.assignmentId === operation.input.assignmentId,
        );
        if (r && ["starting", "consumed"].includes(r.state)) {
          yield* reconcile();
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
    yield* reconcile();
    const inventories = yield* collect(
      operation._tag === "snapshot" ? undefined : operation.request,
    );
    const coordinated =
      authorityAvailable &&
      inventories.every((i) => i.coordinatorEnvironmentId === local.environmentId);
    if (operation._tag === "snapshot")
      return {
        snapshot: {
          policy,
          inventories,
          reservations: yield* store.reservations,
          history: yield* store.history,
          authorityAvailable,
          notices: [
            ...inventories.flatMap((i) => i.notices),
            ...(!coordinated
              ? [
                  "Every linked environment must select this coordinator; disconnected or differently configured hosts block automatic admission.",
                ]
              : []),
          ],
        } satisfies AllocationSnapshot,
      };
    return {
      result: yield* store.allocate({
        at: yield* now,
        request: operation.request,
        inventories,
        authorityAvailable: coordinated,
        reserve: operation._tag === "allocate",
        expectedPolicyVersion: policy.version,
        ...(operation._tag === "preview" && operation.policy
          ? { previewPolicy: operation.policy }
          : {}),
      }),
    };
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
          old.snapshot.policy.mode !== "observation" ||
          old.snapshot.reservations.some((r) =>
            ["reserved", "starting", "consumed"].includes(r.state),
          )
        )
          return yield* new AllocationError({
            code: "conflict",
            detail:
              "Put the previous coordinator in observation mode and drain its reservations before moving authority.",
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
          return yield* inventory(request.request);
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
