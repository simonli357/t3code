import * as NodeOS from "node:os";
import { ComputerOperationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The parts of workenv's own files that this server reads. workenv owns these formats (its helper
 * lives in the installed `work-environment/tool` folder); the schemas accept only what is needed,
 * so a field workenv adds later is ignored rather than fatal.
 */
const Policy = Schema.Struct({
  audience: Schema.String,
  collection: Schema.optionalKey(Schema.String),
  relative_path: Schema.optionalKey(Schema.String),
  backup_required: Schema.optionalKey(Schema.Boolean),
});
const Config = Schema.Struct({
  state: Schema.String,
  jobs_root: Schema.optionalKey(Schema.String),
  /** Where workenv keeps its capacity configuration (per-computer reserves and paths). */
  capacity_config: Schema.optionalKey(Schema.String),
  projects: Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.String,
      /** `directory` for original data that is not a Git repository. */
      mode: Schema.optionalKey(Schema.String),
      jobs_root: Schema.optionalKey(Schema.String),
      keep: Schema.optionalKey(Policy),
    }),
  ),
  keep: Schema.Struct({
    library_root: Schema.String,
    library_id: Schema.String,
    ssh_host: Schema.optionalKey(Schema.String),
    interface_path: Schema.optionalKey(Schema.String),
    route_blocked: Schema.optionalKey(Schema.Boolean),
    ssh_executable: Schema.optionalKey(Schema.String),
    rclone: Schema.optionalKey(Schema.String),
    writer_local: Schema.optionalKey(Schema.Boolean),
  }),
});
export type WorkenvConfig = typeof Config.Type;

const Entry = Schema.Struct({
  type: Schema.String,
  bytes: Schema.optionalKey(Schema.Number),
  sha256: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Number),
});
/** What workenv records once the library's backup confirms one bundle (receipt schema v2). */
export const BackupProof = Schema.Struct({
  schema: Schema.String,
  snapshot_id: Schema.String,
  content_verified_snapshot: Schema.String,
  manifest_sha256: Schema.String,
  path: Schema.String,
  method: Schema.String,
  confirmed_at: Schema.Unknown,
});
export type BackupProof = typeof BackupProof.Type;
/** A keep request or receipt; a published bundle's `manifest.json` has the same shape. */
export const Receipt = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  source: Schema.String,
  project: Schema.String,
  reason: Schema.String,
  audience: Schema.optionalKey(Schema.String),
  collection: Schema.optionalKey(Schema.String),
  destination: Schema.optionalKey(Schema.String),
  status: Schema.String,
  /** Set once workenv has inspected the selection; a request that failed earlier has none. */
  created_at: Schema.optionalKey(Schema.String),
  published_at: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backup_required: Schema.optionalKey(Schema.Boolean),
  backup: Schema.optionalKey(Schema.String),
  backup_error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  backup_receipt: Schema.optionalKey(BackupProof),
  superseded: Schema.optionalKey(Schema.Boolean),
  reference: Schema.optionalKey(Schema.String),
  writer_path: Schema.optionalKey(Schema.String),
  library_id: Schema.optionalKey(Schema.String),
  library_root: Schema.optionalKey(Schema.String),
  library_ssh: Schema.optionalKey(Schema.NullOr(Schema.String)),
  snapshot: Schema.optionalKey(Schema.Record(Schema.String, Entry)),
  origin: Schema.optionalKey(Schema.Struct({ host: Schema.optionalKey(Schema.String) })),
});
export type KeepReceipt = typeof Receipt.Type;

/** A sender or receiver handoff receipt under `<state>/handoffs`. */
const Handoff = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.String),
  source: Schema.String,
  status: Schema.String,
  role: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cancel_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reference: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source_verified_at: Schema.optionalKey(Schema.Number),
  destination: Schema.Struct({ host: Schema.String, job: Schema.String, path: Schema.String }),
});
export type HandoffReceipt = typeof Handoff.Type;

/** `<job>/.workenv.json`, identical on Linux and Windows apart from path syntax. */
const Job = Schema.Struct({
  project: Schema.String,
  root: Schema.String,
  repo: Schema.optionalKey(Schema.String),
  status: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  created_at: Schema.optionalKey(Schema.Number),
});
export type JobRecord = typeof Job.Type;

export const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
export const decodeHandoff = Schema.decodeUnknownEffect(Schema.fromJsonString(Handoff));
export const decodeJob = Schema.decodeUnknownEffect(Schema.fromJsonString(Job));

export const fail = (message: string) => new ComputerOperationError({ message });
export const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
const isOperationError = Schema.is(ComputerOperationError);
/** Every failure a computers operation reports to a client is a `ComputerOperationError`. */
export const operationError = (cause: unknown): ComputerOperationError =>
  isOperationError(cause) ? cause : fail(messageOf(cause));
/** Seconds-or-ISO timestamps from workenv's files, as milliseconds. */
export const parseTime = (text: string | undefined) =>
  text !== undefined && Number.isFinite(Date.parse(text)) ? Date.parse(text) : null;

export const workenvHome = Effect.fn("Workenv.home")(function* () {
  const env = yield* HostProcess.Environment,
    platform = yield* HostProcess.Platform;
  return (platform === "win32" ? env.USERPROFILE : env.HOME) ?? NodeOS.homedir();
});

/**
 * The workenv configuration of this computer, with a stamp that changes when the file does; null
 * when workenv is not installed.
 */
const readWorkenv = Effect.fn("Workenv.readConfig")(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const filename = path.join(yield* workenvHome(), ".config", "workenv", "keep.json");
  if (!(yield* fs.exists(filename))) return null;
  const stamp = yield* fs.stat(filename).pipe(
    Effect.map(
      (info) =>
        `${Option.getOrNull(Option.map(info.mtime, (date) => date.getTime()))}:${info.size}`,
    ),
    Effect.orElseSucceed(() => "unknown"),
  );
  const config = yield* fs
    .readFileString(filename)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Config))));
  return { config, stamp };
});

/** Like `readWorkenv`, but a broken configuration becomes a message instead of a failure. */
export const loadWorkenv = Effect.fn("Workenv.loadConfig")(function* () {
  return yield* readWorkenv().pipe(
    Effect.map((read) => ({
      config: read?.config ?? null,
      stamp: read?.stamp ?? "none",
      error: null as string | null,
    })),
    Effect.catch((cause) =>
      Effect.succeed({
        config: null,
        stamp: "unreadable",
        error: `Workenv configuration is unreadable: ${messageOf(cause)}`,
      }),
    ),
  );
});
