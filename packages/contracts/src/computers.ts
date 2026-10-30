import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";
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
export const COMPUTER_CAPACITY_MAX_DISKS = 16;
/**
 * What an agent needs to choose a computer for new work: a small, bounded slice of the overview,
 * measured when asked. A part that could not be measured is null or absent, never zero.
 */
export const ComputerCapacity = Schema.Struct({
  /** Epoch milliseconds of the oldest measurement below. */
  sampledAt: NonNegativeInt,
  os: ExecutionEnvironmentPlatformOs,
  resources: HostResourcesSnapshot,
  /** The largest disks, with the work disk always among them. */
  disks: Schema.Array(ComputerDisk).check(Schema.isMaxLength(COMPUTER_CAPACITY_MAX_DISKS)),
  /** Mount point in `disks` that holds new agent work; null when it cannot be told. */
  workDisk: Schema.NullOr(Schema.String),
  /** Workenv jobs with a workspace and with a live process; null when workenv cannot be read. */
  jobs: Schema.NullOr(Schema.Struct({ active: NonNegativeInt, running: NonNegativeInt })),
  notices: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
});
export type ComputerCapacity = typeof ComputerCapacity.Type;
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

/** A struct that is present only for the groups it describes. */
function optionalStruct<Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.optionalKey(Schema.Struct(fields));
}

// ── Storage views ─────────────────────────────────────────────────────────────────────────────
// Every byte count below is bytes, or null when it was not measured. Null is never shown as zero.

const Bytes = Schema.NullOr(Schema.Number);

/**
 * One filesystem on a physical disk. Bind mounts and other aliases of the same filesystem are
 * `mountPaths` of one volume, never extra volumes. `usedBytes` is what the filesystem reports used,
 * `availableBytes` what a user may still write; they need not add up to `capacityBytes`.
 */
export const StorageVolume = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Primary mount point (or drive letter) first. */
  mountPaths: Schema.Array(Schema.String),
  filesystem: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  /** Everything but `data` and `system` is system detail, shown under Advanced. */
  role: Schema.Literals(["data", "system", "boot", "swap", "recovery", "unmounted"]),
  capacityBytes: Bytes,
  usedBytes: Bytes,
  availableBytes: Bytes,
  /** The configured reserve that must stay free; null when none is configured. */
  reserveBytes: Bytes,
  /** What agent work may still use here (available minus reserve, not below zero); null unless the work disk and both are known. */
  headroomBytes: Bytes,
  /** What the host's configuration places on this volume. */
  holds: Schema.Array(Schema.Literals(["agent-work", "library", "backup"])),
  measuredAt: Schema.NullOr(Schema.Number),
});
export type StorageVolume = typeof StorageVolume.Type;
export const StorageDisk = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
  bus: Schema.NullOr(Schema.String),
  media: Schema.NullOr(Schema.Literals(["ssd", "hdd", "removable", "virtual"])),
  sizeBytes: Bytes,
  volumes: Schema.Array(StorageVolume),
  /** Boot, swap, recovery and unmounted partitions of this disk. */
  system: Schema.Array(StorageVolume),
});
export type StorageDisk = typeof StorageDisk.Type;
/** Storage another computer serves; never one of this computer's disks. */
export const StorageRemoteMount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  protocol: Schema.String,
  /** The computer that holds the bytes, when the mount names it. */
  host: Schema.NullOr(Schema.String),
  /** The share or path on that computer. */
  backing: Schema.NullOr(Schema.String),
  mountPaths: Schema.Array(Schema.String),
  capacityBytes: Bytes,
  usedBytes: Bytes,
  availableBytes: Bytes,
  measuredAt: Schema.NullOr(Schema.Number),
});
export type StorageRemoteMount = typeof StorageRemoteMount.Type;
/** Mounts that are not disks: memory, kernel views, mounted images, aliases. Advanced details only. */
export const StorageSystemMount = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["memory", "pseudo", "image", "alias", "other"]),
  label: Schema.String,
  mountPaths: Schema.Array(Schema.String),
  filesystem: Schema.NullOr(Schema.String),
  /** The image file behind a mounted image, or the volume an alias points into. */
  backing: Schema.NullOr(Schema.String),
  capacityBytes: Bytes,
  usedBytes: Bytes,
});
export type StorageSystemMount = typeof StorageSystemMount.Type;
export const StorageDisks = Schema.Struct({
  sampledAt: Schema.Number,
  host: Schema.String,
  os: ExecutionEnvironmentPlatformOs,
  disks: Schema.Array(StorageDisk),
  remote: Schema.Array(StorageRemoteMount),
  advanced: Schema.Array(StorageSystemMount),
  /** Where the reserves came from; null when none is configured. */
  reserveSource: Schema.NullOr(Schema.String),
  notices: Schema.Array(Schema.String),
});
export type StorageDisks = typeof StorageDisks.Type;

export const STORAGE_GROUPS = ["workspaces", "archives", "backups", "other"] as const;
export type StorageGroupId = (typeof STORAGE_GROUPS)[number];
/** A size is a measurement with its basis, never a bare number. */
export const StorageSize = Schema.Struct({
  bytes: Bytes,
  /** False when `bytes` is a lower bound: the scan stopped early, or only part of the data is counted. */
  complete: Schema.Boolean,
  measuredAt: Schema.NullOr(Schema.Number),
  basis: Schema.Literals([
    "allocated",
    "logical",
    "lifecycle",
    "manifest",
    "filesystem",
    "reported",
    "unavailable",
  ]),
  /** Bytes in files with several hard links; another entry may count the same bytes. */
  sharedBytes: Schema.optionalKey(Bytes),
});
export type StorageSize = typeof StorageSize.Type;
export const StorageRam = Schema.Struct({
  path: Schema.String,
  usedBytes: Bytes,
  limitBytes: Bytes,
  measuredAt: Schema.NullOr(Schema.Number),
});
export type StorageRam = typeof StorageRam.Type;
export const StorageWorkspaceState = Schema.Literals([
  "active",
  "completed",
  "preservation-pending",
  "cleanup-eligible",
  "held",
  "unknown",
]);
export type StorageWorkspaceState = typeof StorageWorkspaceState.Type;
export const StorageEntry = Schema.Struct({
  /** Opaque and stable on this computer; `holding` takes it back. */
  id: Schema.String,
  group: Schema.Literals(STORAGE_GROUPS),
  title: Schema.String,
  /** One muted line: project, kind, collection. */
  subtitle: Schema.NullOr(Schema.String),
  /** The computer that holds the bytes. */
  host: Schema.String,
  /** False when `host` is not the computer that reported it: nothing is charged to this computer's disks. */
  local: Schema.Boolean,
  location: Schema.NullOr(Schema.String),
  disk: Schema.NullOr(
    Schema.Struct({ disk: Schema.NullOr(Schema.String), volume: Schema.NullOr(Schema.String) }),
  ),
  size: StorageSize,
  /** RAM-backed paths of this entry; excluded from disk totals. */
  ram: Schema.Array(StorageRam),
  workspace: Schema.optionalKey(
    Schema.Struct({
      owner: Schema.Struct({
        project: Schema.NullOr(Schema.String),
        /** The session that directs this one, when this is a worker. */
        master: Schema.NullOr(Schema.String),
        /** Titles of the sessions this one directs, when this is a master. */
        workers: Schema.Array(Schema.String),
        session: Schema.NullOr(Schema.String),
      }),
      state: StorageWorkspaceState,
      /** Where `state` comes from: the lifecycle tool's own record, T3's session record, or neither. */
      stateSource: Schema.Literals(["lifecycle", "session", "none"]),
      lastActivityAt: Schema.NullOr(Schema.Number),
      expiresAt: Schema.NullOr(Schema.Number),
      /** Why it is retained, in the lifecycle tool's words; null when none was reported. */
      retention: Schema.NullOr(Schema.String),
      preservation: Schema.Array(Schema.String),
      /** Kept results made from this workspace; their bytes are not charged to it. */
      keeps: Schema.Array(
        Schema.Struct({ id: Schema.String, title: Schema.String, host: Schema.String }),
      ),
    }),
  ),
  archive: optionalStruct({
    collection: Schema.NullOr(Schema.String),
    project: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    createdAt: Schema.NullOr(Schema.Number),
    retention: Schema.NullOr(Schema.String),
    files: Schema.NullOr(Schema.Number),
    backup: Schema.Literals(["confirmed", "published", "not-verified"]),
    backupVerifiedAt: Schema.NullOr(Schema.Number),
    backupSnapshot: Schema.NullOr(Schema.String),
  }),
  backup: optionalStruct({
    kind: Schema.String,
    repository: Schema.String,
    /** Snapshots share data: the count is not a count of independent copies. */
    snapshots: Schema.NullOr(Schema.Number),
    /** Kept bundles the latest backup covers, out of those it should cover. */
    covered: Schema.NullOr(Schema.Number),
    expected: Schema.NullOr(Schema.Number),
    verifiedAt: Schema.NullOr(Schema.Number),
    retention: Schema.NullOr(Schema.String),
    /** Whether this repository sits on another physical disk than the library it protects. */
    independent: Schema.NullOr(Schema.Boolean),
  }),
  other: optionalStruct({
    classification: Schema.Literals([
      "permanent-source",
      "original-data",
      "project-runtime",
      "shared-tooling",
      "legacy-work",
      "recovery",
    ]),
    protection: Schema.NullOr(Schema.String),
  }),
  notes: Schema.Array(Schema.String),
});
export type StorageEntry = typeof StorageEntry.Type;
export const StorageGroup = Schema.Struct({
  group: Schema.Literals(STORAGE_GROUPS),
  /** `partial` when only some of what exists could be read; `unsupported` when this computer cannot tell. */
  status: Schema.Literals(["complete", "partial", "unsupported", "unavailable"]),
  reason: Schema.NullOr(Schema.String),
  count: Schema.Number,
  /** Entries stored on other computers: counted, but none of their bytes is charged here. */
  remote: Schema.Number,
  /** Entries listed below; fewer than `count` when the list is bounded. */
  shown: Schema.Number,
  /** Disk bytes of the entries measured so far, RAM excluded; null when none has a size. */
  bytes: Bytes,
  measured: Schema.Number,
  /** Entries without a size, or whose size is a lower bound. */
  unmeasured: Schema.Number,
  /** Bytes inside the total that other entries may also hold (hard links). */
  sharedBytes: Bytes,
  ramBytes: Bytes,
  entries: Schema.Array(StorageEntry),
});
export type StorageGroup = typeof StorageGroup.Type;
export const StorageHoldings = Schema.Struct({
  sampledAt: Schema.Number,
  host: Schema.String,
  /** Always the four groups, in display order. */
  groups: Schema.Array(StorageGroup),
  /** Sizes are still being measured in the background. */
  measuring: Schema.Boolean,
  notices: Schema.Array(Schema.String),
});
export type StorageHoldings = typeof StorageHoldings.Type;
/** What one entry is made of, read when it is opened. */
export const StorageDetail = Schema.Struct({
  id: Schema.String,
  sampledAt: Schema.Number,
  parts: Schema.Array(
    Schema.Struct({
      key: Schema.Literals([
        "source",
        "tmp",
        "dependencies",
        "builds",
        "outputs",
        "inputs",
        "other",
      ]),
      label: Schema.String,
      path: Schema.NullOr(Schema.String),
      size: StorageSize,
      /** Present when this part is a RAM-backed path. */
      ram: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  notes: Schema.Array(Schema.String),
});
export type StorageDetail = typeof StorageDetail.Type;

export const ComputerInspectInput = Schema.Struct({
  /**
   * `disks`, `holdings` and `holding` belong to the storage views: the real disks and volumes, the
   * four groups of kept data, and the lazily read details of one entry (`entry`).
   */
  section: Schema.Literals([
    "overview",
    "files",
    "folders",
    "processes",
    "activity",
    "disks",
    "holdings",
    "holding",
  ]),
  /** `holding` only: the id of a `StorageEntry` from `holdings`. */
  entry: Schema.optionalKey(Schema.String),
  /**
   * `holdings` only: the groups whose entries are wanted. The others still carry their counts and
   * totals, with no entries; omitted means every group.
   */
  groups: Schema.optionalKey(Schema.Array(Schema.Literals(STORAGE_GROUPS))),
  path: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  extension: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.Number),
  /**
   * Files section page size: a positive integer, default 200, at most 5000. For `holdings`, the
   * entries sent per requested group: default 400, at most 5000.
   */
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
  /** `disks` section. Older servers never send it. */
  storageDisks: Schema.optionalKey(StorageDisks),
  /** `holdings` section. */
  storageHoldings: Schema.optionalKey(StorageHoldings),
  /** `holding` section; null when the entry is no longer known. */
  storageDetail: Schema.optionalKey(Schema.NullOr(StorageDetail)),
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
