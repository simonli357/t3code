/**
 * The contract between the storage views' data hook and their presentational components, with the
 * same rules as `computersViewModel.ts`: `null` is unknown and is printed as unknown, never as 0;
 * timestamps are ISO strings; the components never fetch or derive facts.
 */
import type {
  EnvironmentMachineKind,
  StorageDetail,
  StorageEntry,
  StorageGroupId,
  StorageSize,
} from "@t3tools/contracts";
import type { ComputerConnection, IsoTimestamp, Loadable } from "./computersViewModel";

/** The Computers page's views: the existing overview, and the two storage views. */
export const STORAGE_VIEWS = ["overview", "disks", "workspaces"] as const;
export type ComputersViewId = (typeof STORAGE_VIEWS)[number];

// ── Disks ─────────────────────────────────────────────────────────────────────

export interface VolumeModel {
  readonly id: string;
  readonly label: string;
  /** Primary mount point (or drive letter) first; the others are aliases of the same filesystem. */
  readonly mountPaths: readonly string[];
  readonly filesystem: string | null;
  readonly device: string | null;
  readonly role: "data" | "system" | "boot" | "swap" | "recovery" | "unmounted";
  readonly capacityBytes: number | null;
  /** What the filesystem reports used. */
  readonly usedBytes: number | null;
  /** What a user may still write; not necessarily capacity minus used. */
  readonly availableBytes: number | null;
  /** The configured reserve; null when none is configured. */
  readonly reserveBytes: number | null;
  /** Available minus the reserve, only where agent work lives. */
  readonly headroomBytes: number | null;
  readonly holds: ReadonlyArray<"agent-work" | "library" | "backup">;
  readonly measuredAt: IsoTimestamp | null;
  /** Whether the folder breakdown can be opened for it. */
  readonly openable: boolean;
}

export interface DiskModel {
  readonly id: string;
  readonly title: string;
  /** "NVMe · SSD · 1 TB" or whatever of it is known. */
  readonly detail: string | null;
  readonly sizeBytes: number | null;
  readonly volumes: ReadonlyArray<VolumeModel>;
  /** Boot, swap, recovery and unmounted partitions: shown under Advanced details. */
  readonly system: ReadonlyArray<VolumeModel>;
}

export interface RemoteStorageModel {
  readonly id: string;
  readonly label: string;
  readonly protocol: string;
  /** The computer that holds the bytes. */
  readonly host: string | null;
  /** The share or path on that computer. */
  readonly backing: string | null;
  readonly capacityBytes: number | null;
  readonly usedBytes: number | null;
  readonly availableBytes: number | null;
  readonly measuredAt: IsoTimestamp | null;
}

export interface SystemMountModel {
  readonly id: string;
  readonly kind: "memory" | "pseudo" | "image" | "alias" | "other";
  readonly label: string;
  readonly mountPaths: readonly string[];
  readonly filesystem: string | null;
  readonly backing: string | null;
  readonly capacityBytes: number | null;
  readonly usedBytes: number | null;
}

export interface ComputerDisksModel {
  readonly computerId: string;
  readonly name: string;
  readonly machineKind: EnvironmentMachineKind | null;
  readonly connection: ComputerConnection;
  /** `unsupported`: the computer's server predates this view, or it cannot report disks. */
  readonly state: "loading" | "ready" | "error" | "unsupported";
  readonly message: string | null;
  /** When the inventory was measured; the date shown on last-known data. */
  readonly sampledAt: IsoTimestamp | null;
  /** The numbers are the last known ones: the computer is offline or the newest read failed. */
  readonly lastKnown: boolean;
  readonly disks: ReadonlyArray<DiskModel>;
  readonly remote: ReadonlyArray<RemoteStorageModel>;
  readonly advanced: ReadonlyArray<SystemMountModel>;
  readonly reserveSource: string | null;
  readonly notices: ReadonlyArray<string>;
}

export interface DisksViewModel {
  readonly computers: Loadable<ReadonlyArray<ComputerDisksModel>>;
}

// ── Workspaces & Archives ─────────────────────────────────────────────────────

export interface HoldingRow {
  /** Unique across computers; also the key of the entry's lazily loaded details. */
  readonly key: string;
  readonly computerId: string;
  readonly entry: StorageEntry;
  /** The computer's name when the bytes are on it, else the host the entry names. */
  readonly hostLabel: string;
  /** "System SSD · /" - the physical disk and volume, when known. */
  readonly diskLabel: string | null;
  /** Present for entries whose parts can be read when opened. */
  readonly details: Loadable<StorageDetail> | null;
  readonly detailsAvailable: boolean;
}

export type CoverageState =
  | "complete"
  | "partial"
  | "unsupported"
  | "unavailable"
  | "offline"
  | "loading"
  | "error";
export interface GroupCoverage {
  readonly computerId: string;
  readonly name: string;
  readonly state: CoverageState;
  readonly reason: string | null;
  /** The data shown for this computer is its last known, from this time. */
  readonly lastKnownAt: IsoTimestamp | null;
}

export interface HoldingGroupModel {
  readonly id: StorageGroupId;
  /** Whether the person has opened the group; entries are fetched only for open groups. */
  readonly open: boolean;
  /** Open, and some computer has not yet sent this group's entries. */
  readonly rowsLoading: boolean;
  readonly title: string;
  readonly description: string;
  /** Entries stored on connected computers, plus the ones they report from elsewhere; null while loading. */
  readonly count: number | null;
  /** The count is a lower bound: some entries stored elsewhere are not listed. */
  readonly countIsLowerBound: boolean;
  /** Entries stored on another computer, listed but not charged to any disk here. */
  readonly storedElsewhere: number;
  /** Disk bytes of what is measured so far, RAM excluded; null when nothing is measured. */
  readonly bytes: number | null;
  readonly measured: number;
  readonly unmeasured: number;
  readonly sharedBytes: number | null;
  readonly ramBytes: number | null;
  readonly measuring: boolean;
  readonly coverage: ReadonlyArray<GroupCoverage>;
  readonly rows: ReadonlyArray<HoldingRow>;
  /** More entries exist than the computers listed. */
  readonly truncated: boolean;
}

export interface HoldingsViewModel {
  readonly loading: boolean;
  /** Always exactly four, in display order. */
  readonly groups: ReadonlyArray<HoldingGroupModel>;
  readonly notices: ReadonlyArray<string>;
}

export interface StorageActions {
  /** Reads every computer again and asks them to measure what is stale. */
  readonly onRefresh: () => void;
  /** Opens or closes a group; the computers send a group's entries only while it is open. */
  readonly onToggleGroup: (group: StorageGroupId, open: boolean) => void;
  /** Asks the computers for more entries per open group than they have sent so far. */
  readonly onLoadMore: () => void;
  /** Reads the parts of one entry when it is opened. */
  readonly onExpandEntry: (computerId: string, entryId: string) => void;
}

export type { StorageSize };
