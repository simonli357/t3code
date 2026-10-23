import { describe, expect, it } from "vite-plus/test";

import {
  ALL_FILTER_VALUE,
  DISK_NEARLY_FULL_SHARE,
  NOT_MEASURED,
  NOT_VERIFIED,
  STALE_SAMPLE_AFTER_MS,
  activityProgressPercent,
  describeActivityTime,
  describeResultCount,
  filterActivity,
  folderShare,
  formatAge,
  formatBytes,
  formatDatedAge,
  formatDuration,
  formatExactBytes,
  formatPercent,
  formatWindow,
  fromFilterSelectValue,
  hasActiveFilters,
  isDiskNearlyFull,
  isSearching,
  isWithinMs,
  memoryUsedPercent,
  normalizeKeepReason,
  normalizeRestoreDestination,
  presentActivityStatus,
  presentBackup,
  resolveDataFreshness,
  resolveDiskUsage,
  retryOffer,
  sortFolders,
  sortProcesses,
  toFilterSelectValue,
} from "./computersFormat";
import {
  KEEP_REASON_MAX_LENGTH,
  type ActivityRow,
  type FolderRow,
  type ProcessRow,
} from "./computersViewModel";

const GB = 1_024 ** 3;

describe("formatBytes", () => {
  it("writes sizes in the app's 1024-based units, with a precision that fits the magnitude and no padding zeros", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(5.83 * GB)).toBe("5.83 GB");
    expect(formatBytes(58.3 * GB)).toBe("58.3 GB");
    expect(formatBytes(412 * GB)).toBe("412 GB");
    expect(formatBytes(1_024 * GB)).toBe("1 TB");
    expect(formatBytes(64 * GB)).toBe("64 GB");
  });

  it("carries a size that rounds up to the next unit instead of printing 1024", () => {
    expect(formatBytes(1_048_575)).toBe("1 MB");
  });

  it("reports an unreadable number as not measured rather than as a size", () => {
    expect(formatBytes(Number.NaN)).toBe(NOT_MEASURED);
    expect(formatBytes(-1)).toBe(NOT_MEASURED);
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(NOT_MEASURED);
  });

  it("keeps the exact byte count for the tooltip", () => {
    expect(formatExactBytes(1)).toBe("1 byte");
    expect(formatExactBytes(442_381_631_488)).toBe(`${(442_381_631_488).toLocaleString()} bytes`);
  });
});

describe("formatPercent", () => {
  it("shows a decimal only below 10% where it carries information", () => {
    expect(formatPercent(37.2)).toBe("37%");
    expect(formatPercent(3.44)).toBe("3.4%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("does not print a negative or unreadable percent", () => {
    expect(formatPercent(-2)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe(NOT_MEASURED);
  });
});

describe("formatDuration", () => {
  it("drops a zero remainder", () => {
    expect(formatDuration(400)).toBe("<1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(180_000)).toBe("3m");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(93_600_000)).toBe("1d 2h");
    expect(formatDuration(-5)).toBe("");
  });
});

describe("formatWindow", () => {
  it("rounds a chart's window to the minute once it is a couple of minutes long", () => {
    expect(formatWindow(45_000)).toBe("45s");
    expect(formatWindow(29 * 60_000 + 30_000)).toBe("30m");
    expect(formatWindow(58 * 60_000)).toBe("58m");
    expect(formatWindow(3_900_000)).toBe("1h 5m");
  });
});

describe("formatDatedAge", () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();

  it("pairs a date with its age so an old date reads as old", () => {
    const iso = new Date(2026, 9, 22, 14, 2).toISOString();
    expect(formatDatedAge(iso, now, "24-hour")).toContain("(58m ago)");
    expect(formatAge(iso, now)).toBe("58m ago");
  });

  it("does not claim sub-minute precision from a clock that ticks once a minute", () => {
    expect(formatAge(new Date(now - 35_000).toISOString(), now)).toBe("just now");
    expect(formatAge(new Date(now - 90_000).toISOString(), now)).toBe("1m ago");
  });

  it("returns null for a timestamp that does not parse, never a made-up date", () => {
    expect(formatDatedAge("not a date", now, "locale")).toBeNull();
    expect(formatAge("not a date", now)).toBeNull();
  });
});

describe("resolveDiskUsage", () => {
  it("shows used against used plus free, so a reserved slice does not read as free space", () => {
    const usage = resolveDiskUsage({ totalBytes: 1_000, usedBytes: 400, freeBytes: 550 });
    expect(usage.usedShare).toBeCloseTo(400 / 950);
    expect(usage.totalBytes).toBe(1_000);
  });

  it("derives the one missing number from the other two", () => {
    expect(resolveDiskUsage({ totalBytes: 1_000, usedBytes: 250, freeBytes: null })).toMatchObject({
      freeBytes: 750,
      usedShare: 0.25,
    });
    expect(resolveDiskUsage({ totalBytes: 1_000, usedBytes: null, freeBytes: 900 })).toMatchObject({
      usedBytes: 100,
      usedShare: 0.1,
    });
  });

  it("has no bar when usage is unknown, instead of an empty one", () => {
    expect(resolveDiskUsage({ totalBytes: 1_000, usedBytes: null, freeBytes: null })).toEqual({
      totalBytes: 1_000,
      usedBytes: null,
      freeBytes: null,
      usedShare: null,
    });
    expect(resolveDiskUsage({ totalBytes: null, usedBytes: null, freeBytes: null }).usedShare).toBe(
      null,
    );
  });

  it("treats unreadable numbers as unknown and clamps an inconsistent report", () => {
    expect(resolveDiskUsage({ totalBytes: 100, usedBytes: Number.NaN, freeBytes: null })).toEqual({
      totalBytes: 100,
      usedBytes: null,
      freeBytes: null,
      usedShare: null,
    });
    expect(resolveDiskUsage({ totalBytes: 100, usedBytes: 150, freeBytes: null }).usedShare).toBe(
      1,
    );
    expect(resolveDiskUsage({ totalBytes: 0, usedBytes: 0, freeBytes: null }).usedShare).toBe(null);
  });
});

describe("isDiskNearlyFull", () => {
  it("flags only a known share at or above the threshold", () => {
    expect(isDiskNearlyFull(DISK_NEARLY_FULL_SHARE)).toBe(true);
    expect(isDiskNearlyFull(0.89)).toBe(false);
    expect(isDiskNearlyFull(null)).toBe(false);
  });
});

describe("memoryUsedPercent", () => {
  it("is null unless both numbers are known", () => {
    expect(memoryUsedPercent({ usedBytes: 21 * GB, totalBytes: 64 * GB })).toBeCloseTo(32.8, 1);
    expect(memoryUsedPercent({ usedBytes: null, totalBytes: 64 * GB })).toBeNull();
    expect(memoryUsedPercent({ usedBytes: 1, totalBytes: 0 })).toBeNull();
  });
});

describe("resolveDataFreshness", () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  it("calls a recent sample from an online computer current", () => {
    expect(resolveDataFreshness({ status: "online" }, { sampledAt: minutesAgo(1) }, now)).toEqual({
      kind: "current",
    });
  });

  it("flags an online computer whose newest sample is old", () => {
    const sampledAt = minutesAgo(STALE_SAMPLE_AFTER_MS / 60_000 + 1);
    expect(resolveDataFreshness({ status: "online" }, { sampledAt }, now)).toEqual({
      kind: "last-known",
      cause: "old-sample",
      sampledAt,
    });
  });

  it("marks the metrics of an online computer as last known when the newest read failed", () => {
    const sampledAt = minutesAgo(1);
    expect(resolveDataFreshness({ status: "online" }, { sampledAt }, now, true)).toEqual({
      kind: "last-known",
      cause: "read-failed",
      sampledAt,
    });
    // With nothing to show there is nothing to qualify; the error stands alone.
    expect(resolveDataFreshness({ status: "online" }, null, now, true)).toEqual({
      kind: "current",
    });
  });

  it("dates the last known data of an offline computer, or says there is none", () => {
    const offline = { status: "offline", lastSeenAt: minutesAgo(900), reason: null } as const;
    expect(resolveDataFreshness(offline, { sampledAt: minutesAgo(900) }, now)).toEqual({
      kind: "last-known",
      cause: "offline",
      sampledAt: minutesAgo(900),
    });
    expect(resolveDataFreshness(offline, null, now)).toEqual({
      kind: "last-known",
      cause: "offline",
      sampledAt: null,
    });
    expect(
      resolveDataFreshness({ status: "connecting", lastSeenAt: null }, null, now),
    ).toMatchObject({ kind: "last-known", cause: "connecting" });
  });
});

describe("search state", () => {
  it("replaces the overview while there is a query or a search in flight", () => {
    expect(isSearching({ query: "  ", results: { status: "idle" } })).toBe(false);
    expect(isSearching({ query: "drawing", results: { status: "idle" } })).toBe(true);
    expect(isSearching({ query: "", results: { status: "loading" } })).toBe(true);
  });

  it("maps no filter to a Select value that cannot be a real id and back", () => {
    expect(toFilterSelectValue(null)).toBe(ALL_FILTER_VALUE);
    expect(fromFilterSelectValue(ALL_FILTER_VALUE)).toBeNull();
    expect(fromFilterSelectValue(null)).toBeNull();
    expect(fromFilterSelectValue(toFilterSelectValue("pdf"))).toBe("pdf");
  });

  it("notices a filter even with no query", () => {
    expect(hasActiveFilters({ projectId: null, computerId: null, fileType: null })).toBe(false);
    expect(hasActiveFilters({ projectId: null, computerId: "sliara", fileType: null })).toBe(true);
  });
});

describe("presentBackup", () => {
  it("says Not verified when nothing has confirmed the backup", () => {
    expect(presentBackup({ state: "not-verified" })).toEqual({
      label: NOT_VERIFIED,
      tone: "muted",
    });
    expect(NOT_VERIFIED).toBe("Not verified");
  });

  it("does not call a published but unchecked copy backed up", () => {
    expect(presentBackup({ state: "published", at: null, where: null })).toEqual({
      label: "Published, not confirmed",
      tone: "warning",
    });
    expect(presentBackup({ state: "confirmed", at: null, where: null }).tone).toBe("success");
  });
});

const activity = (overrides: Partial<ActivityRow>): ActivityRow => ({
  id: "a",
  kind: "transfer",
  status: "failed",
  title: "Copy drawings",
  context: null,
  startedAt: null,
  updatedAt: null,
  progress: null,
  failureReason: "rsync: permission denied",
  note: null,
  retry: { state: "available" },
  ...overrides,
});

describe("retryOffer", () => {
  it("offers retry for a failed transfer, backup, or restore", () => {
    expect(retryOffer(activity({ kind: "transfer" }))).toEqual({ state: "available" });
    expect(retryOffer(activity({ kind: "backup" }))).toEqual({ state: "available" });
    expect(retryOffer(activity({ kind: "restore" }))).toEqual({ state: "available" });
  });

  it("never offers retry for a job, or for anything that did not fail", () => {
    expect(retryOffer(activity({ kind: "job" }))).toBeNull();
    expect(retryOffer(activity({ status: "succeeded" }))).toBeNull();
    expect(retryOffer(activity({ status: "running" }))).toBeNull();
  });

  it("passes through why a retry is not possible", () => {
    const retry = { state: "unavailable", reason: "nas-archive is offline" } as const;
    expect(retryOffer(activity({ retry }))).toEqual(retry);
    expect(retryOffer(activity({ retry: null }))).toBeNull();
  });
});

describe("activity presentation", () => {
  it("never turns a status it could not map into running or done", () => {
    expect(presentActivityStatus("unknown")).toEqual({ label: "Unknown", tone: "muted" });
  });

  it("filters by what needs attention or is still going", () => {
    const rows = [
      activity({ id: "1", status: "failed" }),
      activity({ id: "2", status: "running" }),
      activity({ id: "3", status: "queued" }),
      activity({ id: "4", status: "succeeded" }),
    ];
    expect(filterActivity(rows, "all")).toHaveLength(4);
    expect(filterActivity(rows, "failed").map((row) => row.id)).toEqual(["1"]);
    expect(filterActivity(rows, "in-progress").map((row) => row.id)).toEqual(["2", "3"]);
  });
});

const folder = (name: string, sizeBytes: number | null): FolderRow => ({
  path: `/data/${name}`,
  name,
  kind: "folder",
  sizeBytes,
  note: null,
  openable: true,
});

describe("sortFolders", () => {
  it("sorts largest first, puts unmeasured entries last, and leaves the input alone", () => {
    const input = [folder("b", 10), folder("unread", null), folder("a", 10), folder("big", 99)];
    expect(sortFolders(input).map((row) => row.name)).toEqual(["big", "a", "b", "unread"]);
    expect(input.map((row) => row.name)).toEqual(["b", "unread", "a", "big"]);
  });
});

describe("folderShare", () => {
  it("is the folder's share of the folder it sits in", () => {
    expect(folderShare({ sizeBytes: 25 }, 100, 80)).toBe(0.25);
  });

  it("falls back to the largest sibling when the parent size is unknown", () => {
    expect(folderShare({ sizeBytes: 40 }, null, 80)).toBe(0.5);
  });

  it("has no share for an unmeasured folder, and never exceeds 1", () => {
    expect(folderShare({ sizeBytes: null }, 100, 80)).toBeNull();
    expect(folderShare({ sizeBytes: 500 }, 100, 500)).toBe(1);
  });
});

const proc = (key: string, cpuPercent: number | null, memoryBytes: number | null): ProcessRow => ({
  key,
  name: key,
  command: null,
  pid: null,
  cpuPercent,
  memoryBytes,
  owner: null,
  job: null,
});

describe("sortProcesses", () => {
  const rows = [proc("idle", 0, 5), proc("unknown-cpu", null, 900), proc("busy", 80, 100)];

  it("sorts by the chosen column, with unknown values below known ones", () => {
    expect(sortProcesses(rows, "cpu").map((row) => row.key)).toEqual([
      "busy",
      "idle",
      "unknown-cpu",
    ]);
    expect(sortProcesses(rows, "memory").map((row) => row.key)).toEqual([
      "unknown-cpu",
      "busy",
      "idle",
    ]);
  });

  it("does not rank an unknown figure as zero", () => {
    expect(sortProcesses([proc("a", null, 1), proc("b", 0, 1)], "cpu")[0]?.key).toBe("b");
  });
});

describe("normalizeKeepReason", () => {
  it("trims, and turns a pasted line break into a space so the reason stays one line", () => {
    expect(normalizeKeepReason("  final drawings\nsent to client  ")).toEqual({
      ok: true,
      value: "final drawings sent to client",
    });
  });

  it("requires a reason", () => {
    expect(normalizeKeepReason("   \n ").ok).toBe(false);
  });

  it("accepts the longest allowed reason and rejects one character more", () => {
    expect(normalizeKeepReason("x".repeat(KEEP_REASON_MAX_LENGTH)).ok).toBe(true);
    expect(normalizeKeepReason("x".repeat(KEEP_REASON_MAX_LENGTH + 1)).ok).toBe(false);
  });
});

describe("normalizeRestoreDestination", () => {
  it("trims the folder and requires one", () => {
    expect(normalizeRestoreDestination("  /data/restore ")).toEqual({
      ok: true,
      value: "/data/restore",
    });
    expect(normalizeRestoreDestination("  ").ok).toBe(false);
  });

  it("rejects a path with a line break in it", () => {
    expect(normalizeRestoreDestination("/data/a\n/data/b").ok).toBe(false);
  });
});

describe("isWithinMs", () => {
  it("compares two timestamps, and is false when either is missing or unreadable", () => {
    const a = "2026-10-22T12:00:00.000Z";
    expect(isWithinMs(a, "2026-10-22T12:01:00.000Z", 120_000)).toBe(true);
    expect(isWithinMs(a, "2026-10-22T12:05:00.000Z", 120_000)).toBe(false);
    expect(isWithinMs(a, null, 120_000)).toBe(false);
    expect(isWithinMs("garbage", a, 120_000)).toBe(false);
  });
});

describe("describeResultCount", () => {
  it("says how many of how many when the page is short of the total", () => {
    expect(describeResultCount(100, 412, true)).toBe("Showing 100 of 412");
    expect(describeResultCount(1, 1, false)).toBe("1 match");
    expect(describeResultCount(12, 12, false)).toBe("12 matches");
  });

  it("does not claim a total it does not have", () => {
    expect(describeResultCount(100, null, true)).toBe("100+ matches");
    expect(describeResultCount(7, null, false)).toBe("7 matches");
  });
});

describe("activityProgressPercent", () => {
  it("prefers the stated percent, else derives it from bytes, else has none", () => {
    expect(activityProgressPercent({ percent: 40, bytesDone: 1, bytesTotal: 100 })).toBe(40);
    expect(activityProgressPercent({ percent: null, bytesDone: 25, bytesTotal: 100 })).toBe(25);
    expect(activityProgressPercent({ percent: null, bytesDone: null, bytesTotal: 100 })).toBeNull();
    expect(activityProgressPercent({ percent: null, bytesDone: 5, bytesTotal: 0 })).toBeNull();
    expect(activityProgressPercent(null)).toBeNull();
  });

  it("keeps the bar inside its track", () => {
    expect(activityProgressPercent({ percent: 140, bytesDone: null, bytesTotal: null })).toBe(100);
  });
});

describe("describeActivityTime", () => {
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  const at = (hour: number, minute: number, second = 0) =>
    new Date(2026, 9, 22, hour, minute, second).toISOString();

  it("says when a running row started, and falls back to its last change", () => {
    expect(
      describeActivityTime(
        { status: "running", startedAt: at(14, 48), updatedAt: null },
        now,
        "24-hour",
      ),
    ).toBe("Started 12m ago");
    expect(
      describeActivityTime(
        { status: "queued", startedAt: null, updatedAt: at(14, 58) },
        now,
        "24-hour",
      ),
    ).toBe("Updated 2m ago");
    expect(
      describeActivityTime(
        { status: "queued", startedAt: null, updatedAt: at(14, 59, 40) },
        now,
        "24-hour",
      ),
    ).toBe("Updated just now");
  });

  it("gives a finished row its date and how long it took", () => {
    const text = describeActivityTime(
      { status: "failed", startedAt: at(14, 2), updatedAt: at(14, 5, 12) },
      now,
      "24-hour",
    );
    expect(text).toContain("(54m ago)");
    expect(text).toContain("took 3m 12s");
  });

  it("has nothing to say when the row carries no time", () => {
    expect(
      describeActivityTime(
        { status: "succeeded", startedAt: null, updatedAt: null },
        now,
        "locale",
      ),
    ).toBeNull();
    expect(
      describeActivityTime({ status: "running", startedAt: null, updatedAt: null }, now, "locale"),
    ).toBeNull();
  });

  it("calls a status it could not map a last change, not a finish", () => {
    expect(
      describeActivityTime(
        { status: "unknown", startedAt: null, updatedAt: at(14, 0) },
        now,
        "24-hour",
      ),
    ).toMatch(/^Last changed /);
  });
});
