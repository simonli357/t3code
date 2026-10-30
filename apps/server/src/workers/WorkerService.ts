import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type SessionOwnershipInput,
  SessionOwnershipError,
  type SessionOwnershipResult,
  ThreadId,
  WORKER_ACCOUNT_DISABLED_REASON,
} from "@t3tools/contracts";
import {
  WORKER_REVIEW_BLOCKED as REVIEW_BLOCKED,
  WORKER_REVIEW_DONE as REVIEW_DONE,
} from "@t3tools/shared/workerMessages";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type AuthorityRow,
  type ControlInput,
  HandoffInput,
  type HandoffRow,
  type HandoffStatusInput,
  type HandoffResult,
  type JobRow,
  type JobResult,
  Plan,
  type ReadInput,
  type ReadResult,
  type ReclaimInput,
  type ReclaimResult,
  type ReportInput,
  type ReportResult,
  type SendInput,
  type SpawnInput,
  type WaitInput,
  type WaitResult,
  WorkerError,
  type WorkerResult,
  type WorkerRow,
  communicationRefusal,
  isTerminalJobState,
  jobResult,
  reportHeader,
  retirementWarning,
  selectionKey,
} from "./workerSchemas.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePlan = Schema.decodeUnknownSync(Schema.fromJsonString(Plan));
const decodePlanRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeHandoffInput = Schema.decodeUnknownSync(Schema.fromJsonString(HandoffInput));
const decodeIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ThreadId)));
const decodeStrings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeReclaimResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ownerThreadId: ThreadId,
      workerThreadIds: Schema.Array(ThreadId),
      userMessageId: MessageId,
    }),
  ),
);
const decodeOwnershipResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      ownerThreadId: Schema.NullOr(ThreadId),
      previousOwnerThreadId: Schema.NullOr(ThreadId),
      revision: Schema.Number,
    }),
  ),
);

const isWorkerError = Schema.is(WorkerError);
const failure = (cause: unknown): WorkerError =>
  isWorkerError(cause)
    ? cause
    : new WorkerError({ message: cause instanceof Error ? cause.message : String(cause) });

/** Job kinds a worker sends back to its master. */
const REPORT_KINDS = ["done", "blocked", "notice"] as const;

const jobStateOf = (status: OrchestrationV2Run["status"]): JobRow["state"] => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    default:
      return "submitted";
  }
};

/** A restart cuts a run and continues it as a new one; the assignment follows the continuation. */
const followRestarts = (runs: ReadonlyArray<OrchestrationV2Run>, run: OrchestrationV2Run) => {
  let current = run;
  for (;;) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) return current;
    current = next;
  }
};

export class WorkerService extends Context.Service<
  WorkerService,
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
    readonly report: (
      worker: ThreadId,
      input: typeof ReportInput.Type,
    ) => Effect.Effect<typeof ReportResult.Type, WorkerError>;
    readonly handoff: (
      owner: ThreadId,
      input: typeof HandoffInput.Type,
    ) => Effect.Effect<typeof HandoffResult.Type, WorkerError>;
    readonly handoffStatus: (
      owner: ThreadId,
      input: typeof HandoffStatusInput.Type,
    ) => Effect.Effect<typeof HandoffResult.Type, WorkerError>;
    readonly reclaim: (
      owner: ThreadId,
      input: typeof ReclaimInput.Type,
    ) => Effect.Effect<typeof ReclaimResult.Type, WorkerError>;
    readonly readOwnership: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof SessionOwnershipResult.Type, SessionOwnershipError>;
    readonly changeOwnership: (
      input: typeof SessionOwnershipInput.Type,
      actor?: { readonly threadId: ThreadId; readonly userRequest: string },
    ) => Effect.Effect<typeof SessionOwnershipResult.Type, SessionOwnershipError>;
    /** Starts reconciling worker state from run events; `drain` runs one pass on demand. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: () => Effect.Effect<void, WorkerError>;
  }
>()("t3/workers/WorkerService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const catalog = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  // Holds at most one pending pass, so a burst of events costs one drain.
  const drainRequests = yield* Queue.dropping<void>(1);
  let communicationTimer: Fiber.Fiber<void> | undefined;
  const watched = new Set<string>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const kick = () => Queue.offer(drainRequests, undefined).pipe(Effect.asVoid);
  const watch = (...ids: ReadonlyArray<string | null>) => {
    for (const id of ids) if (id !== null) watched.add(id);
  };

  const thread = Effect.fn("WorkerService.thread")(function* (id: string) {
    const shell = yield* threads.getThreadShell(ThreadId.make(id)).pipe(Effect.mapError(failure));
    if (shell === null || shell.deletedAt !== null)
      return yield* new WorkerError({ message: `Thread ${id} no longer exists.` });
    return shell;
  });
  const busy = (shell: OrchestrationV2ThreadShell) =>
    shell.activeRunId !== null || shell.pendingRuntimeRequest !== null;

  const workerOf = Effect.fn(function* (id: string) {
    return (yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE thread_id = ${id}`)[0];
  });
  const authorityOf = Effect.fn(function* (id: string) {
    return (yield* sql<AuthorityRow>`SELECT * FROM custom_orchestrator_authority WHERE thread_id = ${id}`)[0];
  });
  const owned = Effect.fn(function* (owner: string, id: string) {
    const rows =
      yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE thread_id = ${id} AND owner_id = ${owner}`;
    if (!rows[0])
      return yield* new WorkerError({
        message: `Thread ${id} is not a worker owned by this master.`,
      });
    return rows[0];
  });
  const getJob = Effect.fn(function* (worker: WorkerRow, id: string) {
    const rows =
      yield* sql<JobRow>`SELECT * FROM custom_worker_jobs WHERE id = ${id} AND worker_id = ${worker.thread_id} AND kind = 'work'`;
    if (!rows[0]) return yield* new WorkerError({ message: `Unknown assignment ${id}.` });
    return rows[0];
  });
  const jobById = Effect.fn(function* (id: string) {
    return (yield* sql<JobRow>`SELECT * FROM custom_worker_jobs WHERE id = ${id}`)[0];
  });

  // Only successful caller actions consume the warning, never reads or background delivery.
  // Claiming it atomically makes concurrent launches warn once too.
  const warnIfRetired =
    (id: ThreadId) =>
    <A extends object, E, R>(action: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const before = yield* authorityOf(id);
        const result = yield* action;
        if (!before || before.active || before.retirement_warned) return result;
        const [claimed] = yield* sql<AuthorityRow>`UPDATE custom_orchestrator_authority
          SET retirement_warned = 1 WHERE thread_id = ${id} AND retirement_warned = 0
          RETURNING *`;
        if (!claimed) return result;
        let successor = claimed.successor_id;
        const seen = new Set<string>([id]);
        while (successor && !seen.has(successor)) {
          seen.add(successor);
          const next = yield* authorityOf(successor);
          if (!next || next.active || !next.successor_id) break;
          successor = next.successor_id;
        }
        return { ...result, warning: retirementWarning(successor) };
      }).pipe(Effect.mapError((cause) => (isWorkerError(cause) ? cause : failure(cause))));

  const checkSelection = Effect.fn(function* (selection: ModelSelection) {
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
  const checkWorkerAccount = Effect.fn(function* (selection: ModelSelection) {
    if ((yield* settings.getSettings).workerDisabledInstanceIds.includes(selection.instanceId))
      return yield* new WorkerError({ message: WORKER_ACCOUNT_DISABLED_REASON });
  });
  const checkSuccessorAccount = Effect.fn(function* (owner: string, selection: ModelSelection) {
    // A successor of an independent master is not a worker; only workers are account-limited.
    if ((yield* workerOf(owner))?.owner_id) yield* checkWorkerAccount(selection);
  });
  const checkPermissions = Effect.fn(function* (
    ownerId: string,
    target: OrchestrationV2ThreadShell,
  ) {
    const ownerMode = (yield* thread(ownerId)).runtimeMode;
    if (target.runtimeMode === "full-access" && ownerMode !== "full-access")
      return yield* new WorkerError({
        message: "The worker has broader permissions than the master.",
      });
  });
  const checkWorkerSettings = Effect.fn(function* (
    worker: WorkerRow,
    target: OrchestrationV2ThreadShell,
  ) {
    const plan = decodePlan(worker.plan_json);
    if (worker.owner_id !== null) yield* checkPermissions(worker.owner_id, target);
    if (
      selectionKey(target.modelSelection) !== selectionKey(plan.modelSelection) ||
      target.runtimeMode !== plan.runtimeMode ||
      target.interactionMode !== plan.interactionMode
    )
      return yield* new WorkerError({
        message:
          "Worker settings changed. If the change was intentional, use t3_worker_control with adoptCurrentSettings=true; otherwise restore the saved provider/model/effort and modes.",
      });
    yield* checkSelection(plan.modelSelection);
  });

  const enqueue = Effect.fn(function* (
    id: string,
    workerId: string,
    target: string,
    kind: string,
    prompt: string,
    runId?: string,
  ) {
    const createdAt = yield* now;
    const inserted =
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, turn_id)
      VALUES (${id}, ${workerId}, ${target}, ${kind}, ${prompt}, ${createdAt}, ${runId ?? null}) ON CONFLICT(id) DO NOTHING RETURNING id`;
    const job = (yield* jobById(id))!;
    if (
      job.worker_id !== workerId ||
      job.target_id !== target ||
      job.prompt !== prompt ||
      job.kind !== kind
    )
      return yield* new WorkerError({
        message:
          "This request ID already belongs to a different assignment. Reuse the original prompt or choose a new ID.",
      });
    if (kind === "work" && inserted.length)
      yield* sql`UPDATE custom_workers SET communication_anchor_at = MAX(COALESCE(communication_anchor_at, ''), ${createdAt}) WHERE thread_id = ${workerId}`;
    return job;
  }, sql.withTransaction);

  /** A notice tells the master of something that needs it: a runtime failure or a pending question. */
  const notice = Effect.fn(function* (
    worker: WorkerRow,
    job: JobRow,
    suffix: string,
    detail: string,
  ) {
    if (!worker.notify || worker.owner_id === null) return;
    const plan = decodePlan(worker.plan_json);
    const current = yield* threads
      .getThreadShell(ThreadId.make(worker.thread_id))
      .pipe(Effect.orElseSucceed(() => null));
    const title = current?.title ?? plan.title;
    const createdAt = yield* now;
    yield* enqueue(
      `notice:${job.id}:${suffix}`,
      worker.thread_id,
      worker.owner_id,
      "notice",
      `${reportHeader(title, createdAt)}\nWorker: ${worker.thread_id}\nAssignment: ${job.id}\n${detail}\n${REVIEW_BLOCKED} A runtime failure is not task completion.`,
    );
  });

  /**
   * Resolves a submitted assignment from its run. State is derived from the run each time, so a
   * missed event or a restart never leaves it stale.
   */
  const refreshJob = Effect.fn("WorkerService.refreshJob")(function* (job: JobRow) {
    if (job.kind !== "work" || job.state !== "submitted") return job;
    const worker = yield* workerOf(job.worker_id);
    if (!worker) return job;
    const target = ThreadId.make(job.target_id);
    const { runs } = yield* threads
      .getThreadRecords(target, ["runs"])
      .pipe(Effect.mapError(failure));
    const run = job.id.startsWith("direct:")
      ? runs.find((candidate) => candidate.id === job.turn_id)
      : (runs.find((candidate) => candidate.userMessageId === `worker-job:${job.id}`) ??
        runs.find((candidate) => candidate.id === job.turn_id));
    if (run === undefined) return job;
    const latest = followRestarts(runs, run);
    const state = jobStateOf(latest.status);
    const startedAt = latest.startedAt === null ? undefined : DateTime.formatIso(latest.startedAt);
    if (startedAt !== undefined && job.communication_delivered_at === null) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const accepted =
            yield* sql`UPDATE custom_worker_jobs SET communication_delivered_at = ${startedAt}
            WHERE id = ${job.id} AND communication_delivered_at IS NULL RETURNING id`;
          if (accepted.length)
            yield* sql`UPDATE custom_workers SET communication_anchor_at =
              MAX(COALESCE(communication_anchor_at, ''), ${startedAt}) WHERE thread_id = ${worker.thread_id}`;
        }),
      );
    }
    if (state === "submitted") {
      if (latest.id !== job.turn_id)
        yield* sql`UPDATE custom_worker_jobs SET turn_id = ${latest.id} WHERE id = ${job.id}`;
      return (yield* jobById(job.id))!;
    }
    const shell = yield* threads.getThreadShell(target).pipe(Effect.orElseSucceed(() => null));
    const error =
      state === "error" ? (shell?.lastError ?? job.error ?? "The run failed.") : job.error;
    const at = yield* now;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // An assignment that never started still opens the window, from when it ended.
        if (startedAt === undefined && state !== "completed")
          yield* sql`UPDATE custom_workers SET communication_anchor_at = MAX(COALESCE(communication_anchor_at, ''), ${at}) WHERE thread_id = ${worker.thread_id}`;
        yield* sql`UPDATE custom_worker_jobs SET state = ${state}, error = ${error}, turn_id = ${latest.id} WHERE id = ${job.id}`;
      }),
    );
    yield* reportTerminalJobs(worker.thread_id);
    return (yield* jobById(job.id))!;
  });

  /** Tells the master about assignments that ended badly, once, while notifications are on. */
  const reportTerminalJobs = Effect.fn(function* (workerId: string) {
    const worker = yield* workerOf(workerId);
    if (!worker?.notify || worker.owner_id === null) return;
    const jobs = yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
      WHERE worker_id = ${workerId} AND kind = 'work' AND reported = 0
        AND state IN ('error', 'interrupted') ORDER BY rowid`;
    for (const job of jobs) {
      const shell = yield* threads
        .getThreadShell(ThreadId.make(workerId))
        .pipe(Effect.orElseSucceed(() => null));
      const selfStarted = job.id.startsWith("direct:");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* notice(
            worker,
            job,
            "terminal",
            `Runtime state: ${job.state}${selfStarted ? " (turn started by the worker)" : ""}${job.error ? `\nError: ${job.error}` : ""}\n${(shell?.latestVisibleMessage?.role === "assistant" ? shell.latestVisibleMessage.text : "").slice(0, 600)}`,
          );
          yield* sql`UPDATE custom_worker_jobs SET reported = 1 WHERE id = ${job.id}`;
        }),
      );
    }
  });

  const refreshWorker = Effect.fn(function* (workerId: string) {
    const jobs = yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
      WHERE worker_id = ${workerId} AND kind = 'work' AND state = 'submitted' ORDER BY rowid`;
    for (const job of jobs) yield* refreshJob(job);
  });

  /** Opens a question notice for each pending runtime request the master has not heard about. */
  const noticePendingRequests = Effect.fn(function* (worker: WorkerRow) {
    if (!worker.notify || worker.owner_id === null) return;
    const latest = (yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
      WHERE worker_id = ${worker.thread_id} AND kind = 'work' ORDER BY rowid DESC LIMIT 1`)[0];
    if (!latest || isTerminalJobState(latest.state)) return;
    const { runtimeRequests } = yield* threads
      .getThreadRecords(ThreadId.make(worker.thread_id), ["runtimeRequests"])
      .pipe(Effect.mapError(failure));
    for (const request of runtimeRequests) {
      if (request.status !== "pending") continue;
      yield* notice(
        worker,
        latest,
        request.id,
        `Needs input: ${request.kind === "user_input" ? "a question" : "an approval"} (${request.kind})\nRequest: ${request.id}`,
      );
    }
  });

  const communicationStatus = Effect.fn("WorkerService.communicationStatus")(function* (
    workerId: string,
    jobId?: string,
  ) {
    const worker = yield* workerOf(workerId);
    if (!worker) return { remainingMs: 0, pendingDelivery: false, relevant: false };
    yield* refreshWorker(workerId);
    const anchor = (yield* workerOf(workerId))?.communication_anchor_at ?? null;
    const pendingDelivery =
      (yield* sql`SELECT 1 FROM custom_worker_jobs WHERE worker_id = ${workerId} AND kind = 'work'
        AND communication_delivered_at IS NULL AND state IN ('queued', 'submitted')
        AND id NOT LIKE 'direct:%' LIMIT 1`).length > 0;
    const minutes = (yield* settings.getSettings).workerCommunicationWindowMinutes;
    const current = DateTime.toEpochMillis(yield* DateTime.now);
    const remainingMs =
      minutes === 0
        ? 0
        : pendingDelivery
          ? minutes * 60_000
          : anchor
            ? Math.max(0, Date.parse(anchor) + minutes * 60_000 - current)
            : 0;
    let relevant = worker.owner_id !== null;
    const job = jobId ? yield* jobById(jobId) : undefined;
    if (job?.kind === "notice") {
      const latest = (yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
        WHERE worker_id = ${workerId} AND kind = 'work' ORDER BY rowid DESC LIMIT 1`)[0];
      const source = latest && job.id.startsWith(`notice:${latest.id}:`) ? latest : undefined;
      relevant &&= source !== undefined;
      if (source) {
        const suffix = job.id.slice(`notice:${source.id}:`.length);
        if (suffix === "terminal") {
          relevant &&= ["error", "interrupted"].includes(source.state);
        } else {
          const { runtimeRequests } = yield* threads
            .getThreadRecords(ThreadId.make(workerId), ["runtimeRequests"])
            .pipe(Effect.mapError(failure));
          relevant &&= runtimeRequests.some(
            (request) => request.id === suffix && request.status === "pending",
          );
        }
        // An explicit completion supersedes a deferred runtime notice.
        relevant &&=
          (yield* sql`SELECT 1 FROM custom_worker_jobs WHERE worker_id = ${workerId}
            AND kind = 'done' AND rowid > (SELECT rowid FROM custom_worker_jobs WHERE id = ${source.id}) LIMIT 1`)
            .length === 0;
      }
    } else if (job?.kind === "blocked") {
      relevant &&=
        (yield* sql`SELECT 1 FROM custom_worker_jobs newer
          WHERE newer.worker_id = ${workerId} AND newer.kind = 'work'
          AND newer.rowid > (SELECT rowid FROM custom_worker_jobs WHERE id = ${job.id}) LIMIT 1`)
          .length === 0;
    }
    return { remainingMs, pendingDelivery, relevant };
  }, Effect.mapError(failure));

  const assertCommunicationAllowed = Effect.fn(function* (workerId: string) {
    const status = yield* communicationStatus(workerId);
    if (status.remainingMs > 0)
      return yield* new WorkerError({
        code: "worker_communication_window",
        message: communicationRefusal(status.remainingMs, status.pendingDelivery),
      });
  });

  const describe = Effect.fn(function* (worker: WorkerRow) {
    yield* refreshWorker(worker.thread_id);
    const plan = decodePlan(worker.plan_json);
    const latest = (yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
      WHERE worker_id = ${worker.thread_id} AND kind = 'work' ORDER BY rowid DESC LIMIT 1`)[0];
    const shell = yield* threads
      .getThreadShell(plan.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const notices = yield* sql<{ pending: number; error: string | null }>`SELECT
      COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS pending,
      MAX(CASE WHEN state = 'error' THEN error END) AS error
      FROM custom_worker_jobs WHERE worker_id = ${worker.thread_id} AND kind IN ('notice', 'done', 'blocked')`;
    const state =
      worker.state !== "ready"
        ? worker.state
        : shell === null || shell.deletedAt !== null
          ? "deleted"
          : shell.pendingRuntimeRequest !== null
            ? shell.pendingRuntimeRequest.kind === "user_input"
              ? "needs-input"
              : "needs-approval"
            : (latest?.state ?? "ready");
    return {
      threadId: plan.threadId,
      ownerThreadId: ThreadId.make(worker.owner_id ?? worker.thread_id),
      sourceThreadId: plan.sourceThreadId ?? null,
      title: shell?.title ?? plan.title,
      modelSelection: plan.modelSelection,
      state,
      error: worker.error,
      notifications: worker.notify === 1,
      latestRequest: latest ? jobResult(latest) : null,
      pendingReports: notices[0]?.pending ?? 0,
      deliveryError: notices[0]?.error ?? null,
    } satisfies typeof WorkerResult.Type;
  });

  /** Sends one assignment to its worker. The command ID makes a repeat after a crash a no-op. */
  const deliverWork = Effect.fn("WorkerService.deliverWork")(function* (job: JobRow) {
    const worker = yield* workerOf(job.worker_id);
    if (!worker || worker.state !== "ready") return job;
    const target = yield* thread(job.target_id);
    if (target.archivedAt !== null)
      return yield* new WorkerError({ message: "The worker is archived." });
    yield* checkWorkerSettings(worker, target);
    const dispatchedAt = job.dispatched_at ?? (yield* now);
    yield* sql`UPDATE custom_worker_jobs SET dispatched_at = ${dispatchedAt} WHERE id = ${job.id}`;
    const sent = yield* threads
      .sendToThread({
        projectId: target.projectId,
        commandId: CommandId.make(`worker-job:${job.id}:${job.attempt}`),
        threadId: target.id,
        ...(worker.owner_id === null ? {} : { senderThreadId: ThreadId.make(worker.owner_id) }),
        messageId: MessageId.make(`worker-job:${job.id}`),
        text: job.prompt,
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(failure));
    yield* sql`UPDATE custom_worker_jobs SET state = 'submitted', error = NULL, turn_id = ${sent.run.id} WHERE id = ${job.id}`;
    return (yield* jobById(job.id))!;
  });

  /** Delivers now; a failure settles the assignment as an error rather than losing it. */
  const dispatchWork = Effect.fn(function* (job: JobRow) {
    if (job.state !== "queued") return job;
    return yield* deliverWork(job).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const message = failure(cause).message;
          yield* sql`UPDATE custom_worker_jobs SET state = 'error', error = ${message} WHERE id = ${job.id}`;
          yield* Effect.logWarning("Worker delivery failed", { requestId: job.id, message });
          return (yield* jobById(job.id))!;
        }),
      ),
    );
  });

  const deliverToMaster = Effect.fn("WorkerService.deliverToMaster")(function* (job: JobRow) {
    const master = yield* threads
      .getThreadShell(ThreadId.make(job.target_id))
      .pipe(Effect.mapError(failure));
    if (master === null || master.deletedAt !== null) {
      yield* sql`UPDATE custom_worker_jobs SET state = 'error', error = 'The master no longer exists.' WHERE id = ${job.id}`;
      return;
    }
    // A stopped, snoozed or archived master is not woken; the report stays queued for it.
    if (
      master.archivedAt !== null ||
      master.latestRunStopRequested === true ||
      (master.snoozedUntil != null &&
        DateTime.toEpochMillis(master.snoozedUntil) > DateTime.toEpochMillis(yield* DateTime.now))
    )
      return;
    yield* threads
      .sendToThread({
        projectId: master.projectId,
        commandId: CommandId.make(`worker-job:${job.id}:${job.attempt}`),
        threadId: master.id,
        senderThreadId: ThreadId.make(job.worker_id),
        messageId: MessageId.make(`worker-job:${job.id}`),
        text: job.prompt,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(failure));
    yield* sql`UPDATE custom_worker_jobs SET state = 'completed', error = NULL WHERE id = ${job.id}`;
  });

  // Finished reports wake an idle master immediately. While it is working, they collect into one
  // digest for the end of its turn.
  const batchDoneReports = Effect.fn(function* () {
    const pending = yield* sql<JobRow>`SELECT j.* FROM custom_worker_jobs j
      JOIN custom_workers w ON w.thread_id = j.worker_id
      WHERE j.kind = 'done' AND j.state = 'queued' AND w.notify = 1 AND w.owner_id IS NOT NULL
      ORDER BY j.rowid`;
    const held = new Set<string>();
    for (const target of new Set(pending.map((job) => job.target_id))) {
      const group = pending.filter((job) => job.target_id === target);
      const master = yield* threads
        .getThreadShell(ThreadId.make(target))
        .pipe(Effect.orElseSucceed(() => null));
      if (master !== null && busy(master)) {
        for (const job of group) held.add(job.id);
        continue;
      }
      if (group.length < 2) continue;
      const split = group.map((job) => {
        const [head, tail = ""] = job.prompt.split(`\n\n${REVIEW_DONE}`);
        return [
          head,
          ...tail.split("\n").filter((line) => line.startsWith("Worker working time")),
        ].join("\n");
      });
      // oxlint-disable-next-line t3code/no-em-dash-copy -- Wire format shared with digests already stored by V1.
      const prompt = `[T3 worker reports — ${group.length} finished]\n\n${split.join("\n\n")}\n\n${REVIEW_DONE}`;
      const createdAt = yield* now;
      const digestId = `digest:${target}:${group[0]!.id}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, report_ids_json)
            VALUES (${digestId}, ${group[0]!.worker_id}, ${target}, 'done', ${prompt}, ${createdAt}, ${encodeIds(group.map((job) => job.id))})
            ON CONFLICT(id) DO NOTHING`;
          yield* sql`UPDATE custom_worker_jobs SET state = 'completed'
            WHERE ${sql.in(
              "id",
              group.map((job) => job.id),
            )}`;
        }),
      );
    }
    return held;
  });

  const deliverQueued = Effect.fn(function* () {
    const held = yield* batchDoneReports();
    const jobs = yield* sql<JobRow>`SELECT * FROM custom_worker_jobs WHERE state = 'queued'
      ORDER BY CASE WHEN id LIKE 'handoff-start:%' THEN 0 WHEN kind = 'work' THEN 3 ELSE 1 END, rowid`;
    let deadline: number | undefined;
    for (const job of jobs) {
      if (held.has(job.id)) continue;
      yield* Effect.gen(function* () {
        if (job.kind === "work") {
          yield* dispatchWork(job);
          return;
        }
        const worker = yield* workerOf(job.worker_id);
        if (job.kind === "message") {
          yield* deliverToMaster(job);
          return;
        }
        if (!REPORT_KINDS.includes(job.kind as (typeof REPORT_KINDS)[number])) return;
        if (!worker || worker.state !== "ready" || !worker.notify || worker.owner_id === null)
          return;
        if (job.kind === "notice" || job.kind === "blocked") {
          const status = yield* communicationStatus(worker.thread_id, job.id);
          if (!status.relevant) {
            yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
            return;
          }
          if (status.remainingMs > 0) {
            if (!status.pendingDelivery) {
              const at = DateTime.toEpochMillis(yield* DateTime.now) + status.remainingMs;
              deadline = Math.min(deadline ?? at, at);
            }
            return;
          }
        }
        yield* deliverToMaster(job);
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const message = failure(cause).message;
            yield* sql`UPDATE custom_worker_jobs SET error = ${message}, attempt = attempt + 1 WHERE id = ${job.id} AND state = 'queued'`;
            yield* Effect.logWarning("Worker delivery failed", { requestId: job.id, message });
          }),
        ),
      );
    }
    if (communicationTimer) yield* Fiber.interrupt(communicationTimer);
    communicationTimer = undefined;
    if (deadline !== undefined) {
      const delay = Math.max(0, deadline - DateTime.toEpochMillis(yield* DateTime.now));
      // Node's maximum timer delay is a platform limit, not a policy threshold.
      communicationTimer = yield* Effect.sleep(Math.min(delay, 2_147_483_647)).pipe(
        Effect.andThen(kick()),
        Effect.forkIn(scope),
      );
    }
  });

  const createThread = Effect.fn("WorkerService.createThread")(function* (
    owner: ThreadId,
    parent: OrchestrationV2ThreadShell,
    worker: WorkerRow,
  ) {
    const plan = decodePlan(worker.plan_json);
    const at = yield* now;
    if (plan.sourceThreadId) {
      yield* threads
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`worker:${plan.threadId}:fork`),
          sourceThreadId: plan.sourceThreadId,
          targetThreadId: plan.threadId,
          sourcePoint: { type: "latest_stable" },
          title: plan.title,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    } else {
      if (!plan.projectId)
        return yield* new WorkerError({ message: "The fresh worker has no saved project." });
      yield* launcher
        .launch({
          commandId: CommandId.make(`worker:${plan.threadId}:create`),
          threadId: plan.threadId,
          projectId: plan.projectId,
          title: plan.title,
          generateTitle: false,
          modelSelection: plan.modelSelection,
          runtimeMode: plan.runtimeMode,
          interactionMode: plan.interactionMode,
          workspaceStrategy: { type: "root" },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(failure));
    }
    const created = yield* thread(plan.threadId);
    if (selectionKey(created.modelSelection) !== selectionKey(plan.modelSelection))
      yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`worker:${plan.threadId}:configure`),
          threadId: plan.threadId,
          modelSelection: plan.modelSelection,
        })
        .pipe(Effect.mapError(failure));
    const baseline = yield* threads
      .getThreadEventSequence(plan.threadId)
      .pipe(Effect.mapError(failure));
    yield* sql`UPDATE custom_workers SET state = 'ready', error = NULL, baseline = ${baseline}, read_seq = MAX(read_seq, ${baseline}) WHERE thread_id = ${plan.threadId}`;
    void owner;
    void parent;
    void at;
  });

  const spawnWorker = Effect.fn("WorkerService.spawnWorker")(function* (
    owner: ThreadId,
    parent: OrchestrationV2ThreadShell,
    input: typeof SpawnInput.Type,
    options: { readonly forHandoff: boolean },
  ) {
    if (input.threadId === owner || input.threadId === input.sourceThreadId)
      return yield* new WorkerError({ message: "A worker must have its own new thread ID." });
    let worker = yield* workerOf(input.threadId);
    if (worker) {
      const plan = decodePlan(worker.plan_json);
      if (
        worker.owner_id !== owner ||
        worker.source_id !== (input.sourceThreadId ?? null) ||
        (input.projectId !== undefined && plan.projectId !== input.projectId) ||
        plan.title !== input.title ||
        plan.prompt !== input.prompt ||
        selectionKey(plan.modelSelection) !== selectionKey(input.modelSelection)
      )
        return yield* new WorkerError({
          message: "This worker ID is already reserved with different ownership or task settings.",
        });
    } else {
      const existing = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(failure));
      if (existing !== null)
        return yield* new WorkerError({ message: "That destination thread already exists." });
      const source = input.sourceThreadId ? yield* thread(input.sourceThreadId) : undefined;
      if (
        !options.forHandoff &&
        source &&
        source.modelSelection.instanceId !== input.modelSelection.instanceId
      )
        return yield* new WorkerError({
          message: "The base and worker must use the same provider account.",
        });
      if (source?.runtimeMode === "full-access" && parent.runtimeMode !== "full-access")
        return yield* new WorkerError({
          message: "The base has broader permissions than the master.",
        });
      if (options.forHandoff) yield* checkSuccessorAccount(owner, input.modelSelection);
      else yield* checkWorkerAccount(input.modelSelection);
      yield* checkSelection(input.modelSelection);
      if (source && busy(source))
        return yield* new WorkerError({
          message: "The base is busy. Wait before forking; it will not be interrupted.",
        });
      const projectId = source?.projectId ?? input.projectId ?? parent.projectId;
      if (input.projectId !== undefined && input.projectId !== projectId)
        return yield* new WorkerError({ message: "The fork source belongs to another project." });
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(failure));
      if (Option.isNone(project))
        return yield* new WorkerError({ message: "The project no longer exists." });
      const plan = encodeJson({
        ...input,
        projectId,
        runtimeMode: source?.runtimeMode ?? parent.runtimeMode,
        interactionMode: source?.interactionMode ?? parent.interactionMode,
      });
      yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json)
        VALUES (${input.threadId}, ${owner}, ${input.sourceThreadId ?? null}, ${plan})`;
      worker = yield* owned(owner, input.threadId);
    }
    watch(owner, input.threadId);
    if (worker.state !== "ready") {
      yield* createThread(owner, parent, worker).pipe(
        Effect.tapError(
          (cause) =>
            sql`UPDATE custom_workers SET state = 'error', error = ${failure(cause).message} WHERE thread_id = ${input.threadId}`,
        ),
      );
    }
    return yield* owned(owner, input.threadId);
  });

  const spawn = Effect.fn("WorkerService.spawn")(
    function* (owner: ThreadId, input: typeof SpawnInput.Type) {
      const parent = yield* thread(owner);
      const worker = yield* spawnWorker(owner, parent, input, { forHandoff: false }).pipe(
        lock.withPermit,
      );
      const job = yield* enqueue(
        `spawn:${input.threadId}`,
        worker.thread_id,
        worker.thread_id,
        "work",
        input.prompt,
      );
      yield* dispatchWork(job);
      return yield* describe(yield* owned(owner, input.threadId));
    },
    (effect, owner) => warnIfRetired(owner)(effect),
  );

  const send = Effect.fn("WorkerService.send")(
    function* (owner: ThreadId, input: typeof SendInput.Type) {
      const worker = yield* owned(owner, input.threadId);
      const requestId = `${input.threadId}:${input.clientRequestId}`;
      if (!(yield* jobById(requestId)))
        yield* checkWorkerSettings(worker, yield* thread(input.threadId));
      const job = yield* enqueue(
        requestId,
        worker.thread_id,
        worker.thread_id,
        "work",
        input.prompt,
      );
      return jobResult(yield* dispatchWork(job));
    },
    (effect, owner) => warnIfRetired(owner)(effect),
  );

  const list = Effect.fn("WorkerService.list")(function* (owner: ThreadId) {
    const rows =
      yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE owner_id = ${owner} ORDER BY rowid`;
    return yield* Effect.forEach(rows, describe);
  }, Effect.mapError(failure));

  const read = Effect.fn("WorkerService.read")(function* (
    owner: ThreadId,
    input: typeof ReadInput.Type,
  ) {
    const worker = yield* owned(owner, input.threadId);
    let nextSequence = Math.max(worker.baseline, input.afterSequence ?? worker.read_seq);
    let nextTextOffset =
      input.textOffset ?? (input.afterSequence === undefined ? worker.read_offset : 0);
    const limit = 100;
    const page = Array.from(
      yield* threads
        .streamStoredEventsFrom({ threadId: input.threadId, afterSequence: nextSequence })
        .pipe(Stream.take(limit + 1), Stream.runCollect, Effect.mapError(failure)),
    );
    const batch = page.slice(0, limit);
    const items: Array<(typeof ReadResult.Type)["items"][number]> = [];
    let budget = 12000;
    for (const stored of batch) {
      const event = stored.event;
      let text = "";
      let kind: string = event.type;
      let streaming = false;
      // History imported from V1 predates this worker's assignments; the master never reads it as news.
      if (event.id.startsWith("migration:v1:")) {
        nextSequence = stored.sequence;
        continue;
      }
      if (event.type === "message.updated") {
        const message = event.payload;
        kind = message.role;
        streaming = message.streaming;
        if (!message.streaming && message.role === "assistant") text = message.text;
        else if (input.includeProgress || (!message.streaming && message.role === "user"))
          text = message.text;
      } else if (event.type === "runtime-request.updated" && event.payload.status === "pending") {
        kind = event.payload.kind === "user_input" ? "user-input.requested" : "approval.requested";
        text = `${event.payload.kind}\n${encodeJson({ requestId: event.payload.id })}`;
      } else if (event.type === "run.updated" && event.payload.status === "failed") {
        kind = "run.failed";
        text = "The run failed.";
      } else if (input.includeProgress && event.type === "turn-item.updated") {
        kind = event.payload.type;
        text = encodeJson(event.payload).slice(0, 2000);
      }
      if (text) {
        const part = text.slice(nextTextOffset, nextTextOffset + budget);
        items.push({ sequence: stored.sequence, kind, text: part, streaming });
        budget -= part.length;
        nextTextOffset += part.length;
        if (nextTextOffset < text.length) break;
      }
      nextSequence = stored.sequence;
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
        page.length > limit ||
        batch.some((stored) => stored.sequence > nextSequence),
    };
  }, Effect.mapError(failure));

  const wait = Effect.fn("WorkerService.wait")(function* (
    owner: ThreadId,
    input: typeof WaitInput.Type,
  ) {
    const worker = yield* owned(owner, input.threadId);
    const check = Effect.gen(function* () {
      const job = yield* getJob(worker, input.requestId);
      return yield* dispatchWork(yield* refreshJob(job));
    });
    const changes = threads.streamDomainEvents.pipe(
      Stream.filter((event) => event.threadId === input.threadId),
    );
    const result = yield* Stream.concat(Stream.succeed(null), changes).pipe(
      Stream.mapEffect(() => check),
      Stream.filter((job) => isTerminalJobState(job.state)),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeoutOption(Math.min(input.timeoutMs ?? 30000, 55000)),
    );
    const job = Option.isSome(result) ? result.value[0]! : yield* check;
    return { request: jobResult(job), timedOut: Option.isNone(result) };
  }, Effect.mapError(failure));

  const control = Effect.fn("WorkerService.control")(
    function* (owner: ThreadId, input: typeof ControlInput.Type) {
      const worker = yield* owned(owner, input.threadId);
      if (input.modelSelection && input.adoptCurrentSettings)
        return yield* new WorkerError({
          message: "Choose modelSelection or adoptCurrentSettings, not both.",
        });
      const cancelled = input.cancelRequestId
        ? yield* getJob(worker, input.cancelRequestId).pipe(Effect.flatMap(refreshJob))
        : undefined;
      let queuedRunId: OrchestrationV2Run["id"] | undefined;
      if (cancelled) {
        if (cancelled.state === "submitted") {
          const { runs } = yield* threads
            .getThreadRecords(input.threadId, ["runs"])
            .pipe(Effect.mapError(failure));
          queuedRunId = runs.find(
            (run) => run.id === cancelled.turn_id && run.status === "queued",
          )?.id;
        }
        if (cancelled.state !== "queued" && queuedRunId === undefined)
          return yield* new WorkerError({
            message:
              "Only queued assignments can be cancelled here. Stop a running worker through T3.",
          });
      }
      let adopted: string | undefined;
      if (input.adoptCurrentSettings || input.modelSelection) {
        const target = yield* thread(input.threadId);
        const plan = decodePlan(worker.plan_json);
        yield* checkPermissions(owner, target);
        const selection = input.modelSelection ?? target.modelSelection;
        if (input.modelSelection || selectionKey(selection) !== selectionKey(plan.modelSelection))
          yield* checkWorkerAccount(selection);
        yield* checkSelection(selection);
        if (input.modelSelection) {
          if (worker.state !== "ready")
            return yield* new WorkerError({
              message: "Finish creating the worker before changing its provider or account.",
            });
          if (
            target.runtimeMode !== plan.runtimeMode ||
            target.interactionMode !== plan.interactionMode
          )
            return yield* new WorkerError({
              message:
                "Worker modes changed. Restore them or explicitly adoptCurrentSettings before changing its provider/model.",
            });
          if (selectionKey(selection) !== selectionKey(target.modelSelection))
            yield* threads
              .dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(
                  `worker-settings:${input.threadId}:${selectionKey(selection)}`,
                ),
                threadId: input.threadId,
                modelSelection: selection,
              })
              .pipe(Effect.mapError(failure));
        }
        adopted = encodeJson({
          ...decodePlanRecord(worker.plan_json),
          modelSelection: selection,
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
        });
      }
      if (cancelled && queuedRunId !== undefined)
        yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`worker-cancel:${cancelled.id}`),
            threadId: input.threadId,
            runId: queuedRunId,
          })
          .pipe(Effect.mapError(failure));
      // Dispatch uses the orchestrator's own transaction; never hold a SQL transaction across it.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (adopted !== undefined)
            yield* sql`UPDATE custom_workers SET plan_json = ${adopted} WHERE thread_id = ${input.threadId}`;
          if (input.notifications !== undefined)
            yield* sql`UPDATE custom_workers SET notify = ${input.notifications ? 1 : 0} WHERE thread_id = ${input.threadId}`;
          if (cancelled)
            yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE id = ${cancelled.id}`;
        }),
      );
      if (input.notifications === true) yield* reportTerminalJobs(input.threadId);
      return yield* describe(yield* owned(owner, input.threadId));
    },
    lock.withPermit,
    (effect, owner) => warnIfRetired(owner)(effect),
    Effect.tap(() => kick()),
  );

  const report = Effect.fn("WorkerService.report")(
    function* (workerId: ThreadId, input: typeof ReportInput.Type) {
      const worker = yield* workerOf(workerId);
      if (!worker || worker.state !== "ready" || worker.owner_id === null)
        return yield* new WorkerError({
          message: "This session is not a managed T3 worker; it has no master to report to.",
        });
      const reportId = `report:${workerId}:${input.clientRequestId}`;
      // A retry of a report already accepted is never refused by the window.
      if (input.outcome !== "done" && !(yield* jobById(reportId)))
        yield* assertCommunicationAllowed(workerId);
      const source = yield* thread(workerId);
      const outcome =
        input.outcome === "done"
          ? "done"
          : `blocked, needs ${input.needs === "user" ? "the user" : "the master"}`;
      const body = `\nWorker: ${workerId}\nOutcome: ${outcome}\n${input.summary}${input.evidence ? `\nEvidence: ${input.evidence}` : ""}\n\n${input.outcome === "done" ? REVIEW_DONE : REVIEW_BLOCKED}`;
      const createdAt = yield* now;
      const runId = source.activeRunId ?? source.latestRunId;
      // Persisted without the queue lock so a report is never lost behind a long pass. Reading
      // the owner in the insert keeps it consistent with a handoff, which retargets queued
      // reports in one transaction.
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, turn_id)
        SELECT ${reportId}, thread_id, owner_id, ${input.outcome}, ${reportHeader(source.title, createdAt) + body}, ${createdAt}, ${runId}
        FROM custom_workers WHERE thread_id = ${workerId} AND owner_id IS NOT NULL
        ON CONFLICT(id) DO NOTHING`;
      const job = yield* jobById(reportId);
      // Titles can change after submission. Match the report body while retaining its saved header.
      if (
        !job ||
        job.kind !== input.outcome ||
        !job.prompt.slice(job.prompt.indexOf(`\nWorker: ${workerId}\n`)).startsWith(body)
      )
        return yield* new WorkerError({
          message: "This report ID already belongs to a different assignment.",
        });
      yield* kick();
      const current = (yield* jobById(reportId))!;
      return { ...jobResult(current), held: current.state === "queued" && worker.notify === 0 };
    },
    (effect, workerId) => warnIfRetired(workerId)(effect),
    Effect.mapError(failure),
  );

  const localId = environment.getEnvironmentId;
  const ownershipFailure = (cause: unknown) =>
    new SessionOwnershipError({
      message: failure(cause).message,
      code: isWorkerError(cause) ? cause.code : "pending",
    });
  const assertLocal = Effect.fn(function* (...ids: ReadonlyArray<string | null | undefined>) {
    const local = yield* localId;
    for (const id of ids)
      if (id !== undefined && id !== null && id !== local)
        return yield* new WorkerError({
          code: "unsupported",
          message: "Ownership across linked environments is not available in this build.",
        });
  });

  const ownershipOf = Effect.fn(function* (threadId: ThreadId) {
    const record = yield* workerOf(threadId);
    if (record && record.state !== "ready")
      return yield* new WorkerError({
        message: "Finish creating or recovering this worker before changing ownership.",
      });
    const target = yield* thread(threadId);
    if (target.archivedAt !== null)
      return yield* new WorkerError({
        message: "Unarchive the session before changing ownership.",
      });
    const local = yield* localId;
    return {
      target,
      record,
      owner: record?.owner_id ?? null,
      revision: (yield* authorityOf(threadId))?.revision ?? 0,
      authority: local,
      hasChildren:
        (yield* sql`SELECT 1 FROM custom_workers WHERE owner_id = ${threadId} LIMIT 1`).length > 0,
    };
  });
  const ownershipResult = (
    local: string,
    threadId: ThreadId,
    owner: string | null,
    previous: string | null,
    revision: number,
  ) => ({
    threadId,
    ownerThreadId: owner === null ? null : ThreadId.make(owner),
    ownerEnvironmentId: owner === null ? null : local,
    previousOwnerThreadId: previous === null ? null : ThreadId.make(previous),
    previousOwnerEnvironmentId: previous === null ? null : local,
    authorityEnvironmentId: local,
    revision,
  });

  const readOwnership = Effect.fn("WorkerService.readOwnership")(function* (threadId: ThreadId) {
    const local = yield* localId;
    const state = yield* ownershipOf(threadId);
    return ownershipResult(local, threadId, state.owner, state.owner, state.revision);
  }, Effect.mapError(ownershipFailure));

  /** The newest message the user typed into this thread, never one an agent or the server sent. */
  const latestUserInstruction = Effect.fn(function* (threadId: ThreadId, afterSequence: number) {
    const page = Array.from(
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "message.updated" })
        .pipe(Stream.runCollect, Effect.mapError(failure)),
    );
    let latest: { readonly id: string; readonly text: string } | undefined;
    for (const stored of page) {
      const event = stored.event;
      if (event.type !== "message.updated") continue;
      const message = event.payload;
      if (message.role === "user" && message.createdBy === "user" && !message.streaming)
        latest = { id: message.id, text: message.text };
    }
    return latest;
  });

  const retargetReports = Effect.fn(function* (
    ids: ReadonlyArray<string>,
    owners: ReadonlyArray<string>,
    owner: string | null,
  ) {
    // Split undelivered digests before moving a subset of their workers.
    if (owners.length > 0) {
      const digests = yield* sql<JobRow>`SELECT * FROM custom_worker_jobs
        WHERE id LIKE 'digest:%' AND state = 'queued' AND ${sql.in("target_id", [...owners])}`;
      for (const digest of digests) {
        if (!ids.some((workerId) => digest.prompt.includes(`Worker: ${workerId}\n`))) continue;
        if (!digest.report_ids_json)
          return yield* new WorkerError({
            message:
              "A pending digest from an older build includes this worker. Review that digest before reclaiming it.",
          });
        yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE id = ${digest.id}`;
        yield* sql`UPDATE custom_worker_jobs SET state = 'queued' WHERE ${sql.in("id", decodeStrings(digest.report_ids_json))} AND state = 'completed'`;
      }
    }
    yield* sql`UPDATE custom_worker_jobs SET target_id = COALESCE(${owner}, worker_id), attempt = attempt + 1, dispatched_at = NULL
      WHERE state = 'queued' AND kind IN ('notice', 'done', 'blocked') AND ${sql.in("worker_id", [...ids])}`;
  });

  const applyOwnership = Effect.fn(function* (
    threadId: ThreadId,
    previous: string | null,
    owner: string | null,
    revision: number,
  ) {
    const record = yield* workerOf(threadId);
    yield* retargetReports([threadId], previous ? [previous] : [], owner);
    const baseline = yield* threads.getThreadEventSequence(threadId).pipe(Effect.mapError(failure));
    if (record) {
      yield* sql`UPDATE custom_workers SET owner_id = ${owner} WHERE thread_id = ${threadId}`;
    } else {
      const target = yield* thread(threadId);
      const plan = encodeJson({
        threadId,
        projectId: target.projectId,
        title: target.title,
        modelSelection: target.modelSelection,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        prompt: "Existing session assignment",
      });
      yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, baseline, read_seq)
        VALUES (${threadId}, ${owner}, ${plan}, 'ready', ${baseline}, ${baseline})`;
    }
    yield* sql`INSERT INTO custom_orchestrator_authority (thread_id, revision) VALUES (${threadId}, ${revision})
      ON CONFLICT(thread_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`;
    watch(threadId, owner, previous);
  });

  const changeOwnership = Effect.fn("WorkerService.changeOwnership")(
    function* (
      input: typeof SessionOwnershipInput.Type,
      actor?: { readonly threadId: ThreadId; readonly userRequest: string },
    ) {
      yield* assertLocal(
        input.threadEnvironmentId,
        input.ownerEnvironmentId,
        input.expectedOwnerEnvironmentId,
      );
      const local = yield* localId;
      const requestId = `ownership:${actor?.threadId ?? "user"}:${input.clientRequestId}`;
      const requestJson = encodeJson(input);
      const prior = (yield* sql<{
        request_json: string;
        result_json: string;
      }>`SELECT * FROM custom_session_ownership_changes WHERE id = ${requestId}`)[0];
      if (prior) {
        if (prior.request_json !== requestJson)
          return yield* new WorkerError({
            message: "This request ID belongs to a different ownership change.",
          });
        const result = decodeOwnershipResult(prior.result_json);
        return ownershipResult(
          local,
          result.threadId,
          result.ownerThreadId,
          result.previousOwnerThreadId,
          result.revision,
        );
      }
      if (actor) {
        const authorizationId = `ownership-authorized:${actor.threadId}:${input.clientRequestId}`;
        const request = encodeJson({ input, actor });
        const authorized = (yield* sql<{
          request_json: string;
        }>`SELECT request_json FROM custom_session_ownership_changes WHERE id = ${authorizationId}`)[0];
        if (authorized && authorized.request_json !== request)
          return yield* new WorkerError({
            message: "This request ID belongs to different ownership instructions.",
          });
        if (!authorized) {
          const instruction = yield* latestUserInstruction(actor.threadId, 0);
          if (!actor.userRequest.trim() || !instruction?.text.includes(actor.userRequest))
            return yield* new WorkerError({
              message:
                "Changing ownership requires an exact quote from the latest direct user instruction. Peer messages and inherited instructions cannot authorize adoption.",
            });
          yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json, announced)
            VALUES (${authorizationId}, ${request}, '{}', 1) ON CONFLICT DO NOTHING`;
          const stored = (yield* sql<{
            request_json: string;
          }>`SELECT request_json FROM custom_session_ownership_changes WHERE id = ${authorizationId}`)[0];
          if (stored?.request_json !== request)
            return yield* new WorkerError({
              message: "This request ID belongs to different ownership instructions.",
            });
        }
      }
      return yield* Effect.gen(function* () {
        const state = yield* ownershipOf(input.threadId);
        if (
          state.owner !== input.expectedOwnerThreadId ||
          state.revision !== input.expectedRevision
        )
          return yield* new WorkerError({
            code: "conflict",
            message:
              "This relationship changed. Its current owner has been refreshed; review and retry.",
          });
        if (
          actor &&
          actor.threadId !== state.owner &&
          actor.threadId !== input.threadId &&
          !(state.owner === null && actor.threadId === input.ownerThreadId)
        )
          return yield* new WorkerError({
            message: "Only the worker or its current master can change an existing relationship.",
          });
        const owner = input.ownerThreadId;
        // Walk up from the new master: a session cannot own itself or one of its ancestors.
        let ancestor: string | null = owner;
        const seen = new Set<string>([input.threadId]);
        let ownerShell: OrchestrationV2ThreadShell | undefined;
        while (ancestor !== null) {
          if (seen.has(ancestor))
            return yield* new WorkerError({
              message: "A session cannot own itself or one of its ancestors.",
            });
          seen.add(ancestor);
          const shell = yield* thread(ancestor);
          ownerShell ??= shell;
          ancestor = (yield* workerOf(ancestor))?.owner_id ?? null;
        }
        if (
          ownerShell &&
          state.target.runtimeMode === "full-access" &&
          ownerShell.runtimeMode !== "full-access"
        )
          return yield* new WorkerError({
            message: "The worker has broader permissions than the new master.",
          });
        if (state.owner === null && owner !== null && state.hasChildren)
          return yield* new WorkerError({
            message:
              "This session already owns workers. Assign an independent session, or transfer an existing worker with its children.",
          });
        const revision = state.revision + (owner === state.owner ? 0 : 1);
        const result = ownershipResult(local, input.threadId, owner, state.owner, revision);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* applyOwnership(input.threadId, state.owner, owner, revision);
            yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json, announced)
              VALUES (${requestId}, ${requestJson}, ${encodeJson(result)}, 1) ON CONFLICT(id) DO NOTHING`;
          }),
        );
        return result;
      }).pipe(lock.withPermit);
    },
    Effect.tap(() => kick()),
    Effect.mapError(ownershipFailure),
  );

  const prepareReclaim = Effect.fn("WorkerService.prepareReclaim")(function* (
    owner: ThreadId,
    input: typeof ReclaimInput.Type,
  ) {
    const ids = [...new Set(input.workerThreadIds)].sort();
    const request = encodeJson({ ...input, workerThreadIds: ids });
    const id = `reclaim:${owner}:${input.clientRequestId}`;
    const existing = (yield* sql<{
      request_json: string;
      result_json: string;
    }>`SELECT * FROM custom_worker_reclaims WHERE id = ${id}`)[0];
    if (existing) {
      if (existing.request_json !== request)
        return yield* new WorkerError({
          message: "This reclaim request ID already belongs to different workers or instructions.",
        });
      return { result: decodeReclaimResult(existing.result_json), done: true as const };
    }
    const claimant = yield* thread(owner);
    const authority = yield* authorityOf(owner);
    if (!authority)
      return yield* new WorkerError({
        message: "Only a former master can reclaim workers it previously handed off.",
      });
    const instruction = yield* latestUserInstruction(owner, authority.retired_sequence);
    if (!instruction || !instruction.text.includes(input.userRequest))
      return yield* new WorkerError({
        message:
          "Reclaim requires an exact quote from a new direct user instruction in this retired session. Peer messages and inherited prompts do not authorize reclaim.",
      });
    const selected: Array<WorkerRow> = [];
    for (const workerId of ids) {
      const record = yield* workerOf(workerId);
      const history =
        yield* sql`SELECT 1 FROM custom_orchestrator_handoffs h, json_each(h.transferred_json) item
        WHERE h.owner_id = ${owner} AND h.state = 'completed' AND item.value = ${workerId} LIMIT 1`;
      if (!record || !history.length || record.owner_id === null || record.state !== "ready")
        return yield* new WorkerError({
          message: `Worker ${workerId} is not a handed-off worker available for this master to reclaim.`,
        });
      const changing = yield* sql`SELECT 1 FROM custom_orchestrator_handoffs
        WHERE owner_id IN (${owner}, ${record.owner_id}) AND state = 'queued' LIMIT 1`;
      if (changing.length)
        return yield* new WorkerError({
          message: "Finish or cancel the pending handoff before reclaiming workers.",
        });
      yield* checkPermissions(owner, yield* thread(workerId));
      selected.push(record);
    }
    void claimant;
    return {
      result: {
        ownerThreadId: owner,
        workerThreadIds: ids,
        userMessageId: MessageId.make(instruction.id),
      },
      selected,
      request,
      done: false as const,
    };
  }, lock.withPermit);

  const reclaim = Effect.fn("WorkerService.reclaim")(function* (
    owner: ThreadId,
    input: typeof ReclaimInput.Type,
  ) {
    const plan = yield* prepareReclaim(owner, input);
    if (plan.done) return plan.result;
    // The whole reclaim commits at once, so a retry sees all of it or none of it.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previousOwners = new Set<string>();
          for (const worker of plan.selected) {
            const authority = yield* authorityOf(worker.thread_id);
            const revision = (authority?.revision ?? 0) + 1;
            if (worker.owner_id) previousOwners.add(worker.owner_id);
            yield* applyOwnership(
              ThreadId.make(worker.thread_id),
              worker.owner_id,
              owner,
              revision,
            );
            yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json, announced)
              VALUES (${`reclaim:${owner}:${input.clientRequestId}:${worker.thread_id}`}, ${plan.request}, ${encodeJson({ threadId: worker.thread_id, ownerThreadId: owner, previousOwnerThreadId: worker.owner_id, revision })}, 1)
              ON CONFLICT(id) DO NOTHING`;
          }
          yield* sql`UPDATE custom_orchestrator_authority SET active = 1, revision = revision + 1 WHERE thread_id = ${owner}`;
          yield* sql`INSERT INTO custom_worker_reclaims (id, owner_id, request_json, user_message_id, result_json)
            VALUES (${`reclaim:${owner}:${input.clientRequestId}`}, ${owner}, ${plan.request}, ${plan.result.userMessageId}, ${encodeJson(plan.result)}) ON CONFLICT DO NOTHING`;
        }),
      )
      .pipe(lock.withPermit);
    yield* kick();
    return plan.result;
  }, Effect.mapError(failure));

  const handoffResult = (row: HandoffRow): typeof HandoffResult.Type => ({
    threadId: ThreadId.make(row.thread_id),
    previousOwnerThreadId: ThreadId.make(row.owner_id),
    state: row.state,
    error: row.error,
    transferredWorkerIds: decodeIds(row.transferred_json),
    startupState: row.startup_state ?? null,
    startupError: row.startup_error ?? null,
  });
  const handoffRow = Effect.fn(function* (threadId: string) {
    return (yield* sql<HandoffRow>`SELECT h.*, j.state AS startup_state, j.error AS startup_error
      FROM custom_orchestrator_handoffs h LEFT JOIN custom_worker_jobs j ON j.id = 'handoff-start:' || h.thread_id
      WHERE h.thread_id = ${threadId}`)[0];
  });

  const handoffStatus = Effect.fn("WorkerService.handoffStatus")(
    function* (owner: ThreadId, input: typeof HandoffStatusInput.Type) {
      const row = (yield* sql<HandoffRow>`SELECT * FROM custom_orchestrator_handoffs
        WHERE thread_id = ${input.threadId} AND owner_id = ${owner}`)[0];
      if (!row) return yield* new WorkerError({ message: "Unknown handoff for this master." });
      if (input.cancel) {
        if (!["queued", "error", "cancelled"].includes(row.state))
          return yield* new WorkerError({
            message: "A completed ownership transfer cannot be cancelled.",
          });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled' WHERE id = ${`spawn:${input.threadId}`} AND state = 'queued'`;
            yield* sql`DELETE FROM custom_workers WHERE thread_id = ${input.threadId} AND owner_id = ${owner}`;
            yield* sql`UPDATE custom_orchestrator_handoffs SET state = 'cancelled' WHERE thread_id = ${input.threadId}`;
          }),
        );
      }
      return handoffResult((yield* handoffRow(input.threadId))!);
    },
    lock.withPermit,
    Effect.mapError(failure),
  );

  const handoff = Effect.fn("WorkerService.handoff")(
    function* (owner: ThreadId, rawInput: typeof HandoffInput.Type) {
      let input = rawInput;
      if (input.selfFork) {
        if (input.sourceThreadId && input.sourceThreadId !== owner)
          return yield* new WorkerError({
            message: "selfFork cannot select another source session.",
          });
        input = { ...input, sourceThreadId: owner };
      }
      yield* thread(owner);
      if (input.threadId === owner || input.threadId === input.sourceThreadId)
        return yield* new WorkerError({ message: "A successor must have a new thread ID." });
      const saved =
        (yield* sql<HandoffRow>`SELECT * FROM custom_orchestrator_handoffs WHERE thread_id = ${input.threadId}`)[0];
      const planJson = encodeJson(input);
      if (saved) {
        if (saved.owner_id !== owner || saved.plan_json !== planJson)
          return yield* new WorkerError({
            message: "This successor ID already has different handoff settings.",
          });
        if (saved.state !== "error") return handoffResult((yield* handoffRow(input.threadId))!);
      } else {
        const outstanding =
          yield* sql`SELECT 1 FROM custom_orchestrator_handoffs WHERE owner_id = ${owner} AND state IN ('queued', 'error')`;
        if (outstanding.length)
          return yield* new WorkerError({
            message: "Resolve the existing handoff before preparing another successor.",
          });
        if ((yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(failure))) !== null)
          return yield* new WorkerError({ message: "That destination thread already exists." });
      }
      yield* checkSuccessorAccount(owner, input.modelSelection);
      yield* checkSelection(input.modelSelection);
      if (input.sourceThreadId) yield* checkPermissions(owner, yield* thread(input.sourceThreadId));
      yield* sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json)
        VALUES (${input.threadId}, ${owner}, ${planJson})
        ON CONFLICT(thread_id) DO UPDATE SET state = 'queued', error = NULL`;
      watch(owner, input.threadId, input.sourceThreadId ?? null);
      // Settles now when the source is idle; a self-fork waits for its turn to end.
      yield* processHandoffs();
      return handoffResult((yield* handoffRow(input.threadId))!);
    },
    lock.withPermit,
    (effect, owner) => warnIfRetired(owner)(effect),
    Effect.mapError(failure),
  );

  const processHandoffs = Effect.fn(function* () {
    const rows =
      yield* sql<HandoffRow>`SELECT * FROM custom_orchestrator_handoffs WHERE state = 'queued' ORDER BY rowid`;
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const input = decodeHandoffInput(row.plan_json);
        const parent = yield* thread(row.owner_id);
        if (parent.archivedAt !== null || parent.snoozedUntil != null) return;
        // Self-forks must snapshot the completed turn, never a live tool call.
        if (input.sourceThreadId && busy(yield* thread(input.sourceThreadId))) return;
        if (parent.latestRunStopRequested === true) return;
        const successorMode = input.sourceThreadId
          ? (yield* thread(input.sourceThreadId)).runtimeMode
          : parent.runtimeMode;
        const children = yield* sql<WorkerRow>`SELECT * FROM custom_workers
          WHERE owner_id = ${row.owner_id} AND thread_id != ${row.thread_id}`;
        if (successorMode !== "full-access") {
          for (const child of children)
            if ((yield* thread(child.thread_id)).runtimeMode === "full-access")
              return yield* new WorkerError({
                message:
                  "The successor would have less permission than an existing worker. Choose a compatible source.",
              });
        }
        const parentRecord = yield* workerOf(row.owner_id);
        yield* spawnWorker(ThreadId.make(row.owner_id), parent, input, { forHandoff: true });
        const transferred = children.map((worker) => worker.thread_id);
        const prompt = `[T3 orchestrator handoff]\nPrevious orchestrator: ${row.owner_id}\nYou are the successor orchestrator. Existing worker ownership has transferred to this session. Use t3_worker_list/read to review current assignments and evidence before giving concrete follow-ups. Queued/running work continues; do not duplicate it. The previous conversation remains available.\n\n${input.prompt}`;
        const retiredSequence = yield* threads
          .getThreadEventSequence(ThreadId.make(row.owner_id))
          .pipe(Effect.mapError(failure));
        const createdAt = yield* now;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* retargetReports(transferred, [row.owner_id], row.thread_id);
            yield* sql`UPDATE custom_workers SET owner_id = ${row.thread_id} WHERE owner_id = ${row.owner_id} AND thread_id != ${row.thread_id}`;
            for (const id of transferred)
              yield* sql`INSERT INTO custom_orchestrator_authority (thread_id, revision) VALUES (${id}, 1)
                ON CONFLICT(thread_id) DO UPDATE SET revision = revision + 1`;
            yield* sql`INSERT INTO custom_orchestrator_authority
              (thread_id, active, successor_id, retired_sequence, revision)
              VALUES (${row.owner_id}, 0, ${row.thread_id}, ${retiredSequence}, 1)
              ON CONFLICT(thread_id) DO UPDATE SET active = 0, successor_id = excluded.successor_id,
                retired_sequence = excluded.retired_sequence, revision = revision + 1`;
            // A nested successor keeps the real parent above this group. The old conversation
            // stays reachable under that parent with its history.
            if (parentRecord?.owner_id) {
              yield* sql`UPDATE custom_workers SET owner_id = ${parentRecord.owner_id},
                communication_anchor_at = ${parentRecord.communication_anchor_at} WHERE thread_id = ${row.thread_id}`;
              watch(parentRecord.owner_id);
            } else yield* sql`DELETE FROM custom_workers WHERE thread_id = ${row.thread_id}`;
            yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
              VALUES (${`handoff-start:${row.thread_id}`}, ${row.owner_id}, ${row.thread_id}, 'message', ${prompt}, ${createdAt})
              ON CONFLICT(id) DO NOTHING`;
            yield* sql`UPDATE custom_orchestrator_handoffs SET state = 'completed', error = NULL,
              transferred_json = ${encodeJson(transferred)} WHERE thread_id = ${row.thread_id}`;
          }),
        );
      }).pipe(
        Effect.catch(
          (cause) =>
            sql`UPDATE custom_orchestrator_handoffs SET state = 'error', error = ${failure(cause).message} WHERE thread_id = ${row.thread_id}`,
        ),
      );
    }
  });

  const adoptDirectRun = Effect.fn(function* (threadId: string, run: OrchestrationV2Run) {
    if (run.userMessageId.startsWith("worker-job:")) return;
    const worker = yield* workerOf(threadId);
    if (!worker || worker.state !== "ready") return;
    const requestedAt = DateTime.formatIso(run.requestedAt);
    // Input typed into the worker itself still earns the master a runtime notice if it fails.
    yield* sql`INSERT INTO custom_worker_jobs
      (id, worker_id, target_id, kind, prompt, created_at, state, turn_id, dispatched_at)
      VALUES (${`direct:${threadId}:${run.id}`}, ${threadId}, ${threadId}, 'work', '', ${requestedAt}, 'submitted', ${run.id}, ${requestedAt})
      ON CONFLICT(id) DO NOTHING`;
  });

  const drain = Effect.fn("WorkerService.drain")(function* () {
    const workers = yield* sql<WorkerRow>`SELECT * FROM custom_workers WHERE state = 'ready'`;
    for (const worker of workers) {
      yield* refreshWorker(worker.thread_id);
      yield* reportTerminalJobs(worker.thread_id);
      yield* noticePendingRequests(worker);
    }
    yield* processHandoffs();
    yield* deliverQueued();
  }, Effect.mapError(failure));

  const handleEvent = Effect.fn(function* (event: OrchestrationV2DomainEvent) {
    if (!watched.has(event.threadId)) return;
    if (event.type === "run.updated") {
      yield* adoptDirectRun(event.threadId, event.payload).pipe(Effect.ignore);
      yield* kick();
    } else if (event.type === "runtime-request.updated") yield* kick();
  });

  const start = Effect.fn("WorkerService.start")(function* () {
    const rows = yield* sql<WorkerRow>`SELECT thread_id, owner_id FROM custom_workers`.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<WorkerRow>),
    );
    for (const row of rows) watch(row.thread_id, row.owner_id);
    const pendingHandoffs =
      yield* sql<HandoffRow>`SELECT * FROM custom_orchestrator_handoffs WHERE state = 'queued'`.pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<HandoffRow>),
      );
    for (const row of pendingHandoffs) {
      watch(row.owner_id, row.thread_id);
      watch(decodeHandoffInput(row.plan_json).sourceThreadId ?? null);
    }
    yield* forkParked(
      threads.streamDomainEvents.pipe(
        Stream.runForEach((event) => handleEvent(event)),
        Effect.catchCause((cause) => Effect.logWarning("worker event stream failed", { cause })),
      ),
    );
    yield* forkParked(
      Queue.take(drainRequests).pipe(
        Effect.andThen(drain()),
        Effect.catch((error) => Effect.logError("Worker queue reconciliation failed", error)),
        Effect.forever,
      ),
    );
    // Held reports and deliveries that failed once are retried even when no event arrives.
    yield* forkParked(
      sql`SELECT 1 FROM custom_worker_jobs WHERE state = 'queued' LIMIT 1`.pipe(
        Effect.flatMap((rows) => (rows.length ? kick() : Effect.void)),
        Effect.ignore,
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    );
    yield* kick();
  });

  return WorkerService.of({
    spawn: Effect.fn("WorkerService.spawn.kick")(function* (owner, input) {
      return yield* spawn(owner, input).pipe(Effect.tap(() => kick()));
    }),
    list,
    read,
    send: Effect.fn("WorkerService.send.kick")(function* (owner, input) {
      return yield* send(owner, input).pipe(Effect.tap(() => kick()));
    }),
    wait,
    control,
    report,
    handoff: Effect.fn("WorkerService.handoff.kick")(function* (owner, input) {
      return yield* handoff(owner, input).pipe(Effect.tap(() => kick()));
    }),
    handoffStatus,
    reclaim,
    readOwnership,
    changeOwnership,
    start,
    drain,
  });
});

export const layer = Layer.effect(WorkerService, make);
