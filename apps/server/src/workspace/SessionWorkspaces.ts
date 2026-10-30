// @effect-diagnostics nodeBuiltinImport:off effectFnOpportunity:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ProjectId, ServerSettings, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { prepareSourceSnapshot, verifySourceSnapshot } from "./SourceSnapshot.ts";

const LifecycleCommand = Schema.NullOr(
  Schema.Struct({
    executable: Schema.String,
    args: Schema.Array(Schema.String),
  }),
);
export const SessionWorkspace = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  threadId: Schema.String,
  reservationId: Schema.String,
  root: Schema.String,
  sourceDirectory: Schema.String,
  workspaceDirectory: Schema.String,
  tmpDirectory: Schema.String,
  buildDirectory: Schema.String,
  cacheDirectory: Schema.String,
  downloadsDirectory: Schema.String,
  outputsDirectory: Schema.String,
  evidenceDirectory: Schema.String,
  revision: Schema.String,
  branch: Schema.NullOr(Schema.String),
  sourceKind: Schema.optional(Schema.Literals(["directory", "unborn"])),
  lifecycleCommand: LifecycleCommand,
});
export type SessionWorkspace = typeof SessionWorkspace.Type;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionWorkspace));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Registration = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  registered: Schema.Literal(true),
});
const decodeRegistration = Schema.decodeEffect(Schema.fromJsonString(Registration));

export class SessionWorkspaceError extends Schema.TaggedError<SessionWorkspaceError>()(
  "SessionWorkspaceError",
  {
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Session workspace ${this.threadId}: ${this.detail}`;
  }
}
type NewWorkspace = {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly sourceDirectory: string;
  readonly ref?: string;
  readonly branch?: string;
  readonly fork?: boolean;
};
type MoveWorkspace = {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly sourceDirectory: string;
  readonly cwd: string;
  readonly revision: string;
  readonly branch: string;
};

export class SessionWorkspaces extends Context.Service<
  SessionWorkspaces,
  {
    readonly prepare: (
      input: NewWorkspace,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    /** Reuse the exact registered job; no checkout, copying or lifecycle identity change. */
    readonly inherit: (
      previous: string,
      successor: string,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    readonly get: (
      threadId: string,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    /**
     * Every active session workspace of this environment, for read-only inventories. Rows that
     * cannot be decoded are skipped; the list is bounded.
     */
    readonly list: () => Effect.Effect<ReadonlyArray<SessionWorkspace>, SessionWorkspaceError>;
    readonly verify: (
      threadId: string,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    readonly movePath: (
      threadId: string,
      requestId: string,
    ) => Effect.Effect<string | null, SessionWorkspaceError>;
    readonly registerMove: (
      input: MoveWorkspace,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    readonly reserveMove: (
      input: MoveWorkspace,
    ) => Effect.Effect<SessionWorkspace | null, SessionWorkspaceError>;
    readonly transferDirectory: (
      threadId: string,
      requestId: string,
    ) => Effect.Effect<string | null, SessionWorkspaceError>;
    readonly needsSetup: (threadId: string) => Effect.Effect<boolean, SessionWorkspaceError>;
    readonly completeSetup: (threadId: string) => Effect.Effect<void, SessionWorkspaceError>;
  }
>()("t3/workspace/SessionWorkspaces") {}

// Identity is logical, independent of native provider IDs and destination hosts.
const jobIdFor = (threadId: string) =>
  /^[0-9a-f-]{36}$/i.test(threadId)
    ? threadId.toLowerCase()
    : NodeCrypto.createHash("sha256").update(threadId).digest("hex");
const isWorkspaceError = Schema.is(SessionWorkspaceError);
const failure = (threadId: string) => (cause: unknown) =>
  isWorkspaceError(cause)
    ? cause
    : new SessionWorkspaceError({
        threadId,
        detail: cause instanceof Error ? cause.message : "Workspace operation failed",
        cause,
      });

// Workenv owns these values; T3 accepts only paths inside the job root.
const WORKENV_REDIRECTS = new Set([
  "GOMODCACHE",
  "GOCACHE",
  "GRADLE_USER_HOME",
  "MAVEN_OPTS",
  "NUGET_PACKAGES",
  "NUGET_HTTP_CACHE_PATH",
  "CONDA_PKGS_DIRS",
  "CONDA_ENVS_PATH",
  "UV_CACHE_DIR",
  "YARN_CACHE_FOLDER",
  "ELECTRON_CACHE",
  "ELECTRON_BUILDER_CACHE",
  "npm_config_prefix",
  "CARGO_INSTALL_ROOT",
  "CARGO_HOME",
  "PIPX_HOME",
  "PIPX_BIN_DIR",
  "PIPX_MAN_DIR",
]);

function workenvRedirects(root: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, ".workenv-environment.json"), "utf8"),
    );
  } catch {
    return {};
  }
  const values =
    parsed &&
    typeof parsed === "object" &&
    "version" in parsed &&
    parsed.version === 1 &&
    "environment" in parsed
      ? parsed.environment
      : null;
  if (!values || typeof values !== "object") return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!WORKENV_REDIRECTS.has(name) || typeof value !== "string") continue;
    const target = name === "MAVEN_OPTS" ? value.replace(/^-Dmaven\.repo\.local=/, "") : value;
    if (name === "MAVEN_OPTS" && target === value) continue;
    const relative = NodePath.relative(root, target);
    if (
      !NodePath.isAbsolute(target) ||
      !relative ||
      relative.startsWith("..") ||
      NodePath.isAbsolute(relative)
    )
      continue;
    result[name] = value;
  }
  return result;
}

/** Launch defaults only: tools can still choose paths and explicit provider values win. */
export function workspaceEnvironment(job: SessionWorkspace): Record<string, string> {
  return {
    ...workenvRedirects(job.root),
    T3_WORKSPACE_JOB_ID: job.jobId,
    T3_WORKSPACE_JOB_ROOT: job.root,
    T3_WORKSPACE_BUILD_DIR: job.buildDirectory,
    T3_WORKSPACE_CACHE_DIR: job.cacheDirectory,
    T3_WORKSPACE_DOWNLOADS_DIR: job.downloadsDirectory,
    T3_WORKSPACE_OUTPUTS_DIR: job.outputsDirectory,
    T3_WORKSPACE_EVIDENCE_DIR: job.evidenceDirectory,
    TMPDIR: job.tmpDirectory,
    TMP: job.tmpDirectory,
    TEMP: job.tmpDirectory,
    XDG_CACHE_HOME: job.cacheDirectory,
    npm_config_cache: job.cacheDirectory + "/npm",
    PIP_CACHE_DIR: job.cacheDirectory + "/pip",
    CCACHE_DIR: job.cacheDirectory + "/ccache",
    CARGO_TARGET_DIR: job.buildDirectory + "/cargo",
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const runner = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);
  const read = Effect.fn(function* (threadId: string) {
    const rows = yield* sql<{
      binding_json: string;
      state: string;
      setup_complete: number;
    }>`SELECT binding_json, state, setup_complete
      FROM session_workspaces WHERE thread_id = ${threadId} AND active = 1`;
    return rows[0] ? { ...rows[0], job: yield* decode(rows[0].binding_json) } : null;
  });
  const get = (threadId: string) =>
    read(threadId).pipe(
      Effect.map((row) => row?.job ?? null),
      Effect.mapError(failure(threadId)),
    );
  const configuredRoot = Effect.fn(function* () {
    const config = yield* settings.getSettings;
    if (!config.agentWorkRoot.trim()) return null;
    if (!path.isAbsolute(config.agentWorkRoot.trim()))
      return yield* new SessionWorkspaceError({
        threadId: "configuration",
        detail: "Agent work root must be an absolute path on this environment.",
      });
    return { config, root: path.normalize(config.agentWorkRoot.trim()) };
  });
  const primaryDirectory = Effect.fn(function* (threadId: string, cwd: string, root: string) {
    if (!path.isAbsolute(cwd))
      return yield* new SessionWorkspaceError({
        threadId,
        detail: "Source workspace must be absolute.",
      });
    const repository = yield* git.execute({
      operation: "SessionWorkspaces.primary",
      cwd,
      args: ["rev-parse", "--git-common-dir"],
    });
    const common = path.resolve(cwd, repository.stdout.trim());
    const primary = path.dirname(common);
    const relative = path.relative(root, primary);
    if (
      path.basename(common) !== ".git" ||
      relative === "" ||
      (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    )
      return yield* new SessionWorkspaceError({
        threadId,
        detail:
          "Session workspaces require a persistent plain Git primary outside the agent work root.",
      });
    return primary;
  });
  const binding = (
    input: {
      threadId: string;
      reservationId: string;
      root: string;
      sourceDirectory: string;
      revision: string;
      branch: string | null;
      sourceKind?: "directory" | "unborn";
    },
    config: ServerSettings,
  ): SessionWorkspace => ({
    version: 1,
    jobId: path.basename(input.root),
    ...input,
    workspaceDirectory: path.join(input.root, "repo"),
    tmpDirectory: path.join(input.root, "tmp"),
    buildDirectory: path.join(input.root, "build"),
    cacheDirectory: path.join(input.root, "cache"),
    downloadsDirectory: path.join(input.root, "downloads"),
    outputsDirectory: path.join(input.root, "outputs"),
    evidenceDirectory: path.join(input.root, "evidence"),
    lifecycleCommand: config.workspaceLifecycleCommand,
  });
  const scaffold = (job: SessionWorkspace) =>
    Effect.forEach(
      [
        job.tmpDirectory,
        job.buildDirectory,
        job.cacheDirectory,
        job.downloadsDirectory,
        job.outputsDirectory,
        job.evidenceDirectory,
      ],
      (dir) => fs.makeDirectory(dir, { recursive: true }),
      { discard: true },
    );
  const register = Effect.fn(function* (job: SessionWorkspace) {
    if (!job.lifecycleCommand) return;
    if (
      !path.isAbsolute(job.lifecycleCommand.executable) ||
      /\.(cmd|bat)$/i.test(job.lifecycleCommand.executable)
    )
      return yield* new SessionWorkspaceError({
        threadId: job.threadId,
        detail:
          "Lifecycle registration requires an absolute executable path, without a shell wrapper.",
      });
    const {
      lifecycleCommand,
      reservationId: _reservationId,
      revision: _revision,
      branch: _branch,
      sourceKind: _sourceKind,
      ...payload
    } = job;
    const result = yield* runner.run({
      command: lifecycleCommand.executable,
      args: lifecycleCommand.args,
      cwd: job.workspaceDirectory,
      stdin: encode({ ...payload, action: "register" }) + "\n",
      env: workspaceEnvironment(job),
      timeout: "60 seconds",
      maxOutputBytes: 64 * 1024,
    });
    if (result.code !== 0)
      return yield* new SessionWorkspaceError({
        threadId: job.threadId,
        detail: `Lifecycle registration failed (${result.code}): ${result.stderr.trim()}. Retry uses ${job.root}.`,
      });
    const receipt = yield* decodeRegistration(result.stdout);
    if (receipt.jobId !== job.jobId)
      return yield* new SessionWorkspaceError({
        threadId: job.threadId,
        detail: "Lifecycle registration returned a different job identity.",
      });
  });
  const verify = Effect.fn(
    function* (threadId: string) {
      const row = yield* read(threadId);
      if (!row) return null;
      if (row.state !== "ready")
        return yield* new SessionWorkspaceError({
          threadId,
          detail: `Provisioning is incomplete at ${row.job.root}; retry creation with the same thread ID.`,
        });
      for (const dir of [
        row.job.workspaceDirectory,
        row.job.tmpDirectory,
        row.job.buildDirectory,
        row.job.cacheDirectory,
        row.job.downloadsDirectory,
        row.job.outputsDirectory,
        row.job.evidenceDirectory,
      ]) {
        if ((yield* fs.stat(dir)).type !== "Directory")
          return yield* new SessionWorkspaceError({
            threadId,
            detail: `Recorded directory is unavailable: ${dir}. Restore it through its lifecycle owner.`,
          });
      }
      if (row.job.sourceKind) {
        yield* Effect.tryPromise(() => verifySourceSnapshot(row.job));
      } else if (
        (yield* fs.stat(path.join(row.job.workspaceDirectory, ".git"))).type !== "File" ||
        (yield* primaryDirectory(
          threadId,
          row.job.workspaceDirectory,
          path.dirname(row.job.root),
        )) !== row.job.sourceDirectory
      )
        return yield* new SessionWorkspaceError({
          threadId,
          detail: "Recorded workspace no longer belongs to its persistent Git primary.",
        });
      // Recognition is idempotent and rechecked on resume. Disabling settings never
      // silently strips protection from an already registered job.
      yield* register(row.job);
      return row.job;
    },
    Effect.mapError(failure("resume")),
  );
  const prepare = Effect.fn(
    function* (input: NewWorkspace) {
      const assertCreatable = Effect.gen(function* () {
        const moving = yield* sql`SELECT 1 FROM custom_session_moves
          WHERE thread_id = ${input.threadId} AND locked = 1 LIMIT 1`;
        const incoming = yield* sql`SELECT 1 FROM session_workspaces w
          LEFT JOIN custom_session_moves m ON w.reservation_id = 'move:' || m.id
          WHERE w.thread_id = ${input.threadId} AND w.reservation_id LIKE 'move:%'
          AND (m.id IS NULL OR m.state != 'cancelled') LIMIT 1`;
        if (moving.length || incoming.length)
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail:
              "This thread is reserved for a session move; creation cannot provision its workspace.",
          });
      });
      yield* assertCreatable;
      let row = yield* read(input.threadId);
      if (row) {
        const primary = row.job.sourceKind
          ? path.normalize(input.sourceDirectory)
          : yield* primaryDirectory(
              input.threadId,
              input.sourceDirectory,
              path.dirname(row.job.root),
            );
        if (
          primary !== row.job.sourceDirectory ||
          (input.branch !== undefined && input.branch !== row.job.branch)
        )
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail:
              "The existing job identity is bound to a different source or branch. Retry its original creation request.",
          });
        if (input.fork && !row.job.sourceKind) {
          const status = yield* git.statusDetailsLocal(input.sourceDirectory);
          const head = yield* git.resolveCommit({
            cwd: input.sourceDirectory,
            revision: input.ref ?? "HEAD",
          });
          if (status.hasWorkingTreeChanges || head.commitSha !== row.job.revision)
            return yield* new SessionWorkspaceError({
              threadId: input.threadId,
              detail:
                "The fork source changed after its workspace was reserved. Restore that source or start a new fork identity.",
            });
        }
      }
      if (row?.state === "ready") return yield* verify(input.threadId);
      const configured = yield* configuredRoot();
      if (!row && !configured) return null;
      if (!row) {
        if (!path.isAbsolute(input.sourceDirectory))
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail: "Source workspace must be absolute.",
          });
        if (input.fork) {
          const status = yield* git.statusDetailsLocal(input.sourceDirectory);
          if (status.hasWorkingTreeChanges)
            return yield* new SessionWorkspaceError({
              threadId: input.threadId,
              detail:
                "The fork source has uncommitted changes. Commit the intended source before creating an independent session workspace.",
            });
        }
        const repository = yield* git.execute({
          operation: "SessionWorkspaces.sourceKind",
          cwd: input.sourceDirectory,
          args: ["rev-parse", "--is-inside-work-tree"],
          allowNonZeroExit: true,
        });
        const head =
          repository.exitCode === 0
            ? yield* git.execute({
                operation: "SessionWorkspaces.head",
                cwd: input.sourceDirectory,
                args: ["rev-parse", "--verify", "--quiet", "HEAD"],
                allowNonZeroExit: true,
              })
            : null;
        const sourceKind =
          repository.exitCode !== 0
            ? ("directory" as const)
            : head?.exitCode !== 0
              ? ("unborn" as const)
              : undefined;
        const commit = sourceKind
          ? null
          : yield* git.resolveCommit({
              cwd: input.sourceDirectory,
              revision: input.ref ?? "HEAD",
            });
        const sourceDirectory = sourceKind
          ? path.normalize(input.sourceDirectory)
          : yield* primaryDirectory(input.threadId, input.sourceDirectory, configured!.root);
        const relative = path.relative(configured!.root, sourceDirectory);
        if (
          sourceKind &&
          relative !== ".." &&
          !relative.startsWith(".." + path.sep) &&
          !path.isAbsolute(relative)
        )
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail: "Persistent source inputs must be outside the agent work root.",
          });
        const job = binding(
          {
            threadId: input.threadId,
            reservationId: `new:${input.threadId}`,
            root: path.join(configured!.root, jobIdFor(input.threadId)),
            sourceDirectory,
            revision: commit?.commitSha ?? "",
            branch:
              input.branch ??
              (sourceKind === "unborn"
                ? (yield* git.execute({
                    operation: "SessionWorkspaces.unbornBranch",
                    cwd: input.sourceDirectory,
                    args: ["symbolic-ref", "--short", "HEAD"],
                  })).stdout.trim()
                : null),
            ...(sourceKind ? { sourceKind } : {}),
          },
          configured!.config,
        );
        if (yield* fs.exists(job.root))
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail: `Unassociated job path already exists: ${job.root}. Nothing was adopted or replaced.`,
          });
        // Exclusion and reservation share the move transaction's database lock.
        // Checkout remains outside both the SQL transaction and the engine queue.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertCreatable;
            yield* sql`INSERT INTO session_workspaces (reservation_id, thread_id, binding_json, state, active)
            VALUES (${job.reservationId}, ${input.threadId}, ${encode(job)}, 'reserved', 1)`;
          }),
        );
        row = { job, state: "reserved", setup_complete: 0, binding_json: encode(job) };
      }
      const job = row.job;
      return yield* Effect.gen(function* () {
        yield* scaffold(job);
        if (job.sourceKind) {
          yield* Effect.tryPromise({
            try: () => prepareSourceSnapshot(job),
            catch: failure(input.threadId),
          });
        } else if (!(yield* fs.exists(job.workspaceDirectory))) {
          yield* git.createWorktree(
            {
              cwd: job.sourceDirectory,
              refName: job.revision,
              path: job.workspaceDirectory,
              ...(job.branch ? { newRefName: job.branch } : {}),
            },
            {
              submodules: resolveProjectSettings(
                yield* settings.getSettings,
                input.projectId ?? null,
              ).settings.worktreeSubmodules,
            },
          );
        } else {
          // A crash after git succeeds can be retried, but an arbitrary directory
          // at the reserved path is never accepted as a completed checkout.
          if ((yield* fs.stat(path.join(job.workspaceDirectory, ".git"))).type !== "File")
            return yield* new SessionWorkspaceError({
              threadId: input.threadId,
              detail:
                "Incomplete workspace is not a linked Git worktree; repair the retained reservation.",
            });
          const head = yield* git.resolveCommit({ cwd: job.workspaceDirectory, revision: "HEAD" });
          const primary = yield* primaryDirectory(
            input.threadId,
            job.workspaceDirectory,
            path.dirname(job.root),
          );
          if (head.commitSha !== job.revision || primary !== job.sourceDirectory)
            return yield* new SessionWorkspaceError({
              threadId: input.threadId,
              detail:
                "Incomplete workspace source or revision changed; repair the retained reservation.",
            });
        }
        yield* sql`UPDATE session_workspaces SET state = 'prepared', error = NULL WHERE reservation_id = ${job.reservationId}`;
        yield* register(job);
        yield* sql`UPDATE session_workspaces SET state = 'ready', error = NULL WHERE reservation_id = ${job.reservationId}`;
        return job;
      }).pipe(
        Effect.tapError((cause) =>
          sql`UPDATE session_workspaces SET error = ${String(cause)} WHERE reservation_id = ${job.reservationId}`.pipe(
            Effect.ignore,
          ),
        ),
      );
    },
    lock.withPermit,
    Effect.mapError(failure("create")),
  );
  const movePath = Effect.fn(
    function* (threadId: string, requestId: string) {
      const rows = yield* sql<{
        binding_json: string;
      }>`SELECT binding_json FROM session_workspaces WHERE reservation_id = ${`move:${requestId}`}`;
      if (rows[0]) return (yield* decode(rows[0].binding_json)).workspaceDirectory;
      const existing = yield* get(threadId);
      if (existing) return existing.workspaceDirectory;
      const cancelled = yield* sql<{ binding_json: string }>`SELECT w.binding_json
        FROM session_workspaces w JOIN custom_session_moves m ON w.reservation_id = 'move:' || m.id
        WHERE w.thread_id = ${threadId} AND m.direction = 'in' AND m.state = 'cancelled'
        ORDER BY m.updated_at DESC LIMIT 1`;
      if (cancelled[0]) return (yield* decode(cancelled[0].binding_json)).workspaceDirectory;
      const configured = yield* configuredRoot();
      if (!configured) return null;
      const root = path.join(configured.root, jobIdFor(threadId));
      // Legacy work can share a thread's directory name without belonging to T3.
      // Give this move its own stable root; never adopt or move that existing work.
      const destination = (yield* fs.exists(root))
        ? path.join(configured.root, jobIdFor(requestId))
        : root;
      if (yield* fs.exists(destination))
        return yield* new SessionWorkspaceError({
          threadId,
          detail:
            "The move-specific job path already exists without a reservation. Nothing was adopted or replaced.",
        });
      return path.join(destination, "repo");
    },
    Effect.mapError(failure("move")),
  );
  const reserveMove = Effect.fn(
    function* (input: MoveWorkspace) {
      const configured = yield* configuredRoot();
      const expected = yield* movePath(input.threadId, input.requestId);
      if (!expected) return null;
      if (expected !== input.cwd)
        return yield* new SessionWorkspaceError({
          threadId: input.threadId,
          detail:
            "Destination workspace settings changed during transfer; retry the move preflight.",
        });
      const reservationId = `move:${input.requestId}`;
      const rows = yield* sql<{
        binding_json: string;
      }>`SELECT binding_json FROM session_workspaces WHERE reservation_id = ${reservationId}`;
      let previous = yield* get(input.threadId);
      if (previous && previous.reservationId !== reservationId) {
        const parked = yield* sql`SELECT 1 FROM custom_session_moves
          WHERE thread_id = ${input.threadId} AND id != ${input.requestId}
          AND ((direction = 'out' AND state = 'complete') OR (direction = 'in' AND state = 'cancelled')) LIMIT 1`;
        if (!parked.length)
          return yield* new SessionWorkspaceError({
            threadId: input.threadId,
            detail: "An existing local job is not a parked outgoing or cancelled incoming session.",
          });
      }
      if (!previous && !rows[0]) {
        // A cancelled pre-install transfer has no active binding, but still owns
        // its root and staging. Only its authenticated source can supersede it.
        const cancelled = yield* sql<{ binding_json: string }>`SELECT w.binding_json
          FROM session_workspaces w JOIN custom_session_moves old ON w.reservation_id = 'move:' || old.id
          JOIN custom_session_moves current ON current.id = ${input.requestId}
          WHERE w.thread_id = ${input.threadId} AND old.thread_id = current.thread_id
          AND old.direction = 'in' AND old.state = 'cancelled'
          AND current.direction = 'in' AND current.locked = 1
          AND old.peer_environment_id = current.peer_environment_id
          ORDER BY old.updated_at DESC LIMIT 1`;
        if (cancelled[0]) previous = yield* decode(cancelled[0].binding_json);
      }
      if (!rows[0] && !previous && (yield* fs.exists(path.dirname(input.cwd))))
        return yield* new SessionWorkspaceError({
          threadId: input.threadId,
          detail:
            "The destination job path already exists without an active binding. Retry its original reservation or recover it through the lifecycle owner.",
        });
      const sourceDirectory = yield* primaryDirectory(
        input.threadId,
        input.sourceDirectory,
        path.dirname(path.dirname(input.cwd)),
      );
      if (
        previous &&
        (sourceDirectory !== previous.sourceDirectory || input.cwd !== previous.workspaceDirectory)
      )
        return yield* new SessionWorkspaceError({
          threadId: input.threadId,
          detail:
            "The returning job belongs to a different persistent primary. Choose its original destination project.",
        });
      const job = rows[0]
        ? yield* decode(rows[0].binding_json)
        : previous
          ? {
              ...previous,
              reservationId,
              revision: input.revision,
              branch: input.branch,
            }
          : binding(
              {
                threadId: input.threadId,
                reservationId,
                root: path.dirname(input.cwd),
                sourceDirectory,
                revision: input.revision,
                branch: input.branch,
              },
              configured!.config,
            );
      if (
        job.threadId !== input.threadId ||
        job.sourceDirectory !== sourceDirectory ||
        job.revision !== input.revision ||
        job.branch !== input.branch
      )
        return yield* new SessionWorkspaceError({
          threadId: input.threadId,
          detail: "Move retry differs from its durable workspace reservation.",
        });
      yield* sql`INSERT OR IGNORE INTO session_workspaces (reservation_id, thread_id, binding_json, state, setup_complete)
      VALUES (${reservationId}, ${input.threadId}, ${encode(job)}, 'prepared', 1)`;
      return job;
    },
    sql.withTransaction,
    Effect.mapError(failure("move")),
  );
  const registerMove = Effect.fn(
    function* (input: MoveWorkspace) {
      const job = yield* reserveMove(input);
      if (!job) return null;
      yield* scaffold(job);
      yield* register(job);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE session_workspaces SET active = 0 WHERE thread_id = ${input.threadId}`;
          yield* sql`UPDATE session_workspaces SET active = 1, state = 'ready' WHERE reservation_id = ${job.reservationId}`;
        }),
      );
      return job;
    },
    lock.withPermit,
    Effect.mapError(failure("move")),
  );
  const inherit = Effect.fn(
    function* (previous: string, successor: string) {
      const source = yield* read(previous);
      if (!source) return null;
      const job = yield* verify(previous);
      const existing = yield* read(successor);
      if (existing && existing.binding_json !== source.binding_json)
        return yield* new SessionWorkspaceError({
          threadId: successor,
          detail: "The successor already belongs to another workspace.",
        });
      // Keep the registration byte-for-byte: lifecycle owners bind the job identity,
      // while native startup attaches each successor to that same protected job.
      yield* sql`INSERT OR IGNORE INTO session_workspaces
      (reservation_id, thread_id, binding_json, state, active, setup_complete)
      VALUES (${"renewal:" + successor}, ${successor}, ${source.binding_json}, 'ready', 1, ${source.setup_complete})`;
      return job;
    },
    lock.withPermit,
    Effect.mapError(failure("renewal")),
  );
  const list = Effect.fn("SessionWorkspaces.list")(function* () {
    const rows = yield* sql<{
      binding_json: string;
    }>`SELECT binding_json FROM session_workspaces WHERE active = 1 LIMIT 5000`;
    return yield* Effect.forEach(rows, (row) => decode(row.binding_json).pipe(Effect.option)).pipe(
      Effect.map((jobs) => jobs.flatMap((job) => (job._tag === "Some" ? [job.value] : []))),
    );
  });
  const transferDirectory = Effect.fn("SessionWorkspaces.transferDirectory")(function* (
    threadId: string,
    requestId: string,
  ) {
    const rows = yield* sql<{
      binding_json: string;
    }>`SELECT binding_json FROM session_workspaces WHERE reservation_id = ${`move:${requestId}`}`;
    const job = rows[0] ? yield* decode(rows[0].binding_json) : yield* get(threadId);
    return job ? path.join(job.tmpDirectory, "session-moves", jobIdFor(requestId)) : null;
  });
  return SessionWorkspaces.of({
    prepare,
    inherit,
    get,
    list: () => Effect.mapError(list(), failure("inventory")),
    verify,
    movePath,
    registerMove,
    reserveMove,
    transferDirectory: (threadId, requestId) =>
      Effect.mapError(transferDirectory(threadId, requestId), failure(threadId)),
    needsSetup: (threadId) =>
      read(threadId).pipe(
        Effect.map((row) => !!row && row.setup_complete === 0),
        Effect.mapError(failure(threadId)),
      ),
    completeSetup: (threadId) =>
      sql`UPDATE session_workspaces SET setup_complete = 1 WHERE thread_id = ${threadId} AND active = 1`.pipe(
        Effect.asVoid,
        Effect.mapError(failure(threadId)),
      ),
  });
});
export const layer = Layer.effect(SessionWorkspaces, make);
