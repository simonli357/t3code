import type {
  StorageDetail,
  StorageDisks,
  StorageEntry,
  StorageGroup,
  StorageGroupId,
  StorageHoldings,
  StorageVolume,
} from "@t3tools/contracts";
import { STORAGE_GROUPS } from "@t3tools/contracts";
import type { Loadable } from "../components/computers/computersViewModel";
import type {
  ComputerDisksModel,
  CoverageState,
  DiskModel,
  DisksViewModel,
  GroupCoverage,
  HoldingGroupModel,
  HoldingRow,
  HoldingsViewModel,
  VolumeModel,
} from "../components/computers/storageViewModel";
import type { EnvironmentPresentation } from "./environments";
import { connected, iso } from "./computersView";

type StorageEnvironment = Pick<
  EnvironmentPresentation,
  "environmentId" | "label" | "connection" | "displayUrl" | "serverConfig"
>;

/** What the hook has read from one computer, and when. */
export interface ComputerStorageData {
  readonly disks: StorageDisks | null;
  readonly holdings: StorageHoldings | null;
  /** The groups whose entries `holdings` holds; the others carry totals only. */
  readonly loaded: readonly StorageGroupId[];
  /** Why the newest read failed; the data above is then the last good one. */
  readonly error: string | null;
  /** Epoch milliseconds of the last successful read, on this browser's clock. */
  readonly readAt: number | null;
}
export const noStorageData: ComputerStorageData = {
  disks: null,
  holdings: null,
  loaded: [],
  error: null,
  readAt: null,
};

/** null until the server has reported what it can do; a connected computer is not "outdated" before that. */
export const storageSupport = (environment: StorageEnvironment) =>
  environment.serverConfig === null
    ? null
    : environment.serverConfig.environment.capabilities.computersStorage === true;

const UPDATE_SERVER = "Update this computer’s T3 server to see its storage.";

const connection = (environment: StorageEnvironment, lastSeenAt: string | null) =>
  connected(environment)
    ? ({ status: "online" } as const)
    : ["connecting", "reconnecting"].includes(environment.connection.phase)
      ? ({ status: "connecting", lastSeenAt } as const)
      : ({ status: "offline", lastSeenAt, reason: environment.connection.error } as const);

// ── Disks ─────────────────────────────────────────────────────────────────────

const volumeModel = (volume: StorageVolume, openable: boolean): VolumeModel => ({
  id: volume.id,
  label: volume.label,
  mountPaths: volume.mountPaths,
  filesystem: volume.filesystem,
  device: volume.device,
  role: volume.role,
  capacityBytes: volume.capacityBytes,
  usedBytes: volume.usedBytes,
  availableBytes: volume.availableBytes,
  reserveBytes: volume.reserveBytes,
  headroomBytes: volume.headroomBytes,
  holds: volume.holds,
  measuredAt: iso(volume.measuredAt),
  openable: openable && volume.mountPaths.length > 0 && volume.role !== "unmounted",
});

const MEDIA = { ssd: "SSD", hdd: "HDD", removable: "Removable", virtual: "Virtual" } as const;
const diskDetail = (disk: StorageDisks["disks"][number]) =>
  [disk.bus, disk.media ? MEDIA[disk.media] : null].filter(Boolean).join(" · ") || null;

export function disksModel(
  environments: ReadonlyArray<StorageEnvironment>,
  data: Readonly<Record<string, ComputerStorageData>>,
  ready: boolean,
): DisksViewModel {
  if (!ready) return { computers: { status: "loading" } };
  return {
    computers: {
      status: "ready",
      data: environments.map((environment): ComputerDisksModel => {
        const mine = data[environment.environmentId] ?? noStorageData;
        const inventory = mine.disks;
        const isConnected = connected(environment);
        const support = storageSupport(environment);
        const lastSeenAt = iso(mine.readAt);
        const base = {
          computerId: environment.environmentId,
          name: environment.label,
          machineKind: environment.serverConfig?.environment.platform.machine ?? null,
          connection: connection(environment, lastSeenAt),
        };
        const empty = {
          sampledAt: null,
          lastKnown: false,
          disks: [],
          remote: [],
          advanced: [],
          reserveSource: null,
          notices: [],
        };
        if (!inventory) {
          if (isConnected && support === false)
            return { ...base, ...empty, state: "unsupported", message: UPDATE_SERVER };
          if (mine.error) return { ...base, ...empty, state: "error", message: mine.error };
          return {
            ...base,
            ...empty,
            state: isConnected || mine.readAt === null ? "loading" : "error",
            message: isConnected
              ? null
              : "No storage reading was ever received from this computer.",
          };
        }
        const openable = isConnected && support === true;
        return {
          ...base,
          state: "ready",
          message: mine.error,
          sampledAt: iso(inventory.sampledAt),
          lastKnown: !isConnected || mine.error !== null,
          disks: inventory.disks.map((disk): DiskModel => ({
            id: disk.id,
            title: disk.label,
            detail: diskDetail(disk),
            sizeBytes: disk.sizeBytes,
            volumes: disk.volumes.map((volume) => volumeModel(volume, openable)),
            system: disk.system.map((volume) => volumeModel(volume, false)),
          })),
          remote: inventory.remote.map((remote) => ({
            id: remote.id,
            label: remote.label,
            protocol: remote.protocol,
            host: remote.host,
            backing: remote.backing,
            capacityBytes: remote.capacityBytes,
            usedBytes: remote.usedBytes,
            availableBytes: remote.availableBytes,
            measuredAt: iso(remote.measuredAt),
          })),
          advanced: inventory.advanced,
          reserveSource: inventory.reserveSource,
          notices: inventory.notices,
        };
      }),
    },
  };
}

// ── Workspaces & Archives ──────────────────────────────────────────────────────

const GROUP_TEXT: Record<StorageGroupId, { title: string; description: string }> = {
  workspaces: {
    title: "Workspaces",
    description:
      "Whole session jobs: source, temporary files, builds, caches, outputs and evidence.",
  },
  archives: {
    title: "Archives",
    description: "Results that were kept, with where they live and whether a backup is verified.",
  },
  backups: {
    title: "Backups",
    description:
      "Backup repositories: where they are, what they cover and when they were verified.",
  },
  other: {
    title: "Other retained project data",
    description: "Permanent source, original data and installed runtimes outside the work folders.",
  },
};

/**
 * A holdings answer into what is held: the groups asked for replace their entries; the others take
 * the new totals and keep the entries last received, which are only shown once their group opens.
 */
export function mergeHoldings(
  previous: ComputerStorageData,
  next: StorageHoldings,
  requested: readonly StorageGroupId[],
): Pick<ComputerStorageData, "holdings" | "loaded"> {
  return {
    holdings: {
      ...next,
      groups: next.groups.map((group) =>
        requested.includes(group.group)
          ? group
          : {
              ...group,
              entries:
                previous.holdings?.groups.find((old) => old.group === group.group)?.entries ?? [],
            },
      ),
    },
    loaded: [...new Set([...previous.loaded, ...requested])],
  };
}

/** The groups a saved answer already carries entries for. */
export const loadedGroups = (holdings: StorageHoldings): StorageGroupId[] =>
  holdings.groups
    .filter((group) => group.entries.length > 0 || group.count === 0)
    .map((group) => group.group);

export const detailKey = (computerId: string, entryId: string) =>
  JSON.stringify([computerId, entryId]);

const lastActivity = (entry: StorageEntry) => entry.workspace?.lastActivityAt ?? 0;
const created = (entry: StorageEntry) => entry.archive?.createdAt ?? 0;

const coverageState = (
  environment: StorageEnvironment,
  mine: ComputerStorageData,
  group: StorageGroup | undefined,
): { state: CoverageState; reason: string | null } => {
  const isConnected = connected(environment);
  const support = storageSupport(environment);
  if (isConnected && support === false) return { state: "unsupported", reason: UPDATE_SERVER };
  if (!group)
    return mine.error
      ? { state: "error", reason: mine.error }
      : {
          state: isConnected ? "loading" : "offline",
          reason: isConnected ? null : "Offline, and nothing was saved.",
        };
  const reason = group.reason;
  if (!isConnected) return { state: "offline", reason };
  if (mine.error) return { state: "error", reason: mine.error };
  return { state: group.status, reason };
};

export function holdingsModel(
  environments: ReadonlyArray<StorageEnvironment>,
  data: Readonly<Record<string, ComputerStorageData>>,
  details: Readonly<Record<string, Loadable<StorageDetail>>>,
  ready: boolean,
  open: ReadonlySet<StorageGroupId> = new Set(),
): HoldingsViewModel {
  const loading = !ready;
  const names = new Map<string, string>(environments.map((env) => [env.environmentId, env.label]));
  const groups = STORAGE_GROUPS.map((id): HoldingGroupModel => {
    const coverage: GroupCoverage[] = [];
    const candidates: HoldingRow[] = [];
    let rowsLoading = false;
    let bytes: number | null = null,
      measured = 0,
      unmeasured = 0,
      shared: number | null = null,
      ram: number | null = null,
      localCount = 0,
      unlisted = 0,
      measuring = false,
      anyLoading = false;
    for (const environment of environments) {
      const mine = data[environment.environmentId] ?? noStorageData;
      const group = mine.holdings?.groups.find((entry) => entry.group === id);
      const status = coverageState(environment, mine, group);
      coverage.push({
        computerId: environment.environmentId,
        name: environment.label,
        ...status,
        lastKnownAt:
          group && (status.state === "offline" || status.state === "error")
            ? iso(mine.readAt)
            : null,
      });
      if (status.state === "loading") anyLoading = true;
      if (!group) continue;
      if (open.has(id) && group.count > 0 && !mine.loaded.includes(id)) rowsLoading = true;
      measuring ||= mine.holdings?.measuring ?? false;
      localCount += group.count - group.remote;
      unmeasured += group.unmeasured;
      measured += group.measured;
      if (group.bytes !== null) bytes = (bytes ?? 0) + group.bytes;
      if (group.sharedBytes !== null) shared = (shared ?? 0) + group.sharedBytes;
      if (group.ramBytes !== null) ram = (ram ?? 0) + group.ramBytes;
      unlisted += group.count - group.shown;
      for (const entry of group.entries) {
        candidates.push({
          key: detailKey(environment.environmentId, entry.id),
          computerId: environment.environmentId,
          entry,
          hostLabel: entry.local
            ? (names.get(environment.environmentId) ?? entry.host)
            : entry.host,
          diskLabel: entry.disk
            ? [entry.disk.disk, entry.disk.volume].filter(Boolean).join(" · ") || null
            : null,
          details: null,
          detailsAvailable: false,
        });
      }
    }
    // The same bundle is reported by the computer that stores it and by the one that kept it:
    // it is listed once, as the stored one, and the other report adds no bytes.
    const chosen = new Map<string, HoldingRow>();
    const rows: HoldingRow[] = [];
    for (const row of candidates) {
      if (id !== "archives") {
        rows.push(row);
        continue;
      }
      const previous = chosen.get(row.entry.id);
      if (!previous) {
        chosen.set(row.entry.id, row);
        rows.push(row);
      } else if (row.entry.local && !previous.entry.local) {
        rows[rows.indexOf(previous)] = row;
        chosen.set(row.entry.id, row);
      }
    }
    const remoteDistinct = rows.filter((row) => !row.entry.local).length;
    rows.sort((a, b) =>
      id === "workspaces"
        ? lastActivity(b.entry) - lastActivity(a.entry) ||
          a.entry.title.localeCompare(b.entry.title)
        : id === "archives"
          ? created(b.entry) - created(a.entry)
          : (names.get(a.computerId) ?? "").localeCompare(names.get(b.computerId) ?? "") ||
            a.entry.title.localeCompare(b.entry.title),
    );
    const withDetails = rows.map((row): HoldingRow => {
      const available =
        row.entry.group === "workspaces" || (row.entry.group === "archives" && row.entry.local);
      return {
        ...row,
        detailsAvailable: available,
        details: available ? (details[row.key] ?? null) : null,
      };
    });
    const reported = coverage.some((entry) =>
      ["complete", "partial", "offline", "error"].includes(entry.state),
    );
    return {
      id,
      open: open.has(id),
      rowsLoading,
      ...GROUP_TEXT[id],
      count: reported ? localCount + remoteDistinct : anyLoading || loading ? null : 0,
      countIsLowerBound: unlisted > 0,
      storedElsewhere: remoteDistinct,
      bytes,
      measured,
      unmeasured,
      sharedBytes: shared,
      ramBytes: ram,
      measuring,
      coverage,
      rows: withDetails,
      truncated: unlisted > 0,
    };
  });
  return {
    loading,
    groups,
    notices: environments.flatMap((environment) =>
      (data[environment.environmentId]?.holdings?.notices ?? []).map(
        (notice) => `${environment.label}: ${notice}`,
      ),
    ),
  };
}
