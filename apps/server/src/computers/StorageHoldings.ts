import type {
  StorageDisks,
  StorageEntry,
  StorageGroup,
  StorageGroupId,
  StorageHoldings,
  StorageRam,
  StorageSize,
  StorageWorkspaceState,
} from "@t3tools/contracts";
import { STORAGE_GROUPS } from "@t3tools/contracts";
import { UNMEASURED } from "./StorageMeasure.ts";
import { isWithin } from "./paths.ts";
import type { LifecycleRecord } from "./StorageLifecycle.ts";

/**
 * The four groups of kept data, assembled from what each source reported. Pure: everything this
 * needs has been read already, so each rule (what counts as local bytes, which state a job is in,
 * what is shared) is testable on recorded inputs. Nothing here measures a disk.
 */

/** Entries kept per group; a request sends the first `limit` of them (default `ENTRIES_SENT`). */
export const ENTRIES_KEPT = 5_000;
export const ENTRIES_SENT = 400;

export interface WorkspaceSource {
  /** Absolute folder of the whole job: source, temporary files, builds, caches, outputs, evidence. */
  readonly root: string;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly project: string | null;
  /** The session that directs this one, when it is a worker. */
  readonly master: string | null;
  /** Sessions this one directs, when it is a master. */
  readonly workers: readonly string[];
  readonly session: string | null;
  /** T3's own view of the owning session; null when T3 did not create this folder. */
  readonly threadState: "running" | "idle" | "archived" | null;
  readonly threadUpdatedAt: number | null;
  /** The lifecycle tool's `.workenv.json` status, when the folder carries one. */
  readonly jobStatus: string | null;
  readonly modifiedAt: number | null;
}

export interface ArchiveInfo {
  readonly id: string;
  readonly title: string;
  readonly project: string | null;
  readonly collection: string | null;
  /** The folder that was kept. */
  readonly source: string | null;
  readonly createdAt: number | null;
  readonly files: number | null;
  /** Sum of the recorded sizes; null when a member has none. */
  readonly logicalBytes: number | null;
  readonly writerPath: string;
  /** Whether the library that holds this bundle is on the computer reporting it. */
  readonly local: boolean;
  readonly host: string | null;
  readonly backup: "confirmed" | "published" | "not-verified";
  readonly backupVerifiedAt: number | null;
  readonly backupSnapshot: string | null;
  readonly backupRequired: boolean | null;
}

export interface BackupInfo {
  readonly id: string;
  readonly repository: string;
  readonly description: string | null;
  readonly localPath: string | null;
  readonly host: string | null;
  readonly scope: readonly string[];
  readonly retention: string | null;
  readonly physicalId: string | null;
  readonly libraryPhysicalId: string | null;
  /** The newest receipt; null when none could be read. */
  readonly latest: {
    readonly snapshotId: string;
    readonly confirmedAt: number | null;
    readonly confirmedPaths: ReadonlySet<string>;
    readonly repositoryBytes: number | null;
    readonly repositoryBytesAt: number | null;
  } | null;
  /** Why the receipt is unknown, when it is. */
  readonly problem: string | null;
}

export interface RetainedSource {
  readonly path: string;
  readonly title: string;
  readonly classification:
    | "permanent-source"
    | "original-data"
    | "project-runtime"
    | "shared-tooling";
  readonly detail: string | null;
  /** What the lifecycle tool does to it, when it says; otherwise derived from where it lives. */
  readonly protection?: string;
}

export interface HoldingsInput {
  readonly host: string;
  readonly now: number;
  readonly platform: NodeJS.Platform;
  readonly disks: StorageDisks | null;
  readonly workspaces: readonly WorkspaceSource[];
  readonly lifecycle: readonly LifecycleRecord[];
  readonly lifecycleAvailable: boolean;
  /** Roots that were listed for work folders; empty when no root is configured. */
  readonly jobRoots: readonly string[];
  readonly archives: readonly ArchiveInfo[];
  readonly archiveProblem: string | null;
  readonly archiveSupported: boolean;
  /** Library bundles the backup should cover (paths on the library). */
  readonly libraryPaths: ReadonlySet<string>;
  readonly backups: readonly BackupInfo[];
  readonly backupProblem: string | null;
  readonly backupSupported: boolean;
  readonly retained: readonly RetainedSource[];
  readonly retainedSupported: boolean;
  readonly sizes: (path: string) => StorageSize | null;
  readonly ram: (root: string) => readonly StorageRam[];
  readonly measuring: boolean;
  readonly notices: readonly string[];
  /** Entries kept per group (tests lower it); the default is `ENTRIES_KEPT`. */
  readonly keep?: number;
}

const SLASHES = /[\\/]+$/;
export const normalize = (platform: NodeJS.Platform, path: string) => {
  const trimmed = path.replace(SLASHES, "") || path.slice(0, 1);
  return platform === "win32" ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
};

/** The disk and volume under `path`, the most specific mount winning; remote mounts are reported as such. */
export function locate(disks: StorageDisks | null, platform: NodeJS.Platform, path: string) {
  if (!disks) return null;
  type Hit = { length: number; disk: string | null; volume: string | null; remote: string | null };
  const hits: Hit[] = [];
  for (const disk of disks.disks)
    for (const volume of [...disk.volumes, ...disk.system])
      for (const mount of volume.mountPaths)
        if (isWithin(platform, mount, path))
          hits.push({ length: mount.length, disk: disk.label, volume: volume.label, remote: null });
  for (const remote of disks.remote)
    for (const mount of remote.mountPaths)
      if (isWithin(platform, mount, path))
        hits.push({
          length: mount.length,
          disk: null,
          volume: remote.label,
          remote: remote.host ?? remote.backing ?? remote.label,
        });
  return hits.toSorted((a, b) => b.length - a.length)[0] ?? null;
}

const unmeasured = (size: StorageSize) => size.bytes === null || !size.complete;
const lifecycleSize = (record: LifecycleRecord | undefined): StorageSize | null =>
  record?.allocatedBytes != null
    ? {
        bytes: record.allocatedBytes,
        // The tool counts ordinary single-link files only, which it calls an estimate.
        complete: false,
        measuredAt: record.observedAt,
        basis: "lifecycle",
      }
    : null;

const shortId = (value: string) => value.slice(0, 8);
const basename = (value: string) => value.split(/[\\/]/).findLast(Boolean) ?? value;

/** The workspace state and where it comes from; the lifecycle tool's record outranks T3's own. */
export function workspaceState(
  record: LifecycleRecord | undefined,
  source: Pick<WorkspaceSource, "threadState"> | undefined,
): { state: StorageWorkspaceState; stateSource: "lifecycle" | "session" | "none" } {
  if (record && record.status !== "removed") {
    if (record.status === "grace") return { state: "cleanup-eligible", stateSource: "lifecycle" };
    if (record.status === "held")
      return {
        state: record.pending.length ? "preservation-pending" : "held",
        stateSource: "lifecycle",
      };
    if (record.status === "active")
      return {
        state: record.pending.length ? "preservation-pending" : "active",
        stateSource: "lifecycle",
      };
    return { state: "unknown", stateSource: "lifecycle" };
  }
  if (source?.threadState === "running") return { state: "active", stateSource: "session" };
  if (source?.threadState) return { state: "completed", stateSource: "session" };
  return { state: "unknown", stateSource: "none" };
}

export function buildHoldings(input: HoldingsInput): StorageHoldings {
  const { platform, now } = input;
  const key = (path: string) => normalize(platform, path);
  const records = new Map(input.lifecycle.map((record) => [key(record.job), record]));
  const used = new Set<string>();

  // --- workspaces ----------------------------------------------------------------------------
  const workspaces: StorageEntry[] = [];
  const addWorkspace = (root: string, source: WorkspaceSource | undefined) => {
    const id = key(root);
    if (used.has(id)) return;
    used.add(id);
    const record = records.get(id);
    if (record?.status === "removed") return;
    const { state, stateSource } = workspaceState(record, source);
    const where = locate(input.disks, platform, root);
    const remote = where?.remote ?? null;
    const measured = remote ? null : input.sizes(root);
    const size: StorageSize =
      measured ?? (remote ? UNMEASURED : (lifecycleSize(record) ?? UNMEASURED));
    const keeps = input.archives
      .filter((archive) => archive.source && isWithin(platform, root, archive.source))
      .map((archive) => ({
        id: archive.id,
        title: archive.title,
        host: archive.local ? input.host : (archive.host ?? "another computer"),
      }));
    const role = source?.master
      ? `Worker of ${source.master}`
      : source?.workers.length
        ? `Master of ${source.workers.length} worker${source.workers.length === 1 ? "" : "s"}`
        : source?.threadId
          ? "Session"
          : "Job folder";
    const retention = record
      ? record.holdReasons.length
        ? record.holdReasons.slice(0, 3).join("; ")
        : state === "active"
          ? "In use; the lifecycle tool has not scheduled it"
          : state === "cleanup-eligible"
            ? "Idle; waiting out the lifecycle tool's grace period"
            : null
      : input.lifecycleAvailable
        ? "Not registered with the lifecycle tool; kept until removed manually"
        : "No lifecycle tool reports retention here; kept until removed manually";
    const notes: string[] = [];
    if (remote)
      notes.push(
        `This folder is a network mount of ${remote}; its bytes are not on this computer.`,
      );
    if (!source?.threadState && !record && !source?.jobStatus)
      notes.push("Nothing records which session owns this folder.");
    const lastActivity = record?.lastActivityAt ?? source?.threadUpdatedAt ?? null;
    if (lastActivity === null && source?.modifiedAt)
      notes.push("Last activity was not recorded; the folder itself last changed then.");
    workspaces.push({
      id: `workspace:${id}`,
      group: "workspaces",
      title:
        source?.title ??
        (source?.project ? `${source.project} ${shortId(basename(root))}` : basename(root)),
      subtitle: [source?.project, role].filter(Boolean).join(" · ") || null,
      host: remote ?? input.host,
      local: remote === null,
      location: root,
      disk: where ? { disk: where.disk, volume: where.volume } : null,
      size,
      ram: input.ram(root),
      workspace: {
        owner: {
          project: source?.project ?? null,
          master: source?.master ?? null,
          workers: source?.workers ?? [],
          session: source?.session ?? null,
        },
        state,
        stateSource,
        lastActivityAt: lastActivity ?? source?.modifiedAt ?? null,
        expiresAt: record?.status === "grace" ? record.expiresAt : null,
        retention,
        preservation: record?.pending ?? [],
        keeps,
      },
      notes,
    });
  };
  for (const source of input.workspaces) addWorkspace(source.root, source);
  for (const record of input.lifecycle)
    if (record.status !== "removed") addWorkspace(record.job, undefined);
  workspaces.sort(
    (a, b) =>
      (b.workspace?.lastActivityAt ?? 0) - (a.workspace?.lastActivityAt ?? 0) ||
      a.title.localeCompare(b.title),
  );

  // --- archives --------------------------------------------------------------------------------
  const archives: StorageEntry[] = input.archives
    .map((archive): StorageEntry => {
      const where = archive.local ? locate(input.disks, platform, archive.writerPath) : null;
      const size: StorageSize =
        archive.logicalBytes === null
          ? UNMEASURED
          : {
              bytes: archive.logicalBytes,
              complete: true,
              measuredAt: archive.createdAt,
              basis: "manifest",
            };
      return {
        id: `archive:${archive.id}`,
        group: "archives",
        title: archive.title,
        subtitle: [archive.project, archive.collection].filter(Boolean).join(" · ") || null,
        host: archive.local ? input.host : (archive.host ?? "another computer"),
        local: archive.local,
        location: archive.writerPath,
        disk: where ? { disk: where.disk, volume: where.volume } : null,
        size,
        ram: [],
        archive: {
          collection: archive.collection,
          project: archive.project,
          source: archive.source,
          createdAt: archive.createdAt,
          retention:
            archive.backupRequired === true
              ? "Kept; its independent backup is required"
              : "Kept; no expiry is recorded",
          files: archive.files,
          backup: archive.backup,
          backupVerifiedAt: archive.backupVerifiedAt,
          backupSnapshot: archive.backupSnapshot,
        },
        notes: archive.local
          ? [
              "Recorded size is the sum of the bundle's files; space on disk can be lower when files are shared.",
            ]
          : [
              `Stored on ${archive.host ?? "another computer"}; nothing is charged to this computer's disks.`,
            ],
      };
    })
    .toSorted((a, b) => (b.archive?.createdAt ?? 0) - (a.archive?.createdAt ?? 0));

  // --- backups -----------------------------------------------------------------------------------
  const backups: StorageEntry[] = input.backups.map((backup): StorageEntry => {
    const local = backup.localPath !== null;
    const where = backup.localPath ? locate(input.disks, platform, backup.localPath) : null;
    const reported = backup.latest?.repositoryBytes ?? null;
    const measured = backup.localPath ? input.sizes(backup.localPath) : null;
    const size: StorageSize =
      reported !== null
        ? {
            bytes: reported,
            complete: true,
            measuredAt: backup.latest?.repositoryBytesAt ?? backup.latest?.confirmedAt ?? null,
            basis: "reported",
          }
        : (measured ?? UNMEASURED);
    // Coverage is counted against the bundles stored on this computer; with none, it is not known here.
    const counted = backup.latest !== null && input.libraryPaths.size > 0;
    const covered = counted
      ? [...input.libraryPaths].filter((path) => backup.latest!.confirmedPaths.has(path)).length
      : null;
    const independent =
      backup.physicalId && backup.libraryPhysicalId
        ? backup.physicalId !== backup.libraryPhysicalId
        : null;
    const notes = [
      "Snapshots share their data (deduplicated); they are not independent copies and their sizes are not added.",
      ...(size.bytes === null
        ? [
            local
              ? "Occupied bytes are not readable by this server and the backup tool does not report them."
              : "The repository is on another computer; its occupied bytes are not reported here.",
          ]
        : []),
      ...(backup.problem ? [backup.problem] : []),
      ...(backup.latest && !counted
        ? ["No kept bundle is stored on this computer, so the receipt is not matched to any here."]
        : []),
      ...backup.scope.slice(0, 2).map((line) => `Covers: ${line}`),
    ];
    return {
      id: `backup:${backup.id}`,
      group: "backups",
      title: `${backup.id === "library" ? "Library backup" : `Backup ${backup.id}`} on ${
        local ? input.host : (backup.host ?? "another computer")
      }`,
      subtitle: backup.description,
      host: local ? input.host : (backup.host ?? "another computer"),
      local,
      location: backup.repository,
      disk: where ? { disk: where.disk, volume: where.volume } : null,
      size,
      ram: [],
      backup: {
        kind: "restic",
        repository: backup.repository,
        snapshots: null,
        covered,
        expected: counted ? input.libraryPaths.size : null,
        verifiedAt: backup.latest?.confirmedAt ?? null,
        retention: backup.retention,
        independent,
      },
      notes,
    };
  });

  // --- other retained project data ---------------------------------------------------------------
  const other: StorageEntry[] = [];
  const seen = new Set<string>();
  const outsideRoots = (path: string) =>
    !input.jobRoots.some((root) => isWithin(platform, root, path));
  for (const retained of input.retained) {
    const id = key(retained.path);
    if (seen.has(id)) continue;
    seen.add(id);
    const where = locate(input.disks, platform, retained.path);
    const remote = where?.remote ?? null;
    other.push({
      id: `other:${id}`,
      group: "other",
      title: retained.title,
      subtitle: {
        "permanent-source": "Permanent source",
        "original-data": "Original data",
        "project-runtime": "Installed runtime",
        "shared-tooling": "Shared tooling or cache",
      }[retained.classification],
      host: remote ?? input.host,
      local: remote === null,
      location: retained.path,
      disk: where ? { disk: where.disk, volume: where.volume } : null,
      size: remote ? UNMEASURED : (input.sizes(retained.path) ?? UNMEASURED),
      ram: [],
      other: {
        classification: retained.classification,
        protection:
          retained.protection ??
          (outsideRoots(retained.path)
            ? "Outside the work folders, so automatic cleanup does not apply"
            : "Inside a work folder; its lifecycle rules apply"),
      },
      notes: retained.detail ? [retained.detail] : [],
    });
  }
  const recovered = input.lifecycle.filter(
    (record) => record.status === "removed" && record.recoveryRefs > 0,
  );
  if (recovered.length) {
    const refs = recovered.reduce((sum, record) => sum + record.recoveryRefs, 0);
    const bytes = recovered.reduce((sum, record) => sum + (record.recoveryBytes ?? 0), 0);
    other.push({
      id: "other:recovery",
      group: "other",
      title: "Expired work kept as recovery refs",
      subtitle: `${recovered.length} expired workspace${recovered.length === 1 ? "" : "s"}`,
      host: input.host,
      local: true,
      location: null,
      disk: null,
      size: {
        bytes,
        complete: false,
        measuredAt: Math.max(...recovered.map((record) => record.observedAt)),
        basis: "lifecycle",
      },
      ram: [],
      other: {
        classification: "recovery",
        protection: `${refs} Git recovery ref${refs === 1 ? "" : "s"} in the project repositories`,
      },
      notes: ["The folders were removed; their committed work stays in the project repositories."],
    });
  }
  other.sort(
    (a, b) =>
      (a.other?.classification ?? "").localeCompare(b.other?.classification ?? "") ||
      a.title.localeCompare(b.title),
  );

  // --- groups ------------------------------------------------------------------------------------
  const group = (
    id: StorageGroupId,
    entries: readonly StorageEntry[],
    status: StorageGroup["status"],
    reason: string | null,
  ): StorageGroup => {
    const onDisk = entries.filter((entry) => entry.local);
    const known = onDisk.filter((entry) => entry.size.bytes !== null);
    const bytes = known.reduce((sum, entry) => sum + (entry.size.bytes ?? 0), 0);
    const shared = known.reduce((sum, entry) => sum + (entry.size.sharedBytes ?? 0), 0);
    const ram = entries.flatMap((entry) => entry.ram).filter((r) => r.usedBytes !== null);
    return {
      group: id,
      status,
      reason,
      count: entries.length,
      remote: entries.length - onDisk.length,
      shown: Math.min(entries.length, input.keep ?? ENTRIES_KEPT),
      bytes: known.length ? bytes : null,
      measured: known.length,
      unmeasured: onDisk.filter((entry) => unmeasured(entry.size)).length,
      sharedBytes: known.some((entry) => entry.size.sharedBytes != null) ? shared : null,
      ramBytes: ram.length ? ram.reduce((sum, r) => sum + (r.usedBytes ?? 0), 0) : null,
      entries: entries.slice(0, input.keep ?? ENTRIES_KEPT),
    };
  };
  const noRoots = !input.workspaces.length && !input.lifecycle.length && !input.jobRoots.length;
  const groups: StorageGroup[] = STORAGE_GROUPS.map((id) => {
    switch (id) {
      case "workspaces":
        return group(
          id,
          workspaces,
          noRoots ? "unsupported" : input.lifecycleAvailable ? "complete" : "partial",
          noRoots
            ? "No agent work folder or lifecycle tool is configured on this computer."
            : input.lifecycleAvailable
              ? null
              : "No lifecycle tool is installed: retention, expiry and preservation state are not reported.",
        );
      case "archives":
        return group(
          id,
          archives,
          !input.archiveSupported ? "unsupported" : input.archiveProblem ? "partial" : "complete",
          !input.archiveSupported
            ? "Kept results need the lifecycle tool, which is not installed on this computer."
            : input.archiveProblem,
        );
      case "backups":
        return group(
          id,
          backups,
          !input.backupSupported
            ? "unsupported"
            : input.backupProblem && !backups.length
              ? "unavailable"
              : input.backupProblem || backups.some((entry) => entry.backup?.verifiedAt == null)
                ? "partial"
                : "complete",
          !input.backupSupported
            ? "Backups are described by the lifecycle tool's library interface, which is not installed on this computer."
            : input.backupProblem,
        );
      case "other":
        return group(
          id,
          other,
          input.retainedSupported ? "complete" : "partial",
          input.retainedSupported
            ? null
            : "Only the projects registered in T3 are listed; no lifecycle tool names further protected data.",
        );
    }
  });
  return {
    sampledAt: now,
    host: input.host,
    groups,
    measuring: input.measuring,
    notices: [...input.notices],
  };
}
