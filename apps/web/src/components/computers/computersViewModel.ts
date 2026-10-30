/** The contract between the Computers page's data hook and its presentational components: `null`
 * means unknown and is never rendered as zero, ids and timestamps stay opaque, and array order is
 * render order. The hook owns fetching and the view only renders and reports intent. */
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";

export type IsoTimestamp = string;

/** One piece of data on its way in: a skeleton, a concrete error, or the value. */
export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: T };

/** The state of a user-triggered action (Keep, Restore) for the thing currently open. */
export type ActionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "done"; readonly message: string };

/** Whether an action can run right now. The reason is shown next to the disabled control. */
export type ActionAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

// ── Computers ────────────────────────────────────────────────────────────────

/**
 * Offline and connecting computers keep their panel and show their last known data under
 * the date it was measured. `lastSeenAt` is when the computer last answered; null if it never has.
 */
export type ComputerConnection =
  | { readonly status: "online" }
  | { readonly status: "connecting"; readonly lastSeenAt: IsoTimestamp | null }
  | {
      readonly status: "offline";
      readonly lastSeenAt: IsoTimestamp | null;
      /** Why it is unreachable, if known ("Connection refused"). Shown verbatim. */
      readonly reason: string | null;
    };

export interface MetricSample {
  readonly at: IsoTimestamp;
  /** 0-100. null is a sample whose value could not be read: drawn as a gap, never as 0. */
  readonly percent: number | null;
}

export interface ComputerDisk {
  /** Unique within its computer (the mount point or drive letter will do). */
  readonly id: string;
  /** What the user calls it: "Data", "C:", "/". */
  readonly label: string;
  /** Mount point when it adds something to the label ("/mnt/data"). */
  readonly mountPath: string | null;
  /**
   * At least two of the three are needed to draw a bar; the third is derived. Free is the space a
   * user can actually write, so used + free may be less than total on filesystems that reserve some.
   */
  readonly totalBytes: number | null;
  readonly usedBytes: number | null;
  readonly freeBytes: number | null;
}

/** The newest measurement of a whole computer. */
export interface ComputerMetrics {
  /** When this was measured. It is the date shown on "last known data" for a computer not online. */
  readonly sampledAt: IsoTimestamp | null;
  readonly cpu: {
    /** Whole-host utilisation, 0-100. */
    readonly percent: number | null;
    readonly logicalCores: number | null;
    /** Oldest first. A short recent window; the sparkline spans exactly these samples. */
    readonly history: ReadonlyArray<MetricSample>;
  };
  readonly memory: {
    readonly usedBytes: number | null;
    readonly totalBytes: number | null;
    /** Percent of memory in use, oldest first. */
    readonly history: ReadonlyArray<MetricSample>;
  };
  readonly disks: ReadonlyArray<ComputerDisk>;
}

export interface ComputerPanelModel {
  readonly id: string;
  readonly name: string;
  /** Picks the icon. null shows the generic server icon. */
  readonly machineKind: EnvironmentMachineKind | null;
  /** One muted line under the name, such as how it is reached ("T3 Connect", "SSH user@host"). */
  readonly subtitle: string | null;
  readonly connection: ComputerConnection;
  /** null: nothing was ever measured (or it has not loaded yet). */
  readonly metrics: ComputerMetrics | null;
  /** Why metrics are missing or could not be read, shown verbatim in place of the numbers. */
  readonly metricsError: string | null;
  /**
   * Whether disk folder breakdowns and process lists can be opened for this computer (online, or
   * cached). When false the CPU, memory, and disk rows are plain text, not buttons.
   */
  readonly canInspect: boolean;
}

// ── Disk and process details ─────────────────────────────────────────────────

export interface FolderRow {
  /** Absolute path; unique within the breakdown. */
  readonly path: string;
  /** Last path segment, shown as the label. */
  readonly name: string;
  /** A folder can be opened (when `openable`); a file is listed because it takes space too. */
  readonly kind: "folder" | "file";
  /** null: not measured (permission denied, scan stopped). Say why in `note`. */
  readonly sizeBytes: number | null;
  readonly note: string | null;
  /** Whether `onOpenFolder` can list this folder's children. Only meaningful for a folder. */
  readonly openable: boolean;
}

/** One level of a disk's folder breakdown. The first level is the disk root. */
export interface DiskBreakdown {
  /** The folder these rows belong to. */
  readonly path: string;
  /** null at the disk root; otherwise an "Up" control appears. */
  readonly parentPath: string | null;
  /** Total size of `path`. Each row's bar is its share of this; null falls back to the largest row. */
  readonly scopeBytes: number | null;
  /** Any order; the view sorts by size, largest first, with unmeasured entries last. */
  readonly folders: ReadonlyArray<FolderRow>;
  /** When the scan was taken. Always shown, since a scan is rarely live. */
  readonly measuredAt: IsoTimestamp | null;
  /** A caveat about the numbers ("Scan stopped after 60 s, sizes are partial"). Shown verbatim. */
  readonly notice: string | null;
}

export interface ProcessRow {
  /** Unique within the list (pid plus start time, say). */
  readonly key: string;
  readonly name: string;
  /** Full command line, shown on hover. */
  readonly command: string | null;
  readonly pid: number | null;
  /**
   * Share of the whole host's CPU, 0-100, on the same scale as `ComputerMetrics.cpu.percent`, so the
   * rows add up to at most the host figure. Not per-core: divide a per-core figure by the core count.
   */
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly owner: string | null;
  /** The Workenv job that owns this process, if that is known. */
  readonly job: { readonly id: string; readonly title: string } | null;
}

export interface ProcessList {
  /** When the list was read. */
  readonly measuredAt: IsoTimestamp | null;
  /** Any order; the view sorts by the chosen column. */
  readonly processes: ReadonlyArray<ProcessRow>;
  /** How many processes the host has, when `processes` holds only the busiest ones. */
  readonly totalCount: number | null;
  /** Workenv jobs known to be running on this computer. Empty when none is known to be. */
  readonly jobs: ReadonlyArray<ActivityRow>;
}

export type ProcessFocus = "cpu" | "memory";

// ── Search ───────────────────────────────────────────────────────────────────

export type FileKind = "file" | "folder";

/** Where a result lives. Caches and system files are never searched, so they have no entry. */
export type FileLocation = "project" | "work-folder" | "kept-archive";

/**
 * What is known about a file's backup. "not-verified" is for every case where it is not known:
 * never checked, check failed, or the computer is unreachable. It is the default, and nothing is
 * shown as backed up unless a check says "confirmed".
 */
export type BackupStatus =
  | {
      /** A check found the copy. */
      readonly state: "confirmed";
      /** When that check ran. */
      readonly at: IsoTimestamp | null;
      /** Where the copy is ("nas-archive:/backups/2026-10"). */
      readonly where: string | null;
    }
  | {
      /** A copy was handed to the archive but no check has found it yet. */
      readonly state: "published";
      readonly at: IsoTimestamp | null;
      readonly where: string | null;
    }
  | { readonly state: "not-verified" };

export interface KeptInfo {
  /** The one-line reason the file was kept. */
  readonly reason: string;
  readonly keptAt: IsoTimestamp | null;
}

export interface FileRow {
  readonly id: string;
  readonly name: string;
  readonly kind: FileKind;
  /** null when it is not known which kind of place this is. */
  readonly location: FileLocation | null;
  readonly computerId: string;
  readonly computerName: string;
  /** Full path on that computer. */
  readonly path: string;
  readonly projectName: string | null;
  /** A short display label ("PDF", "STEP"). null when it could not be told. */
  readonly fileType: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: IsoTimestamp | null;
  readonly backup: BackupStatus;
  /** Set once the file is in the kept archive. */
  readonly kept: KeptInfo | null;
}

/** Everything the file details dialog shows, which is a result row plus what its actions need. */
export interface FileDetail extends FileRow {
  readonly keep: ActionAvailability;
  readonly restore: ActionAvailability;
  /**
   * Computers a restore can be written to, in display order; the first is the default. Offline ones
   * are listed but disabled. With a single entry the view shows it as fixed text, not a choice.
   */
  readonly restoreTargets: ReadonlyArray<{
    readonly computerId: string;
    readonly name: string;
    readonly online: boolean;
  }>;
}

export interface SearchFilters {
  /** null means every project; the same for the others. */
  readonly projectId: string | null;
  readonly computerId: string | null;
  readonly fileType: string | null;
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** A computer the search could not fully cover, so an empty or short result is not read as complete. */
export interface SearchCaveat {
  readonly computerName: string;
  /** "Offline, not searched", "Still indexing, results may be incomplete". Shown verbatim. */
  readonly message: string;
}

export type SearchResults =
  /** Nothing is being searched, so the overview shows instead of results. */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<FileRow>;
      /** How many files match in all, when known. */
      readonly totalCount: number | null;
      /** More pages exist; the view offers `onLoadMoreResults`. */
      readonly hasMore: boolean;
      readonly loadingMore: boolean;
      readonly caveats: ReadonlyArray<SearchCaveat>;
    };

export interface ComputersSearchModel {
  readonly query: string;
  readonly filters: SearchFilters;
  readonly projectOptions: ReadonlyArray<FilterOption>;
  readonly computerOptions: ReadonlyArray<FilterOption>;
  readonly results: SearchResults;
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Workenv jobs, file transfers, backups, and restores, in one list. */
export type ActivityKind = "job" | "transfer" | "backup" | "restore";

/** "unknown" is for a status the data layer could not map; it is never guessed as running or done. */
export type ActivityStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "unknown";

export interface ActivityProgress {
  readonly percent: number | null;
  readonly bytesDone: number | null;
  readonly bytesTotal: number | null;
}

/**
 * Retry is offered only for a failed transfer, backup, or restore, and only when this is not null.
 * A failed job never gets a Retry button, whatever is sent here.
 */
export type ActivityRetry =
  | { readonly state: "available" }
  | { readonly state: "in-flight" }
  | { readonly state: "unavailable"; readonly reason: string };

export interface ActivityRow {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly status: ActivityStatus;
  readonly title: string;
  /** Where it ran or what it moved ("sliara → nas-archive", a path). */
  readonly context: string | null;
  readonly startedAt: IsoTimestamp | null;
  /** When anything about it last changed; for a finished row, when it finished. */
  readonly updatedAt: IsoTimestamp | null;
  /** Only meaningful while running. */
  readonly progress: ActivityProgress | null;
  /** The concrete reason a failed row failed, verbatim (stderr tail, exit code, path). */
  readonly failureReason: string | null;
  /** A neutral line that is not a failure ("Workspace exists; running state is under Processes"). */
  readonly note: string | null;
  readonly retry: ActivityRetry | null;
}

// ── The page ─────────────────────────────────────────────────────────────────

/** What is open in a dialog. At most one at a time. */
export type ComputersDetail =
  | {
      readonly kind: "disk";
      readonly computerId: string;
      readonly diskId: string;
      /** Loading while the computer measures folder sizes, which can take a while on a big disk. */
      readonly breakdown: Loadable<DiskBreakdown>;
    }
  | {
      readonly kind: "processes";
      readonly computerId: string;
      /** Which block was clicked; it sets the initial sort. */
      readonly focus: ProcessFocus;
      readonly processes: Loadable<ProcessList>;
    }
  | {
      readonly kind: "file";
      readonly fileId: string;
      readonly file: Loadable<FileDetail>;
      readonly keepState: ActionState;
      readonly restoreState: ActionState;
    };

export interface ComputersViewModel {
  readonly computers: Loadable<ReadonlyArray<ComputerPanelModel>>;
  readonly search: ComputersSearchModel;
  /** Newest first. The view shows the first screenful and lets the person reveal more. */
  readonly activity: Loadable<ReadonlyArray<ActivityRow>>;
  readonly detail: ComputersDetail | null;
  /** A refresh is running; spins the header's refresh button. */
  readonly refreshing: boolean;
}

/** The reason on a Keep is one line of 1 to this many characters once trimmed. */
export const KEEP_REASON_MAX_LENGTH = 200;

/**
 * The only things a person can do here: look, Keep a file, Restore a file to a folder, and Retry a
 * failed transfer or backup. There is deliberately nothing that stops or changes a process or job.
 */
export interface ComputersActions {
  /** Reload everything; also the "Try again" of the computers, activity, and search error states. */
  readonly onRefresh: () => void;
  readonly onQueryChange: (query: string) => void;
  readonly onFiltersChange: (filters: SearchFilters) => void;
  readonly onLoadMoreResults: () => void;
  /**
   * Opens a disk's folder breakdown. Also the "Try again" of that dialog's error, so calling it for the
   * target that is already open should load it again.
   */
  readonly onOpenDisk: (target: { computerId: string; diskId: string }) => void;
  /** Lists the children of a folder inside the open disk details. */
  readonly onOpenFolder: (path: string) => void;
  /** Opens CPU or memory details; like `onOpenDisk`, calling it again for the open target reloads it. */
  readonly onOpenProcesses: (target: { computerId: string; focus: ProcessFocus }) => void;
  /** Opens a result's details; calling it again for the open file reloads it. */
  readonly onOpenFile: (fileId: string) => void;
  readonly onCloseDetail: () => void;
  readonly onKeep: (input: { fileId: string; reason: string }) => void;
  /** `destination` is the folder typed by the person, trimmed and non-empty, on `computerId`. */
  readonly onRestore: (input: { fileId: string; computerId: string; destination: string }) => void;
  readonly onRetryActivity: (activityId: string) => void;
}

export interface ComputersPageViewProps {
  readonly model: ComputersViewModel;
  readonly actions: ComputersActions;
  /** The user's clock preference (`useClientSettings((s) => s.timestampFormat)`). */
  readonly timestampFormat: TimestampFormat;
}
