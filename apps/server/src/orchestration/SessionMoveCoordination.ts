import { SessionMoveError, ThreadId, ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Files from "../project/SessionMoveFiles.ts";
import { PeerLinks } from "./PeerLinks.ts";
import { WorkerControls } from "./WorkerControls.ts";

type WorkerRow = {
  thread_id: string;
  owner_id: string | null;
  source_id: string | null;
  plan_json: string;
  baseline: number;
  state: string;
  error: string | null;
  notify: number;
  read_seq: number;
  read_offset: number;
};
type JobRow = {
  id: string;
  worker_id: string;
  target_id: string;
  kind: string;
  prompt: string;
  created_at: string;
  state: string;
  attempt: number;
  turn_id: string | null;
  error: string | null;
  reported: number;
  dispatched_at: string | null;
  policy_json: string | null;
  report_ids_json: string | null;
};
type Coordination = {
  worker: WorkerRow | null;
  children: ReadonlyArray<WorkerRow>;
  jobs: ReadonlyArray<JobRow>;
  aliases: ReadonlyArray<{ incoming_id: string; job_id: string; thread_id: string }>;
  authority: {
    thread_id: string;
    active: number;
    successor_id: string | null;
    retired_sequence: number;
    revision: number;
    retirement_warned: number;
  } | null;
  handoffs: ReadonlyArray<{
    thread_id: string;
    owner_id: string;
    plan_json: string;
    state: string;
    error: string | null;
    transferred_json: string;
  }>;
};
const encode = (value: unknown) => JSON.stringify(value);
const WorkerSchema = Schema.Struct({
  thread_id: Schema.String,
  owner_id: Schema.NullOr(Schema.String),
  source_id: Schema.NullOr(Schema.String),
  plan_json: Schema.String,
  baseline: Schema.Number,
  state: Schema.String,
  error: Schema.NullOr(Schema.String),
  notify: Schema.Number,
  read_seq: Schema.Number,
  read_offset: Schema.Number,
});
const JobSchema = Schema.Struct({
  id: Schema.String,
  worker_id: Schema.String,
  target_id: Schema.String,
  kind: Schema.String,
  prompt: Schema.String,
  created_at: Schema.String,
  state: Schema.String,
  attempt: Schema.Number,
  turn_id: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  reported: Schema.Number,
  dispatched_at: Schema.NullOr(Schema.String),
  policy_json: Schema.NullOr(Schema.String),
  report_ids_json: Schema.NullOr(Schema.String),
});
const CoordinationSchema = Schema.Struct({
  worker: Schema.NullOr(WorkerSchema),
  children: Schema.Array(WorkerSchema),
  jobs: Schema.Array(JobSchema),
  aliases: Schema.Array(
    Schema.Struct({ incoming_id: Schema.String, job_id: Schema.String, thread_id: Schema.String }),
  ),
  authority: Schema.NullOr(
    Schema.Struct({
      thread_id: Schema.String,
      active: Schema.Number,
      successor_id: Schema.NullOr(Schema.String),
      retired_sequence: Schema.Number,
      revision: Schema.Number,
      retirement_warned: Schema.Number,
    }),
  ),
  handoffs: Schema.Array(
    Schema.Struct({
      thread_id: Schema.String,
      owner_id: Schema.String,
      plan_json: Schema.String,
      state: Schema.String,
      error: Schema.NullOr(Schema.String),
      transferred_json: Schema.String,
    }),
  ),
});
const RelocationSchema = Schema.Struct({
  kind: Schema.Literals(["owner", "execution"]),
  workerId: Schema.String,
  masterId: Schema.NullOr(Schema.String),
  targetEnvironmentId: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
});
const decodeCoordination = Schema.decodeUnknownEffect(CoordinationSchema);
const decodeRelocation = Schema.decodeUnknownEffect(RelocationSchema);
const plan = (worker: WorkerRow): Record<string, unknown> => JSON.parse(worker.plan_json);
const peerRef = (environment: string, thread: string) => `peer:${environment}:${thread}`;
const splitPeer = (value: string) => {
  const match = /^peer:([^:]+):(.+)$/.exec(value);
  return match ? { environment: match[1]!, thread: match[2]! } : null;
};
const address = (value: string, source: string, destination: string) => {
  const parsed = splitPeer(value) ?? { environment: source, thread: value };
  return parsed.environment === destination
    ? parsed.thread
    : peerRef(parsed.environment, parsed.thread);
};

/** Worker execution stays on its current machine; only addresses and durable receipts move. */
export const makeCoordination = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workers = yield* WorkerControls;
  const peers = yield* PeerLinks;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const local = yield* peers.localEnvironment;
  const get = Effect.fn(function* (id: string) {
    return (yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE thread_id = ${id}`)[0];
  });
  const snapshot = Effect.fn(function* (threadId: string) {
    return {
      worker: (yield* get(threadId)) ?? null,
      children: yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE owner_id = ${threadId}`,
      jobs: yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
        WHERE worker_id = ${threadId} OR target_id = ${threadId}`,
      aliases: yield* sql<{ incoming_id: string; job_id: string; thread_id: string }>`SELECT *
        FROM custom_session_move_job_aliases WHERE thread_id = ${threadId}`,
      authority:
        (yield* sql<
          NonNullable<Coordination["authority"]>
        >`SELECT * FROM custom_orchestrator_authority WHERE thread_id = ${threadId}`)[0] ?? null,
      handoffs: yield* sql<
        Coordination["handoffs"][number]
      >`SELECT * FROM custom_orchestrator_handoffs WHERE owner_id = ${threadId} AND state != 'queued'`,
    };
  });
  const putWorker = Effect.fn(function* (value: WorkerRow) {
    yield* sql`INSERT INTO custom_workers
      (thread_id, owner_id, source_id, plan_json, baseline, state, error, notify, read_seq, read_offset)
      VALUES (${value.thread_id}, ${value.owner_id}, ${value.source_id}, ${value.plan_json}, ${value.baseline}, ${value.state}, ${value.error}, ${value.notify}, ${value.read_seq}, ${value.read_offset})
      ON CONFLICT(thread_id) DO UPDATE SET owner_id = excluded.owner_id, source_id = excluded.source_id,
        plan_json = excluded.plan_json, baseline = excluded.baseline, state = excluded.state,
        error = excluded.error, notify = excluded.notify, read_seq = excluded.read_seq, read_offset = excluded.read_offset`;
  });
  const putJob = Effect.fn(function* (value: JobRow) {
    const existing =
      (yield* sql<JobRow>`SELECT * FROM custom_worker_jobs WHERE id = ${value.id}`)[0];
    if (existing) {
      if (
        existing.worker_id !== value.worker_id ||
        existing.prompt !== value.prompt ||
        existing.kind !== value.kind
      )
        return yield* new SessionMoveError({
          message: "A transferred assignment/report conflicts with an existing receipt.",
        });
      if (existing.state === "queued" && value.state === "completed")
        yield* sql`UPDATE custom_worker_jobs SET state = 'completed', reported = ${value.reported}
          WHERE id = ${existing.id} AND state = 'queued'`;
      return;
    }
    yield* sql`INSERT INTO custom_worker_jobs
      (id, worker_id, target_id, kind, prompt, created_at, state, attempt, turn_id, error, reported, dispatched_at, policy_json, report_ids_json)
      VALUES (${value.id}, ${value.worker_id}, ${value.target_id}, ${value.kind}, ${value.prompt}, ${value.created_at}, ${value.state}, ${value.attempt}, ${value.turn_id}, ${value.error}, ${value.reported}, ${value.dispatched_at}, ${value.policy_json}, ${value.report_ids_json})`;
  });
  const importState = Effect.fn(
    function* (source: string, threadId: ThreadId, raw: unknown, selection: ModelSelection) {
      const value = yield* decodeCoordination(raw).pipe(
        Effect.mapError(
          () => new SessionMoveError({ message: "Invalid worker coordination state." }),
        ),
      );
      if (value.authority) {
        if (value.authority.thread_id !== threadId)
          return yield* new SessionMoveError({
            message: "Unrelated master authority in transfer.",
          });
        const seq = yield* sql<{
          value: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events WHERE stream_id = ${threadId}
          AND CAST(json_extract(metadata_json, '$.moveSourceSequence') AS INTEGER) <= ${value.authority.retired_sequence}`;
        yield* sql`INSERT INTO custom_orchestrator_authority (thread_id, active, successor_id, retired_sequence, revision, retirement_warned)
          VALUES (${threadId}, ${value.authority.active}, ${value.authority.successor_id}, ${seq[0]!.value}, ${value.authority.revision}, ${value.authority.retirement_warned})
          ON CONFLICT(thread_id) DO UPDATE SET active = excluded.active, successor_id = excluded.successor_id, retired_sequence = excluded.retired_sequence,
            revision = excluded.revision, retirement_warned = excluded.retirement_warned`;
      }
      for (const handoff of value.handoffs) {
        if (handoff.owner_id !== threadId || handoff.state === "queued")
          return yield* new SessionMoveError({ message: "Unrelated handoff in transfer." });
        yield* sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json, state, error, transferred_json)
          VALUES (${handoff.thread_id}, ${handoff.owner_id}, ${handoff.plan_json}, ${handoff.state}, ${handoff.error}, ${handoff.transferred_json})
          ON CONFLICT(thread_id) DO NOTHING`;
      }
      if (value.worker) {
        if (value.worker.thread_id !== threadId)
          return yield* new SessionMoveError({ message: "Unrelated worker in transfer." });
        const sourcePlan = plan(value.worker);
        delete sourcePlan.environmentId;
        if (value.worker.owner_id === null && sourcePlan.authorityEnvironmentId === undefined)
          sourcePlan.authorityEnvironmentId = source;
        if (sourcePlan.authorityEnvironmentId === local.environmentId) {
          delete sourcePlan.authorityEnvironmentId;
          delete sourcePlan.authorityRevision;
        }
        const translated = yield* sql<{ baseline: number; read_seq: number }>`SELECT
        COALESCE(MAX(CASE WHEN CAST(json_extract(metadata_json, '$.moveSourceSequence') AS INTEGER) <= ${value.worker.baseline} THEN sequence END), 0) AS baseline,
        COALESCE(MAX(CASE WHEN CAST(json_extract(metadata_json, '$.moveSourceSequence') AS INTEGER) <= ${value.worker.read_seq} THEN sequence END), 0) AS read_seq
        FROM orchestration_events WHERE stream_id = ${threadId}`;
        yield* putWorker({
          ...value.worker,
          owner_id:
            value.worker.owner_id === null
              ? null
              : address(value.worker.owner_id, source, local.environmentId),
          state: "ready",
          baseline: translated[0]!.baseline,
          read_seq: translated[0]!.read_seq,
          plan_json: encode({ ...sourcePlan, modelSelection: selection }),
        });
      }
      for (const child of value.children) {
        if (child.owner_id !== threadId)
          return yield* new SessionMoveError({ message: "Unrelated owned worker in transfer." });
        const sourcePlan = plan(child);
        delete sourcePlan.authorityEnvironmentId;
        delete sourcePlan.authorityRevision;
        const executionEnvironment = child.state === "remote" ? sourcePlan.environmentId : source;
        if (typeof executionEnvironment !== "string")
          return yield* new SessionMoveError({
            message: "A worker's execution computer is missing.",
          });
        if (executionEnvironment === local.environmentId) {
          const native = yield* get(child.thread_id);
          if (
            !native ||
            (native.owner_id !== peerRef(source, threadId) && native.owner_id !== threadId)
          )
            return yield* new SessionMoveError({
              message: "A destination worker changed ownership while moving its master.",
            });
          const nativePlan = plan(native);
          delete nativePlan.authorityEnvironmentId;
          delete nativePlan.authorityRevision;
          yield* sql`UPDATE custom_workers SET owner_id = ${threadId}, plan_json = ${encode(nativePlan)} WHERE thread_id = ${child.thread_id}`;
        } else {
          if (Option.isNone(yield* peers.resolve(executionEnvironment)))
            return yield* new SessionMoveError({
              message: "The destination must be linked to every existing worker's computer.",
            });
          yield* putWorker({
            ...child,
            owner_id: threadId,
            state: "remote",
            plan_json: encode({ ...sourcePlan, environmentId: executionEnvironment }),
          });
        }
      }
      for (const job of value.jobs) {
        if (job.kind === "message") continue; // Peer confirmations are bound to their original addresses.
        if (job.worker_id !== threadId && job.target_id !== threadId)
          return yield* new SessionMoveError({ message: "Unrelated pending work in transfer." });
        yield* putJob({
          ...job,
          id: job.id,
          target_id:
            job.target_id === threadId
              ? threadId
              : address(job.target_id, source, local.environmentId),
          report_ids_json: job.report_ids_json,
        });
        if (job.worker_id !== threadId && !job.id.startsWith("peer:"))
          yield* sql`INSERT INTO custom_session_move_job_aliases (incoming_id, job_id, thread_id)
            VALUES (${peerRef(source, job.id)}, ${job.id}, ${threadId}) ON CONFLICT(incoming_id) DO NOTHING`;
      }
      for (const alias of value.aliases ?? []) {
        if (alias.thread_id !== threadId)
          return yield* new SessionMoveError({ message: "Unrelated report alias in transfer." });
        yield* sql`INSERT INTO custom_session_move_job_aliases (incoming_id, job_id, thread_id)
          VALUES (${alias.incoming_id}, ${alias.job_id}, ${threadId}) ON CONFLICT(incoming_id) DO NOTHING`;
      }
    },
    (effect) => workers.withCoordinationLock(sql.withTransaction(effect)),
  );
  const relocate = Effect.fn(
    function* (from: string, raw: unknown) {
      const change = yield* decodeRelocation(raw).pipe(
        Effect.mapError(() => new SessionMoveError({ message: "Invalid worker relocation." })),
      );
      if (
        !change ||
        !["owner", "execution"].includes(change.kind) ||
        typeof change.workerId !== "string" ||
        (change.masterId !== null && typeof change.masterId !== "string") ||
        typeof change.targetEnvironmentId !== "string"
      )
        return yield* new SessionMoveError({ message: "Invalid worker relocation." });
      if (Option.isNone(yield* peers.resolve(change.targetEnvironmentId)))
        return yield* new SessionMoveError({
          message: "The worker's computer must be linked to the destination.",
        });
      const worker = yield* get(change.workerId);
      if (!worker)
        return yield* new SessionMoveError({ message: "The relocated worker no longer exists." });
      if (change.kind === "owner") {
        if (change.masterId === null)
          return yield* new SessionMoveError({
            message: "An owner relocation requires its master.",
          });
        const oldOwner = peerRef(from, change.masterId);
        const nextOwner = peerRef(change.targetEnvironmentId, change.masterId);
        if (worker.owner_id !== oldOwner && worker.owner_id !== nextOwner)
          return yield* new SessionMoveError({
            message: "Only the current master computer may relocate ownership.",
          });
        const relocatedPlan = plan(worker);
        delete relocatedPlan.authorityRevision;
        relocatedPlan.authorityEnvironmentId = change.targetEnvironmentId;
        yield* sql`UPDATE custom_workers SET owner_id = ${nextOwner}, plan_json = ${encode(relocatedPlan)} WHERE thread_id = ${worker.thread_id}`;
        yield* sql`UPDATE custom_worker_jobs SET target_id = ${nextOwner} WHERE worker_id = ${worker.thread_id}
        AND target_id = ${oldOwner} AND state = 'queued' AND kind IN ('notice', 'done', 'blocked')`;
      } else {
        const current = plan(worker);
        if (
          worker.owner_id !== change.masterId ||
          worker.state !== "remote" ||
          (current.environmentId !== from && current.environmentId !== change.targetEnvironmentId)
        )
          return yield* new SessionMoveError({
            message: "Only the worker's current computer may relocate execution.",
          });
        yield* sql`UPDATE custom_workers SET plan_json = ${encode({
          ...current,
          environmentId: change.targetEnvironmentId,
          ...(change.modelSelection ? { modelSelection: change.modelSelection } : {}),
        })} WHERE thread_id = ${worker.thread_id}`;
      }
      return { relocated: true };
    },
    (effect) => workers.withCoordinationLock(sql.withTransaction(effect)),
  );
  const finish = Effect.fn(function* (
    threadId: ThreadId,
    destination: string,
    requestId: string,
    selection: ModelSelection,
  ) {
    const state = yield* snapshot(threadId);
    // Install receipts and proxies before producers start reporting to the new master.
    const staging = Files.moveDirectory(config.stateDir, requestId);
    const filename = path.join(staging, "coordination-live.json");
    yield* fs.writeFileString(filename, encode(state));
    const file = yield* Effect.tryPromise(() =>
      Files.copyMoveFile({
        source: filename,
        sourceRoot: staging,
        staging,
        kind: "history",
        name: "coordination-live.json",
      }),
    );
    if (file.bytes > 64 * 1024 * 1024)
      return yield* new SessionMoveError({
        message: "Worker coordination exceeds the transfer budget.",
      });
    for (let offset = 0; offset < file.bytes; offset += Files.MOVE_CHUNK_BYTES) {
      const data = yield* Effect.tryPromise(() => Files.readMoveChunk(staging, file, offset));
      yield* peers.call(
        destination,
        { _tag: "sessionMove", op: "coordination", requestId, coordination: file, offset, data },
        120_000,
      );
    }
    yield* peers.call(
      destination,
      { _tag: "sessionMove", op: "coordination", requestId, coordination: file },
      120_000,
    );
    if (state.worker) {
      const owner = state.worker.owner_id === null ? null : splitPeer(state.worker.owner_id);
      const authority = owner?.environment ?? plan(state.worker).authorityEnvironmentId;
      if (typeof authority === "string" && authority !== destination)
        yield* peers.call(authority, {
          _tag: "sessionMove",
          op: "relocate",
          requestId,
          relocation: {
            kind: "execution",
            workerId: threadId,
            masterId: owner?.thread ?? null,
            targetEnvironmentId: destination,
            modelSelection: selection,
          },
        });
      // When the owner is on the destination, it already restored its local owner
      // address. Retain the source copy only as a forwarding proxy for late calls.
      yield* putWorker({
        ...state.worker,
        state: "remote",
        plan_json: encode({
          ...plan(state.worker),
          environmentId: destination,
          modelSelection: selection,
        }),
      });
      yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE worker_id = ${threadId} AND state = 'queued' AND kind != 'message'`;
    }
    for (const child of state.children) {
      const sourcePlan = plan(child);
      const environment =
        child.state === "remote" ? (sourcePlan.environmentId as string) : local.environmentId;
      if (environment !== local.environmentId && environment !== destination)
        yield* peers.call(environment, {
          _tag: "sessionMove",
          op: "relocate",
          requestId,
          relocation: {
            kind: "owner",
            workerId: child.thread_id,
            masterId: threadId,
            targetEnvironmentId: destination,
          },
        });
      delete sourcePlan.authorityRevision;
      yield* sql`UPDATE custom_workers SET owner_id = ${peerRef(destination, threadId)},
        plan_json = ${encode({ ...sourcePlan, authorityEnvironmentId: destination })}
        WHERE thread_id = ${child.thread_id} AND owner_id = ${threadId}`;
      // The destination now owns synchronization. Do not retry an obsolete
      // authority's outbox against a worker after the master has moved.
      yield* sql`UPDATE custom_session_ownership_changes SET announced = 1
        WHERE json_extract(result_json, '$.threadId') = ${child.thread_id}`;
    }
    // Reports that arrived after capture are forwarded with their original receipt
    // identities. The destination deduplicates those against the imported receipts.
    yield* sql`UPDATE custom_worker_jobs SET target_id = ${peerRef(destination, threadId)}
      WHERE target_id = ${threadId} AND kind IN ('notice', 'done', 'blocked') AND state = 'queued'`;
  }, workers.withCoordinationLock);
  return { importState, relocate, finish };
});
