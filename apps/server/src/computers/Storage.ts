// @effect-diagnostics nodeBuiltinImport:off effectFnOpportunity:off
import * as NodeCrypto from "node:crypto";
import {
  StorageSize,
  type StorageDetail,
  type StorageDisks,
  type StorageEntry,
  type StorageGroupId,
  type StorageHoldings,
  type StorageRam,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ProcessRunner from "../processRunner.ts";
import { chooseBundles, type ArchiveSource } from "./Archive.ts";
import { writeJson } from "./ComputerStore.ts";
import {
  buildHoldings,
  ENTRIES_SENT,
  locate,
  normalize,
  type ArchiveInfo,
  type BackupInfo,
  type RetainedSource,
  type WorkspaceSource,
} from "./StorageHoldings.ts";
import {
  emptyLayout,
  newLifecycleCache,
  readBackupRepositories,
  readCapacityLayout,
  readLatestBackup,
  readLifecycle,
  readRetentionPolicy,
  readSharedLocations,
  sharedProtection,
  type CapacityLayout,
} from "./StorageLifecycle.ts";
import {
  readDiskInventory,
  type DiskReading,
  type FsUsage,
  type MountRecord,
  type StorageSettings,
} from "./StorageDisks.ts";
import {
  DEFAULT_TREE_BUDGET,
  measureTree,
  sizeOfTree,
  UNMEASURED,
  type TreeBudget,
} from "./StorageMeasure.ts";
import { backupEvidence, type BackupVerification } from "./WorkenvBackup.ts";
import { messageOf, parseTime, type WorkenvConfig } from "./WorkenvConfig.ts";
import { isWithin } from "./paths.ts";

/**
 * The storage views of one computer: its real disks, and what is kept on them. Everything a request
 * answers comes from caches. Folder sizes are measured by one background worker, one folder at a
 * time and within a budget, only after a client asked for the inventory; a size is shown with when
 * it was measured and is unknown until then. Nothing here deletes, moves or changes anything.
 */

const DISKS_TTL_MS = 30_000;
const HOLDINGS_TTL_MS = 5_000;
const SHELLS_TTL_MS = 30_000;
const RAM_TTL_MS = 60_000;
const FORCED_MAX_AGE_MS = 2 * 60_000;
const PERSIST_EVERY = 25;
const RAM_TREE_BUDGET: TreeBudget = { entries: 20_000, deadlineMs: 2_000 };
const ACTIVE_SIZE_TTL_MS = 5 * 60_000;
const IDLE_SIZE_TTL_MS = 6 * 60 * 60_000;
const RETAINED_SIZE_TTL_MS = 24 * 60 * 60_000;
const ALIAS_TTL_MS = 10 * 60_000;
/** Permanent sources and datasets can be huge: a small budget gives "at least", not a long scan. */
const RETAINED_TREE_BUDGET: TreeBudget = { entries: 100_000, deadlineMs: 10_000 };
const SIZES_KEPT = 4_000;
const FOLDERS_LISTED = 5_000;
const DETAIL_DEADLINE_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ThreadInfo {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly archived: boolean;
  readonly running: boolean;
  readonly updatedAt: number | null;
  readonly ownerId: string | null;
  readonly ownerElsewhere: boolean;
  readonly workerIds: readonly string[];
}
export interface ShellInfo {
  readonly projects: ReadonlyArray<{ id: string; title: string; workspaceRoot: string }>;
  readonly threads: readonly ThreadInfo[];
}

export interface StorageDeps {
  /** The computers state folder: measurements are kept in it between runs. */
  readonly directory: string;
  readonly workenv: Effect.Effect<{ config: WorkenvConfig | null; error: string | null }>;
  readonly workenvJobs: (
    config: WorkenvConfig,
  ) => Effect.Effect<ReadonlyArray<{ root: string; project: string; status: string }>>;
  readonly archive: (
    config: WorkenvConfig,
  ) => Effect.Effect<{ sources: readonly ArchiveSource[]; problem: string | null }>;
  readonly verified: () => ReadonlyMap<string, BackupVerification>;
  readonly sessions: Effect.Effect<ReadonlyArray<{ threadId: string; root: string }>>;
  readonly shells: Effect.Effect<ShellInfo>;
  readonly agentWorkRoot: Effect.Effect<string | null>;
}

const PersistedSizes = Schema.Struct({
  version: Schema.Literal(1),
  sizes: Schema.Record(Schema.String, StorageSize),
});
const decodeSizes = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedSizes));

const MEMORY = new Set(["tmpfs", "ramfs"]);
const shortHost = (value: string) => value.split(".")[0] ?? value;

export const makeStorage = Effect.fn("Storage.make")(function* (deps: StorageDeps) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcess.Platform,
    host = shortHost(yield* HostProcess.Hostname),
    scope = yield* Scope.Scope;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();
  const sizesFile = path.join(deps.directory, "storage-sizes.json");

  const sizes = new Map<string, StorageSize>();
  let sizesVersion = 0;
  yield* fs.readFileString(sizesFile).pipe(
    Effect.flatMap(decodeSizes),
    Effect.tap((saved) =>
      Effect.sync(() => {
        for (const [key, size] of Object.entries(saved.sizes)) sizes.set(key, size);
        sizesVersion++;
      }),
    ),
    // No saved measurements, or an unreadable file: everything is simply measured again.
    Effect.ignore,
  );
  const queue = new Map<string, TreeBudget>();
  let worker: Fiber.Fiber<void> | null = null;
  let paused = false;
  const stale = (key: string, maxAge: number, now: number) => {
    const known = sizes.get(key);
    return !known || known.measuredAt === null || now - known.measuredAt > maxAge;
  };
  const persist = Effect.gen(function* () {
    const newest = [...sizes]
      .toSorted((a, b) => (b[1].measuredAt ?? 0) - (a[1].measuredAt ?? 0))
      .slice(0, SIZES_KEPT);
    yield* writeJson(sizesFile, { version: 1, sizes: Object.fromEntries(newest) }).pipe(
      Effect.ignore,
    );
  });
  const measureQueue = Effect.gen(function* () {
    let measured = 0;
    for (;;) {
      if (paused || queue.size === 0) break;
      const [target, budget] = queue.entries().next().value!;
      queue.delete(target);
      const tree = yield* Effect.promise((signal) => measureTree(target, budget, signal));
      sizes.set(target, sizeOfTree(tree, yield* Clock.currentTimeMillis));
      sizesVersion++;
      // A long first pass keeps what it has measured so far, so a restart does not start over.
      if (++measured % PERSIST_EVERY === 0) yield* persist;
      // Pace the scan: the user's own work comes first.
      yield* Effect.sleep("40 millis");
    }
    yield* persist;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        worker = null;
      }),
    ),
    Effect.provideContext(context),
  );
  const schedule = Effect.fn("Storage.schedule")(function* (
    targets: ReadonlyArray<{ path: string; maxAgeMs: number; budget: TreeBudget }>,
    force: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    // Asking for a refresh skips the long waits but not the sense: a size measured a moment ago stands.
    for (const target of targets)
      if (
        stale(
          target.path,
          force ? Math.min(target.maxAgeMs, FORCED_MAX_AGE_MS) : target.maxAgeMs,
          now,
        )
      )
        queue.set(target.path, target.budget);
    if (queue.size && worker === null && !paused)
      worker = yield* Effect.forkIn(measureQueue, scope);
  });
  const settled = Effect.suspend(() =>
    worker ? Fiber.await(worker).pipe(Effect.asVoid) : Effect.void,
  );

  let diskCache: {
    at: number;
    reading: DiskReading;
    layout: CapacityLayout;
    config: WorkenvConfig | null;
  } | null = null;
  const readDisks = Effect.fn("Storage.disks")(function* (refresh: boolean) {
    const now = yield* Clock.currentTimeMillis;
    if (diskCache && !refresh && now - diskCache.at < DISKS_TTL_MS) return diskCache;
    const { config } = yield* deps.workenv;
    const layout = yield* readCapacityLayout(config, host);
    const work = yield* deps.agentWorkRoot;
    const settings: StorageSettings = {
      reserves: layout.reserves,
      reserveSource: layout.source,
      workRoots: [work, config?.jobs_root, ...layout.jobRoots].filter((root): root is string =>
        Boolean(root),
      ),
      notices: layout.notices,
    };
    const reading = yield* readDiskInventory(settings);
    diskCache = { at: now, reading, layout, config };
    return diskCache;
  });

  let shellCache: { at: number; value: ShellInfo } | null = null;
  /** Every thread is read at most every `SHELLS_TTL_MS`, however many clients poll. */
  const shellSnapshot = Effect.fn("Storage.shells")(function* (now: number) {
    if (shellCache && now - shellCache.at < SHELLS_TTL_MS) return shellCache.value;
    const value = yield* deps.shells;
    shellCache = { at: now, value };
    return value;
  });
  const lifecycleCache = newLifecycleCache();
  let holdingsCache: { at: number; version: number; value: StorageHoldings } | null = null;
  /** What the last build listed, so a detail request can find an entry's folder again. */
  let known = new Map<string, { path: string; kind: StorageEntry["group"] }>();

  const memoryMounts = (mounts: readonly MountRecord[], usage: ReadonlyMap<string, FsUsage>) =>
    mounts
      .filter((mount) => MEMORY.has(mount.fstype))
      .map((mount) => ({
        path: mount.target,
        usedBytes: usage.get(mount.target)?.usedBytes ?? null,
        limitBytes: usage.get(mount.target)?.capacityBytes ?? null,
      }));

  interface RamProbe {
    readonly path: string;
    /** Where a link into memory ends; null for a mount of its own, whose usage is the mount's. */
    readonly real: string | null;
    readonly mountUsed: number | null;
    readonly limitBytes: number | null;
  }
  const ramProbes = new Map<string, { at: number; probes: readonly RamProbe[] }>();
  /**
   * RAM-backed paths under a job folder: tmpfs mounts inside it, and top-level links from it into
   * memory. Looking is a directory read and a few link reads, kept for `RAM_TTL_MS`; sizes of
   * linked folders come from the background measurer.
   */
  const probeRam = Effect.fn("Storage.ram")(function* (
    root: string,
    memory: ReturnType<typeof memoryMounts>,
    now: number,
  ) {
    const known = ramProbes.get(root);
    if (known && now - known.at < RAM_TTL_MS) return known.probes;
    const probes: RamProbe[] = memory
      .filter((mount) => mount.path !== root && isWithin(platform, root, mount.path))
      .map((mount) => ({
        path: mount.path,
        real: null,
        mountUsed: mount.usedBytes,
        limitBytes: mount.limitBytes,
      }));
    if (memory.length) {
      const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const name of names.slice(0, 64)) {
        const child = path.join(root, name);
        if (Option.isNone(yield* fs.readLink(child).pipe(Effect.option))) continue;
        const real = yield* fs.realPath(child).pipe(Effect.option);
        if (Option.isNone(real)) continue;
        const backing = memory
          .filter((mount) => isWithin(platform, mount.path, real.value))
          .toSorted((a, b) => b.path.length - a.path.length)[0];
        if (backing && !probes.some((probe) => probe.path === child))
          probes.push({
            path: child,
            real: real.value,
            mountUsed: null,
            limitBytes: backing.limitBytes,
          });
      }
    }
    ramProbes.set(root, { at: now, probes });
    return probes;
  });
  const ramOf = (probes: readonly RamProbe[], now: number): StorageRam[] =>
    probes.map((probe) => {
      const measured = probe.real ? sizes.get(probe.real) : undefined;
      return {
        path: probe.path,
        usedBytes: probe.real ? (measured?.bytes ?? null) : probe.mountUsed,
        limitBytes: probe.limitBytes,
        measuredAt: probe.real ? (measured?.measuredAt ?? null) : now,
      };
    });

  const threadSource = (
    root: string,
    threadId: string | null,
    shell: ShellInfo,
    threads: ReadonlyMap<string, ThreadInfo>,
  ): Partial<WorkspaceSource> => {
    const thread = threadId ? threads.get(threadId) : undefined;
    if (!thread) return {};
    const project = shell.projects.find((entry) => entry.id === thread.projectId)?.title ?? null;
    const titleOf = (id: string) => threads.get(id)?.title ?? null;
    return {
      threadId: thread.id,
      title: thread.title,
      session: thread.title,
      project,
      master: thread.ownerId
        ? (titleOf(thread.ownerId) ?? "a session on another computer")
        : thread.ownerElsewhere
          ? "a session on another computer"
          : null,
      workers: thread.workerIds.flatMap((id) => titleOf(id) ?? []).slice(0, 12),
      threadState: thread.archived ? "archived" : thread.running ? "running" : "idle",
      threadUpdatedAt: thread.updatedAt,
    };
  };

  // The computer an ssh alias names, from the local ssh configuration only (`ssh -G` connects to nothing).
  const runner = yield* ProcessRunner.ProcessRunner;
  const aliases = new Map<string, { at: number; label: string }>();
  const hostLabels = Effect.fn("Storage.hosts")(function* (
    names: Iterable<string | null | undefined>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const alias of new Set([...names].flatMap((name) => (name ? [name] : [])))) {
      if (aliases.has(alias) && now - aliases.get(alias)!.at < ALIAS_TTL_MS) continue;
      const result = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)
        ? yield* runner
            .run({
              command: "ssh",
              args: ["-G", alias],
              timeout: "5 seconds",
              maxOutputBytes: 65_536,
            })
            .pipe(Effect.option)
        : Option.none();
      const address =
        Option.isSome(result) && result.value.code === 0
          ? /^hostname (\S+)$/m.exec(result.value.stdout)?.[1]
          : undefined;
      aliases.set(alias, {
        at: now,
        label: address && address !== alias ? `${alias} (${address})` : alias,
      });
    }
    return (name: string | null | undefined) => (name ? (aliases.get(name)?.label ?? name) : null);
  });

  const archiveInfos = (
    sources: readonly ArchiveSource[],
    config: WorkenvConfig,
    label: (name: string | null | undefined) => string | null,
  ): ArchiveInfo[] => {
    const verified = deps.verified();
    return [...chooseBundles(sources).values()].map((source): ArchiveInfo => {
      const { receipt } = source;
      const evidence = backupEvidence(receipt, verified.get(receipt.id ?? ""));
      const sameLibrary = receipt.library_id === config.keep.library_id;
      const local = sameLibrary ? config.keep.writer_local === true : false;
      const members = source.members;
      const bytes = members.every(([, size]) => size !== null)
        ? members.reduce((sum, [, size]) => sum + (size ?? 0), 0)
        : null;
      return {
        id: receipt.id!,
        title: receipt.reason,
        project: receipt.project,
        collection: receipt.collection ?? null,
        source: receipt.source,
        createdAt: receipt.published_at
          ? receipt.published_at * 1000
          : parseTime(receipt.created_at),
        files: members.length,
        logicalBytes: bytes,
        writerPath: receipt.writer_path!,
        local,
        host: sameLibrary
          ? config.keep.writer_local
            ? host
            : label(config.keep.ssh_host)
          : label(receipt.library_ssh ?? receipt.origin?.host),
        backup: evidence ? "confirmed" : "published",
        backupVerifiedAt: evidence?.at ?? null,
        backupSnapshot: evidence?.proof.snapshot_id.slice(0, 8) ?? null,
        backupRequired:
          receipt.backup_required ??
          config.projects[receipt.project]?.keep?.backup_required ??
          null,
      };
    });
  };

  const backupInfos = Effect.fn("Storage.backups")(function* (
    config: WorkenvConfig,
    libraryPaths: ReadonlySet<string>,
    label: (name: string | null | undefined) => string | null,
  ) {
    const found = yield* readBackupRepositories(config);
    const infos: BackupInfo[] = [];
    for (const repository of found.repositories) {
      const latest = repository.latestReceipt
        ? yield* readLatestBackup(repository.latestReceipt)
        : null;
      const retention =
        repository.retention ??
        (repository.latestReceipt ? yield* readRetentionPolicy(repository.latestReceipt) : null);
      infos.push({
        id: repository.id,
        repository: repository.repository,
        description: repository.description,
        localPath: repository.localPath,
        host: label(repository.sshHost),
        scope: repository.scope,
        retention,
        physicalId: repository.physicalId,
        libraryPhysicalId: repository.libraryPhysicalId,
        latest: latest
          ? {
              snapshotId: latest.snapshotId,
              confirmedAt: latest.confirmedAt,
              confirmedPaths: new Set(latest.confirmed.keys()),
              repositoryBytes: latest.repositoryBytes,
              repositoryBytesAt: latest.repositoryBytesAt,
            }
          : null,
        problem: latest
          ? null
          : repository.latestReceipt
            ? `The latest backup receipt (${repository.latestReceipt}) is not readable on this computer.`
            : "This repository records no receipt path.",
      });
    }
    void libraryPaths;
    return { infos, error: found.error };
  });

  /**
   * A holdings answer carries the first `limit` entries of the groups asked for; the others keep
   * their totals and send none. `shown` says how many entries each group would send.
   */
  const only = (
    value: StorageHoldings,
    groups: readonly StorageGroupId[] | undefined,
    limit: number,
  ) => ({
    ...value,
    groups: value.groups.map((group) => ({
      ...group,
      shown: Math.min(group.entries.length, limit),
      entries: !groups || groups.includes(group.group) ? group.entries.slice(0, limit) : [],
    })),
  });

  const holdings = Effect.fn("Storage.holdings")(function* (
    refresh: boolean,
    groups?: readonly StorageGroupId[],
    limit: number = ENTRIES_SENT,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (
      holdingsCache &&
      !refresh &&
      holdingsCache.version === sizesVersion &&
      now - holdingsCache.at < HOLDINGS_TTL_MS
    )
      return only(holdingsCache.value, groups, limit);
    const { config } = yield* deps.workenv;
    const inventory = yield* readDisks(false).pipe(Effect.result);
    const disks = inventory._tag === "Success" ? inventory.success : null;
    const layout = disks?.layout ?? emptyLayout;
    const notices: string[] = [];
    if (inventory._tag === "Failure")
      notices.push(
        `Disks could not be read, so locations are not matched to them: ${messageOf(inventory.failure)}`,
      );
    const shell = yield* shellSnapshot(now);
    const threads = new Map(shell.threads.map((thread) => [thread.id, thread]));
    const work = yield* deps.agentWorkRoot;

    // Work folders: T3's own session records, the lifecycle tool's job records, and whatever sits
    // in the job roots without either.
    const sources = new Map<string, WorkspaceSource>();
    const key = (root: string) => normalize(platform, root);
    const merge = (root: string, partial: Partial<WorkspaceSource>) => {
      const id = key(root);
      const previous = sources.get(id);
      const next: WorkspaceSource = {
        root,
        threadId: null,
        title: null,
        project: null,
        master: null,
        workers: [],
        session: null,
        threadState: null,
        threadUpdatedAt: null,
        jobStatus: null,
        modifiedAt: null,
        ...previous,
      };
      const defined = Object.fromEntries(
        Object.entries(partial).filter(([, value]) => value !== null && value !== undefined),
      );
      sources.set(id, { ...next, ...defined, root });
    };
    const missing: string[] = [];
    for (const session of yield* deps.sessions) {
      if (!(yield* fs.exists(session.root).pipe(Effect.orElseSucceed(() => false)))) {
        missing.push(session.root);
        continue;
      }
      merge(session.root, threadSource(session.root, session.threadId, shell, threads));
    }
    if (missing.length)
      notices.push(
        `${missing.length} session workspace record${missing.length === 1 ? " points" : "s point"} at folders that no longer exist.`,
      );
    if (config)
      for (const job of yield* deps.workenvJobs(config))
        merge(job.root, { project: job.project, jobStatus: job.status });
    const roots = [
      ...new Set(
        [
          work,
          config?.jobs_root,
          ...Object.values(config?.projects ?? {}).map((project) => project.jobs_root),
          ...layout.jobRoots,
        ].flatMap((root) => (root ? [root] : [])),
      ),
    ];
    for (const root of roots) {
      const names = (yield* fs
        .readDirectory(root)
        .pipe(Effect.orElseSucceed(() => [] as string[]))).slice(0, FOLDERS_LISTED);
      yield* Effect.forEach(
        names,
        (name) =>
          Effect.gen(function* () {
            const folder = path.join(root, name);
            const info = yield* fs.stat(folder).pipe(Effect.option);
            if (Option.isNone(info) || info.value.type !== "Directory") return;
            merge(folder, {
              modifiedAt: Option.getOrNull(Option.map(info.value.mtime, (date) => date.getTime())),
              ...(UUID.test(name) && !sources.has(key(folder))
                ? threadSource(folder, name.toLowerCase(), shell, threads)
                : {}),
            });
          }),
        { concurrency: 16, discard: true },
      );
    }
    // The folder's own mtime is only a fallback, so fill it for folders found another way.
    const memory = disks ? memoryMounts(disks.reading.mounts, disks.reading.usage) : [];
    const ramByRoot = new Map<string, readonly StorageRam[]>();
    const ramTargets = new Map<string, TreeBudget>();
    yield* Effect.forEach(
      [...sources.values()],
      (source) =>
        probeRam(source.root, memory, now).pipe(
          Effect.tap((probes) =>
            Effect.sync(() => {
              if (!probes.length) return;
              ramByRoot.set(key(source.root), ramOf(probes, now));
              for (const probe of probes)
                if (probe.real) ramTargets.set(probe.real, RAM_TREE_BUDGET);
            }),
          ),
          Effect.ignore,
        ),
      { concurrency: 8, discard: true },
    );

    const lifecycleAvailable =
      config !== null &&
      (yield* fs.exists(path.join(config.state, "expiry")).pipe(Effect.orElseSucceed(() => false)));
    const lifecycle = config ? yield* readLifecycle(config.state, lifecycleCache) : [];

    const archive = config ? yield* deps.archive(config) : { sources: [], problem: null };
    const label = yield* hostLabels(
      config
        ? [
            config.keep.ssh_host,
            ...archive.sources.map(
              (source) => source.receipt.library_ssh ?? source.receipt.origin?.host,
            ),
          ]
        : [],
    );
    const archives = config ? archiveInfos(archive.sources, config, label) : [];
    const libraryPaths = new Set(
      archives.filter((entry) => entry.local).map((entry) => entry.writerPath),
    );
    const backups = config
      ? yield* backupInfos(config, libraryPaths, label)
      : { infos: [] as BackupInfo[], error: null };

    const shared = config ? yield* readSharedLocations(platform) : [];
    const retained: RetainedSource[] = [
      ...shell.projects.map((project): RetainedSource => ({
        path: project.workspaceRoot,
        title: project.title,
        classification: "permanent-source",
        detail: "A project folder registered in T3; T3 does not delete it.",
      })),
      ...Object.entries(config?.projects ?? {}).map(([name, project]): RetainedSource => ({
        path: project.source,
        title: name,
        classification: project.mode === "directory" ? "original-data" : "permanent-source",
        detail: project.keep?.backup_required
          ? "Results kept from this project need an independent backup."
          : null,
      })),
      ...shared.map((location): RetainedSource => ({
        path: location.path,
        title: location.name,
        classification: "shared-tooling",
        detail: null,
        protection: sharedProtection(location),
      })),
      ...layout.runtimes.map((runtime): RetainedSource => ({
        path: runtime.path,
        title: runtime.key,
        classification: "project-runtime",
        detail: "An installed runtime named by the capacity configuration.",
      })),
    ];

    const value = buildHoldings({
      host,
      now,
      platform,
      disks: disks?.reading.disks ?? null,
      workspaces: [...sources.values()],
      lifecycle,
      lifecycleAvailable,
      jobRoots: roots,
      archives,
      archiveProblem: archive.problem,
      archiveSupported: config !== null,
      libraryPaths,
      backups: backups.infos,
      backupProblem: backups.error,
      backupSupported: config !== null,
      retained,
      retainedSupported: config !== null,
      sizes: (target) => sizes.get(target) ?? null,
      ram: (root) => ramByRoot.get(key(root)) ?? [],
      measuring: queue.size > 0 || worker !== null,
      notices,
    });

    // Measure what is local, newest work first: the queue is bounded by what the groups list.
    known = new Map(
      value.groups.flatMap((group) =>
        group.entries.flatMap((entry) =>
          entry.location ? [[entry.id, { path: entry.location, kind: entry.group }] as const] : [],
        ),
      ),
    );
    const targets = value.groups.flatMap((group) =>
      group.entries
        .filter((entry) => entry.local && entry.location)
        .filter(
          (entry) =>
            entry.group === "workspaces" ||
            entry.group === "other" ||
            (entry.group === "backups" && entry.size.basis !== "reported"),
        )
        .map((entry) => ({
          path: entry.location!,
          maxAgeMs:
            entry.group === "workspaces"
              ? entry.workspace?.state === "active"
                ? ACTIVE_SIZE_TTL_MS
                : IDLE_SIZE_TTL_MS
              : entry.group === "backups"
                ? IDLE_SIZE_TTL_MS
                : RETAINED_SIZE_TTL_MS,
          budget: entry.group === "other" ? RETAINED_TREE_BUDGET : DEFAULT_TREE_BUDGET,
        })),
    );
    // A repository that is only a remote location (sftp:...) has no folder to measure here.
    yield* schedule(
      [
        ...targets.filter((target) => path.isAbsolute(target.path)),
        ...[...ramTargets].map(([target, budget]) => ({
          path: target,
          maxAgeMs: ACTIVE_SIZE_TTL_MS,
          budget,
        })),
      ],
      refresh,
    );
    holdingsCache = {
      at: now,
      version: sizesVersion,
      value: { ...value, measuring: queue.size > 0 || worker !== null },
    };
    return only(holdingsCache.value, groups, limit);
  });

  const PARTS: ReadonlyArray<{
    key: StorageDetail["parts"][number]["key"];
    label: string;
    names: readonly string[];
  }> = [
    { key: "source", label: "Source", names: ["repo"] },
    { key: "tmp", label: "Temporary files", names: ["tmp"] },
    { key: "dependencies", label: "Dependencies and caches", names: ["cache", "downloads"] },
    { key: "builds", label: "Builds", names: ["build"] },
    { key: "outputs", label: "Outputs and evidence", names: ["outputs", "evidence"] },
    { key: "inputs", label: "Inputs", names: ["inputs"] },
  ];

  const detail = Effect.fn("Storage.detail")(function* (id: string) {
    const entry = known.get(id);
    if (!entry) return null;
    const now = yield* Clock.currentTimeMillis;
    const deadline = now + DETAIL_DEADLINE_MS;
    const measure = Effect.fn("Computers.measure")(function* (
      target: string,
      budget = DEFAULT_TREE_BUDGET,
    ) {
      const cached = sizes.get(target);
      const at = yield* Clock.currentTimeMillis;
      if (cached && cached.measuredAt !== null && at - cached.measuredAt < ACTIVE_SIZE_TTL_MS)
        return cached;
      const left = deadline - at;
      if (left <= 500) return UNMEASURED;
      const tree = yield* Effect.promise((signal) =>
        measureTree(
          target,
          { entries: budget.entries, deadlineMs: Math.min(left, budget.deadlineMs) },
          signal,
        ),
      );
      const size = sizeOfTree(tree, yield* Clock.currentTimeMillis);
      sizes.set(target, size);
      sizesVersion++;
      return size;
    });
    if (entry.kind === "workspaces") {
      const names = yield* fs
        .readDirectory(entry.path)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      const claimed = new Set(PARTS.flatMap((part) => part.names));
      const memory = (yield* readDisks(false).pipe(Effect.option)).pipe(
        Option.map((disks) => memoryMounts(disks.reading.mounts, disks.reading.usage)),
        Option.getOrElse(() => []),
      );
      const parts: StorageDetail["parts"][number][] = [];
      for (const part of PARTS) {
        const present = part.names.filter((name) => names.includes(name));
        if (!present.length) continue;
        const measured = yield* Effect.forEach(
          present,
          (name) => measure(path.join(entry.path, name)),
          {
            concurrency: 2,
          },
        );
        const known = measured.filter((size) => size.bytes !== null);
        parts.push({
          key: part.key,
          label: part.label,
          path: present.length === 1 ? path.join(entry.path, present[0]!) : null,
          size: known.length
            ? {
                bytes: known.reduce((sum, size) => sum + (size.bytes ?? 0), 0),
                complete: measured.every((size) => size.complete && size.bytes !== null),
                measuredAt: Math.min(...known.map((size) => size.measuredAt ?? now)),
                basis: known[0]!.basis,
                sharedBytes: known.reduce((sum, size) => sum + (size.sharedBytes ?? 0), 0),
              }
            : UNMEASURED,
        });
      }
      const rest = names.filter((name) => !claimed.has(name) && !name.startsWith("."));
      if (rest.length) {
        const measured = yield* Effect.forEach(
          rest.slice(0, 24),
          (name) => measure(path.join(entry.path, name)),
          {
            concurrency: 2,
          },
        );
        const known = measured.filter((size) => size.bytes !== null);
        parts.push({
          key: "other",
          label: "Everything else",
          path: null,
          size: known.length
            ? {
                bytes: known.reduce((sum, size) => sum + (size.bytes ?? 0), 0),
                complete:
                  rest.length <= 24 &&
                  measured.every((size) => size.complete && size.bytes !== null),
                measuredAt: Math.min(...known.map((size) => size.measuredAt ?? now)),
                basis: known[0]!.basis,
              }
            : UNMEASURED,
        });
      }
      // RAM-backed paths of this job, with their own usage and limit, never part of the disk bytes.
      for (const ram of ramOf(yield* probeRam(entry.path, memory, now), now))
        parts.push({
          key: "tmp",
          label: `RAM: ${path.basename(ram.path)}`,
          path: ram.path,
          ram: true,
          size: {
            bytes: ram.usedBytes,
            complete: ram.usedBytes !== null,
            measuredAt: ram.measuredAt,
            basis: ram.usedBytes === null ? "unavailable" : "allocated",
          },
        });
      holdingsCache = null;
      return {
        id,
        sampledAt: now,
        parts,
        notes: [
          "Source includes any dependencies installed inside the repository folder.",
          ...(parts.some((part) => part.ram)
            ? ["RAM-backed paths use memory, not disk space, and are not part of the disk total."]
            : []),
        ],
      } satisfies StorageDetail;
    }
    if (entry.kind === "archives") {
      const size = yield* measure(entry.path);
      return {
        id,
        sampledAt: now,
        parts: [{ key: "other", label: "Occupied on this disk", path: entry.path, size }],
        notes: [
          "Files shared with other bundles are counted once here; the bundle's recorded size counts every file.",
        ],
      } satisfies StorageDetail;
    }
    return { id, sampledAt: now, parts: [], notes: [] } satisfies StorageDetail;
  });

  /** For tests and shutdown: stops measuring after the folder in progress. */
  const pause = Effect.sync(() => {
    paused = true;
  });

  return {
    disks: (refresh = false) => readDisks(refresh).pipe(Effect.map((cache) => cache.reading.disks)),
    holdings,
    detail,
    settled,
    pause,
  };
});

export type Storage = Effect.Success<ReturnType<typeof makeStorage>>;
export type StorageDisksResult = StorageDisks;
void NodeCrypto;
void locate;
