import {
  CommandId,
  EnvironmentId,
  EventId,
  ModelSelection,
  OrchestrationEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  SessionMoveError,
  SessionMoveInput,
  SessionMoveResult,
  SessionMoveStatusInput,
  ThreadId,
  RuntimeMode,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import {
  findSessionTranscripts,
  resolveDeepseekHarnessTranscriptHome,
  resolveTranscriptHome,
} from "../project/AgentTranscripts.ts";
import * as Files from "../project/SessionMoveFiles.ts";
import * as CodexState from "../project/CodexMoveState.ts";
import * as CodexHistory from "../project/CodexMoveHistory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PeerLinks } from "./PeerLinks.ts";
import * as PeerLive from "./PeerLinks.ts";
import * as Workers from "./WorkerControls.ts";
import {
  OrchestrationEngineService,
  OrchestrationThreadMaintenance,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";
import { makeCoordination } from "./SessionMoveCoordination.ts";
import * as SessionWorkspaces from "../workspace/SessionWorkspaces.ts";

const MoveFile = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["native", "attachment", "provider-asset", "workspace", "history"]),
  bytes: Schema.Number,
  sha256: Schema.String,
  executable: Schema.Boolean,
});
const MOVE_DRIVER = Schema.Literals(["codex", "claudeAgent", "deepseekHarness"]);
type MoveDriver = "codex" | "claudeAgent" | "deepseekHarness";
const moveDriver = (driver: ProviderDriverKind): MoveDriver | undefined => {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claudeAgent";
  if (driver === "deepseekHarness") return "deepseekHarness";
  return undefined;
};
const Manifest = Schema.Struct({
  input: SessionMoveInput,
  sourceEnvironmentId: Schema.String,
  targetEnvironmentId: Schema.String,
  driver: MOVE_DRIVER,
  nativeId: Schema.String,
  nativeIds: Schema.optional(Schema.Array(Schema.String)),
  resumeCursor: Schema.Unknown,
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
  coordination: Schema.Unknown,
});
type Manifest = typeof Manifest.Type;
const PeerInput = Schema.Struct({
  _tag: Schema.Literal("sessionMove"),
  op: Schema.Literals([
    "probe",
    "begin",
    "chunk",
    "prepare",
    "commit",
    "status",
    "cancel",
    "relocate",
    "coordination",
  ]),
  requestId: CommandId,
  input: Schema.optional(SessionMoveInput),
  driver: Schema.optional(MOVE_DRIVER),
  modelSelection: Schema.optional(ModelSelection),
  head: Schema.optional(Schema.String),
  manifest: Schema.optional(Manifest),
  file: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
  data: Schema.optional(Schema.String.check(Schema.isMaxLength(750_000))),
  relocation: Schema.optional(Schema.Unknown),
  coordination: Schema.optional(Schema.Unknown),
});
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
const decodePeer = Schema.decodeUnknownEffect(PeerInput);
const decodeFile = Schema.decodeUnknownEffect(MoveFile);
const isMoveError = Schema.is(SessionMoveError);
const decodeEvents = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(OrchestrationEvent)),
);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = (value: unknown) => JSON.stringify(value);
const decodeCodexState = CodexState.decodeCodexMoveState;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cursorId = (driver: MoveDriver, value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const cursor = value as { resume?: unknown; sessionId?: unknown; threadId?: unknown };
  const id =
    driver === "codex"
      ? cursor.threadId
      : driver === "deepseekHarness"
        ? cursor.sessionId
        : cursor.resume;
  return typeof id === "string" && SESSION_ID_PATTERN.test(id)
    ? id
    : null;
};
const deepseekProjectKey = (cwd: string) => {
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
};
const failure = (cause: unknown) =>
  isMoveError(cause)
    ? cause
    : new SessionMoveError({ message: cause instanceof Error ? cause.message : String(cause) });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const recordObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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
    readonly receive: (from: string, input: unknown) => Effect.Effect<unknown, SessionMoveError>;
    readonly drain: () => Effect.Effect<void, SessionMoveError>;
    readonly start: () => Effect.Effect<void, SessionMoveError, Scope.Scope>;
  }
>()("t3/orchestration/SessionMoves") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcessEnvironment;
  const isExecutable = yield* HostProcessIsExecutable;
  const settings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const maintenance = yield* OrchestrationThreadMaintenance;
  const directory = yield* ProviderSessionDirectory;
  const provider = yield* ProviderService;
  const workers = yield* Workers.WorkerControls;
  const registry = yield* ProviderRegistry;
  const liveness = yield* ThreadBackgroundLivenessService;
  const peers = yield* PeerLinks;
  const coordination = yield* makeCoordination;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const incomingLock = yield* Semaphore.make(1);
  const workspaces = yield* Effect.serviceOption(SessionWorkspaces.SessionWorkspaces);
  const work = yield* Queue.dropping<void>(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const local = yield* peers.localEnvironment;
  const row = Effect.fn(function* (id: string) {
    return (yield* sql<MoveRow>`SELECT * FROM custom_session_moves WHERE id = ${id}`)[0];
  });
  const stagingDirectory = (value: MoveRow) =>
    Effect.gen(function* () {
      const directory = Option.isSome(workspaces)
        ? yield* workspaces.value
            .transferDirectory(value.thread_id, value.id)
            .pipe(Effect.mapError(failure))
        : null;
      return directory ?? Files.moveDirectory(config.stateDir, value.id);
    });
  const shell = Effect.fn(function* (id: ThreadId) {
    const result = yield* snapshots.getThreadShellById(id);
    if (Option.isNone(result))
      return yield* new SessionMoveError({ message: "The session no longer exists." });
    return result.value;
  });
  const authorize = Effect.fn(function* (threadId: ThreadId, actor: ThreadId | undefined) {
    if (!actor || actor === threadId) return;
    if (
      !(yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = ${threadId} AND owner_id = ${actor}`)
        .length
    )
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
        value.direction === "out" ? local.environmentId : value.peer_environment_id,
      ),
      targetEnvironmentId: EnvironmentId.make(
        value.direction === "out" ? value.peer_environment_id : local.environmentId,
      ),
      projectId: input.projectId,
      state: value.state,
      error: value.error,
      updatedAt: value.updated_at,
    };
  };
  const setState = Effect.fn(function* (
    id: string,
    state: MoveRow["state"],
    error: string | null = null,
  ) {
    yield* sql`UPDATE custom_session_moves SET state = ${state}, error = ${error}, updated_at = ${yield* now} WHERE id = ${id}`;
  });
  const configuration = Effect.fn(
    function* (instanceId: ProviderInstanceId, driver: MoveDriver) {
      const current = yield* settings.getSettings;
      const instance: ProviderInstanceConfig | undefined =
        current.providerInstances[instanceId] ??
        (instanceId === driver
          ? { driver: ProviderDriverKind.make(driver), config: current.providers[driver] }
          : undefined);
      if (!instance || instance.driver !== driver)
        return yield* new SessionMoveError({
          message:
            "The destination account must use the same provider. Configure a matching account before moving.",
        });
      const home =
        driver === "deepseekHarness"
          ? yield* resolveDeepseekHarnessTranscriptHome(
              instance,
              instanceId,
              hostEnvironment,
              config.stateDir,
            )
          : yield* resolveTranscriptHome(instance, hostEnvironment);
      if (!home)
        return yield* new SessionMoveError({
          message: "The provider session directory could not be resolved.",
        });
      return home;
    },
    Effect.provideService(Path.Path, path),
    Effect.provideService(Crypto.Crypto, crypto),
  );
  const profile = Effect.fn(function* (driver: MoveDriver, selection: typeof ModelSelection.Type) {
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
  const targetProbe = Effect.fn(function* (
    from: string,
    input: SessionMoveInput,
    driver: MoveDriver,
    selection: typeof ModelSelection.Type,
    head: string,
  ) {
    const project = yield* snapshots.getProjectShellById(input.projectId);
    if (Option.isNone(project))
      return yield* new SessionMoveError({
        message: "Choose a project on the destination computer.",
      });
    yield* profile(driver, selection);
    yield* configuration(selection.instanceId, driver);
    const existing =
      yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${input.threadId}`;
    const parked = yield* sql`SELECT 1 FROM custom_session_moves WHERE thread_id = ${input.threadId}
      AND locked = 1 AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))`;
    if (existing.length && !parked.length)
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
      Files.git(project.value.workspaceRoot, ["cat-file", "-e", head + "^{commit}"])
        .then(() => true)
        .catch(() => false),
    );
    return { cwd, hasCommit, replaceExisting: existing.length > 0, source: from };
  });
  const capture = Effect.fn(function* (value: MoveRow) {
    if (value.manifest_json) return decodeManifest(value.manifest_json);
    const input = decodeInput(value.input_json);
    const detail = yield* snapshots.getThreadDetailById(input.threadId);
    if (Option.isNone(detail))
      return yield* new SessionMoveError({ message: "The source session disappeared." });
    const thread = detail.value;
    const binding = yield* directory.getBinding(input.threadId);
    const driver = Option.isSome(binding)
      ? moveDriver(binding.value.provider)
      : undefined;
    if (
      Option.isNone(binding) ||
      driver === undefined
    )
      return yield* new SessionMoveError({
        message: "This provider does not support native session moves.",
      });
    const nativeId = cursorId(driver, binding.value.resumeCursor);
    if (!nativeId)
      return yield* new SessionMoveError({
        message: "The source has no persisted native resume identifier.",
      });
    const sourceProject = yield* snapshots.getProjectShellById(thread.projectId);
    if (Option.isNone(sourceProject))
      return yield* new SessionMoveError({ message: "The source project is missing." });
    const sourceCwd = thread.worktreePath ?? sourceProject.value.workspaceRoot;
    const workspace = yield* io(() => Files.inspectMoveWorkspace(sourceCwd));
    const selection = {
      ...thread.modelSelection,
      instanceId: input.providerInstanceId ?? thread.modelSelection.instanceId,
    };
    const probe = recordObject(
      yield* peers.call(value.peer_environment_id, {
        _tag: "sessionMove",
        op: "probe",
        requestId: input.requestId,
        input,
        driver,
        modelSelection: selection,
        head: workspace.head,
      }),
    );
    if (typeof probe.cwd !== "string" || typeof probe.hasCommit !== "boolean")
      return yield* new SessionMoveError({
        message: "The destination needs nativeSessionMoves support.",
      });
    const home = yield* configuration(
      binding.value.providerInstanceId ?? thread.modelSelection.instanceId,
      driver,
    );
    const staging = yield* stagingDirectory(value);
    yield* fs.makeDirectory(staging, { recursive: true });
    const nativeState =
      driver === "codex"
        ? yield* io(() => CodexState.captureCodexMoveState(home.homePath, nativeId))
        : null;
    const cursor = recordObject(binding.value.resumeCursor);
    const ancestry =
      driver === "deepseekHarness" && Array.isArray(cursor.ancestry)
        ? cursor.ancestry.filter(
            (entry): entry is string =>
              typeof entry === "string" && SESSION_ID_PATTERN.test(entry),
          )
        : [];
    const family =
      nativeState?.nativeIds ??
      (driver === "deepseekHarness" ? [...new Set([nativeId, ...ancestry])] : [nativeId]);
    if (driver === "deepseekHarness") {
      for (const id of family) {
        const found = yield* findSessionTranscripts(home, id).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
        if (found.length === 0)
          return yield* new SessionMoveError({
            message: `The DeepSeek Harness fork ancestry is incomplete (${id}).`,
          });
      }
    }
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
      yield* fs.writeFileString(filename, encode(nativeState));
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
      const info = yield* fs.stat(entry.path);
      const sourceFiles =
        info.type === "Directory" ? yield* io(() => Files.listMoveFiles(entry.path)) : [entry.path];
      for (const source of sourceFiles) {
        const name =
          driver === "codex"
            ? path.relative(home.homePath, source).replaceAll("\\", "/")
            : driver === "deepseekHarness"
              ? (() => {
                  const relative = path.relative(home.homePath, source).split(path.sep);
                  const sessionId = relative[2];
                  const artifacts = relative.slice(3).join("/");
                  if (!sessionId || !artifacts) {
                    throw new Error("The DeepSeek Harness session artifact has no owner.");
                  }
                  return `sessions/${deepseekProjectKey(probe.cwd)}/${sessionId}/${artifacts}`;
                })()
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
    if (driver === "deepseekHarness") {
      const providerAttachments = path.join(home.homePath, "attachments", "v1");
      const hasProviderAttachments = yield* fs.stat(providerAttachments).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      const attachmentFiles = hasProviderAttachments
        ? yield* io(() => Files.listMoveFiles(providerAttachments))
        : [];
      for (const source of attachmentFiles) {
        const relative = path.relative(providerAttachments, source).replaceAll("\\", "/");
        files.push(
          yield* io(() =>
            Files.copyMoveFile({
              source,
              sourceRoot: home.homePath,
              staging,
              kind: "provider-asset",
              name: `attachments/v1/${relative}`,
            }),
          ),
        );
      }
    }
    for (const message of thread.messages)
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
    const head = yield* engine.latestSequence;
    const stats = yield* engine.getThreadReplayStats({
      threadId: input.threadId,
      fromSequenceExclusive: 0,
      toSequenceInclusive: head,
      maxEvents: 250_001,
    });
    if (stats.eventCount > 250_000 || stats.payloadBytes > 64 * 1024 * 1024)
      return yield* new SessionMoveError({
        message: "The T3 history exceeds the move budget; no history has been truncated.",
      });
    const original = yield* Stream.runCollect(
      engine.readThreadEvents({
        threadId: input.threadId,
        fromSequenceExclusive: 0,
        toSequenceInclusive: head,
        limit: 250_000,
      }),
    );
    const events: OrchestrationEvent[] = [];
    for (const event of original) {
      const payload = { ...event.payload } as Record<string, unknown>;
      if ("projectId" in payload) payload.projectId = input.projectId;
      if ("worktreePath" in payload) payload.worktreePath = probe.cwd;
      if ("branch" in payload) payload.branch = Files.moveBranch(value.id);
      if ("modelSelection" in payload)
        payload.modelSelection = {
          ...recordObject(payload.modelSelection),
          instanceId: selection.instanceId,
        };
      if ("session" in payload && payload.session)
        payload.session = {
          ...recordObject(payload.session),
          providerInstanceId: selection.instanceId,
          status: "stopped",
          activeTurnId: null,
        };
      if (event.type === "thread.created") payload.historyImport = true;
      events.push({
        ...event,
        eventId: EventId.make(yield* crypto.randomUUIDv4),
        commandId: event.commandId,
        metadata: {
          ...event.metadata,
          sessionMoveImport: true,
          sessionMoveId: value.id,
          moveSourceSequence: event.sequence,
        },
        payload,
      } as OrchestrationEvent);
    }
    const historyFile = path.join(staging, "events.json");
    yield* fs.writeFileString(historyFile, encode(events));
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
    const manifest: Manifest = {
      input,
      sourceEnvironmentId: local.environmentId,
      targetEnvironmentId: value.peer_environment_id,
      driver,
      nativeId,
      ...(nativeState
        ? { nativeIds: nativeState.nativeIds }
        : driver === "deepseekHarness"
          ? { nativeIds: family }
          : {}),
      resumeCursor: binding.value.resumeCursor,
      modelSelection: selection,
      title: thread.title,
      runtimeMode: thread.runtimeMode,
      sourceCwd,
      targetCwd: probe.cwd,
      workspace,
      files,
      coordination: null,
    };
    yield* sql`UPDATE custom_session_moves SET manifest_json = ${encode(manifest)} WHERE id = ${value.id}`;
    return manifest;
  });
  const prepareTarget = Effect.fn(function* (value: MoveRow) {
    const manifest = decodeManifest(value.manifest_json!);
    const staging = yield* stagingDirectory(value);
    yield* io(() => Files.verifyMoveFiles(staging, manifest.files));
    const project = yield* snapshots.getProjectShellById(manifest.input.projectId);
    if (Option.isNone(project))
      return yield* new SessionMoveError({ message: "The destination project disappeared." });
    if (Option.isSome(workspaces)) {
      const previous = yield* workspaces.value
        .get(manifest.input.threadId)
        .pipe(Effect.mapError(failure));
      if (
        previous &&
        previous.reservationId !== `move:${value.id}` &&
        previous.workspaceDirectory === manifest.targetCwd
      ) {
        // The move lock was acquired only after targetProbe established that this
        // host's copy was parked. Keep its entire worktree before installing the
        // returning source, including ignored files and uncommitted work.
        const parked =
          yield* sql`SELECT 1 FROM custom_session_moves WHERE thread_id = ${manifest.input.threadId}
          AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))
          AND EXISTS (SELECT 1 FROM custom_session_moves WHERE id = ${value.id} AND direction = 'in' AND locked = 1)`;
        if (!parked.length)
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
        projectRoot: project.value.workspaceRoot,
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
          sourceDirectory: project.value.workspaceRoot,
          cwd: manifest.targetCwd,
          revision: manifest.workspace.head,
          branch: Files.moveBranch(value.id),
        })
        .pipe(Effect.mapError(failure));
    const home = yield* configuration(manifest.modelSelection.instanceId, manifest.driver);
    const imported =
      yield* sql`SELECT 1 FROM orchestration_events WHERE stream_id = ${manifest.input.threadId}
      AND json_extract(metadata_json, '$.sessionMoveId') = ${value.id} LIMIT 1`;
    if (imported.length && Option.isSome(yield* directory.getBinding(manifest.input.threadId)))
      yield* provider.stopSession({ threadId: manifest.input.threadId });
    const parked =
      yield* sql`SELECT 1 FROM custom_session_moves WHERE thread_id = ${manifest.input.threadId}
      AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled' AND EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${manifest.input.threadId})))`;
    const nativeState =
      manifest.driver === "codex"
        ? (decodeCodexState(
            yield* fs.readFileString(path.join(staging, "history", "codex-state.json")),
          ) as CodexState.CodexMoveState)
        : null;
    const rolloutName =
      (nativeState && CodexState.codexRolloutName(nativeState, manifest.nativeId)) ||
      manifest.files.find(
        (entry) =>
          entry.kind === "native" && entry.name.endsWith("-" + manifest.nativeId + ".jsonl"),
      )?.name;
    const nativeRoot =
      manifest.driver === "codex"
        ? home.homePath
        : manifest.driver === "deepseekHarness"
          ? home.homePath
        : path.join(home.homePath, "projects", manifest.targetCwd.replace(/[^a-zA-Z0-9]/g, "-"));
    yield* fs.makeDirectory(nativeRoot, { recursive: true });
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
          parked.length > 0 || imported.length > 0,
        ),
      );
    } else
      for (const file of manifest.files.filter((entry) => entry.kind === "native"))
        yield* io(() =>
          Files.installMoveFile(
            staging,
            file,
            nativeRoot,
            file.name,
            parked.length > 0 || imported.length > 0,
          ),
        );
    if (manifest.driver === "claudeAgent") {
      const workerArgs = isExecutable
        ? ["__claude-history"]
        : [
            yield* path.fromFileUrl(
              new URL(
                import.meta.url.endsWith(".ts")
                  ? "../claude-history-worker.ts"
                  : "./claude-history-worker.mjs",
                import.meta.url,
              ),
            ),
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
    const existing =
      yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${manifest.input.threadId}`;
    if (!imported.length) {
      const events = yield* decodeEvents(
        yield* fs.readFileString(path.join(staging, "history", "events.json")),
      );
      yield* maintenance.importEvents({
        threadId: manifest.input.threadId,
        events,
        replaceExisting: existing.length > 0,
      });
    }
    // Install attachments after historical deletions have been projected.
    for (const file of manifest.files.filter((entry) => entry.kind === "attachment"))
      yield* io(() => Files.installMoveFile(staging, file, config.attachmentsDir));
    for (const file of manifest.files.filter((entry) => entry.kind === "provider-asset"))
      yield* io(() => Files.installMoveFile(staging, file, home.homePath, file.name));
    const resumeCursor = {
      ...recordObject(manifest.resumeCursor),
      ...(manifest.driver === "codex"
        ? {
            requireNativeResume: true,
            ...(rolloutName ? { rolloutPath: Files.contained(nativeRoot, rolloutName) } : {}),
          }
        : manifest.driver === "claudeAgent"
          ? { threadId: manifest.input.threadId }
          : {}),
    };
    yield* directory.upsert({
      threadId: manifest.input.threadId,
      provider: ProviderDriverKind.make(manifest.driver),
      providerInstanceId: manifest.modelSelection.instanceId,
      status: "stopped",
      runtimeMode: manifest.runtimeMode,
      resumeCursor,
      runtimePayload: {
        cwd: manifest.targetCwd,
        modelSelection: manifest.modelSelection,
        nativeSessionMove: value.id,
      },
    });
    const startSession = () =>
      provider.startSession(manifest.input.threadId, {
        threadId: manifest.input.threadId,
        provider: ProviderDriverKind.make(manifest.driver),
        providerInstanceId: manifest.modelSelection.instanceId,
        modelSelection: manifest.modelSelection,
        runtimeMode: manifest.runtimeMode,
        cwd: manifest.targetCwd,
        resumeCursor,
      });
    let session = yield* startSession();
    if (nativeState?.databases.length) {
      // Initialize native schema first; merge only this family with its process closed.
      yield* provider.stopSession({ threadId: manifest.input.threadId });
      yield* io(() =>
        CodexState.installCodexMoveState(home.homePath, manifest.targetCwd, nativeState),
      );
      session = yield* startSession();
    }
    if (cursorId(manifest.driver, session.resumeCursor) !== manifest.nativeId) {
      yield* provider.stopSession({ threadId: manifest.input.threadId });
      return yield* new SessionMoveError({
        message:
          "Native resume returned a different session. The move remains paused; no fresh conversation is accepted.",
      });
    }
    yield* setState(value.id, "prepared");
  });
  const receive = Effect.fn("SessionMoves.receive")(
    function* (from: string, raw: unknown) {
      if (Option.isNone(yield* peers.resolve(from)))
        return yield* new SessionMoveError({ message: "The caller is not a linked environment." });
      const request = yield* decodePeer(raw).pipe(Effect.mapError(failure));
      if (request.op === "relocate") return yield* coordination.relocate(from, request.relocation);
      if (request.op === "probe") {
        if (!request.input || !request.driver || !request.modelSelection || !request.head)
          return yield* new SessionMoveError({ message: "Incomplete session-move probe." });
        if (request.manifest) {
          const manifest = request.manifest;
          if (
            manifest.sourceEnvironmentId !== from ||
            manifest.targetEnvironmentId !== local.environmentId ||
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
          manifest.targetEnvironmentId !== local.environmentId ||
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
              : manifest.driver === "deepseekHarness"
                ? (() => {
                    const parts = file.name.split("/");
                    return (
                      parts.length >= 4 &&
                      parts[0] === "sessions" &&
                      parts[1]!.length > 0 &&
                      SESSION_ID_PATTERN.test(parts[2] ?? "") &&
                      parts.slice(3).join("/").length > 0
                    );
                  })()
              : file.name === manifest.nativeId + ".jsonl" ||
                file.name.startsWith(manifest.nativeId + "/");
          if (!valid)
            return yield* new SessionMoveError({
              message: "A transfer entry is not native conversation state.",
            });
        }
        if (!nativeFiles.length)
          return yield* new SessionMoveError({ message: "The native transcript is missing." });
        for (const file of manifest.files.filter((entry) => entry.kind === "provider-asset")) {
          if (
            manifest.driver !== "deepseekHarness" ||
            !file.name.startsWith("attachments/v1/")
          )
            return yield* new SessionMoveError({
              message: "A transfer entry is not a DeepSeek Harness provider asset.",
            });
        }
        const bindings = yield* directory.listBindings();
        const nativeIds = new Set(
          manifest.nativeIds ?? [
            manifest.nativeId,
            ...nativeFiles.flatMap((file) => {
              if (manifest.driver === "deepseekHarness") {
                const id = file.name.split("/")[2];
                return id ? [id] : [];
              }
              const id = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(
                file.name,
              )?.[1];
              return id ? [id] : [];
            }),
          ],
        );
        if (
          bindings.some(
            (entry) =>
              entry.threadId !== manifest.input.threadId &&
              entry.providerInstanceId === manifest.modelSelection.instanceId &&
              nativeIds.has(cursorId(manifest.driver, entry.resumeCursor) ?? ""),
          )
        )
          return yield* new SessionMoveError({
            message: "Another destination conversation already owns this native session.",
          });
        yield* maintenance
          .run(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE custom_session_moves SET locked = 0 WHERE thread_id = ${manifest.input.threadId}
          AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled'))`;
                yield* sql`INSERT INTO custom_session_moves
          (id, thread_id, target_thread_id, direction, peer_environment_id, state, input_json, manifest_json, created_at, updated_at)
          VALUES (${request.requestId}, ${manifest.input.threadId}, ${manifest.input.threadId}, 'in', ${from}, 'copying', ${encode(manifest.input)}, ${encode(manifest)}, ${yield* now}, ${yield* now})`;
                // The incoming lock and its workspace reservation commit together.
                // A concurrent create must lose before either side checks out files.
                if (Option.isSome(workspaces)) {
                  const project = yield* snapshots.getProjectShellById(manifest.input.projectId);
                  if (Option.isNone(project))
                    return yield* new SessionMoveError({
                      message: "The destination project disappeared.",
                    });
                  yield* workspaces.value
                    .reserveMove({
                      threadId: manifest.input.threadId,
                      requestId: request.requestId,
                      sourceDirectory: project.value.workspaceRoot,
                      cwd: manifest.targetCwd,
                      revision: manifest.workspace.head,
                      branch: Files.moveBranch(request.requestId),
                    })
                    .pipe(Effect.mapError(failure));
                }
              }),
            ),
          )
          .pipe(coordination.withLock);
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
      if (request.op === "coordination") {
        if (saved.state !== "prepared" && saved.state !== "complete")
          return yield* new SessionMoveError({
            message: "Verify the native copy before moving worker coordination.",
          });
        if (saved.state === "complete") return { restored: true };
        const file = yield* decodeFile(request.coordination).pipe(Effect.mapError(failure));
        if (
          file.kind !== "history" ||
          file.name !== "coordination-live.json" ||
          file.bytes > 64 * 1024 * 1024
        )
          return yield* new SessionMoveError({ message: "Invalid coordination transfer." });
        yield* io(async () => Files.validateMoveFiles([file]));
        const staging = yield* stagingDirectory(saved);
        if (request.offset !== undefined && request.data !== undefined) {
          yield* io(() => Files.writeMoveChunk(staging, file, request.offset!, request.data!));
          return { received: request.offset + Buffer.from(request.data, "base64").length };
        }
        yield* io(() => Files.verifyMoveFiles(staging, [file]));
        yield* coordination.importState(
          from,
          ThreadId.make(saved.thread_id),
          decodeUnknownJson(yield* fs.readFileString(path.join(staging, "history", file.name))),
          decodeManifest(saved.manifest_json!).modelSelection,
        );
        return { restored: true };
      }
      if (request.op === "cancel") {
        if (saved.state === "complete") return result(saved);
        if (Option.isSome(yield* directory.getBinding(ThreadId.make(saved.thread_id))))
          yield* provider.stopSession({ threadId: ThreadId.make(saved.thread_id) });
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
        yield* sql`UPDATE custom_session_moves SET state = 'complete', locked = 0, error = NULL, updated_at = ${yield* now} WHERE id = ${saved.id}`;
        yield* workers
          .drain()
          .pipe(Effect.catch((cause) => Effect.logWarning("Moved work remains queued", cause)));
      }
      return result((yield* row(saved.id))!);
    },
    incomingLock.withPermit,
    Effect.mapError(failure),
  );
  const finishCancellation = Effect.fn(function* (value: MoveRow) {
    const input = decodeInput(value.input_json);
    const remote = recordObject(
      yield* peers.call(value.peer_environment_id, {
        _tag: "sessionMove",
        op: "cancel",
        requestId: value.id,
        input,
      }),
    );
    if (remote.state === "complete") {
      yield* setState(value.id, "committing");
      yield* Queue.offer(work, undefined);
      return yield* new SessionMoveError({
        message: "The destination committed; resolving the durable move receipt.",
      });
    }
    yield* sql`UPDATE custom_session_moves SET state = 'cancelled', locked = 0, error = NULL, updated_at = ${yield* now} WHERE id = ${value.id} AND state = 'cancelling'`;
    yield* workers
      .drain()
      .pipe(
        Effect.catch((cause) => Effect.logWarning("Cancelled move work remains queued", cause)),
      );
  });
  const transfer = Effect.fn(function* (value: MoveRow) {
    const input = decodeInput(value.input_json);
    if (value.state !== "committing") {
      const thread = yield* shell(input.threadId);
      if (
        thread.session?.activeTurnId ||
        thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        thread.latestTurn?.state === "running" ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        liveness.getThreadBackgroundLiveness(input.threadId) !== null
      )
        return;
      if (
        (yield* sql`SELECT 1 FROM projection_turns WHERE thread_id = ${input.threadId} AND state = 'pending' LIMIT 1`)
          .length
      )
        return;
      yield* provider.stopSession({ threadId: input.threadId });
      const claimed =
        yield* sql`UPDATE custom_session_moves SET state = 'copying', error = NULL, updated_at = ${yield* now}
        WHERE id = ${value.id} AND state IN ('queued', 'copying', 'prepared') RETURNING id`;
      if (!claimed.length) return;
      let manifest = yield* capture(value);
      if ((yield* row(value.id))?.state !== "copying") return;
      const call = (op: string, extra: Record<string, unknown> = {}) =>
        peers.call(
          value.peer_environment_id,
          { _tag: "sessionMove", op, requestId: input.requestId, ...extra },
          120_000,
        );
      const remote = recordObject(
        yield* call("begin", { manifest }).pipe(
          Effect.catchTag("PeerRejected", (cause) =>
            Effect.gen(function* () {
              // A legacy capture may name a now-occupied job root. Only the authenticated
              // destination, before it owns any receipt, can offer a replacement path.
              const probe = recordObject(
                yield* call("probe", {
                  input: manifest.input,
                  driver: manifest.driver,
                  modelSelection: manifest.modelSelection,
                  head: manifest.workspace.head,
                  manifest,
                }),
              );
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
              if (!changed.length)
                return yield* new SessionMoveError({
                  message: "The move changed during workspace reconciliation.",
                });
              manifest = revised;
              return yield* call("begin", { manifest });
            }),
          ),
        ),
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
      if (!committing.length) return;
    }
    const current = (yield* row(value.id))!;
    yield* coordination.finish(
      input.threadId,
      value.peer_environment_id,
      value.id,
      decodeManifest(current.manifest_json!).modelSelection,
    );
    const committed = recordObject(
      yield* peers.call(
        value.peer_environment_id,
        { _tag: "sessionMove", op: "commit", requestId: value.id },
        120_000,
      ),
    );
    if (committed.state !== "complete")
      return yield* new SessionMoveError({
        message: "The destination did not confirm native continuation.",
      });
    const archivedAt = yield* now;
    const archived =
      yield* sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${"server:move:" + value.id + ":archive"}`;
    if (!archived.length)
      yield* maintenance.importEvents({
        threadId: input.threadId,
        allowExisting: true,
        events: [
          {
            sequence: 0,
            eventId: EventId.make(yield* crypto.randomUUIDv4),
            aggregateKind: "thread",
            aggregateId: input.threadId,
            type: "thread.archived",
            occurredAt: archivedAt,
            commandId: CommandId.make("server:move:" + value.id + ":archive"),
            causationEventId: null,
            correlationId: null,
            metadata: { sessionMoveImport: true },
            payload: { threadId: input.threadId, archivedAt, updatedAt: archivedAt },
          },
        ],
      });
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
    const peer = yield* peers.resolve(input.environment);
    if (Option.isNone(peer) || peer.value.environmentId === local.environmentId)
      return yield* new SessionMoveError({ message: "Choose another linked computer." });
    const value = yield* shell(input.threadId);
    if (value.archivedAt !== null)
      return yield* new SessionMoveError({ message: "Unarchive this session before moving it." });
    if (
      (yield* sql`SELECT 1 FROM custom_orchestrator_handoffs WHERE owner_id = ${input.threadId} AND state = 'queued'`)
        .length
    )
      return yield* new SessionMoveError({
        message: "Finish or cancel the queued master handoff before moving this session.",
      });
    const binding = yield* directory.getBinding(input.threadId);
    const driver = Option.isSome(binding)
      ? moveDriver(binding.value.provider)
      : undefined;
    if (
      Option.isNone(binding) ||
      driver === undefined
    )
      return yield* new SessionMoveError({
        message: "This session needs supported native state before it can move.",
      });
    if (!cursorId(driver, binding.value.resumeCursor))
      return yield* new SessionMoveError({
        message: "This session needs supported native state before it can move.",
      });
    const project = yield* snapshots.getProjectShellById(value.projectId);
    if (Option.isNone(project))
      return yield* new SessionMoveError({ message: "The source project is missing." });
    const workspace = yield* io(() =>
      Files.inspectMoveWorkspace(value.worktreePath ?? project.value.workspaceRoot),
    );
    // Validate destination support before holding a working conversation.
    yield* peers.call(peer.value.environmentId, {
      _tag: "sessionMove",
      op: "probe",
      requestId: input.requestId,
      input,
      driver,
      modelSelection: {
        ...value.modelSelection,
        instanceId: input.providerInstanceId ?? value.modelSelection.instanceId,
      },
      head: workspace.head,
    });
    yield* maintenance
      .run(sql`INSERT INTO custom_session_moves
      (id, thread_id, target_thread_id, direction, peer_environment_id, input_json, created_at, updated_at)
      VALUES (${input.requestId}, ${input.threadId}, ${input.threadId}, 'out', ${peer.value.environmentId}, ${encode(input)}, ${yield* now}, ${yield* now})`)
      .pipe(coordination.withLock);
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
      if (!claimed.length)
        return yield* new SessionMoveError({
          message: "The move entered commit; resolve its receipt before cancelling.",
        });
      yield* finishCancellation(saved).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* sql`UPDATE custom_session_moves SET error = ${failure(cause).message} WHERE id = ${saved.id}`;
          }),
        ),
      );
    }
    return result((yield* row(saved.id))!);
  }, Effect.mapError(failure));
  const start = Effect.fn("SessionMoves.start")(function* () {
    const changes = yield* engine.subscribeDomainEvents;
    yield* changes.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.session-set" || event.type === "thread.turn-diff-completed",
      ),
      Stream.runForEach(() => Queue.offer(work, undefined)),
      Effect.forkScoped,
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
  return SessionMoves.of({ request, status, receive, drain, start });
});
export const layer = Layer.effect(SessionMoves, make);
export const liveLayer = layer.pipe(
  Layer.provide(Workers.liveLayer),
  Layer.provide(PeerLive.layer),
);
