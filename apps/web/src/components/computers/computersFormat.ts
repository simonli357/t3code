/**
 * Pure helpers behind the Computers page: how numbers and dates are written, what an unknown
 * value is called, and the few rules the view applies to the data it is given.
 *
 * The page's one rule: unknown is never zero. Every formatter here takes a known value; callers
 * branch on `null` first and print `NOT_MEASURED` or `NOT_VERIFIED` instead.
 */
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { formatDayAwareTimestamp, formatElapsedDurationLabel } from "../../timestampFormat";
import {
  KEEP_REASON_MAX_LENGTH,
  type ActivityKind,
  type ActivityProgress,
  type ActivityRetry,
  type ActivityRow,
  type ActivityStatus,
  type BackupStatus,
  type ComputerConnection,
  type ComputerDisk,
  type ComputerMetrics,
  type ComputersSearchModel,
  type FileLocation,
  type FolderRow,
  type ProcessFocus,
  type ProcessRow,
  type SearchFilters,
} from "./computersViewModel";

/** A live measurement (CPU, memory, disk) that has no value. */
export const NOT_MEASURED = "Not measured";
/** Backup, size, and modified time when nothing has confirmed them. */
export const NOT_VERIFIED = "Not verified";

// ── Numbers ──────────────────────────────────────────────────────────────────

const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

/** 1024-based sizes with the app's usual labels: "412 GB", "58.3 GB", "5.83 GB", and "1 TB" for a round one. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NOT_MEASURED;
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1_024;
    unit += 1;
  } while (value >= 1_024 && unit < BYTE_UNITS.length - 1);
  const digits = (next: number) => (next >= 100 ? 0 : next >= 10 ? 1 : 2);
  // 1023.96 KB rounds up to "1024 KB"; carry it into the next unit instead.
  if (Number(value.toFixed(digits(value))) >= 1_024 && unit < BYTE_UNITS.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  // Number() drops the zeros toFixed pads on: 64.00 -> "64", 58.30 -> "58.3".
  return `${Number(value.toFixed(digits(value)))} ${BYTE_UNITS[unit]}`;
}

/** The exact figure, for the tooltip behind a rounded size: "442,381,631,488 bytes". */
export function formatExactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NOT_MEASURED;
  return `${Math.round(bytes).toLocaleString()} ${Math.round(bytes) === 1 ? "byte" : "bytes"}`;
}

/** "37%", and one decimal below 10% where a whole number would hide the movement: "3.4%". */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return NOT_MEASURED;
  const value = Math.max(0, percent);
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}%`;
}

/** Clamps to 0-100 for drawing; text keeps the real number. */
export function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/**
 * A stretch of time to the nearest minute once it is a couple of minutes long ("29m 30s" reads "30m"),
 * for describing a chart's window, where the seconds are noise.
 */
export function formatWindow(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 120_000 ? formatDuration(ms) : formatDuration(Math.round(ms / 60_000) * 60_000);
}

/** "45s", "3m 12s", "2h 5m", "1d 3h"; a zero remainder is dropped ("3m"). Under a second is "<1s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const withRemainder = (major: string, minor: number, unit: string) =>
    minor === 0 ? major : `${major} ${minor}${unit}`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return withRemainder(`${minutes}m`, seconds % 60, "s");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return withRemainder(`${hours}h`, minutes % 60, "m");
  return withRemainder(`${Math.floor(hours / 24)}d`, hours % 24, "h");
}

// ── Times ────────────────────────────────────────────────────────────────────

/**
 * "3m ago", or "just now" for anything under a minute: the page's clock ticks once a minute, so a
 * seconds figure would be precision it does not have. null when the timestamp does not parse.
 */
export function formatAge(iso: string, nowMs: number): string | null {
  const label = formatElapsedDurationLabel(iso, nowMs);
  if (label === "") return null;
  return label === "just now" || label.endsWith("s") ? "just now" : `${label} ago`;
}

/** "yesterday at 2:02 PM", "10/3 2:02 PM". null when the timestamp does not parse. */
export function formatMoment(
  iso: string,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  const text = formatDayAwareTimestamp(iso, timestampFormat, nowMs);
  return text === "" ? null : text;
}

/** A date with its age beside it, so an old date reads as old: "10/3 2:02 PM (19d ago)". */
export function formatDatedAge(
  iso: string,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  const moment = formatMoment(iso, nowMs, timestampFormat);
  if (moment === null) return null;
  const age = formatAge(iso, nowMs);
  return age === null || age === "just now" ? moment : `${moment} (${age})`;
}

/** Whether two timestamps are within `toleranceMs` of each other. False if either is missing or unreadable. */
export function isWithinMs(a: string | null, b: string | null, toleranceMs: number): boolean {
  if (a === null || b === null) return false;
  const first = Date.parse(a);
  const second = Date.parse(b);
  return (
    Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= toleranceMs
  );
}

// ── Computers ────────────────────────────────────────────────────────────────

/** An online computer whose newest sample is older than this is flagged as stale. */
export const STALE_SAMPLE_AFTER_MS = 5 * 60_000;

export type DataFreshness =
  /** Nothing to qualify: show the numbers as current. */
  | { readonly kind: "current" }
  /**
   * The numbers are the last ones known. `sampledAt` is when they were measured (null if that was
   * never recorded) and `cause` says why they are not live.
   */
  | {
      readonly kind: "last-known";
      readonly cause: "offline" | "connecting" | "old-sample" | "read-failed";
      readonly sampledAt: string | null;
    };

export function resolveDataFreshness(
  connection: ComputerConnection,
  metrics: Pick<ComputerMetrics, "sampledAt"> | null,
  nowMs: number,
  /** The newest read of the computer failed, so `metrics` is an older, good one. */
  readFailed = false,
): DataFreshness {
  const sampledAt = metrics?.sampledAt ?? null;
  if (connection.status !== "online") {
    return { kind: "last-known", cause: connection.status, sampledAt };
  }
  if (readFailed && metrics !== null) {
    return { kind: "last-known", cause: "read-failed", sampledAt };
  }
  if (sampledAt !== null) {
    const sampledMs = Date.parse(sampledAt);
    if (Number.isFinite(sampledMs) && nowMs - sampledMs > STALE_SAMPLE_AFTER_MS) {
      return { kind: "last-known", cause: "old-sample", sampledAt };
    }
  }
  return { kind: "current" };
}

export interface ResolvedDiskUsage {
  readonly totalBytes: number | null;
  readonly usedBytes: number | null;
  readonly freeBytes: number | null;
  /** Used as a share of used + free (or of total when free is derived), 0-1. null if unknowable. */
  readonly usedShare: number | null;
}

const knownBytes = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Fills the one missing number of total/used/free from the other two, and never invents more than
 * that: a disk with only a total has no usage, so it has no bar rather than an empty one.
 */
export function resolveDiskUsage(
  disk: Pick<ComputerDisk, "totalBytes" | "usedBytes" | "freeBytes">,
): ResolvedDiskUsage {
  const total = knownBytes(disk.totalBytes);
  let used = knownBytes(disk.usedBytes);
  let free = knownBytes(disk.freeBytes);

  let usedShare: number | null = null;
  if (used !== null && free !== null) {
    usedShare = used + free > 0 ? used / (used + free) : null;
  } else if (used !== null && total !== null) {
    free = Math.max(0, total - used);
    usedShare = total > 0 ? used / total : null;
  } else if (free !== null && total !== null) {
    used = Math.max(0, total - free);
    usedShare = total > 0 ? used / total : null;
  }
  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    usedShare: usedShare === null ? null : Math.min(1, Math.max(0, usedShare)),
  };
}

/** A disk this full is worth noticing; the bar changes tone, nothing else. */
export const DISK_NEARLY_FULL_SHARE = 0.9;

export function isDiskNearlyFull(usedShare: number | null): boolean {
  return usedShare !== null && usedShare >= DISK_NEARLY_FULL_SHARE;
}

/** Used memory as a percent of total, or null when either is unknown. */
export function memoryUsedPercent(
  memory: Pick<ComputerMetrics["memory"], "usedBytes" | "totalBytes">,
): number | null {
  const used = knownBytes(memory.usedBytes);
  const total = knownBytes(memory.totalBytes);
  if (used === null || total === null || total <= 0) return null;
  return clampPercent((used / total) * 100);
}

// ── Search ───────────────────────────────────────────────────────────────────

/** The value standing for "no filter" in a Select, which has no null. Never a real id. */
export const ALL_FILTER_VALUE = "__all__";

export const toFilterSelectValue = (value: string | null): string => value ?? ALL_FILTER_VALUE;

export const fromFilterSelectValue = (value: string | null): string | null =>
  value === null || value === ALL_FILTER_VALUE ? null : value;

/** "12 matches", "Showing 100 of 412", or "100+ matches" when more exist and how many is not known. */
export function describeResultCount(shown: number, total: number | null, hasMore: boolean): string {
  const noun = (count: number) => (count === 1 ? "match" : "matches");
  if (total !== null && total > shown) return `Showing ${shown} of ${total}`;
  if (total === null && hasMore) return `${shown}+ matches`;
  return `${shown} ${noun(shown)}`;
}

export const FILE_LOCATION_LABELS: Record<FileLocation, string> = {
  project: "Project",
  "work-folder": "Work folder",
  "kept-archive": "Kept archive",
};

export function hasActiveFilters(filters: SearchFilters): boolean {
  return filters.projectId !== null || filters.computerId !== null || filters.fileType !== null;
}

/** Results replace the overview while there is a query or the data layer is searching. */
export function isSearching(search: Pick<ComputersSearchModel, "query" | "results">): boolean {
  return search.query.trim().length > 0 || search.results.status !== "idle";
}

export interface BackupPresentation {
  readonly label: string;
  readonly tone: "success" | "warning" | "error" | "info" | "muted";
}

export function presentBackup(backup: BackupStatus): BackupPresentation {
  switch (backup.state) {
    case "confirmed":
      return { label: "Backup confirmed", tone: "success" };
    case "published":
      return { label: "Published, not confirmed", tone: "warning" };
    case "not-verified":
      return { label: NOT_VERIFIED, tone: "muted" };
  }
}

// ── Activity ─────────────────────────────────────────────────────────────────

export type ActivityFilter = "all" | "in-progress" | "failed";

export function filterActivity(
  rows: ReadonlyArray<ActivityRow>,
  filter: ActivityFilter,
): ReadonlyArray<ActivityRow> {
  if (filter === "all") return rows;
  if (filter === "failed") return rows.filter((row) => row.status === "failed");
  return rows.filter((row) => row.status === "running" || row.status === "queued");
}

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  job: "Job",
  transfer: "Transfer",
  backup: "Backup",
  restore: "Restore",
};

export interface ActivityStatusPresentation {
  readonly label: string;
  readonly tone: "success" | "error" | "info" | "muted";
}

export function presentActivityStatus(status: ActivityStatus): ActivityStatusPresentation {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "muted" };
    case "running":
      return { label: "Running", tone: "info" };
    case "succeeded":
      return { label: "Done", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "canceled":
      return { label: "Canceled", tone: "muted" };
    case "unknown":
      return { label: "Unknown", tone: "muted" };
  }
}

/**
 * The retry to offer on a row, or null for none. A person may retry a failed transfer, backup, or
 * restore; a job is never retried from here, whatever the data layer attached.
 */
export function retryOffer(row: ActivityRow): ActivityRetry | null {
  if (row.status !== "failed" || row.kind === "job") return null;
  return row.retry;
}

/** Percent complete for a running row: the stated percent, else bytes done of total; null if neither. */
export function activityProgressPercent(progress: ActivityProgress | null): number | null {
  if (progress === null) return null;
  if (progress.percent !== null && Number.isFinite(progress.percent)) {
    return clampPercent(progress.percent);
  }
  const done = knownBytes(progress.bytesDone);
  const total = knownBytes(progress.bytesTotal);
  if (done === null || total === null || total <= 0) return null;
  return clampPercent((done / total) * 100);
}

/**
 * The time line under an activity: when it started while it runs, when it finished once it has, and how
 * long it took if both ends are known. null when the row carries no time at all.
 */
export function describeActivityTime(
  row: Pick<ActivityRow, "status" | "startedAt" | "updatedAt">,
  nowMs: number,
  timestampFormat: TimestampFormat,
): string | null {
  const age = (iso: string | null) => (iso === null ? null : formatAge(iso, nowMs));
  const dated = (iso: string | null) =>
    iso === null ? null : formatDatedAge(iso, nowMs, timestampFormat);

  if (row.status === "running" || row.status === "queued") {
    const label = row.status === "running" ? "Started" : "Queued";
    const startedAge = age(row.startedAt);
    if (startedAge !== null) return `${label} ${startedAge}`;
    const updatedAge = age(row.updatedAt);
    return updatedAge === null ? null : `Updated ${updatedAge}`;
  }

  const when = dated(row.updatedAt);
  if (when === null) return null;
  if (row.status === "unknown") return `Last changed ${when}`;
  const startedMs = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);
  const endedMs = row.updatedAt === null ? Number.NaN : Date.parse(row.updatedAt);
  const took =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? formatDuration(endedMs - startedMs)
      : "";
  return took === "" ? when : `${when} · took ${took}`;
}

// ── Details ──────────────────────────────────────────────────────────────────

const compareNullsLast = (a: number | null, b: number | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

/** Largest first; folders whose size is unknown sink below every measured one. */
export function sortFolders(folders: ReadonlyArray<FolderRow>): ReadonlyArray<FolderRow> {
  return folders.toSorted(
    (a, b) =>
      compareNullsLast(a.sizeBytes, b.sizeBytes) ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  );
}

/**
 * A folder's size as a 0-1 share of the folder it sits in. Falls back to the largest sibling when the
 * parent's total is unknown, so bars still compare; null when the folder itself is unmeasured.
 */
export function folderShare(
  folder: Pick<FolderRow, "sizeBytes">,
  scopeBytes: number | null,
  largestBytes: number | null,
): number | null {
  const size = knownBytes(folder.sizeBytes);
  if (size === null) return null;
  const scope = knownBytes(scopeBytes);
  const denominator = scope !== null && scope > 0 ? scope : largestBytes;
  if (denominator === null || denominator <= 0) return null;
  return Math.min(1, size / denominator);
}

/** The busiest process by the chosen column first; unknown values below known ones. */
export function sortProcesses(
  processes: ReadonlyArray<ProcessRow>,
  by: ProcessFocus,
): ReadonlyArray<ProcessRow> {
  const metric = (row: ProcessRow) => (by === "cpu" ? row.cpuPercent : row.memoryBytes);
  const other = (row: ProcessRow) => (by === "cpu" ? row.memoryBytes : row.cpuPercent);
  return processes.toSorted(
    (a, b) =>
      compareNullsLast(metric(a), metric(b)) ||
      compareNullsLast(other(a), other(b)) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** One line, trimmed, 1 to `KEEP_REASON_MAX_LENGTH` characters. Pasted line breaks become spaces. */
export function normalizeKeepReason(input: string): Validation<string> {
  const reason = input.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (reason.length === 0) {
    return { ok: false, message: "Say in a few words why this is worth keeping." };
  }
  if (reason.length > KEEP_REASON_MAX_LENGTH) {
    return {
      ok: false,
      message: `Shorten the reason to ${KEEP_REASON_MAX_LENGTH} characters (now ${reason.length}).`,
    };
  }
  return { ok: true, value: reason };
}

/** A non-empty single-line path. Whether it exists, and is writable, is for the computer to say. */
export function normalizeRestoreDestination(input: string): Validation<string> {
  const destination = input.trim();
  if (destination.length === 0) {
    return { ok: false, message: "Enter the folder to restore into." };
  }
  // A control character in a path is a typo or a paste accident, not a folder name.
  if (Array.from(destination).some((char) => char.charCodeAt(0) < 0x20)) {
    return { ok: false, message: "Enter the folder path on one line." };
  }
  return { ok: true, value: destination };
}
