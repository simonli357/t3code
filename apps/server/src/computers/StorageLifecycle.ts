import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { StorageReserve } from "./StorageDisks.ts";
import { messageOf, parseTime, workenvHome, type WorkenvConfig } from "./WorkenvConfig.ts";

/**
 * What the lifecycle tool installed on this computer says about storage, read from its own files
 * and nothing else: the job lifecycle records, the capacity configuration and the library
 * interface with its backup receipts. Every reader is tolerant (a field the tool adds later is
 * ignored) and optional (a computer without the tool, or without a file, simply has no answer).
 */

const Allocation = Schema.Struct({
  single_link_file_bytes: Schema.optionalKey(Schema.Number),
  basis: Schema.optionalKey(Schema.String),
});
const PendingKeep = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
});
const Usage = Schema.Struct({
  pending_keeps: Schema.optionalKey(Schema.Array(PendingKeep)),
  pending_handoffs: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  protected: Schema.optionalKey(Schema.Boolean),
});
const Recovery = Schema.Struct({
  logical_bytes: Schema.optionalKey(Schema.Number),
  destination: Schema.optionalKey(Schema.String),
});
const Lifecycle = Schema.Struct({
  job: Schema.String,
  observed_at: Schema.Number,
  status: Schema.String,
  fixture_only: Schema.optionalKey(Schema.Boolean),
  last_activity: Schema.optionalKey(Schema.Number),
  grace_started: Schema.optionalKey(Schema.Number),
  expires_at: Schema.optionalKey(Schema.Number),
  removed_at: Schema.optionalKey(Schema.Number),
  hold_reasons: Schema.optionalKey(Schema.Array(Schema.String)),
  allocation: Schema.optionalKey(Allocation),
  usage: Schema.optionalKey(Usage),
  recovery: Schema.optionalKey(Schema.Array(Recovery)),
});
const decodeLifecycle = Schema.decodeUnknownEffect(Schema.fromJsonString(Lifecycle));

export interface LifecycleRecord {
  readonly job: string;
  /** The tool's own word: `active`, `held`, `grace` or `removed`. */
  readonly status: string;
  readonly observedAt: number;
  readonly lastActivityAt: number | null;
  readonly expiresAt: number | null;
  readonly holdReasons: readonly string[];
  /** Keeps and handoffs the tool is waiting on before the job may expire. */
  readonly pending: readonly string[];
  /** Bytes of ordinary files with one hard link; the tool says this is a conservative estimate. */
  readonly allocatedBytes: number | null;
  readonly allocationBasis: string | null;
  readonly recoveryBytes: number | null;
  readonly recoveryRefs: number;
}

const ms = (seconds: number | undefined) =>
  seconds === undefined ? null : Math.round(seconds * 1000);

function toRecord(raw: typeof Lifecycle.Type): LifecycleRecord {
  const keeps = (raw.usage?.pending_keeps ?? []).map(
    (keep) => keep.reason ?? `Keep of ${keep.source ?? "a path"} is not complete`,
  );
  const handoffs = (raw.usage?.pending_handoffs ?? []).map(() => "A handoff is not delivered yet");
  const recovery = raw.recovery ?? [];
  return {
    job: raw.job,
    status: raw.status,
    observedAt: ms(raw.observed_at) ?? 0,
    lastActivityAt: ms(raw.last_activity),
    expiresAt: ms(raw.expires_at),
    holdReasons: [...new Set(raw.hold_reasons ?? [])],
    pending: [...new Set([...keeps, ...handoffs])],
    allocatedBytes: raw.allocation?.single_link_file_bytes ?? null,
    allocationBasis: raw.allocation?.basis ?? null,
    recoveryBytes: recovery.length
      ? recovery.reduce((sum, item) => sum + (item.logical_bytes ?? 0), 0)
      : null,
    recoveryRefs: recovery.length,
  };
}

export interface LifecycleCache {
  readonly entries: Map<string, { stamp: string; value: LifecycleRecord | null }>;
}
export const newLifecycleCache = (): LifecycleCache => ({ entries: new Map() });
const LIFECYCLE_LIMIT = 5_000;

/** `<state>/expiry/*.json`, each file parsed again only when its stamp moves. */
export const readLifecycle = Effect.fn("StorageLifecycle.read")(function* (
  state: string,
  cache: LifecycleCache,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const directory = path.join(state, "expiry");
  const names = (yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => [] as string[])))
    .filter((name) => name.endsWith(".json"))
    .slice(0, LIFECYCLE_LIMIT);
  const seen = new Set<string>();
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);
        seen.add(file);
        const info = yield* fs.stat(file).pipe(Effect.option);
        const stamp =
          Option.isSome(info) && Option.isSome(info.value.mtime)
            ? `${info.value.mtime.value.getTime()}:${info.value.size}`
            : "?";
        if (cache.entries.get(file)?.stamp === stamp) return;
        const value = yield* fs.readFileString(file).pipe(
          Effect.flatMap(decodeLifecycle),
          Effect.map((raw) => (raw.fixture_only ? null : toRecord(raw))),
          Effect.orElseSucceed(() => null),
        );
        cache.entries.set(file, { stamp, value });
      }),
    { concurrency: 8, discard: true },
  );
  for (const file of cache.entries.keys()) if (!seen.has(file)) cache.entries.delete(file);
  return [...cache.entries.values()].flatMap((entry) => (entry.value ? [entry.value] : []));
});

const CapacityPath = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  reserve_bytes: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
});
const Capacity = Schema.Struct({
  hosts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      jobs_roots: Schema.optionalKey(Schema.Array(Schema.String)),
      paths: Schema.optionalKey(Schema.Record(Schema.String, CapacityPath)),
    }),
  ),
  library: Schema.optionalKey(Schema.Struct({ host: Schema.String, path: Schema.String })),
  backup: Schema.optionalKey(Schema.Struct({ host: Schema.String, path: Schema.String })),
});
const decodeCapacity = Schema.decodeUnknownEffect(Schema.fromJsonString(Capacity));

export interface CapacityLayout {
  readonly reserves: readonly StorageReserve[];
  /** Installed runtimes the configuration names (a path that is not a work, library or backup location). */
  readonly runtimes: ReadonlyArray<{ readonly key: string; readonly path: string }>;
  readonly jobRoots: readonly string[];
  readonly source: string | null;
  readonly notices: readonly string[];
}
export const emptyLayout: CapacityLayout = {
  reserves: [],
  runtimes: [],
  jobRoots: [],
  source: null,
  notices: [],
};

/**
 * The reserves and locations the capacity configuration declares for this computer, found by its
 * host name. A computer the file does not name, or a file that cannot be read, declares none.
 */
export const readCapacityLayout = Effect.fn("StorageLifecycle.capacity")(function* (
  config: WorkenvConfig | null,
  hostname: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = config?.capacity_config;
  if (!file) return emptyLayout;
  const parsed = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeCapacity), Effect.result);
  if (parsed._tag === "Failure")
    return {
      ...emptyLayout,
      notices: [`The capacity configuration could not be read: ${messageOf(parsed.failure)}`],
    };
  const local = hostname.split(".")[0]!.toLowerCase();
  const host = parsed.success.hosts.find((entry) => entry.name.toLowerCase() === local);
  if (!host)
    return { ...emptyLayout, notices: [`The capacity configuration does not name ${hostname}.`] };
  const libraryKey =
    parsed.success.library?.host.toLowerCase() === local ? parsed.success.library.path : null;
  const backupKey =
    parsed.success.backup?.host.toLowerCase() === local ? parsed.success.backup.path : null;
  const reserves: StorageReserve[] = [];
  const runtimes: Array<{ key: string; path: string }> = [];
  for (const [key, entry] of Object.entries(host.paths ?? {})) {
    if (!entry.path) continue;
    const role =
      key === "jobs"
        ? "agent-work"
        : key === libraryKey || key.startsWith("library")
          ? "library"
          : key === backupKey || key.startsWith("backup")
            ? "backup"
            : "other";
    if (role === "other" && /runtime/i.test(key)) runtimes.push({ key, path: entry.path });
    reserves.push({ path: entry.path, role, bytes: entry.reserve_bytes ?? null });
  }
  return {
    reserves,
    runtimes,
    jobRoots: host.jobs_roots ?? [],
    source: "the capacity configuration of the lifecycle tool",
    notices: [],
  } satisfies CapacityLayout;
});

const BackupSection = Schema.Struct({
  repository: Schema.optionalKey(Schema.String),
  repository_path: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  retention: Schema.optionalKey(Schema.String),
  receipt: Schema.optionalKey(Schema.Struct({ latest: Schema.optionalKey(Schema.String) })),
});
const Qualified = Schema.Struct({
  library: Schema.optionalKey(Schema.Struct({ physical_id: Schema.optionalKey(Schema.String) })),
  backup: Schema.optionalKey(
    Schema.Struct({
      path: Schema.optionalKey(Schema.String),
      physical_id: Schema.optionalKey(Schema.String),
      ssh_host: Schema.optionalKey(Schema.String),
    }),
  ),
});
const InterfaceBackups = Schema.Struct({
  library: Schema.optionalKey(Schema.Struct({ root: Schema.optionalKey(Schema.String) })),
  backup: Schema.optionalKey(BackupSection),
  additional_backups: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        backup: Schema.optionalKey(BackupSection),
        qualified_storage: Schema.optionalKey(Qualified),
      }),
    ),
  ),
});
const decodeInterfaceBackups = Schema.decodeUnknownEffect(Schema.fromJsonString(InterfaceBackups));

export interface BackupRepository {
  readonly id: string;
  /** The repository as the interface states it: a local path or `sftp:<alias>:<path>`. */
  readonly repository: string;
  readonly description: string | null;
  /** Set when the repository is a local path (not reached over sftp). */
  readonly localPath: string | null;
  readonly sshHost: string | null;
  readonly remotePath: string | null;
  readonly latestReceipt: string | null;
  readonly scope: readonly string[];
  readonly retention: string | null;
  /** Physical identity of the disk the repository was qualified on, when the interface records it. */
  readonly physicalId: string | null;
  readonly libraryPhysicalId: string | null;
}

/** `<repository> (<description>)` or `<repository> <description>`; the repository is the first word. */
function splitRepository(text: string) {
  const space = text.indexOf(" ");
  return space < 0
    ? { repository: text, description: null }
    : {
        repository: text.slice(0, space),
        description:
          text
            .slice(space + 1)
            .trim()
            .replace(/^\((.*)\)$/, "$1") || null,
      };
}

function repositoryOf(
  id: string,
  section: typeof BackupSection.Type | undefined,
  qualified: typeof Qualified.Type | undefined,
): BackupRepository | null {
  const stated = section?.repository_path ?? section?.repository;
  if (!stated) return null;
  const { repository, description } = splitRepository(section?.repository ?? stated);
  const spec = section?.repository_path ?? repository;
  const sftp = /^sftp:([^:]+):(.+)$/.exec(spec);
  return {
    id,
    repository: spec,
    description,
    localPath: sftp ? null : spec,
    sshHost: sftp?.[1] ?? qualified?.backup?.ssh_host ?? null,
    remotePath: sftp?.[2] ?? null,
    latestReceipt: section?.receipt?.latest ?? null,
    scope: section?.scope ?? [],
    retention: section?.retention ?? null,
    physicalId: qualified?.backup?.physical_id ?? null,
    libraryPhysicalId: qualified?.library?.physical_id ?? null,
  };
}

/** Every backup repository the library interface describes, the library's own first. */
export const readBackupRepositories = Effect.fn("StorageLifecycle.backups")(function* (
  config: WorkenvConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = config.keep.interface_path;
  if (!file)
    return {
      repositories: [] as BackupRepository[],
      error: "The library interface is not configured.",
    };
  const read = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeInterfaceBackups), Effect.result);
  if (read._tag === "Failure")
    return {
      repositories: [] as BackupRepository[],
      error: `The library interface cannot be read on this computer: ${messageOf(read.failure)}`,
    };
  const interfaceFile = read.success;
  const repositories = [
    repositoryOf("library", interfaceFile.backup, undefined),
    ...Object.entries(interfaceFile.additional_backups ?? {}).map(([id, entry]) =>
      repositoryOf(id, entry.backup, entry.qualified_storage),
    ),
  ].flatMap((repository) => (repository ? [repository] : []));
  return { repositories, error: null as string | null };
});

const BackupItem = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  bytes: Schema.optionalKey(Schema.Number),
  files: Schema.optionalKey(Schema.Number),
});
const LatestBackup = Schema.Struct({
  snapshot_id: Schema.String,
  confirmed_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  backup_finished: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  items: Schema.optionalKey(Schema.Array(BackupItem)),
  /** Optional: the repository's occupied bytes, when the backup tool records them. */
  repository_bytes: Schema.optionalKey(Schema.Number),
  repository_bytes_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
});
const decodeLatestBackup = Schema.decodeUnknownEffect(Schema.fromJsonString(LatestBackup));

export interface LatestBackup {
  readonly snapshotId: string;
  readonly confirmedAt: number | null;
  /** Library paths the latest backup confirmed, with the bytes each holds. */
  readonly confirmed: ReadonlyMap<string, number | null>;
  readonly itemCount: number;
  readonly repositoryBytes: number | null;
  readonly repositoryBytesAt: number | null;
}
const timeOf = (value: string | number | undefined) =>
  typeof value === "number" ? value * 1000 : value === undefined ? null : parseTime(value);

export const readLatestBackup = Effect.fn("StorageLifecycle.latestBackup")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeLatestBackup), Effect.option);
  if (Option.isNone(read)) return null;
  const items = read.value.items ?? [];
  return {
    snapshotId: read.value.snapshot_id,
    confirmedAt: timeOf(read.value.confirmed_at) ?? timeOf(read.value.backup_finished),
    confirmed: new Map(
      items
        .filter((item) => item.status === "confirmed")
        .map((item) => [item.path, item.bytes ?? null]),
    ),
    itemCount: items.length,
    repositoryBytes: read.value.repository_bytes ?? null,
    repositoryBytesAt: timeOf(read.value.repository_bytes_at),
  } satisfies LatestBackup;
});

/** The newest retention plan's `--keep-*` options as a sentence, or null when none can be read. */
export const readRetentionPolicy = Effect.fn("StorageLifecycle.retention")(function* (
  latestReceipt: string,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const directory = path.join(path.dirname(latestReceipt), "retention");
  const names = (yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => [] as string[])))
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  const newest = names.at(-1);
  if (!newest) return null;
  const plan = yield* fs
    .readFileString(path.join(directory, newest))
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ policy: Schema.optionalKey(Schema.Array(Schema.String)) }),
          ),
        ),
      ),
      Effect.option,
    );
  if (Option.isNone(plan)) return null;
  const policy = plan.value.policy ?? [];
  const kept = policy.flatMap((word, position) => {
    const found = /^--keep-(\w+)$/.exec(word);
    const count = policy[position + 1];
    return found && count && /^\d+$/.test(count) ? [`${count} ${found[1]}`] : [];
  });
  return kept.length ? `Keeps ${kept.join(", ")} snapshots` : null;
});

const SharedLocationConfig = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  policy: Schema.String,
  note: Schema.optionalKey(Schema.String),
  cap_bytes: Schema.optionalKey(Schema.Number),
  build_cache_cap_bytes: Schema.optionalKey(Schema.Number),
  age_days: Schema.optionalKey(Schema.Number),
  container_age_days: Schema.optionalKey(Schema.Number),
  image_age_days: Schema.optionalKey(Schema.Number),
});
const decodeJobsConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ shared_locations: Schema.optionalKey(Schema.Array(SharedLocationConfig)) }),
  ),
);
export type SharedLocation = typeof SharedLocationConfig.Type;

/**
 * Folders outside every job that the lifecycle tool keeps an eye on (container storage, package
 * stores, caches, installed toolchains), with the policy it applies to each, from the `shared_locations`
 * of the jobs configuration next to `keep.json`. Without the file there are none.
 */
export const readSharedLocations = Effect.fn("StorageLifecycle.shared")(function* (
  platform: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const file = path.join(
    yield* workenvHome(),
    ".config",
    "workenv",
    platform === "win32" ? "windows-jobs.json" : "linux-jobs.json",
  );
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeJobsConfig),
    Effect.map((config) => config.shared_locations ?? []),
    Effect.orElseSucceed(() => [] as readonly SharedLocation[]),
  );
});

const GiB = 2 ** 30;
const gib = (bytes: number) => `${Math.round((bytes / GiB) * 10) / 10} GiB`;
/** What the lifecycle tool does to a shared location, in a sentence. */
export function sharedProtection(location: SharedLocation): string {
  switch (location.policy) {
    case "report":
      return `Measured only, never removed automatically${location.note ? `: ${location.note}` : ""}`;
    case "cache":
      return `Regenerable cache; its oldest entries are removed above ${
        location.cap_bytes === undefined ? "its cap" : gib(location.cap_bytes)
      }`;
    case "temp":
      return `Temporary files; entries untouched for ${location.age_days ?? "several"} days are removed`;
    case "docker":
      return `Container storage; build cache is capped${
        location.build_cache_cap_bytes === undefined
          ? ""
          : ` at ${gib(location.build_cache_cap_bytes)}`
      }, unused images and finished containers older than ${location.image_age_days ?? "a set number of"} days are removed, volumes never`;
    case "pnpm":
      return "Package store; pruned only when no install is running";
    default:
      return `Lifecycle policy: ${location.policy}`;
  }
}
