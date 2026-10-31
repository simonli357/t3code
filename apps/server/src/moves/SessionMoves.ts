import {
  CommandId,
  EnvironmentId,
  EventId,
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestratorMcpFailure,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  RuntimeMode,
  SessionMoveError,
  SessionMoveInput,
  SessionMoveResult,
  SessionMoveStatusInput,
  ThreadId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { attachmentRelativePath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerRequests from "../peer/PeerRequests.ts";
import { findSessionTranscripts, resolveTranscriptHome } from "../project/AgentTranscripts.ts";
import { parsePeerRef, peerRef } from "../workers/workerSchemas.ts";
import * as CodexHistory from "../project/CodexMoveHistory.ts";
import * as CodexState from "../project/CodexMoveState.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Files from "../project/SessionMoveFiles.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SessionWorkspaces from "../workspace/SessionWorkspaces.ts";
import { MOVE_COMMAND_PREFIX } from "./ThreadMoveGuard.ts";

const MoveFile = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["native", "attachment", "provider-asset", "workspace", "history"]),
  bytes: Schema.Number,
  sha256: Schema.String,
  executable: Schema.Boolean,
});
const MOVE_DRIVER = Schema.Literals(["codex", "claudeAgent", "deepseekHarness"]);
type MoveDriver = typeof MOVE_DRIVER.Type;
const moveDriver = (driver: ProviderDriverKind): MoveDriver | undefined => {
  switch (driver) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claudeAgent";
    case "deepseekHarness":
      return "deepseekHarness";
    default:
      return undefined;
  }
};
/** What a session owes the workers around it, so they keep reporting to it from the other computer. */
const CoordinatedWorker = Schema.Struct({
  threadId: Schema.String,
  planJson: Schema.String,
  notify: Schema.Number,
  /** The worker already lives on the destination, so the move brings its master back to it. */
  home: Schema.Boolean,
});
const Coordination = Schema.Struct({
  /** The moving session as a worker, with the master that owns it. */
  worker: Schema.optional(
    Schema.Struct({
      ...CoordinatedWorker.fields,
      ownerThreadId: Schema.String,
      ownerRuntimeMode: RuntimeMode,
    }),
  ),
  /** The workers the moving session owns as a master. */
  children: Schema.Array(CoordinatedWorker),
});
const Manifest = Schema.Struct({
  input: SessionMoveInput,
  sourceEnvironmentId: Schema.String,
  targetEnvironmentId: Schema.String,
  driver: MOVE_DRIVER,
  nativeId: Schema.String,
  nativeIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: ModelSelection,
  title: Schema.String,
  runtimeMode: RuntimeMode,
  sourceCwd: Schema.String,
  targetCwd: Schema.String,
  workspace: Schema.Struct({
    head: Schema.String,
    origin: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
  }),
  files: Schema.Array(MoveFile),
  coordination: Schema.optional(Coordination),
});
type Manifest = typeof Manifest.Type;

const MoveRequest = Schema.Struct({
  op: Schema.Literals(["probe", "begin", "chunk", "prepare", "commit", "status", "cancel"]),
  requestId: CommandId,
  input: Schema.optional(SessionMoveInput),
  driver: Schema.optional(MOVE_DRIVER),
  modelSelection: Schema.optional(ModelSelection),
  head: Schema.optional(Schema.String),
  manifest: Schema.optional(Manifest),
  file: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(750_000))),
});
type WorkerRecord = {
  thread_id: string;
  owner_id: string | null;
  plan_json: string;
  state: string;
  notify: number;
};
type MoveRow = {
  id: string;
  thread_id: string;
  target_thread_id: string;
  direction: "out" | "in";
  peer_environment_id: string;
  state: SessionMoveResult["state"];
  locked: number;
  input_json: string;
  manifest_json: string | null;
  error: string | null;
  updated_at: string;
};
const decodeInput = Schema.decodeUnknownSync(Schema.fromJsonString(SessionMoveInput));
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));
const decodeRequest = Schema.decodeUnknownEffect(MoveRequest);
const isMoveError = Schema.is(SessionMoveError);
const eventsCodec = Schema.toCodecJson(Schema.Array(OrchestrationV2DomainEvent));
const encodeEvents = Schema.encodeSync(eventsCodec);
const decodeEvents = Schema.decodeUnknownEffect(Schema.fromJsonString(eventsCodec));
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = (value: unknown) => JSON.stringify(value);
const decodeCodexState = CodexState.decodeCodexMoveState;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The native session's own ID, when it is one a path can safely carry. */
const safeNativeId = (value: string | null | undefined) =>
  typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
const failure = (cause: unknown) =>
  isMoveError(cause)
    ? cause
    : new SessionMoveError({ message: cause instanceof Error ? cause.message : String(cause) });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const recordObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The thread's own history is bounded so one move cannot read a whole database into memory. */
const MAX_EVENTS = 250_000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
/** Between sessions, a move has nothing to wait for; a working one queues until it settles. */
const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export class SessionMoves extends Context.Service<
  SessionMoves,
  {
    readonly request: (
      input: SessionMoveInput,
      actor?: ThreadId,
    ) => Effect.Effect<SessionMoveResult, SessionMoveError>;
    readonly status: (
      input: SessionMoveStatusInput,
      actor?: ThreadId,
    ) => Effect.Effect<SessionMoveResult, SessionMoveError>;
    readonly drain: () => Effect.Effect<void, SessionMoveError>;
    readonly start: () => Effect.Effect<void, SessionMoveError, Scope.Scope>;
  }
>()("t3/moves/SessionMoves") {}

/** Rewrites what names the source computer so the copied history reads as the destination's. */
const remapValue = (
  value: unknown,
  map: {
    readonly sourceInstance: string;
    readonly targetInstance: string;
    readonly sourceProject: string;
    readonly targetProject: string;
    readonly targetCwd: string;
    readonly targetBranch: string;
  },
): unknown => {
  if (Array.isArray(value)) return value.map((entry) => remapValue(entry, map));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "providerInstanceId" || key === "instanceId") && entry === map.sourceInstance)
      result[key] = map.targetInstance;
    else if (key === "projectId" && entry === map.sourceProject) result[key] = map.targetProject;
    else if (key === "worktreePath" && typeof entry === "string") result[key] = map.targetCwd;
    else if (key === "branch" && typeof entry === "string") result[key] = map.targetBranch;
    else result[key] = remapValue(entry, map);
  }
  return result;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const isExecutable = yield* HostProcess.IsExecutable;
  const settings = yield* ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventStore.EventStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const registry = yield* ProviderRegistry;
  const links = yield* PeerLinks.PeerLinks;
  const requests = yield* PeerRequests.PeerRequests;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const workspaces = yield* Effect.serviceOption(SessionWorkspaces.SessionWorkspaces);
  const lock = yield* Semaphore.make(1);
  const incomingLock = yield* Semaphore.make(1);
  const work = yield* Queue.dropping<void>(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const localId = yield* environment.getEnvironmentId;

  const row = Effect.fn("SessionMoves.row")(function* (id: string) {
    return (yield* sql<MoveRow>`SELECT * FROM custom_session_moves WHERE id = ${id}`)[0];
  });
  const stagingDirectory = Effect.fn("SessionMoves.stagingDirectory")(function* (value: MoveRow) {
    const directory = Option.isSome(workspaces)
      ? yield* workspaces.value
          .transferDirectory(value.thread_id, value.id)
          .pipe(Effect.mapError(failure))
      : null;
    return directory ?? Files.moveDirectory(config.stateDir, value.id);
  });
  const authorize = Effect.fn("SessionMoves.authorize")(function* (
    threadId: ThreadId,
    actor: ThreadId | undefined,
  ) {
    if (!actor || actor === threadId) return;
    const owned =
      yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId} AND owner_id = ${actor}`;
    if (owned.length === 0)
      return yield* new SessionMoveError({
        message: "Move this session or a worker you currently own.",
      });
  });
  const result = (value: MoveRow): SessionMoveResult => {
    const input = decodeInput(value.input_json);
    return {
      requestId: CommandId.make(value.id),
      threadId: input.threadId,
      targetThreadId: input.threadId,
      sourceEnvironmentId: EnvironmentId.make(
        value.direction === "out" ? localId : value.peer_environment_id,
      ),
      targetEnvironmentId: EnvironmentId.make(
        value.direction === "out" ? value.peer_environment_id : localId,
      ),
      projectId: input.projectId,
      state: value.state,
      error: value.error,
      updatedAt: value.updated_at,
    };
  };
  const setState = Effect.fn("SessionMoves.setState")(function* (
    id: string,
    state: MoveRow["state"],
    error: string | null = null,
  ) {
    yield* sql`UPDATE custom_session_moves SET state = ${state}, error = ${error}, updated_at = ${yield* now} WHERE id = ${id}`;
  });

  /** The directory the provider keeps its sessions in for this account. */
  const nativeHome = Effect.fn("SessionMoves.nativeHome")(
    function* (instanceId: ProviderInstanceId, driver: MoveDriver) {
      const current = yield* settings.getSettings.pipe(Effect.mapError(failure));
      const configured = current.providerInstances[instanceId];
      const instance =
        configured ??
        (instanceId === driver ? { driver: ProviderDriverKind.make(driver) } : undefined);
      if (!instance || instance.driver !== driver)
        return yield* new SessionMoveError({
          message:
            "The destination account must use the same provider. Configure a matching account before moving.",
        });
      if (driver === "deepseekHarness")
        return yield* new SessionMoveError({
          message: "DeepSeek Harness sessions cannot move until that provider is available here.",
        });
      const home = yield* resolveTranscriptHome(instance, hostEnvironment);
      if (!home)
        return yield* new SessionMoveError({
          message: "The provider session directory could not be resolved.",
        });
      return home;
    },
    Effect.provideService(Path.Path, path),
  );

  /** The destination needs the same provider, signed in, with the saved model and options. */
  const profile = Effect.fn("SessionMoves.profile")(function* (
    driver: MoveDriver,
    selection: ModelSelection,
  ) {
    const choices = yield* registry.getProviders;
    const instance = choices.find((entry) => entry.instanceId === selection.instanceId);
    const model = instance?.models.find(
      (entry) => entry.slug === selection.model || entry.aliases?.includes(selection.model),
    );
    if (
      !instance ||
      instance.driver !== driver ||
      !instance.enabled ||
      instance.auth.status !== "authenticated" ||
      !model
    )
      return yield* new SessionMoveError({
        message:
          "The destination needs the same provider, an authenticated account, and the selected model. No provider/model fallback is used.",
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
        return yield* new SessionMoveError({
          message: "The destination does not support the saved model options.",
        });
    }
  });

  const parkedCopy = (threadId: string) =>
    sql`SELECT 1 FROM custom_session_moves WHERE thread_id = ${threadId}
      AND locked = 1 AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))`;
  const threadExists = Effect.fn("SessionMoves.threadExists")(function* (threadId: ThreadId) {
    return (yield* threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell !== null && shell.deletedAt === null),
      Effect.orElseSucceed(() => false),
    )) as boolean;
  });

  const targetProbe = Effect.fn("SessionMoves.targetProbe")(function* (
    from: string,
    input: SessionMoveInput,
    driver: MoveDriver,
    selection: ModelSelection,
    head: string,
  ) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(failure), Effect.map(Option.getOrUndefined));
    if (project === undefined)
      return yield* new SessionMoveError({
        message: "Choose a project on the destination computer.",
      });
    yield* profile(driver, selection);
    yield* nativeHome(selection.instanceId, driver);
    const exists = yield* threadExists(input.threadId);
    if (exists && (yield* parkedCopy(input.threadId)).length === 0)
      return yield* new SessionMoveError({
        message: "The destination already has an independent session with this ID.",
      });
    const cwd =
      (Option.isSome(workspaces)
        ? yield* workspaces.value
            .movePath(input.threadId, input.requestId)
            .pipe(Effect.mapError(failure))
        : null) ?? Files.moveDirectory(config.worktreesDir, input.requestId);
    const hasCommit = yield* io(() =>
      Files.git(project.workspaceRoot, ["cat-file", "-e", head + "^{commit}"])
        .then(() => true)
        .catch(() => false),
    );
    return { cwd, hasCommit, replaceExisting: exists, source: from };
  });

  /** Waits for the session to settle; a working conversation is never copied mid-turn. */
  const settled = Effect.fn("SessionMoves.settled")(function* (threadId: ThreadId) {
    const records = yield* threads.getThreadRecords(threadId, ["runs", "providerThreads"]);
    const shell = yield* threads.getThreadShell(threadId);
    return (
      shell !== null &&
      shell.pendingRuntimeRequest === null &&
      !records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) &&
      !records.providerThreads.some((entry) => (entry.pendingBackgroundTasks?.length ?? 0) > 0)
    );
  }, Effect.mapError(failure));

  /** Closes the provider's live session so its native files stop changing before they are read. */
  const closeSessions = Effect.fn("SessionMoves.closeSessions")(function* (threadId: ThreadId) {
    const records = yield* threads.getThreadRecords(threadId, ["providerSessions"]);
    for (const session of records.providerSessions) {
      if (!(yield* providerSessions.isLive(session.id))) continue;
      yield* providerSessions.detach({
        providerSessionId: session.id,
        threadId,
        detail: "session move",
      });
    }
  }, Effect.mapError(failure));

  const replan = (planJson: string, change: (plan: Record<string, unknown>) => void) => {
    const plan = recordObject(parseJson(planJson));
    change(plan);
    return encode(plan);
  };

  /**
   * The workers a session owns, and the master that owns it, as they must travel with it. A
   * session whose workers or master run on a third computer waits until they come back.
   */
  const coordinationOf = Effect.fn("SessionMoves.coordinationOf")(function* (
    threadId: ThreadId,
    destination: string,
  ) {
    const own =
      yield* sql<WorkerRecord>`SELECT * FROM custom_workers WHERE thread_id = ${threadId}`;
    const children = yield* sql<WorkerRecord>`SELECT * FROM custom_workers
      WHERE owner_id = ${threadId} AND thread_id != ${threadId}`;
    const busy = yield* sql`SELECT 1 FROM custom_worker_jobs
      WHERE state IN ('queued', 'submitted')
        AND (worker_id = ${threadId} AND kind IN ('work', 'message'))
      LIMIT 1`;
    if (busy.length > 0)
      return yield* new SessionMoveError({
        message: "Wait for this session's queued assignments and messages before moving it.",
      });
    const refuse = (message: string) => new SessionMoveError({ message });
    let worker: typeof Coordination.Type.worker;
    const record = own[0];
    if (record?.owner_id) {
      if (record.state !== "ready")
        return yield* refuse("This worker is still starting; move it once it is ready.");
      const peer = parsePeerRef(record.owner_id);
      if (peer && peer.environmentId !== destination)
        return yield* refuse(
          "This worker belongs to a master on another computer. Move it from that master's computer or release it first.",
        );
      const ownerThreadId = peer ? peer.threadId : record.owner_id;
      const ownerShell = peer
        ? undefined
        : yield* threads
            .getThreadShell(ThreadId.make(ownerThreadId))
            .pipe(Effect.mapError(failure));
      worker = {
        threadId,
        planJson: record.plan_json,
        notify: record.notify,
        home: peer !== undefined,
        ownerThreadId,
        ownerRuntimeMode:
          ownerShell?.runtimeMode ??
          (recordObject(parseJson(record.plan_json)).ownerRuntimeMode as typeof RuntimeMode.Type) ??
          "approval-required",
      };
    }
    const owned: Array<typeof CoordinatedWorker.Type> = [];
    for (const child of children) {
      const plan = recordObject(parseJson(child.plan_json));
      const remoteHome = child.state === "remote" && plan.environmentId === destination;
      if (child.state !== "ready" && !remoteHome)
        return yield* refuse(
          child.state === "remote"
            ? "This session owns workers on another computer. Hand them back before moving it."
            : "A worker of this session is still starting; move it once the worker is ready.",
        );
      owned.push({
        threadId: child.thread_id,
        planJson: child.plan_json,
        notify: child.notify,
        home: remoteHome,
      });
    }
    return worker === undefined && owned.length === 0
      ? undefined
      : { ...(worker ? { worker } : {}), children: owned };
  });

  /** The source's side of coordination once the destination holds the session. Safe to repeat. */
  const releaseCoordination = Effect.fn("SessionMoves.releaseCoordination")(function* (
    value: MoveRow,
  ) {
    const saved = yield* row(value.id);
    const coordination = saved?.manifest_json
      ? decodeManifest(saved.manifest_json).coordination
      : undefined;
    if (!coordination) return;
    const threadId = value.thread_id;
    const destination = value.peer_environment_id;
    const guest = peerRef(destination, threadId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const worker = coordination.worker;
        if (worker?.home) yield* sql`DELETE FROM custom_workers WHERE thread_id = ${threadId}`;
        else if (worker)
          yield* sql`UPDATE custom_workers SET state = 'remote', plan_json = ${replan(
            worker.planJson,
            (plan) => {
              plan.environmentId = destination;
              plan.syncedOwnerId = worker.ownerThreadId;
            },
          )} WHERE thread_id = ${threadId}`;
        const away = coordination.children
          .filter((child) => !child.home)
          .map((child) => child.threadId);
        const back = coordination.children
          .filter((child) => child.home)
          .map((child) => child.threadId);
        if (back.length > 0)
          yield* sql`DELETE FROM custom_workers WHERE ${sql.in("thread_id", back)}`;
        for (const child of coordination.children.filter((entry) => !entry.home))
          yield* sql`UPDATE custom_workers SET owner_id = ${guest}, plan_json = ${replan(
            child.planJson,
            (plan) => {
              plan.ownerRuntimeMode = recordObject(plan).runtimeMode;
            },
          )} WHERE thread_id = ${child.threadId}`;
        // Reports still waiting for this session now follow it to the destination.
        yield* sql`UPDATE custom_worker_jobs SET target_id = ${guest}, attempt = attempt + 1, dispatched_at = NULL
          WHERE state = 'queued' AND kind IN ('notice', 'done', 'blocked') AND target_id = ${threadId}`;
        if (away.length > 0)
          yield* sql`UPDATE custom_worker_jobs SET target_id = ${guest}, attempt = attempt + 1, dispatched_at = NULL
            WHERE state = 'queued' AND kind IN ('notice', 'done', 'blocked') AND ${sql.in("worker_id", away)}`;
      }),
    );
  });

  /** The destination's side of coordination, applied as the move commits. Safe to repeat. */
  const adoptCoordination = Effect.fn("SessionMoves.adoptCoordination")(function* (
    value: MoveRow,
    manifest: Manifest,
  ) {
    const coordination = manifest.coordination;
    if (!coordination) return;
    const threadId = manifest.input.threadId;
    const source = value.peer_environment_id;
    const baseline = yield* events.latestSequence({ threadId });
    const worker = coordination.worker;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (worker?.home)
          yield* sql`UPDATE custom_workers SET state = 'ready', owner_id = ${worker.ownerThreadId},
            plan_json = ${replan(worker.planJson, (plan) => {
              delete plan.environmentId;
              delete plan.syncedOwnerId;
              delete plan.ownerRuntimeMode;
              plan.modelSelection = manifest.modelSelection;
              plan.projectId = manifest.input.projectId;
            })} WHERE thread_id = ${threadId}`;
        else if (worker) {
          const planJson = replan(worker.planJson, (plan) => {
            delete plan.environmentId;
            delete plan.syncedOwnerId;
            plan.modelSelection = manifest.modelSelection;
            plan.projectId = manifest.input.projectId;
            plan.ownerRuntimeMode = worker.ownerRuntimeMode;
          });
          yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, notify, baseline, read_seq)
            VALUES (${threadId}, ${peerRef(source, worker.ownerThreadId)}, ${planJson}, 'ready', ${worker.notify}, ${baseline}, ${baseline})
            ON CONFLICT(thread_id) DO UPDATE SET owner_id = excluded.owner_id, plan_json = excluded.plan_json,
              state = 'ready', notify = excluded.notify`;
        }
        for (const child of coordination.children)
          if (child.home)
            yield* sql`UPDATE custom_workers SET owner_id = ${threadId} WHERE thread_id = ${child.threadId}`;
          else {
            const planJson = replan(child.planJson, (plan) => {
              plan.environmentId = source;
              plan.syncedOwnerId = threadId;
            });
            yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, notify)
              VALUES (${child.threadId}, ${threadId}, ${planJson}, 'remote', ${child.notify})
              ON CONFLICT(thread_id) DO UPDATE SET owner_id = excluded.owner_id, plan_json = excluded.plan_json, state = 'remote'`;
          }
      }),
    );
  });

  const capture = Effect.fn("SessionMoves.capture")(function* (value: MoveRow) {
    if (value.manifest_json) return decodeManifest(value.manifest_json);
    const input = decodeInput(value.input_json);
    const records = yield* threads
      .getThreadRecords(input.threadId, ["messages", "providerThreads"])
      .pipe(Effect.mapError(failure));
    const thread = records.thread;
    const providerThread: OrchestrationV2ProviderThread | undefined = records.providerThreads.find(
      (entry) => entry.id === thread.activeProviderThreadId,
    );
    const driver = providerThread ? moveDriver(providerThread.driver) : undefined;
    const nativeId = safeNativeId(providerThread?.nativeThreadRef?.nativeId);
    if (!providerThread || driver === undefined)
      return yield* new SessionMoveError({
        message: "This provider does not support native session moves.",
      });
    if (!nativeId)
      return yield* new SessionMoveError({
        message: "The source has no persisted native resume identifier.",
      });
    const sourceProject = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(failure), Effect.map(Option.getOrUndefined));
    if (sourceProject === undefined)
      return yield* new SessionMoveError({ message: "The source project is missing." });
    const sourceCwd = thread.worktreePath ?? sourceProject.workspaceRoot;
    const workspace = yield* io(() => Files.inspectMoveWorkspace(sourceCwd));
    const selection = {
      ...thread.modelSelection,
      instanceId: input.providerInstanceId ?? thread.modelSelection.instanceId,
    };
    const probe = recordObject(
      yield* requests
        .call(value.peer_environment_id as EnvironmentId, "sessionMove", {
          op: "probe",
          requestId: input.requestId,
          input,
          driver,
          modelSelection: selection,
          head: workspace.head,
        })
        .pipe(Effect.mapError(failure)),
    );
    if (typeof probe.cwd !== "string" || typeof probe.hasCommit !== "boolean")
      return yield* new SessionMoveError({
        message: "The destination needs nativeSessionMoves support.",
      });
    const home = yield* nativeHome(providerThread.providerInstanceId, driver);
    const staging = yield* stagingDirectory(value);
    yield* fs.makeDirectory(staging, { recursive: true }).pipe(Effect.mapError(failure));
    const nativeState =
      driver === "codex"
        ? yield* io(() => CodexState.captureCodexMoveState(home.homePath, nativeId))
        : null;
    const family = nativeState?.nativeIds ?? [nativeId];
    let entries = nativeState?.rollouts
      ? nativeState.rollouts.map((entry) => ({ path: Files.contained(home.homePath, entry.name) }))
      : (yield* Effect.forEach(family, (id) =>
          findSessionTranscripts(home, id).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        )).flat();
    if (driver === "claudeAgent") {
      const currentDirectory = path.join(
        home.homePath,
        "projects",
        sourceCwd.replace(/[^a-zA-Z0-9]/g, "-"),
      );
      const current = entries.filter((entry) => path.dirname(entry.path) === currentDirectory);
      if (current.length) entries = current;
    }
    if (!entries.length)
      return yield* new SessionMoveError({
        message:
          "The complete native transcript could not be found; a summary will not be substituted.",
      });
    const files: Files.MoveFile[] = [];
    if (nativeState) {
      const filename = path.join(staging, "codex-state.json");
      yield* fs.writeFileString(filename, encode(nativeState)).pipe(Effect.mapError(failure));
      files.push(
        yield* io(() =>
          Files.copyMoveFile({
            source: filename,
            sourceRoot: staging,
            staging,
            kind: "history",
            name: "codex-state.json",
          }),
        ),
      );
    }
    for (const entry of entries) {
      const info = yield* fs.stat(entry.path).pipe(Effect.mapError(failure));
      const sourceFiles =
        info.type === "Directory" ? yield* io(() => Files.listMoveFiles(entry.path)) : [entry.path];
      for (const source of sourceFiles) {
        const name =
          driver === "codex"
            ? path.relative(home.homePath, source).replaceAll("\\", "/")
            : path
                .relative(path.dirname(info.type === "Directory" ? entry.path : source), source)
                .replaceAll("\\", "/");
        if (files.some((file) => file.kind === "native" && file.name === name))
          return yield* new SessionMoveError({
            message: "Multiple native transcript copies need disambiguation before moving.",
          });
        const prefixBytes = nativeState?.rollouts?.find((entry) => entry.name === name)?.bytes;
        files.push(
          yield* io(() =>
            Files.copyMoveFile({
              source,
              sourceRoot: home.homePath,
              staging,
              kind: "native",
              name,
              ...(prefixBytes === undefined ? {} : { bytes: prefixBytes }),
            }),
          ),
        );
      }
    }
    for (const message of records.messages)
      for (const attachment of message.attachments ?? []) {
        const name = attachmentRelativePath(attachment);
        if (!name || files.some((file) => file.kind === "attachment" && file.name === name))
          continue;
        files.push(
          yield* io(() =>
            Files.copyMoveFile({
              source: Files.contained(config.attachmentsDir, name),
              sourceRoot: config.attachmentsDir,
              staging,
              kind: "attachment",
              name,
            }),
          ),
        );
      }
    const head = yield* events.latestSequence({ threadId: input.threadId });
    const original = yield* Stream.runCollect(
      events.read({ threadId: input.threadId, throughSequence: head, limit: MAX_EVENTS + 1 }),
    ).pipe(Effect.mapError(failure));
    const history = Array.from(original, (stored) => stored.event).filter(
      (event) => !event.type.startsWith("provider-session."),
    );
    if (original.length > MAX_EVENTS)
      return yield* new SessionMoveError({
        message: "The T3 history exceeds the move budget; no history has been truncated.",
      });
    const targetBranch = Files.moveBranch(value.id);
    const remapped = remapValue(encodeEvents(history), {
      sourceInstance: thread.modelSelection.instanceId,
      targetInstance: selection.instanceId,
      sourceProject: thread.projectId,
      targetProject: input.projectId,
      targetCwd: probe.cwd,
      targetBranch,
    });
    const historyJson = encode(remapped);
    if (historyJson.length > MAX_HISTORY_BYTES)
      return yield* new SessionMoveError({
        message: "The T3 history exceeds the move budget; no history has been truncated.",
      });
    const historyFile = path.join(staging, "events.json");
    yield* fs.writeFileString(historyFile, historyJson).pipe(Effect.mapError(failure));
    files.push(
      yield* io(() =>
        Files.copyMoveFile({
          source: historyFile,
          sourceRoot: staging,
          staging,
          kind: "history",
          name: "events.json",
        }),
      ),
    );
    files.push(
      ...(yield* io(() =>
        Files.captureMoveWorkspace(sourceCwd, staging, !probe.hasCommit, input.threadId),
      )),
    );
    yield* io(async () => Files.validateMoveFiles(files));
    const coordination = yield* coordinationOf(input.threadId, value.peer_environment_id);
    const manifest: Manifest = {
      input,
      sourceEnvironmentId: localId,
      targetEnvironmentId: value.peer_environment_id,
      driver,
      nativeId,
      ...(nativeState ? { nativeIds: nativeState.nativeIds } : {}),
      modelSelection: selection,
      title: thread.title,
      runtimeMode: thread.runtimeMode,
      sourceCwd,
      targetCwd: probe.cwd,
      workspace,
      files,
      ...(coordination ? { coordination } : {}),
    };
    yield* sql`UPDATE custom_session_moves SET manifest_json = ${encode(manifest)} WHERE id = ${value.id}`;
    return manifest;
  });

  const prepareTarget = Effect.fn("SessionMoves.prepareTarget")(function* (value: MoveRow) {
    const manifest = decodeManifest(value.manifest_json!);
    const staging = yield* stagingDirectory(value);
    yield* io(() => Files.verifyMoveFiles(staging, manifest.files));
    const project = yield* projects
      .getById(manifest.input.projectId)
      .pipe(Effect.mapError(failure), Effect.map(Option.getOrUndefined));
    if (project === undefined)
      return yield* new SessionMoveError({ message: "The destination project disappeared." });
    const returning =
      yield* sql`SELECT 1 FROM custom_session_moves WHERE thread_id = ${manifest.input.threadId}
      AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))
      AND EXISTS (SELECT 1 FROM custom_session_moves WHERE id = ${value.id} AND direction = 'in' AND locked = 1)`;
    if (Option.isSome(workspaces)) {
      const previous = yield* workspaces.value
        .get(manifest.input.threadId)
        .pipe(Effect.mapError(failure));
      if (
        previous &&
        previous.reservationId !== `move:${value.id}` &&
        previous.workspaceDirectory === manifest.targetCwd
      ) {
        // The move lock was taken only after the probe established that this host's copy
        // was parked. Keep its whole worktree, ignored files and uncommitted work included.
        if (returning.length === 0)
          return yield* new SessionMoveError({
            message: "An existing local job is not a parked outgoing session.",
          });
        yield* io(() =>
          Files.parkReturningWorkspace(
            previous.workspaceDirectory,
            previous.root,
            staging,
            value.id,
          ),
        );
      }
    }
    yield* io(() =>
      Files.restoreMoveWorkspace({
        projectRoot: project.workspaceRoot,
        cwd: manifest.targetCwd,
        staging,
        workspace: manifest.workspace,
        files: manifest.files,
        requestId: value.id,
        threadId: manifest.input.threadId,
      }),
    );
    if (Option.isSome(workspaces))
      yield* workspaces.value
        .registerMove({
          threadId: manifest.input.threadId,
          requestId: value.id,
          sourceDirectory: project.workspaceRoot,
          cwd: manifest.targetCwd,
          revision: manifest.workspace.head,
          branch: Files.moveBranch(value.id),
        })
        .pipe(Effect.mapError(failure));
    const home = yield* nativeHome(manifest.modelSelection.instanceId, manifest.driver);
    const imported =
      (yield* sql`SELECT 1 FROM orchestration_v2_events WHERE event_id = ${`move:${value.id}:history`}`)
        .length > 0;
    const replace = returning.length > 0 || imported;
    const nativeState =
      manifest.driver === "codex"
        ? (decodeCodexState(
            yield* fs
              .readFileString(path.join(staging, "history", "codex-state.json"))
              .pipe(Effect.mapError(failure)),
          ) as CodexState.CodexMoveState)
        : null;
    const nativeRoot =
      manifest.driver === "claudeAgent"
        ? path.join(home.homePath, "projects", manifest.targetCwd.replace(/[^a-zA-Z0-9]/g, "-"))
        : home.homePath;
    yield* fs.makeDirectory(nativeRoot, { recursive: true }).pipe(Effect.mapError(failure));
    if (nativeState) {
      if (
        !nativeState.nativeIds.includes(manifest.nativeId) ||
        (manifest.nativeIds && encode(manifest.nativeIds) !== encode(nativeState.nativeIds))
      )
        return yield* new SessionMoveError({
          message: "Codex move ownership does not match its native state.",
        });
      yield* io(() =>
        CodexHistory.installCodexMoveHistory(
          staging,
          nativeRoot,
          nativeState.nativeIds,
          manifest.files,
          replace,
        ),
      );
    } else
      for (const file of manifest.files.filter((entry) => entry.kind === "native"))
        yield* io(() => Files.installMoveFile(staging, file, nativeRoot, file.name, replace));
    if (manifest.driver === "claudeAgent") {
      const workerArgs = isExecutable
        ? ["__claude-history"]
        : [
            yield* path
              .fromFileUrl(new URL("../claude-history-worker.ts", import.meta.url))
              .pipe(Effect.mapError(failure)),
          ];
      yield* io(() =>
        Files.verifyClaudeMove(
          process.execPath,
          workerArgs,
          home.homePath,
          manifest.targetCwd,
          manifest.nativeId,
        ),
      );
    }
    if (!imported) {
      const history = yield* decodeEvents(
        yield* fs
          .readFileString(path.join(staging, "history", "events.json"))
          .pipe(Effect.mapError(failure)),
      ).pipe(Effect.mapError(failure));
      yield* sink
        .write({
          commandId: CommandId.make(`${MOVE_COMMAND_PREFIX}${value.id}:import`),
          events: history.map((event, index) => ({
            ...event,
            id: EventId.make(`move:${value.id}:${index === 0 ? "history" : index}`),
          })),
        })
        .pipe(Effect.mapError(failure));
    }
    for (const file of manifest.files.filter((entry) => entry.kind === "attachment"))
      yield* io(() => Files.installMoveFile(staging, file, config.attachmentsDir));
    if (nativeState?.databases.length)
      yield* io(() =>
        CodexState.installCodexMoveState(home.homePath, manifest.targetCwd, nativeState),
      );
    yield* setState(value.id, "prepared");
  });

  const receive = Effect.fn("SessionMoves.receive")(
    function* (from: string, raw: unknown) {
      const request = yield* decodeRequest(raw).pipe(Effect.mapError(failure));
      if (request.op === "probe") {
        if (!request.input || !request.driver || !request.modelSelection || !request.head)
          return yield* new SessionMoveError({ message: "Incomplete session-move probe." });
        if (request.manifest) {
          const manifest = request.manifest;
          if (
            manifest.sourceEnvironmentId !== from ||
            manifest.targetEnvironmentId !== localId ||
            manifest.input.requestId !== request.requestId ||
            encode(manifest.input) !== encode(request.input) ||
            manifest.driver !== request.driver ||
            encode(manifest.modelSelection) !== encode(request.modelSelection) ||
            manifest.workspace.head !== request.head ||
            (yield* row(request.requestId)) ||
            (Option.isSome(workspaces) &&
              (yield* sql`SELECT 1 FROM session_workspaces WHERE reservation_id = ${`move:${request.requestId}`}`)
                .length > 0)
          )
            return yield* new SessionMoveError({
              message: "Only an unreserved transfer can reconcile its destination workspace.",
            });
        }
        const probe = yield* targetProbe(
          from,
          request.input,
          request.driver,
          request.modelSelection,
          request.head,
        );
        return { ...probe, ...(request.manifest ? { unreserved: true } : {}) };
      }
      if (request.op === "begin") {
        const manifest = request.manifest;
        if (
          !manifest ||
          manifest.sourceEnvironmentId !== from ||
          manifest.targetEnvironmentId !== localId ||
          manifest.input.requestId !== request.requestId
        )
          return yield* new SessionMoveError({
            message: "The transfer addresses do not match its authenticated peers.",
          });
        yield* io(async () => Files.validateMoveFiles(manifest.files));
        const saved = yield* row(request.requestId);
        if (saved) {
          if (
            saved.direction === "in" &&
            saved.peer_environment_id === from &&
            saved.state === "cancelled"
          )
            return result(saved);
          if (
            saved.direction !== "in" ||
            saved.peer_environment_id !== from ||
            saved.manifest_json !== encode(manifest)
          )
            return yield* new SessionMoveError({
              message: "This request ID belongs to a different transfer.",
            });
          return result(saved);
        }
        const probe = yield* targetProbe(
          from,
          manifest.input,
          manifest.driver,
          manifest.modelSelection,
          manifest.workspace.head,
        );
        if (manifest.targetCwd !== probe.cwd)
          return yield* new SessionMoveError({
            message: "The transfer workspace does not match its destination.",
          });
        const nativeFiles = manifest.files.filter((entry) => entry.kind === "native");
        for (const file of nativeFiles) {
          const valid =
            manifest.driver === "codex"
              ? /^(sessions\/[0-9]{4}\/[0-9]{2}\/[0-9]{2}|archived_sessions)\/rollout-[^/]+-[0-9a-f-]{36}\.jsonl$/i.test(
                  file.name,
                )
              : file.name === manifest.nativeId + ".jsonl" ||
                file.name.startsWith(manifest.nativeId + "/");
          if (!valid)
            return yield* new SessionMoveError({
              message: "A transfer entry is not native conversation state.",
            });
        }
        if (!nativeFiles.length)
          return yield* new SessionMoveError({ message: "The native transcript is missing." });
        if (manifest.files.some((entry) => entry.kind === "provider-asset"))
          return yield* new SessionMoveError({
            message: "A transfer entry is not a provider asset this build accepts.",
          });
        const owned = yield* sql<{
          thread_id: string;
        }>`SELECT thread_id FROM orchestration_v2_projection_provider_threads
          WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${manifest.nativeId}
            AND json_extract(payload_json, '$.providerInstanceId') = ${manifest.modelSelection.instanceId}
            AND thread_id != ${manifest.input.threadId} LIMIT 1`.pipe(
          Effect.orElseSucceed(() => []),
        );
        if (owned.length > 0)
          return yield* new SessionMoveError({
            message: "Another destination conversation already owns this native session.",
          });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE custom_session_moves SET locked = 0 WHERE thread_id = ${manifest.input.threadId}
              AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))`;
            yield* sql`INSERT INTO custom_session_moves
              (id, thread_id, target_thread_id, direction, peer_environment_id, state, input_json, manifest_json, created_at, updated_at)
              VALUES (${request.requestId}, ${manifest.input.threadId}, ${manifest.input.threadId}, 'in', ${from}, 'copying', ${encode(manifest.input)}, ${encode(manifest)}, ${yield* now}, ${yield* now})`;
            // The incoming lock and its workspace reservation commit together, so a
            // concurrent create loses before either side checks out files.
            if (Option.isSome(workspaces)) {
              const project = yield* projects
                .getById(manifest.input.projectId)
                .pipe(Effect.mapError(failure), Effect.map(Option.getOrUndefined));
              if (project === undefined)
                return yield* new SessionMoveError({
                  message: "The destination project disappeared.",
                });
              yield* workspaces.value
                .reserveMove({
                  threadId: manifest.input.threadId,
                  requestId: request.requestId,
                  sourceDirectory: project.workspaceRoot,
                  cwd: manifest.targetCwd,
                  revision: manifest.workspace.head,
                  branch: Files.moveBranch(request.requestId),
                })
                .pipe(Effect.mapError(failure));
            }
          }),
        );
        return result((yield* row(request.requestId))!);
      }
      const saved = yield* row(request.requestId);
      if (!saved && request.op === "cancel" && request.input) {
        const input = request.input;
        yield* sql`INSERT INTO custom_session_moves (id, thread_id, target_thread_id, direction, peer_environment_id, state, locked, input_json, created_at, updated_at)
          VALUES (${request.requestId}, ${input.threadId}, ${input.threadId}, 'in', ${from}, 'cancelled', 0, ${encode(input)}, ${yield* now}, ${yield* now})`;
        return result((yield* row(request.requestId))!);
      }
      if (!saved && (request.op === "status" || request.op === "cancel"))
        return { state: "absent" };
      if (!saved || saved.direction !== "in" || saved.peer_environment_id !== from)
        return yield* new SessionMoveError({
          message: "This peer does not own the staged transfer.",
        });
      if (request.op === "status") return result(saved);
      if (request.op === "cancel") {
        if (saved.state === "complete") return result(saved);
        yield* closeSessions(ThreadId.make(saved.thread_id)).pipe(Effect.ignore);
        yield* setState(saved.id, "cancelled");
        return result((yield* row(saved.id))!);
      }
      if (saved.state === "cancelled")
        return yield* new SessionMoveError({ message: "This transfer was cancelled." });
      if (request.op === "chunk") {
        if (saved.state !== "copying") return result(saved);
        const manifest = decodeManifest(saved.manifest_json!);
        const file = request.file === undefined ? undefined : manifest.files[request.file];
        if (!file || request.offset === undefined || request.data === undefined)
          return yield* new SessionMoveError({ message: "Invalid transfer chunk." });
        const staging = yield* stagingDirectory(saved);
        yield* io(() => Files.writeMoveChunk(staging, file, request.offset!, request.data!));
        return { received: request.offset + Buffer.from(request.data, "base64").length };
      }
      if (request.op === "prepare" && saved.state === "copying") yield* prepareTarget(saved);
      if (request.op === "commit") {
        if (saved.state !== "prepared" && saved.state !== "complete")
          return yield* new SessionMoveError({
            message: "The native session must be verified before commit.",
          });
        if (saved.state === "prepared") {
          yield* adoptCoordination(saved, decodeManifest(saved.manifest_json!));
          yield* sql`UPDATE custom_session_moves SET state = 'complete', locked = 0, error = NULL, updated_at = ${yield* now} WHERE id = ${saved.id}`;
        }
      }
      return result((yield* row(saved.id))!);
    },
    incomingLock.withPermit,
    Effect.mapError(failure),
  );

  const peerCall = (peer: string, body: Record<string, unknown>, timeoutSeconds = 120) =>
    requests
      .call(peer as EnvironmentId, "sessionMove", body, Duration.seconds(timeoutSeconds))
      .pipe(Effect.mapError(failure), Effect.map(recordObject));

  const finishCancellation = Effect.fn("SessionMoves.finishCancellation")(function* (
    value: MoveRow,
  ) {
    const remote = yield* peerCall(value.peer_environment_id, {
      op: "cancel",
      requestId: value.id,
      input: decodeInput(value.input_json),
    });
    if (remote.state === "complete") {
      yield* setState(value.id, "committing");
      yield* Queue.offer(work, undefined);
      return yield* new SessionMoveError({
        message: "The destination committed; resolving the durable move receipt.",
      });
    }
    yield* sql`UPDATE custom_session_moves SET state = 'cancelled', locked = 0, error = NULL, updated_at = ${yield* now} WHERE id = ${value.id} AND state = 'cancelling'`;
  });

  const transfer = Effect.fn("SessionMoves.transfer")(function* (value: MoveRow) {
    const input = decodeInput(value.input_json);
    if (value.state !== "committing") {
      if (!(yield* settled(input.threadId))) return;
      yield* closeSessions(input.threadId);
      const claimed =
        yield* sql`UPDATE custom_session_moves SET state = 'copying', error = NULL, updated_at = ${yield* now}
        WHERE id = ${value.id} AND state IN ('queued', 'copying', 'prepared') RETURNING id`;
      if (claimed.length === 0) return;
      let manifest = yield* capture(value);
      if ((yield* row(value.id))?.state !== "copying") return;
      const call = (op: string, extra: Record<string, unknown> = {}) =>
        peerCall(value.peer_environment_id, { op, requestId: input.requestId, ...extra });
      const reconcileBegin = Effect.fn("SessionMoves.reconcileBegin")(function* (
        cause: SessionMoveError,
      ) {
        // A legacy capture may name a now-occupied job root. Only the authenticated
        // destination, before it owns any receipt, can offer a replacement path.
        const probe = yield* call("probe", {
          input: manifest.input,
          driver: manifest.driver,
          modelSelection: manifest.modelSelection,
          head: manifest.workspace.head,
          manifest,
        }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
        if (
          probe.unreserved !== true ||
          typeof probe.cwd !== "string" ||
          probe.cwd === manifest.targetCwd
        )
          return yield* cause;
        const revised = { ...manifest, targetCwd: probe.cwd };
        const changed =
          yield* sql`UPDATE custom_session_moves SET manifest_json = ${encode(revised)}
          WHERE id = ${value.id} AND state = 'copying' AND manifest_json = ${encode(manifest)} RETURNING id`;
        if (changed.length === 0)
          return yield* new SessionMoveError({
            message: "The move changed during workspace reconciliation.",
          });
        manifest = revised;
        return yield* call("begin", { manifest });
      });
      const remote = yield* call("begin", { manifest }).pipe(
        Effect.catchTags({ SessionMoveError: reconcileBegin }),
      );
      if (remote.state === "cancelled") return;
      if (remote.state === "copying") {
        const staging = yield* stagingDirectory(value);
        for (const [index, file] of manifest.files.entries()) {
          for (
            let offset = 0;
            offset < file.bytes || (offset === 0 && file.bytes === 0);
            offset += Files.MOVE_CHUNK_BYTES
          ) {
            if ((yield* row(value.id))?.state !== "copying") return;
            const data = yield* io(() => Files.readMoveChunk(staging, file, offset));
            yield* call("chunk", { file: index, offset, data });
            if (file.bytes === 0) break;
          }
        }
        yield* call("prepare");
      }
      const committing =
        yield* sql`UPDATE custom_session_moves SET state = 'committing', updated_at = ${yield* now}
        WHERE id = ${value.id} AND state = 'copying' RETURNING id`;
      if (committing.length === 0) return;
    }
    const committed = yield* peerCall(value.peer_environment_id, {
      op: "commit",
      requestId: value.id,
    });
    if (committed.state !== "complete")
      return yield* new SessionMoveError({
        message: "The destination did not confirm native continuation.",
      });
    yield* releaseCoordination(value);
    const archiveId = CommandId.make(`${MOVE_COMMAND_PREFIX}${value.id}:archive`);
    const archived =
      yield* sql`SELECT 1 FROM orchestration_v2_command_receipts WHERE command_id = ${archiveId}`;
    if (archived.length === 0)
      yield* threads
        .dispatch({ type: "thread.archive", commandId: archiveId, threadId: input.threadId })
        .pipe(Effect.mapError(failure));
    yield* setState(value.id, "complete");
  });

  const drain = Effect.fn("SessionMoves.drain")(
    function* () {
      const pending =
        yield* sql<MoveRow>`SELECT * FROM custom_session_moves WHERE direction = 'out' AND state IN ('queued', 'copying', 'prepared', 'committing', 'cancelling') ORDER BY created_at`;
      for (const value of pending)
        yield* (value.state === "cancelling" ? finishCancellation(value) : transfer(value)).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* sql`UPDATE custom_session_moves SET error = ${failure(cause).message}, updated_at = ${yield* now} WHERE id = ${value.id} AND state NOT IN ('complete', 'cancelled')`;
            }),
          ),
        );
    },
    lock.withPermit,
    Effect.mapError(failure),
  );

  const request = Effect.fn("SessionMoves.request")(function* (
    input: SessionMoveInput,
    actor?: ThreadId,
  ) {
    yield* authorize(input.threadId, actor);
    const saved = yield* row(input.requestId);
    if (saved) {
      if (saved.direction !== "out" || saved.input_json !== encode(input))
        return yield* new SessionMoveError({
          message: "Use the same request ID only for the identical session move.",
        });
      yield* Queue.offer(work, undefined);
      return result(saved);
    }
    const linked = yield* links.list.pipe(Effect.mapError(failure));
    const peer = linked.find(
      (entry) =>
        entry.environmentId === input.environment ||
        entry.label.toLowerCase() === input.environment.toLowerCase(),
    );
    if (peer === undefined || peer.environmentId === localId)
      return yield* new SessionMoveError({ message: "Choose another linked computer." });
    const records = yield* threads
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(failure));
    const thread = records.thread;
    if (thread.deletedAt !== null)
      return yield* new SessionMoveError({ message: "The session no longer exists." });
    if (thread.archivedAt !== null)
      return yield* new SessionMoveError({ message: "Unarchive this session before moving it." });
    const queuedHandoff =
      yield* sql`SELECT 1 FROM custom_orchestrator_handoffs WHERE owner_id = ${input.threadId} AND state = 'queued'`.pipe(
        Effect.orElseSucceed(() => []),
      );
    if (queuedHandoff.length > 0)
      return yield* new SessionMoveError({
        message: "Finish or cancel the queued master handoff before moving this session.",
      });
    const providerThread = records.providerThreads.find(
      (entry) => entry.id === thread.activeProviderThreadId,
    );
    const driver = providerThread ? moveDriver(providerThread.driver) : undefined;
    if (driver === undefined || !safeNativeId(providerThread?.nativeThreadRef?.nativeId))
      return yield* new SessionMoveError({
        message: "This session needs supported native state before it can move.",
      });
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(failure), Effect.map(Option.getOrUndefined));
    if (project === undefined)
      return yield* new SessionMoveError({ message: "The source project is missing." });
    const workspace = yield* io(() =>
      Files.inspectMoveWorkspace(thread.worktreePath ?? project.workspaceRoot),
    );
    // Validate destination support before holding a working conversation.
    yield* requests
      .call(peer.environmentId, "sessionMove", {
        op: "probe",
        requestId: input.requestId,
        input,
        driver,
        modelSelection: {
          ...thread.modelSelection,
          instanceId: input.providerInstanceId ?? thread.modelSelection.instanceId,
        },
        head: workspace.head,
      })
      .pipe(Effect.mapError(failure));
    yield* sql`INSERT INTO custom_session_moves
      (id, thread_id, target_thread_id, direction, peer_environment_id, input_json, created_at, updated_at)
      VALUES (${input.requestId}, ${input.threadId}, ${input.threadId}, 'out', ${peer.environmentId}, ${encode(input)}, ${yield* now}, ${yield* now})`;
    yield* Queue.offer(work, undefined);
    return result((yield* row(input.requestId))!);
  }, Effect.mapError(failure));

  const status = Effect.fn("SessionMoves.status")(function* (
    input: SessionMoveStatusInput,
    actor?: ThreadId,
  ) {
    const saved = input.requestId
      ? yield* row(input.requestId)
      : (yield* sql<MoveRow>`SELECT * FROM custom_session_moves WHERE direction = 'out' AND thread_id = ${input.threadId ?? actor ?? ""} ORDER BY rowid DESC LIMIT 1`)[0];
    if (!saved || saved.direction !== "out")
      return yield* new SessionMoveError({ message: "Unknown outgoing session move." });
    yield* authorize(ThreadId.make(saved.thread_id), actor);
    if (input.cancel && saved.state !== "cancelled" && saved.state !== "complete") {
      if (saved.state === "committing")
        return yield* new SessionMoveError({
          message:
            "Resolve the commit receipt before cancelling; the destination may already be active.",
        });
      const claimed =
        yield* sql`UPDATE custom_session_moves SET state = 'cancelling', updated_at = ${yield* now}
          WHERE id = ${saved.id} AND state IN ('queued', 'copying', 'prepared', 'cancelling') RETURNING id`;
      if (claimed.length === 0)
        return yield* new SessionMoveError({
          message: "The move entered commit; resolve its receipt before cancelling.",
        });
      yield* finishCancellation(saved).pipe(
        Effect.catch((cause) =>
          sql`UPDATE custom_session_moves SET error = ${failure(cause).message} WHERE id = ${saved.id}`.pipe(
            Effect.mapError(failure),
          ),
        ),
      );
    }
    return result((yield* row(saved.id))!);
  }, Effect.mapError(failure));

  const start = Effect.fn("SessionMoves.start")(function* () {
    yield* requests.register("sessionMove", (from, body) =>
      receive(from, body).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
        ),
      ),
    );
    yield* Queue.take(work).pipe(
      Effect.andThen(drain()),
      Effect.catch((cause) => Effect.logError("Session move reconciliation failed", cause)),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Queue.offer(work, undefined).pipe(
      Effect.repeat(Schedule.spaced("15 seconds")),
      Effect.forkScoped,
    );
  });
  return SessionMoves.of({ request, status, drain, start });
});

export const layer = Layer.effect(SessionMoves, make);
