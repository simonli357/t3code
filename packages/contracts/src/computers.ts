import * as Schema from "effect/Schema";
import { PositiveInt } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export class ComputerOperationError extends Schema.TaggedError<ComputerOperationError>()(
  "ComputerOperationError",
  { message: Schema.String },
) {}

export const ComputerDisk = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  totalBytes: Schema.Number,
  availableBytes: Schema.Number,
  freeBytes: Schema.Number,
});
export const ComputerFile = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  project: Schema.String,
  area: Schema.optionalKey(Schema.Literals(["project", "work", "archive"])),
  /** Null when the size was not measured. For folders see `sizeComplete`. */
  sizeBytes: Schema.NullOr(Schema.Number),
  /** Folders only: false when the bounded scan stopped early, so `sizeBytes` is a lower bound. */
  sizeComplete: Schema.optionalKey(Schema.Boolean),
  modifiedAt: Schema.NullOr(Schema.Number),
  directory: Schema.Boolean,
  backup: Schema.Literals(["not-verified", "published", "confirmed"]),
  /** Epoch milliseconds of the check supporting `confirmed`; null otherwise. */
  backupVerifiedAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  reference: Schema.NullOr(Schema.String),
  /** Kept-archive files only: whether this computer can restore the file right now. */
  restorable: Schema.optionalKey(Schema.Boolean),
  restoreUnavailableReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
  computer: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kept: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ reason: Schema.String, keptAt: Schema.NullOr(Schema.Number) })),
  ),
});
export type ComputerFile = typeof ComputerFile.Type;
/**
 * `status` is one of running, stalled, pending, failed, completed, published, cancelled (the clients
 * understand these) or a workenv job state (active, expired, removing, creating, setup-failed).
 */
export const ComputerActivity = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["job", "transfer", "backup", "restore"]),
  label: Schema.String,
  status: Schema.String,
  updatedAt: Schema.Number,
  detail: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
});
export type ComputerActivity = typeof ComputerActivity.Type;
export const ComputerProcess = Schema.Struct({
  pid: Schema.Number,
  name: Schema.String,
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: Schema.Number,
  /** The executable path (argv[0]) only, never arguments; null when unavailable. */
  command: Schema.NullOr(Schema.String),
  /** The user the process runs as, where the platform exposes it (Linux); null otherwise. */
  owner: Schema.NullOr(Schema.String),
  /**
   * The id (`job:<name>`) of the workenv job that launched this process. Only workenv's own
   * launch records say so; a process is never matched to a job by its name or location.
   */
  jobId: Schema.NullOr(Schema.String),
});
export const ComputerInspectInput = Schema.Struct({
  section: Schema.Literals(["overview", "files", "folders", "processes", "activity"]),
  path: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  extension: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.Number),
  /** Files section page size: a positive integer, default 200, at most 5000. */
  limit: Schema.optionalKey(PositiveInt),
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type ComputerInspectInput = typeof ComputerInspectInput.Type;
export const ComputerInspection = Schema.Struct({
  sampledAt: Schema.Number,
  resources: Schema.NullOr(HostResourcesSnapshot),
  history: Schema.Array(HostResourcesSnapshot),
  disks: Schema.Array(ComputerDisk),
  files: Schema.Array(ComputerFile),
  totalFiles: Schema.Number,
  indexedAt: Schema.NullOr(Schema.Number),
  indexing: Schema.Boolean,
  projects: Schema.Array(Schema.String),
  processes: Schema.Array(ComputerProcess),
  activities: Schema.Array(ComputerActivity),
  errors: Schema.Array(Schema.String),
});
export type ComputerInspection = typeof ComputerInspection.Type;
/**
 * `retry` takes the `id` of a transfer activity. `backup` re-verifies, and if needed restarts, the
 * library backup for published keeps; `requestId` explicitly rechecks one keep even if it was
 * confirmed before (a published native receipt, its backup activity id, or a catalog bundle id).
 * Only omission of `requestId` checks all waiting keeps; unresolved explicit ids are rejected.
 */
export const ComputerActionInput = Schema.Struct({
  action: Schema.Literals(["keep", "retry", "restore", "backup"]),
  path: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  destination: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
});
export type ComputerActionInput = typeof ComputerActionInput.Type;
export const ComputerActionResult = Schema.Struct({ activity: ComputerActivity });
