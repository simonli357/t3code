import {
  CommandId,
  EnvironmentId,
  OrchestratorMcpFailure,
  OrchestrationV2ThreadShell,
  SessionOwnershipInput,
  SessionOwnershipResult,
  SessionOwnershipError,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerRequests from "../peer/PeerRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  Plan,
  WorkerError,
  parsePeerRef,
  peerRef,
  type WorkerRow as Worker,
  type AuthorityRow,
} from "./workerSchemas.ts";
import { makeSessionOrganizationQuery } from "./SessionOrganizationQuery.ts";
const SessionAddress = Schema.Struct({ environmentId: Schema.String, threadId: ThreadId });
const isWorkerError = Schema.is(WorkerError);
const isPeerUnavailable = Schema.is(PeerRequests.PeerUnavailable);
const failure = (cause: unknown) =>
  isWorkerError(cause)
    ? cause
    : new WorkerError({ message: cause instanceof Error ? cause.message : String(cause) });
const peerResult =
  <A>(decode: (value: unknown) => A) =>
  (value: unknown) =>
    Effect.try({ try: () => decode(value), catch: failure });
const OrganizationSnapshot = Schema.Struct({
  threadId: ThreadId,
  authority: Schema.String,
  execution: Schema.String,
  owner: Schema.NullOr(SessionAddress),
  revision: Schema.Number,
  plan: Plan,
  hasChildren: Schema.Boolean,
});
type OrganizationSnapshot = typeof OrganizationSnapshot.Type;
const OrganizationPatch = Schema.Struct({
  snapshot: OrganizationSnapshot,
  owner: Schema.NullOr(SessionAddress),
  ownerRuntimeMode: Schema.optional(OrchestrationV2ThreadShell.fields.runtimeMode),
  hosts: Schema.Array(Schema.String),
  revision: Schema.Number,
});
type OrganizationPatch = typeof OrganizationPatch.Type;
const OrganizationDecision = Schema.Struct({
  state: Schema.Literals(["preparing", "committed", "complete", "aborted"]),
  participants: Schema.Array(Schema.String),
  patch: Schema.NullOr(OrganizationPatch),
});
type OrganizationTransaction = {
  id: string;
  request_json: string;
  state: (typeof OrganizationDecision.Type)["state"];
  participants_json: string;
  patch_json: string | null;
  result_json: string | null;
  error: string | null;
};
const decodeOrganizationSnapshot = Schema.decodeUnknownSync(OrganizationSnapshot);
const decodeOrganizationPatch = Schema.decodeUnknownSync(Schema.fromJsonString(OrganizationPatch));
const decodeOrganizationDecision = Schema.decodeUnknownSync(OrganizationDecision);
const decodeOrganizationRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ input: SessionOwnershipInput, actor: Schema.optional(SessionAddress) }),
  ),
);
const decodeOrganizationResponse = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), result: SessionOwnershipResult }),
    Schema.Struct({
      ok: Schema.Literal(false),
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  ]),
);
const decodeHosts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(Plan));
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePlan = encodeUnknown;
const decodeOwnershipResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(SessionOwnershipResult),
);
const Request = Schema.Union([
  Schema.TaggedStruct("organizationInspect", { threadId: ThreadId }),
  Schema.TaggedStruct("organizationAccept", { snapshot: OrganizationSnapshot }),
  Schema.TaggedStruct("organizationReserve", { id: Schema.String }),
  Schema.TaggedStruct("organizationDecision", { id: Schema.String }),
  Schema.TaggedStruct("organizationFinish", {
    id: Schema.String,
    release: Schema.optional(Schema.Boolean),
  }),
  Schema.TaggedStruct("organizationChange", {
    input: SessionOwnershipInput,
    actor: Schema.optional(SessionAddress),
  }),
]);

/** Durable custom.52 ownership transactions, using V2 thread reads and native peer transport. */
const decodeRequest = Schema.decodeUnknownEffect(Request);

export const makeSessionOwnership = Effect.fn("SessionOwnership.make")(function* (input: {
  readonly lock: Semaphore.Semaphore;
  readonly localEnvironmentId: Effect.Effect<string>;
  readonly watched: Set<string>;
  readonly kick: () => Effect.Effect<void>;
  readonly retargetReports: (
    ids: ReadonlyArray<string>,
    owners: ReadonlyArray<string>,
    owner: string | null,
  ) => Effect.Effect<void, WorkerError>;
  readonly latestUserInstruction: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly text: string } | undefined, WorkerError>;
}) {
  const { lock, watched, kick, retargetReports, latestUserInstruction } = input;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const transport = yield* Effect.serviceOption(PeerRequests.PeerRequests);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peers = {
    localEnvironment: input.localEnvironmentId.pipe(
      Effect.map((environmentId) => ({ environmentId })),
    ),
    call: (
      environmentId: string,
      body: typeof Request.Type,
    ): Effect.Effect<
      unknown,
      PeerRequests.PeerUnavailable | PeerRequests.PeerRejected | WorkerError
    > =>
      Option.isSome(transport)
        ? transport.value.call(EnvironmentId.make(environmentId), "session-organization", body)
        : Effect.fail(
            new WorkerError({
              message: "Linked environment transport is unavailable.",
              code: "pending",
            }),
          ),
  };
  const thread = (id: ThreadId) =>
    threads.getThreadShell(id).pipe(
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new WorkerError({ message: `Session ${id} is unavailable.` }),
      ),
      Effect.mapError(failure),
    );
  const authorityOf = Effect.fn(function* (id: string) {
    return (yield* sql<AuthorityRow>`SELECT * FROM custom_orchestrator_authority WHERE thread_id = ${id}`)[0];
  });
  const query = yield* makeSessionOrganizationQuery;
  const published = new Map<string, string>();
  const publish = Effect.fn(function* (initialize = false) {
    const ids = [...watched].filter((id) => !parsePeerRef(id)).map((id) => ThreadId.make(id));
    const organizations = yield* query(ids);
    for (const [id, organization] of organizations) {
      const encoded = encodeUnknown(organization);
      if (published.get(id) === encoded) continue;
      if (!initialize && (yield* threads.getThreadShell(id)) !== null) {
        yield* threads.dispatch({
          type: "thread.metadata.update",
          threadId: id,
          commandId: CommandId.make(`organization:${id}:${yield* crypto.randomUUIDv4()}`),
        });
      }
      published.set(id, encoded);
    }
  });
  const address = (id: string | null, environmentId: string) =>
    id === null ? null : (parsePeerRef(id) ?? { environmentId, threadId: ThreadId.make(id) });
  const localId = (ref: typeof SessionAddress.Type | null, local: string) =>
    ref === null
      ? null
      : ref.environmentId === local
        ? ref.threadId
        : peerRef(ref.environmentId, ref.threadId);
  const inspectOrganization = Effect.fn(function* (threadId: ThreadId) {
    const local = (yield* peers.localEnvironment).environmentId;
    const record =
      (yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${threadId}`)[0];
    const target = record?.state === "remote" ? null : yield* thread(threadId);
    if (target?.archivedAt)
      return yield* new WorkerError({
        message: "Unarchive the session before changing ownership.",
      });
    if (record && !["ready", "remote"].includes(record.state))
      return yield* new WorkerError({
        message: "Finish creating or recovering this worker before changing ownership.",
      });
    const plan = record
      ? decodePlan(record.plan_json)
      : {
          threadId,
          projectId: target!.projectId,
          title: target!.title,
          modelSelection: target!.modelSelection,
          runtimeMode: target!.runtimeMode,
          interactionMode: target!.interactionMode,
          prompt: "Existing session assignment",
        };
    const authority =
      plan.authorityEnvironmentId ??
      (!plan.organizationHosts && record?.state !== "remote"
        ? parsePeerRef(record?.owner_id ?? null)?.environmentId
        : undefined) ??
      local;
    return {
      threadId,
      authority,
      execution: record?.state === "remote" ? plan.environmentId! : local,
      owner: address(record?.owner_id ?? null, local),
      revision: (yield* authorityOf(threadId))?.revision ?? 0,
      plan: target ? { ...plan, runtimeMode: target.runtimeMode } : plan,
      hasChildren:
        (yield* sql`SELECT 1 FROM custom_workers WHERE owner_id = ${threadId} LIMIT 1`).length > 0,
    } satisfies OrganizationSnapshot;
  });
  const inspectAt = Effect.fn(function* (ref: typeof SessionAddress.Type) {
    const local = (yield* peers.localEnvironment).environmentId;
    return ref.environmentId === local
      ? yield* inspectOrganization(ref.threadId)
      : yield* peers
          .call(ref.environmentId, { _tag: "organizationInspect", threadId: ref.threadId })
          .pipe(Effect.flatMap(peerResult(decodeOrganizationSnapshot)));
  });
  const canonicalOrganization = Effect.fn(function* (threadId: ThreadId, environment?: string) {
    let current = environment ?? (yield* peers.localEnvironment).environmentId;
    let snapshot = yield* inspectAt({ environmentId: current, threadId });
    const seen = new Set<string>();
    while (snapshot.authority !== current) {
      if (seen.has(snapshot.authority))
        return yield* new WorkerError({
          message: "Ownership routing is inconsistent; retry after recovery.",
        });
      seen.add(current);
      current = snapshot.authority;
      snapshot = yield* inspectAt({ environmentId: current, threadId });
    }
    return snapshot;
  });
  const organizationResult = (
    snapshot: OrganizationSnapshot,
    owner = snapshot.owner,
    revision = snapshot.revision,
  ) => ({
    threadId: snapshot.threadId,
    ownerThreadId: owner?.threadId ?? null,
    ownerEnvironmentId: owner?.environmentId ?? null,
    previousOwnerThreadId: snapshot.owner?.threadId ?? null,
    previousOwnerEnvironmentId: snapshot.owner?.environmentId ?? null,
    authorityEnvironmentId: snapshot.authority,
    revision,
  });
  const ownershipFailure = (cause: unknown) =>
    new SessionOwnershipError({
      message: failure(cause).message,
      code: isWorkerError(cause) ? cause.code : "pending",
    });
  const readOwnership = Effect.fn("SessionOwnership.readOwnership")(function* (
    threadId: ThreadId,
    environment?: string,
  ) {
    return organizationResult(yield* canonicalOrganization(threadId, environment));
  }, Effect.mapError(ownershipFailure));
  const reserveOrganization = Effect.fn(
    function* (coordinator: string, id: string) {
      const held = (yield* sql<{
        id: string;
        coordinator: string;
      }>`SELECT * FROM custom_ownership_reservation`)[0];
      if (held && (held.id !== id || held.coordinator !== coordinator))
        return yield* new WorkerError({
          code: "conflict",
          message: "Another ownership change is in progress. Retry after it finishes.",
        });
      if (
        (yield* sql`SELECT 1 FROM custom_orchestrator_handoffs WHERE state IN ('queued', 'error') LIMIT 1`)
          .length
      )
        return yield* new WorkerError({
          code: "conflict",
          message: "Finish or cancel the pending master renewal before changing ownership.",
        });
      // Completed moves and cancelled incoming copies stay locked on purpose;
      // they are finished and must not block ownership changes.
      if (
        (yield* sql`SELECT 1 FROM custom_session_moves WHERE locked = 1
          AND state != 'complete' AND NOT (direction = 'in' AND state = 'cancelled') LIMIT 1`)
          .length
      )
        return yield* new WorkerError({
          code: "conflict",
          message: "Wait for the native session move to finish.",
        });
      yield* sql`INSERT INTO custom_ownership_reservation (singleton, id, coordinator) VALUES (1, ${id}, ${coordinator}) ON CONFLICT DO NOTHING`;
    },
    sql.withTransaction,
    lock.withPermit,
  );
  const organizationDecision = Effect.fn(function* (id: string) {
    const row =
      (yield* sql<OrganizationTransaction>`SELECT * FROM custom_ownership_transactions WHERE id = ${id}`)[0];
    if (!row) return yield* new WorkerError({ message: "Unknown ownership transaction." });
    return {
      state: row.state,
      participants: decodeHosts(row.participants_json),
      patch: row.patch_json ? decodeOrganizationPatch(row.patch_json) : null,
    };
  });
  const acceptOrganization = Effect.fn(function* (snapshot: OrganizationSnapshot) {
    const local = (yield* peers.localEnvironment).environmentId;
    const existing =
      (yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${snapshot.threadId}`)[0];
    if (existing) {
      const current = yield* inspectOrganization(snapshot.threadId);
      if (
        current.authority !== snapshot.authority ||
        (!decodePlan(existing.plan_json).organizationHosts &&
          current.execution !== snapshot.execution)
      )
        return yield* new WorkerError({
          message:
            "A different scoped session already uses this worker ID on a participant. Its relationship was preserved.",
        });
    } else if (
      local !== snapshot.execution &&
      (yield* threads.getThreadShell(snapshot.threadId)) !== null
    )
      return yield* new WorkerError({
        message:
          "A different local conversation uses this worker ID. Its relationship was preserved.",
      });
  });
  const applyOrganization = Effect.fn(function* (patch: OrganizationPatch) {
    const local = (yield* peers.localEnvironment).environmentId;
    if (!patch.hosts.includes(local)) return;
    const { snapshot } = patch;
    const record =
      (yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${snapshot.threadId}`)[0];
    if (record && (decodePlan(record.plan_json).authorityRevision ?? -1) >= patch.revision) return;
    const owner = localId(patch.owner, local);
    const {
      environmentId: _execution,
      ownerRuntimeMode: _mode,
      ...priorPlan
    } = record ? decodePlan(record.plan_json) : snapshot.plan;
    const plan = encodePlan({
      ...priorPlan,
      ...(snapshot.execution !== local ? { environmentId: snapshot.execution } : {}),
      authorityEnvironmentId: snapshot.authority,
      authorityRevision: patch.revision,
      organizationHosts: patch.hosts,
      ...(patch.ownerRuntimeMode ? { ownerRuntimeMode: patch.ownerRuntimeMode } : {}),
    });
    // Every report takes the same authority route before and after transfer. A
    // receipt's origin identity survives relays and lost responses.
    const reportTarget =
      local === snapshot.execution && local !== snapshot.authority
        ? peerRef(snapshot.authority, snapshot.threadId)
        : owner;
    yield* retargetReports(
      [snapshot.threadId],
      record?.owner_id ? [record.owner_id] : [],
      reportTarget,
    );
    const baseline =
      snapshot.execution === local
        ? yield* threads.getThreadEventSequence(snapshot.threadId).pipe(Effect.mapError(failure))
        : 0;
    yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, baseline, read_seq)
      VALUES (${snapshot.threadId}, ${owner}, ${plan}, ${snapshot.execution === local ? "ready" : "remote"}, ${baseline}, ${baseline})
      ON CONFLICT(thread_id) DO UPDATE SET owner_id = excluded.owner_id, plan_json = excluded.plan_json`;
    yield* sql`INSERT INTO custom_orchestrator_authority (thread_id, revision) VALUES (${snapshot.threadId}, ${patch.revision})
      ON CONFLICT(thread_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`;
    watched.add(snapshot.threadId);
    if (owner && !parsePeerRef(owner)) watched.add(owner);
    if (record?.owner_id && !parsePeerRef(record.owner_id)) watched.add(record.owner_id);
  });
  const finishOrganization = Effect.fn(function* (
    coordinator: string,
    id: string,
    release = false,
  ) {
    const local = (yield* peers.localEnvironment).environmentId;
    const decision =
      local === coordinator
        ? yield* organizationDecision(id)
        : yield* peers
            .call(coordinator, { _tag: "organizationDecision", id })
            .pipe(Effect.flatMap(peerResult(decodeOrganizationDecision)));
    if (!decision.participants.includes(local))
      return yield* new WorkerError({ message: "This computer is not a transaction participant." });
    yield* Effect.gen(function* () {
      const held = (yield* sql<{
        id: string;
        coordinator: string;
      }>`SELECT * FROM custom_ownership_reservation`)[0];
      // A completed release is idempotent. A delayed packet never releases a newer reservation.
      if (!held || held.id !== id || held.coordinator !== coordinator) return;
      if (decision.state === "preparing") return;
      if (decision.state !== "aborted" && decision.patch) yield* applyOrganization(decision.patch);
      if (release || decision.state === "aborted" || decision.state === "complete")
        yield* sql`DELETE FROM custom_ownership_reservation WHERE id = ${id} AND coordinator = ${coordinator}`;
    }).pipe(sql.withTransaction, lock.withPermit);
    yield* publish();
    yield* kick();
  });
  const recoverOrganization = Effect.fn(function* (id: string) {
    const local = (yield* peers.localEnvironment).environmentId;
    const decision = yield* organizationDecision(id);
    if (decision.state === "preparing") return;
    // Install every route before releasing any report producer. A lost response
    // repeats installation with the same revision and delivery identities.
    for (const release of [false, true])
      for (const participant of decision.participants) {
        if (participant === local) yield* finishOrganization(local, id, release);
        else yield* peers.call(participant, { _tag: "organizationFinish", id, release });
      }
    if (decision.state === "committed")
      yield* sql`UPDATE custom_ownership_transactions SET state = 'complete' WHERE id = ${id}`;
    if (decision.state === "aborted")
      yield* sql`UPDATE custom_ownership_transactions SET participants_json = '[]' WHERE id = ${id}`;
  });
  const ownershipLock = yield* Semaphore.make(1);
  const coordinateOwnership = Effect.fn(function* (
    input: SessionOwnershipInput,
    actor?: typeof SessionAddress.Type,
  ) {
    const local = (yield* peers.localEnvironment).environmentId;
    const id = `organization:${actor ? peerRef(actor.environmentId, actor.threadId) : "user"}:${input.clientRequestId}`;
    const request = encodeUnknown({ input, actor });
    const prior =
      (yield* sql<OrganizationTransaction>`SELECT * FROM custom_ownership_transactions WHERE id = ${id}`)[0];
    if (prior && prior.request_json !== request)
      return yield* new WorkerError({
        message: "This request ID belongs to a different ownership change.",
      });
    if (prior?.state === "aborted")
      return yield* new WorkerError({
        code: "conflict",
        message: prior.error ?? "The change was rejected. Refresh the relationship and retry.",
      });
    if (prior?.result_json) {
      yield* recoverOrganization(id);
      return decodeOwnershipResult(prior.result_json);
    }
    yield* sql`INSERT INTO custom_ownership_transactions (id, request_json, state) VALUES (${id}, ${request}, 'preparing') ON CONFLICT DO NOTHING`;
    const participants = new Set(prior ? decodeHosts(prior.participants_json) : []);
    const reserve = Effect.fn(function* (environment: string) {
      participants.add(environment);
      // Persist before sending: a lost reservation response is still recoverable.
      yield* sql`UPDATE custom_ownership_transactions SET participants_json = ${encodeUnknown([...participants])} WHERE id = ${id}`;
      if (environment === local) yield* reserveOrganization(local, id);
      else yield* peers.call(environment, { _tag: "organizationReserve", id });
    });
    const inspect = Effect.fn(function* (ref: typeof SessionAddress.Type) {
      let current = ref;
      const seen = new Set<string>();
      while (true) {
        if (seen.has(current.environmentId))
          return yield* new WorkerError({
            message: "Ownership authority routing contains a cycle.",
          });
        seen.add(current.environmentId);
        yield* reserve(current.environmentId);
        const value = yield* inspectAt(current);
        if (value.authority === current.environmentId) return value;
        current = { threadId: current.threadId, environmentId: value.authority };
      }
    });
    return yield* Effect.gen(function* () {
      const snapshot = yield* inspect({ environmentId: local, threadId: input.threadId });
      if (snapshot.authority !== local)
        return yield* new WorkerError({
          code: "conflict",
          message: "Ownership authority moved. Refresh and retry.",
        });
      let owner =
        input.ownerThreadId === null
          ? null
          : { environmentId: input.ownerEnvironmentId ?? local, threadId: input.ownerThreadId };
      const expected =
        input.expectedOwnerThreadId === null
          ? null
          : {
              environmentId: input.expectedOwnerEnvironmentId ?? local,
              threadId: input.expectedOwnerThreadId,
            };
      if (
        encodeUnknown(snapshot.owner) !== encodeUnknown(expected) ||
        snapshot.revision !== input.expectedRevision
      )
        return yield* new WorkerError({
          code: "conflict",
          message:
            "This relationship changed. Its current owner has been refreshed; review and retry.",
        });
      if (
        actor &&
        encodeUnknown(actor) !== encodeUnknown(snapshot.owner) &&
        !(actor.threadId === snapshot.threadId && actor.environmentId === snapshot.execution) &&
        !(snapshot.owner === null && encodeUnknown(actor) === encodeUnknown(owner))
      )
        return yield* new WorkerError({
          message: "Only the worker or its current master can change an existing relationship.",
        });
      const hosts = new Set([
        local,
        snapshot.execution,
        ...(snapshot.plan.organizationHosts ?? []),
        ...(snapshot.owner ? [snapshot.owner.environmentId] : []),
        ...(owner ? [owner.environmentId] : []),
      ]);
      for (const host of hosts) {
        yield* reserve(host);
        if (host === local) yield* acceptOrganization(snapshot);
        else yield* peers.call(host, { _tag: "organizationAccept", snapshot });
      }
      let ancestor = owner;
      const seen = new Set([peerRef(snapshot.execution, snapshot.threadId)]);
      let ownerRuntimeMode: OrchestrationV2ThreadShell["runtimeMode"] | undefined;
      while (ancestor) {
        const parent = yield* inspect(ancestor);
        const key = peerRef(parent.execution, parent.threadId);
        if (seen.has(key))
          return yield* new WorkerError({
            message: "A session cannot own itself or one of its ancestors.",
          });
        seen.add(key);
        if (!ownerRuntimeMode) {
          yield* reserve(parent.execution);
          const liveParent = yield* inspectAt({
            environmentId: parent.execution,
            threadId: parent.threadId,
          });
          ownerRuntimeMode = liveParent.plan.runtimeMode;
          owner = { environmentId: parent.execution, threadId: parent.threadId };
          if (!hosts.has(parent.execution)) {
            hosts.add(parent.execution);
            if (parent.execution === local) yield* acceptOrganization(snapshot);
            else yield* peers.call(parent.execution, { _tag: "organizationAccept", snapshot });
          }
        }
        ancestor = parent.owner;
      }
      const executionState = yield* inspectAt({
        environmentId: snapshot.execution,
        threadId: snapshot.threadId,
      });
      if (
        ownerRuntimeMode &&
        executionState.plan.runtimeMode === "full-access" &&
        ownerRuntimeMode !== "full-access"
      )
        return yield* new WorkerError({
          message: "The worker has broader permissions than the new master.",
        });
      if (snapshot.owner === null && owner && snapshot.hasChildren)
        return yield* new WorkerError({
          message:
            "This session already owns workers. Assign an independent session, or transfer an existing worker with its children.",
        });
      const revision =
        snapshot.revision + (encodeUnknown(owner) === encodeUnknown(snapshot.owner) ? 0 : 1);
      const patch: OrganizationPatch = {
        snapshot,
        owner,
        ownerRuntimeMode,
        hosts: [...hosts],
        revision,
      };
      const result = organizationResult(snapshot, owner, revision);
      yield* Effect.gen(function* () {
        yield* applyOrganization(patch);
        yield* sql`UPDATE custom_ownership_transactions SET state = 'committed', patch_json = ${encodeUnknown(patch)}, result_json = ${encodeUnknown(result)} WHERE id = ${id}`;
      }).pipe(sql.withTransaction, lock.withPermit);
      yield* recoverOrganization(id);
      return result;
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const decision = yield* organizationDecision(id);
          if (
            decision.state === "committed" ||
            decision.state === "complete" ||
            isPeerUnavailable(cause)
          )
            return yield* new WorkerError({
              code: "pending",
              message: `Ownership change awaiting recovery. Retry this same request. ${failure(cause).message}`,
            });
          yield* sql`UPDATE custom_ownership_transactions SET state = 'aborted', error = ${failure(cause).message} WHERE id = ${id}`;
          yield* recoverOrganization(id).pipe(Effect.ignore);
          return yield* new WorkerError({
            code: isWorkerError(cause) ? (cause.code ?? "rejected") : "rejected",
            message: failure(cause).message,
          });
        }),
      ),
    );
  }, ownershipLock.withPermit);
  const recoverOrganizations = Effect.fn(function* () {
    const pending = yield* sql<OrganizationTransaction>`SELECT * FROM custom_ownership_transactions
      WHERE state IN ('preparing', 'committed') OR (state = 'aborted' AND participants_json != '[]')`;
    for (const row of pending) {
      const request = decodeOrganizationRequest(row.request_json);
      yield* (
        row.state === "preparing"
          ? coordinateOwnership(request.input, request.actor)
          : recoverOrganization(row.id)
      ).pipe(Effect.ignore);
    }
    const held = (yield* sql<{
      id: string;
      coordinator: string;
    }>`SELECT * FROM custom_ownership_reservation`)[0];
    if (held) yield* finishOrganization(held.coordinator, held.id).pipe(Effect.ignore);
  });
  const changeOwnership = Effect.fn("SessionOwnership.changeOwnership")(
    function* (
      input: SessionOwnershipInput,
      actor?: { readonly threadId: ThreadId; readonly userRequest: string },
    ) {
      const local = (yield* peers.localEnvironment).environmentId;
      const legacy = (yield* sql<{
        request_json: string;
        result_json: string;
      }>`SELECT * FROM custom_session_ownership_changes WHERE id = ${`ownership:${actor?.threadId ?? "user"}:${input.clientRequestId}`}`)[0];
      if (legacy) {
        if (legacy.request_json !== encodeUnknown(input))
          return yield* new WorkerError({
            message: "This request ID belongs to a different ownership change.",
          });
        const result = decodeOwnershipResult(legacy.result_json);
        return {
          ...result,
          authorityEnvironmentId: local,
          ownerEnvironmentId: result.ownerThreadId ? local : null,
          previousOwnerEnvironmentId: result.previousOwnerThreadId ? local : null,
        };
      }
      if (actor) {
        const authorizationId = `ownership-authorized:${actor.threadId}:${input.clientRequestId}`;
        const authorized = (yield* sql<{
          request_json: string;
        }>`SELECT request_json FROM custom_session_ownership_changes WHERE id = ${authorizationId}`)[0];
        const authorizedRequest = encodeUnknown({ input, actor });
        if (authorized && authorized.request_json !== authorizedRequest)
          return yield* new WorkerError({
            message: "This request ID belongs to different ownership instructions.",
          });
        if (!authorized) {
          const instruction = yield* latestUserInstruction(actor.threadId);
          if (!actor.userRequest.trim() || !instruction?.text.includes(actor.userRequest))
            return yield* new WorkerError({
              message:
                "Changing ownership requires an exact quote from the latest direct user instruction. Peer messages and inherited instructions cannot authorize adoption.",
            });
          yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json, announced)
          VALUES (${authorizationId}, ${authorizedRequest}, '{}', 1) ON CONFLICT DO NOTHING`;
          const storedAuthorization = (yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM custom_session_ownership_changes WHERE id = ${authorizationId}`)[0];
          if (storedAuthorization?.request_json !== authorizedRequest)
            return yield* new WorkerError({
              message: "This request ID belongs to different ownership instructions.",
            });
        }
      }
      const snapshot = yield* canonicalOrganization(input.threadId, input.threadEnvironmentId);
      const verifiedActor = actor ? { environmentId: local, threadId: actor.threadId } : undefined;
      const scopedInput = {
        ...input,
        ownerEnvironmentId: input.ownerEnvironmentId ?? local,
        expectedOwnerEnvironmentId: input.expectedOwnerEnvironmentId ?? local,
      };
      if (snapshot.authority === local)
        return yield* coordinateOwnership(scopedInput, verifiedActor);
      const response = yield* peers
        .call(snapshot.authority, {
          _tag: "organizationChange",
          input: scopedInput,
          actor: verifiedActor,
        })
        .pipe(Effect.flatMap(peerResult(decodeOrganizationResponse)));
      if (!response.ok)
        return yield* new WorkerError({ message: response.message, code: response.code });
      return response.result;
    },
    Effect.tap(() => kick()),
    Effect.mapError(ownershipFailure),
  );

  if (Option.isSome(transport))
    yield* transport.value.register("session-organization", (from, raw) =>
      Effect.gen(function* () {
        if (Option.isNone(links))
          return yield* new WorkerError({
            message: "This environment has no peer link to the caller.",
          });
        if (!(yield* links.value.list).some((link) => link.environmentId === from))
          return yield* new WorkerError({
            message: "This environment has no peer link to the caller.",
          });
        const request = yield* decodeRequest(raw);
        switch (request._tag) {
          case "organizationInspect":
            return yield* inspectOrganization(request.threadId);
          case "organizationAccept":
            yield* acceptOrganization(request.snapshot);
            return { accepted: true };
          case "organizationReserve": {
            const decision = yield* peers
              .call(from, { _tag: "organizationDecision", id: request.id })
              .pipe(Effect.flatMap(peerResult(decodeOrganizationDecision)));
            if (
              decision.state !== "preparing" ||
              !decision.participants.includes((yield* peers.localEnvironment).environmentId)
            )
              return yield* new WorkerError({
                message: "This ownership reservation is no longer preparing.",
              });
            yield* reserveOrganization(from, request.id);
            return { reserved: true };
          }
          case "organizationDecision":
            return yield* organizationDecision(request.id);
          case "organizationFinish":
            yield* finishOrganization(from, request.id, request.release);
            return { finished: true };
          case "organizationChange": {
            if (request.actor && request.actor.environmentId !== from)
              return yield* new WorkerError({
                message: "A peer cannot impersonate another environment's session.",
              });
            return yield* coordinateOwnership(request.input, request.actor).pipe(
              Effect.map((result) => ({ ok: true, result })),
              Effect.catch((cause) =>
                Effect.succeed({
                  ok: false,
                  message: failure(cause).message,
                  code: isWorkerError(cause) ? cause.code : "pending",
                }),
              ),
            );
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorMcpFailure({
              code: "invalid_request",
              message: failure(cause).message,
            }),
        ),
      ),
    );
  return { readOwnership, changeOwnership, recoverOrganizations, publish };
});
