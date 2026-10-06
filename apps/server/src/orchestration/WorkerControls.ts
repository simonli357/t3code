import {
  CommandId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationThreadShell,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkThread } from "../project/ThreadFork.ts";

export class WorkerError extends Schema.TaggedError<WorkerError>()("WorkerError", {
  message: Schema.String,
}) {}
export const SpawnInput = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  prompt: TrimmedNonEmptyString,
});
export const SendInput = Schema.Struct({
  threadId: ThreadId,
  clientRequestId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
export const ReadInput = Schema.Struct({
  threadId: ThreadId,
  afterSequence: Schema.optional(NonNegativeInt),
  textOffset: Schema.optional(NonNegativeInt),
  includeProgress: Schema.optional(Schema.Boolean),
});
export const WaitInput = Schema.Struct({
  threadId: ThreadId,
  requestId: TrimmedNonEmptyString,
  timeoutMs: Schema.optional(NonNegativeInt),
});
export const ControlInput = Schema.Struct({
  threadId: ThreadId,
  notifications: Schema.optional(Schema.Boolean),
  cancelRequestId: Schema.optional(TrimmedNonEmptyString),
});
const JobState = Schema.Literals([
  "queued",
  "submitted",
  "completed",
  "error",
  "interrupted",
  "cancelled",
]);
export const JobResult = Schema.Struct({
  requestId: Schema.String,
  threadId: ThreadId,
  state: JobState,
  turnId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export const WorkerResult = Schema.Struct({
  threadId: ThreadId,
  ownerThreadId: ThreadId,
  sourceThreadId: ThreadId,
  title: Schema.String,
  modelSelection: ModelSelection,
  state: Schema.String,
  error: Schema.NullOr(Schema.String),
  notifications: Schema.Boolean,
  latestRequest: Schema.NullOr(JobResult),
  pendingReports: Schema.Number,
  deliveryError: Schema.NullOr(Schema.String),
});
export const ReadResult = Schema.Struct({
  worker: WorkerResult,
  items: Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      kind: Schema.String,
      text: Schema.String,
      streaming: Schema.Boolean,
    }),
  ),
  nextSequence: Schema.Number,
  nextTextOffset: Schema.Number,
  hasMore: Schema.Boolean,
});
export const WaitResult = Schema.Struct({ request: JobResult, timedOut: Schema.Boolean });
type Job = {
  id: string;
  worker_id: string;
  target_id: string;
  kind: string;
  prompt: string;
  created_at: string;
  state: typeof JobState.Type;
  attempt: number;
  turn_id: string | null;
  error: string | null;
  reported: number;
  dispatched_at: string | null;
};
type Worker = {
  thread_id: string;
  owner_id: string;
  source_id: string;
  plan_json: string;
  baseline: number;
  state: string;
  error: string | null;
  notify: number;
  read_seq: number;
  read_offset: number;
};
const Plan = Schema.Struct({
  ...SpawnInput.fields,
  runtimeMode: OrchestrationThreadShell.fields.runtimeMode,
  interactionMode: OrchestrationThreadShell.fields.interactionMode,
});
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(Plan));
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePlan = Schema.encodeSync(Schema.fromJsonString(Plan));
const terminal = (state: string) =>
  ["completed", "error", "interrupted", "cancelled"].includes(state);
const jobResult = (job: Job): typeof JobResult.Type => ({
  requestId: job.id,
  threadId: ThreadId.make(job.worker_id),
  state: job.state,
  turnId: job.turn_id,
  error: job.error,
});
const isWorkerError = Schema.is(WorkerError);
const failure = (cause: unknown) =>
  isWorkerError(cause)
    ? cause
    : new WorkerError({
        message: cause instanceof Error ? cause.message : String(cause),
      });
const selectionKey = (value: typeof ModelSelection.Type) =>
  JSON.stringify({
    ...value,
    options: [...(value.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  });

export class WorkerControls extends Context.Service<
  WorkerControls,
  {
    readonly spawn: (
      owner: ThreadId,
      input: typeof SpawnInput.Type,
    ) => Effect.Effect<typeof WorkerResult.Type, WorkerError>;
    readonly list: (
      owner: ThreadId,
    ) => Effect.Effect<ReadonlyArray<typeof WorkerResult.Type>, WorkerError>;
    readonly read: (
      owner: ThreadId,
      input: typeof ReadInput.Type,
    ) => Effect.Effect<typeof ReadResult.Type, WorkerError>;
    readonly send: (
      owner: ThreadId,
      input: typeof SendInput.Type,
    ) => Effect.Effect<typeof JobResult.Type, WorkerError>;
    readonly wait: (
      owner: ThreadId,
      input: typeof WaitInput.Type,
    ) => Effect.Effect<typeof WaitResult.Type, WorkerError>;
    readonly control: (
      owner: ThreadId,
      input: typeof ControlInput.Type,
    ) => Effect.Effect<typeof WorkerResult.Type, WorkerError>;
    readonly start: () => Effect.Effect<void, WorkerError, Scope.Scope>;
    readonly drain: () => Effect.Effect<void, WorkerError>;
  }
>()("t3/orchestration/WorkerControls") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const provider = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const catalog = yield* ProviderRegistry;
  const lock = yield* Semaphore.make(1);
  const persisted = yield* sql<Worker>`SELECT * FROM custom_workers`;
  const watched = new Set(persisted.flatMap((worker) => [worker.thread_id, worker.owner_id]));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const thread = Effect.fn(function* (id: string) {
    const result = yield* snapshots.getThreadShellById(ThreadId.make(id));
    if (Option.isNone(result))
      return yield* new WorkerError({ message: `Thread ${id} no longer exists.` });
    return result.value;
  });
  const owned = Effect.fn(function* (owner: ThreadId, id: string) {
    const rows =
      yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${id} AND owner_id = ${owner}`;
    if (!rows[0])
      return yield* new WorkerError({
        message: `Thread ${id} is not a worker owned by this master.`,
      });
    return rows[0];
  });
  const getJob = Effect.fn(function* (worker: Worker, id: string) {
    const rows =
      yield* sql<Job>`SELECT * FROM custom_worker_jobs WHERE id = ${id} AND worker_id = ${worker.thread_id} AND kind = 'work'`;
    if (!rows[0]) return yield* new WorkerError({ message: `Unknown assignment ${id}.` });
    return rows[0];
  });
  const describe = Effect.fn(function* (worker: Worker) {
    const plan = decodePlan(worker.plan_json);
    const latest =
      yield* sql<Job>`SELECT * FROM custom_worker_jobs WHERE worker_id = ${worker.thread_id} AND kind = 'work' ORDER BY rowid DESC LIMIT 1`;
    const status = yield* snapshots.getThreadShellById(plan.threadId);
    const notices = yield* sql<{ pending: number; error: string | null }>`SELECT
      COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS pending,
      MAX(CASE WHEN state = 'error' THEN error END) AS error
      FROM custom_worker_jobs WHERE worker_id = ${worker.thread_id} AND kind = 'notice'`;
    const state =
      worker.state !== "ready"
        ? worker.state
        : Option.isNone(status)
          ? "deleted"
          : status.value.hasPendingApprovals
            ? "needs-approval"
            : status.value.hasPendingUserInput
              ? "needs-input"
              : (latest[0]?.state ?? "ready");
    return {
      threadId: plan.threadId,
      ownerThreadId: ThreadId.make(worker.owner_id),
      sourceThreadId: plan.sourceThreadId,
      title: plan.title,
      modelSelection: plan.modelSelection,
      state,
      error: worker.error,
      notifications: worker.notify === 1,
      latestRequest: latest[0] ? jobResult(latest[0]) : null,
      pendingReports: notices[0]?.pending ?? 0,
      deliveryError: notices[0]?.error ?? null,
    } satisfies typeof WorkerResult.Type;
  });
  const busy = Effect.fn(function* (value: OrchestrationThreadShell) {
    if (
      value.session?.activeTurnId ||
      ["starting", "running"].includes(value.session?.status ?? "") ||
      value.latestTurn?.state === "running" ||
      value.hasPendingApprovals ||
      value.hasPendingUserInput
    )
      return true;
    const rows =
      yield* sql`SELECT 1 FROM projection_turns WHERE thread_id = ${value.id} AND state IN ('pending', 'running') LIMIT 1`;
    return rows.length > 0;
  });
  const enqueue = Effect.fn(function* (
    id: string,
    worker: Worker,
    target: string,
    kind: string,
    prompt: string,
  ) {
    const createdAt = yield* now;
    yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
      VALUES (${id}, ${worker.thread_id}, ${target}, ${kind}, ${prompt}, ${createdAt}) ON CONFLICT(id) DO NOTHING`;
    const rows = yield* sql<Job>`SELECT * FROM custom_worker_jobs WHERE id = ${id}`;
    const job = rows[0]!;
    if (
      job.worker_id !== worker.thread_id ||
      job.target_id !== target ||
      job.prompt !== prompt ||
      job.kind !== kind
    )
      return yield* new WorkerError({
        message:
          "This request ID already belongs to a different assignment. Reuse the original prompt or choose a new ID.",
      });
    return job;
  });
  const checkSelection = Effect.fn(function* (selection: typeof ModelSelection.Type) {
    const providers = yield* catalog.getProviders;
    const instance = providers.find((entry) => entry.instanceId === selection.instanceId);
    const model = instance?.models.find((entry) => entry.slug === selection.model);
    if (
      !instance?.enabled ||
      !instance.installed ||
      instance.availability === "unavailable" ||
      !model
    )
      return yield* new WorkerError({
        message: "The selected provider/model is unavailable; no substitution was made.",
      });
    for (const option of selection.options ?? []) {
      const descriptor = model.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === option.id,
      );
      if (
        !descriptor ||
        (descriptor.type === "select" &&
          !descriptor.options.some((entry) => entry.id === option.value))
      )
        return yield* new WorkerError({
          message: `Model ${selection.model} does not support ${option.id}=${option.value}.`,
        });
    }
  });
  const report = Effect.fn(function* (worker: Worker, job: Job, suffix: string, detail: string) {
    if (!worker.notify) return;
    const plan = decodePlan(worker.plan_json);
    yield* enqueue(
      `notice:${job.id}:${suffix}`,
      worker,
      worker.owner_id,
      "notice",
      `[T3 worker report — ${plan.title}]\nWorker: ${worker.thread_id}\nAssignment: ${job.id}\n${detail}\nUse t3_worker_read for output and t3_worker_send to continue this same worker. A finished turn is not acceptance of the assigned work. Do not reply just to acknowledge this report; continue only if the user's task requires it.`,
    );
  });

  const refreshJobs = Effect.fn(function* () {
    const jobs = yield* sql<Job>`SELECT * FROM custom_worker_jobs
      WHERE kind = 'work' AND (state = 'submitted' OR (reported = 0 AND state IN ('completed', 'error', 'interrupted')))
      ORDER BY rowid`;
    for (const job of jobs) {
      const workers =
        yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${job.worker_id}`;
      const worker = workers[0];
      if (!worker) continue;
      const turns = yield* sql<{
        state: string;
        turn_id: string | null;
      }>`SELECT state, turn_id FROM projection_turns
        WHERE thread_id = ${job.target_id} AND pending_message_id = ${`worker-job:${job.id}`} ORDER BY row_id DESC LIMIT 1`;
      const turn = turns[0];
      if (turn?.turn_id && turn.turn_id !== job.turn_id)
        yield* sql`UPDATE custom_worker_jobs SET turn_id = ${turn.turn_id} WHERE id = ${job.id}`;
      const session = yield* snapshots.getThreadShellById(ThreadId.make(job.target_id));
      let state = turn?.state ?? job.state;
      let error = job.error;
      if (state === "error" && !error && Option.isSome(session))
        error = session.value.session?.lastError ?? "Provider turn failed.";
      // Failed startup removes the pending placeholder without ever allocating a native turn.
      if (!turn && job.state === "submitted") {
        const failed = yield* sql<{
          summary: string;
        }>`SELECT summary FROM projection_thread_activities
          WHERE thread_id = ${job.target_id} AND kind = 'provider.turn.start.failed'
            AND json_extract(payload_json, '$.requestId') = ${`worker-job:${job.id}`} LIMIT 1`;
        if (
          failed[0] ||
          Option.isNone(session) ||
          (Option.isSome(session) &&
            ["error", "interrupted", "stopped"].includes(session.value.session?.status ?? ""))
        ) {
          state = "error";
          error =
            failed[0]?.summary ??
            (Option.isSome(session) ? session.value.session?.lastError : null) ??
            "Worker stopped before its turn started.";
        }
      }
      if (terminal(state)) {
        const replies = yield* sql<{ text: string }>`SELECT text FROM projection_thread_messages
          WHERE thread_id = ${job.target_id} AND turn_id = ${turn?.turn_id ?? job.turn_id} AND role = 'assistant'
          ORDER BY created_at DESC, message_id DESC LIMIT 1`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (worker.notify && !job.reported)
              yield* report(
                worker,
                job,
                "terminal",
                `State: ${state}${error ? `\nError: ${error}` : ""}\n${(replies[0]?.text ?? "").slice(0, 3000)}`,
              );
            yield* sql`UPDATE custom_worker_jobs SET state = ${state}, error = ${error},
            turn_id = ${turn?.turn_id ?? job.turn_id}, reported = ${worker.notify ? 1 : job.reported} WHERE id = ${job.id}`;
          }),
        );
      } else {
        const questions = yield* sql<{
          activity_id: string;
          summary: string;
          payload_json: string;
        }>`SELECT activity_id, summary, payload_json FROM projection_thread_activities AS a
          WHERE thread_id = ${job.target_id} AND turn_id IS ${turn?.turn_id ?? job.turn_id}
            AND created_at >= ${job.dispatched_at ?? job.created_at}
            AND kind IN ('user-input.requested', 'approval.requested')
            AND NOT EXISTS (SELECT 1 FROM custom_worker_jobs WHERE id = ${`notice:${job.id}:`} || a.activity_id)`;
        for (const question of questions)
          yield* report(
            worker,
            job,
            question.activity_id,
            `Needs input: ${question.summary}\n${question.payload_json.slice(0, 3000)}`,
          );
      }
    }
  });
  const drain = Effect.fn("WorkerControls.drain")(
    function* () {
      yield* refreshJobs();
      const jobs =
        yield* sql<Job>`SELECT * FROM custom_worker_jobs WHERE state = 'queued' ORDER BY rowid`;
      const blocked = new Set<string>();
      for (const job of jobs) {
        if (blocked.has(job.target_id)) continue;
        const workers =
          yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${job.worker_id}`;
        const worker = workers[0];
        if (!worker || worker.state !== "ready") continue;
        if (job.kind === "notice" && !worker.notify) continue;
        const attempt = Effect.gen(function* () {
          const commandId = CommandId.make(`worker-job:${job.id}:${job.attempt}`);
          const receipts = yield* sql<{
            status: string;
            error: string | null;
          }>`SELECT status, error FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
          if (receipts[0]?.status === "accepted") {
            yield* sql`UPDATE custom_worker_jobs SET state = ${job.kind === "notice" ? "completed" : "submitted"}, error = NULL WHERE id = ${job.id}`;
            return;
          }
          if (receipts[0]?.status === "rejected")
            return yield* new WorkerError({
              message: receipts[0].error ?? "Dispatch was rejected.",
            });
          const sequence = yield* engine.latestSequence;
          const target = yield* thread(job.target_id);
          if (target.archivedAt !== null || target.snoozedUntil != null || (yield* busy(target))) {
            blocked.add(job.target_id);
            return;
          }
          if (job.kind === "work") {
            const owner = yield* thread(worker.owner_id);
            if (target.runtimeMode === "full-access" && owner.runtimeMode !== "full-access")
              return yield* new WorkerError({
                message: "The worker has broader permissions than the master.",
              });
            const plan = decodePlan(worker.plan_json);
            if (
              selectionKey(target.modelSelection) !== selectionKey(plan.modelSelection) ||
              target.runtimeMode !== plan.runtimeMode ||
              target.interactionMode !== plan.interactionMode
            )
              return yield* new WorkerError({
                message:
                  "Worker settings changed outside this workflow. Restore its original provider/model/effort and modes before sending more work.",
              });
            yield* checkSelection(plan.modelSelection);
          }
          const dispatchedAt = job.dispatched_at ?? (yield* now);
          yield* sql`UPDATE custom_worker_jobs SET dispatched_at = ${dispatchedAt} WHERE id = ${job.id}`;
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId,
            threadId: target.id,
            expectedThreadSequence: sequence,
            message: {
              messageId: MessageId.make(`worker-job:${job.id}`),
              role: "user",
              text: job.prompt,
              attachments: [],
            },
            modelSelection: target.modelSelection,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt: dispatchedAt,
          });
          yield* sql`UPDATE custom_worker_jobs SET state = ${job.kind === "notice" ? "completed" : "submitted"}, error = NULL WHERE id = ${job.id}`;
          blocked.add(job.target_id);
        });
        yield* attempt.pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const message = failure(cause).message;
              if (message.includes("Worker dispatch precondition changed")) {
                blocked.add(job.target_id);
                yield* sql`UPDATE custom_worker_jobs SET attempt = attempt + 1 WHERE id = ${job.id}`;
                return;
              }
              yield* sql`UPDATE custom_worker_jobs SET state = 'error', error = ${message} WHERE id = ${job.id}`;

              yield* Effect.logWarning("Worker delivery failed", { requestId: job.id, message });
            }),
          ),
        );
      }
    },
    lock.withPermit,
    Effect.mapError(failure),
  );

  const spawn = Effect.fn("WorkerControls.spawn")(
    function* (owner: ThreadId, input: typeof SpawnInput.Type) {
      const parent = yield* thread(owner);
      if (input.threadId === owner || input.threadId === input.sourceThreadId)
        return yield* new WorkerError({ message: "A worker must have its own new thread ID." });
      const existing =
        yield* sql<Worker>`SELECT * FROM custom_workers WHERE thread_id = ${input.threadId}`;
      let worker = existing[0];
      if (worker) {
        const plan = decodePlan(worker.plan_json);
        if (
          worker.owner_id !== owner ||
          worker.source_id !== input.sourceThreadId ||
          plan.title !== input.title ||
          plan.prompt !== input.prompt ||
          selectionKey(plan.modelSelection) !== selectionKey(input.modelSelection)
        )
          return yield* new WorkerError({
            message:
              "This worker ID is already reserved with different ownership or task settings.",
          });
      } else {
        const source = yield* thread(input.sourceThreadId);
        if (source.modelSelection.instanceId !== input.modelSelection.instanceId)
          return yield* new WorkerError({
            message: "The base and worker must use the same provider account.",
          });
        if (source.runtimeMode === "full-access" && parent.runtimeMode !== "full-access")
          return yield* new WorkerError({
            message: "The base has broader permissions than the master.",
          });
        yield* checkSelection(input.modelSelection);
        if (yield* busy(source))
          return yield* new WorkerError({
            message: "The base is busy. Wait before forking; it will not be interrupted.",
          });
        const plan = encodePlan({
          ...input,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
        });
        yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json)
        VALUES (${input.threadId}, ${owner}, ${input.sourceThreadId}, ${plan})`;
        worker = yield* owned(owner, input.threadId);
      }
      watched.add(owner);
      watched.add(input.threadId);
      if (worker.state !== "ready") {
        yield* Effect.gen(function* () {
          yield* forkThread({
            sourceThreadId: input.sourceThreadId,
            threadId: input.threadId,
          }).pipe(
            Effect.provideService(OrchestrationEngineService, engine),
            Effect.provideService(ProjectionSnapshotQuery, snapshots),
            Effect.provideService(ProviderService, provider),
            Effect.provideService(ProviderSessionDirectory, directory),
          );
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`worker:${input.threadId}:configure`),
            threadId: input.threadId,
            title: input.title,
            modelSelection: input.modelSelection,
          });
          const baseline = yield* engine.latestSequence;
          yield* sql`UPDATE custom_workers SET state = 'ready', error = NULL, baseline = ${baseline} WHERE thread_id = ${input.threadId}`;
        }).pipe(
          Effect.tapError(
            (cause) =>
              sql`UPDATE custom_workers SET state = 'error', error = ${failure(cause).message} WHERE thread_id = ${input.threadId}`,
          ),
        );
      }
      worker = yield* owned(owner, input.threadId);
      yield* enqueue(`spawn:${input.threadId}`, worker, worker.thread_id, "work", input.prompt);
      return yield* describe(worker);
    },
    lock.withPermit,
    Effect.mapError(failure),
  );

  const send = Effect.fn("WorkerControls.send")(
    function* (owner: ThreadId, input: typeof SendInput.Type) {
      const worker = yield* owned(owner, input.threadId);
      return jobResult(
        yield* enqueue(
          `${input.threadId}:${input.clientRequestId}`,
          worker,
          worker.thread_id,
          "work",
          input.prompt,
        ),
      );
    },
    lock.withPermit,
    Effect.mapError(failure),
  );
  const list = Effect.fn("WorkerControls.list")(function* (owner: ThreadId) {
    return yield* Effect.forEach(
      yield* sql<Worker>`SELECT * FROM custom_workers WHERE owner_id = ${owner} ORDER BY rowid`,
      describe,
    );
  }, Effect.mapError(failure));
  const read = Effect.fn("WorkerControls.read")(function* (
    owner: ThreadId,
    input: typeof ReadInput.Type,
  ) {
    const worker = yield* owned(owner, input.threadId);
    let nextSequence = Math.max(worker.baseline, input.afterSequence ?? worker.read_seq);
    let nextTextOffset =
      input.textOffset ?? (input.afterSequence === undefined ? worker.read_offset : 0);
    const head = yield* engine.latestSequence;
    const events = yield* engine
      .readThreadEvents({
        threadId: input.threadId,
        fromSequenceExclusive: nextSequence,
        toSequenceInclusive: head,
        limit: 100,
      })
      .pipe(Stream.runCollect);
    const items: Array<(typeof ReadResult.Type.items)[number]> = [];
    let budget = 12000;
    for (const event of events) {
      let text = "";
      let kind: string = event.type;
      let streaming = false;
      if (event.type === "thread.message-sent") {
        if (!event.payload.streaming && event.payload.role === "assistant") {
          const messages = yield* sql<{ text: string }>`SELECT text FROM projection_thread_messages
            WHERE thread_id = ${input.threadId} AND message_id = ${event.payload.messageId}`;
          text = messages[0]?.text ?? event.payload.text;
        } else if (
          input.includeProgress ||
          (!event.payload.streaming && event.payload.role === "user")
        ) {
          text = event.payload.text;
        }
        kind = event.payload.role;
        streaming = event.payload.streaming;
      } else if (
        event.type === "thread.activity-appended" &&
        (input.includeProgress ||
          ["user-input.requested", "approval.requested", "provider.turn.start.failed"].includes(
            event.payload.activity.kind,
          ))
      ) {
        kind = event.payload.activity.kind;
        text = `${event.payload.activity.summary}\n${encodeUnknown(event.payload.activity.payload)}`;
      }
      if (text) {
        const part = text.slice(nextTextOffset, nextTextOffset + budget);
        items.push({ sequence: event.sequence, kind, text: part, streaming });
        budget -= part.length;
        nextTextOffset += part.length;
        if (nextTextOffset < text.length) break;
      }
      nextSequence = event.sequence;
      nextTextOffset = 0;
      if (budget === 0) break;
    }
    yield* sql`UPDATE custom_workers SET read_seq = ${nextSequence}, read_offset = ${nextTextOffset} WHERE thread_id = ${worker.thread_id}`;
    return {
      worker: yield* describe(worker),
      items,
      nextSequence,
      nextTextOffset,
      hasMore:
        nextTextOffset > 0 ||
        events.some((event) => event.sequence > nextSequence) ||
        (events.length === 100 && nextSequence < head),
    };
  }, Effect.mapError(failure));
  const wait = Effect.fn("WorkerControls.wait")(
    function* (owner: ThreadId, input: typeof WaitInput.Type) {
      const worker = yield* owned(owner, input.threadId);
      const changes = yield* engine.subscribeDomainEvents;
      const result = yield* Stream.concat(Stream.succeed(null), changes).pipe(
        Stream.mapEffect(() => drain().pipe(Effect.andThen(getJob(worker, input.requestId)))),
        Stream.filter((job) => terminal(job.state)),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption(Math.min(input.timeoutMs ?? 30000, 55000)),
      );
      const job = Option.isSome(result) ? result.value[0]! : yield* getJob(worker, input.requestId);
      return { request: jobResult(job), timedOut: Option.isNone(result) };
    },
    Effect.scoped,
    Effect.mapError(failure),
  );
  const control = Effect.fn("WorkerControls.control")(
    function* (owner: ThreadId, input: typeof ControlInput.Type) {
      const worker = yield* owned(owner, input.threadId);
      if (input.notifications !== undefined)
        yield* sql`UPDATE custom_workers SET notify = ${input.notifications ? 1 : 0} WHERE thread_id = ${input.threadId}`;
      if (input.cancelRequestId) {
        const job = yield* getJob(worker, input.cancelRequestId);
        if (job.state !== "queued")
          return yield* new WorkerError({
            message:
              "Only queued assignments can be cancelled here. Stop a running worker through T3.",
          });
        yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
      }
      return yield* describe(yield* owned(owner, input.threadId));
    },
    lock.withPermit,
    Effect.mapError(failure),
  );
  const start = Effect.fn("WorkerControls.start")(function* () {
    const changes = yield* engine.subscribeDomainEvents;
    yield* changes.pipe(
      Stream.filter(
        (event) =>
          watched.has(event.aggregateId) &&
          (event.type !== "thread.message-sent" || !event.payload.streaming) &&
          (event.type !== "thread.activity-appended" ||
            [
              "user-input.requested",
              "user-input.resolved",
              "approval.requested",
              "approval.resolved",
              "provider.turn.start.failed",
            ].includes(event.payload.activity.kind)),
      ),
      Stream.runForEach(() =>
        drain().pipe(
          Effect.catch((error) => Effect.logError("Worker queue reconciliation failed", error)),
        ),
      ),
      Effect.forkScoped,
    );
    yield* drain();
  });
  return WorkerControls.of({
    spawn: (owner, input) => spawn(owner, input).pipe(Effect.tap(() => drain())),
    send: (owner, input) =>
      send(owner, input).pipe(
        Effect.tap(() => drain()),
        Effect.flatMap((job) =>
          owned(owner, input.threadId).pipe(
            Effect.flatMap((worker) => getJob(worker, job.requestId)),
            Effect.map(jobResult),
            Effect.mapError(failure),
          ),
        ),
      ),
    list,
    read,
    wait,
    control: (owner, input) => control(owner, input).pipe(Effect.tap(() => drain())),
    start,
    drain,
  });
});
export const layer = Layer.effect(WorkerControls, make);
