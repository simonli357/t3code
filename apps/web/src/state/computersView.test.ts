import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type ComputerActivity, type ComputerInspection } from "@t3tools/contracts";
import type { ComputerCache } from "./computersCache";
import type { EnvironmentPresentation } from "./environments";
import { activityRow, panel, processList, searchCaveats } from "./computersView";

const offline = {
  environmentId: EnvironmentId.make("computer-a"),
  label: "Laptop",
  displayUrl: null,
  connection: { phase: "offline" as const, error: "Disconnected", traceId: null },
  serverConfig: null,
};
const connected = {
  ...offline,
  connection: { phase: "connected" as const, error: null, traceId: null },
};
// Only the part the page reads; the rest of a server's configuration is irrelevant here.
const outdatedServer = {
  environment: { capabilities: { computers: false }, platform: { machine: "linux" } },
} as unknown as NonNullable<EnvironmentPresentation["serverConfig"]>;

const snapshot: ComputerInspection = {
  sampledAt: 1000,
  resources: {
    sampledAt: 1000,
    cpuUtilization: null,
    cpuCount: 0,
    totalMemoryBytes: 0,
    availableMemoryBytes: 0,
  },
  history: [],
  disks: [
    { path: "/data", label: "/dev/disk", totalBytes: 100, freeBytes: 40, availableBytes: 30 },
  ],
  files: [],
  totalFiles: 0,
  indexedAt: null,
  indexing: false,
  projects: [],
  processes: [],
  activities: [],
  errors: [],
};
const nothingSaved: ComputerCache = {
  overview: null,
  activity: null,
};
const activity = (overrides: Partial<ComputerActivity>): ComputerActivity => ({
  id: "a1",
  kind: "transfer",
  label: "Keep drawings",
  status: "published",
  updatedAt: 1000,
  detail: null,
  source: "/work/drawings",
  retryable: false,
  ...overrides,
});

describe("a computer's panel", () => {
  it("keeps dated offline readings without replacing unknown CPU or RAM with zero", () => {
    const result = panel(offline, { ...nothingSaved, overview: snapshot }, null);
    expect(result.connection).toEqual({
      status: "offline",
      lastSeenAt: "1970-01-01T00:00:01.000Z",
      reason: "Disconnected",
    });
    expect(result.canInspect).toBe(false);
    expect(result.metrics?.cpu.percent).toBeNull();
    expect(result.metrics?.memory.totalBytes).toBeNull();
    expect(result.metrics?.disks[0]).toMatchObject({
      usedBytes: 60,
      freeBytes: 30,
      totalBytes: 100,
    });
  });

  it("does not invent a last seen time for a computer never measured", () => {
    expect(panel(offline, nothingSaved, null).connection).toMatchObject({ lastSeenAt: null });
  });

  it("calls a server outdated only once it has said what it supports", () => {
    expect(panel(connected, nothingSaved, null).metricsError).toBeNull();
    expect(
      panel({ ...connected, serverConfig: outdatedServer }, nothingSaved, null).metricsError,
    ).toBe("Update this computer’s T3 server to read computer details.");
  });
});

describe("activity rows", () => {
  it.each([
    ["published", "succeeded"],
    ["delivered", "succeeded"],
    ["pending", "queued"],
    ["copying", "unknown"],
    ["creating", "unknown"],
    ["cancelled", "canceled"],
    ["invalid", "failed"],
    ["setup-failed", "failed"],
    ["interrupted", "failed"],
    ["active", "unknown"],
    ["expired", "unknown"],
    ["something-new", "unknown"],
  ] as const)("shows %s as %s", (reported, shown) => {
    expect(activityRow(connected, activity({ status: reported })).status).toBe(shown);
  });

  it("never calls a job workspace that exists running, and says what it was reported as", () => {
    const row = activityRow(
      connected,
      activity({
        kind: "job",
        status: "active",
        detail: "Workenv job record; active does not imply a running process.",
      }),
    );
    expect(row.status).toBe("unknown");
    expect(row.note).toBe("Active · Workenv job record; active does not imply a running process.");
    expect(row.retry).toBeNull();
  });

  it("gives a stopped action's own words as its reason, or names the status when there are none", () => {
    expect(
      activityRow(
        connected,
        activity({ status: "interrupted", detail: "Server stopped before recording a result." }),
      ),
    ).toMatchObject({ failureReason: "Server stopped before recording a result.", note: null });
    expect(activityRow(connected, activity({ status: "setup-failed" })).failureReason).toBe(
      "Setup-failed",
    );
    expect(activityRow(connected, activity({ status: "failed" })).failureReason).toBeNull();
  });

  it("offers retry for a failed backup or transfer only while the computer is connected", () => {
    const backup = activity({
      kind: "backup",
      status: "failed",
      detail: "Disk full",
      retryable: true,
    });
    expect(activityRow(offline, backup).retry).toEqual({
      state: "unavailable",
      reason: "Computer is offline",
    });
    expect(activityRow(connected, backup).retry).toEqual({ state: "available" });
    const transfer = activity({ status: "failed", retryable: true });
    expect(activityRow(connected, transfer).retry).toEqual({ state: "available" });
    expect(activityRow(connected, activity({ status: "failed" })).retry).toBeNull();
    expect(
      activityRow(connected, activity({ kind: "backup", status: "failed", retryable: false }))
        .retry,
    ).toBeNull();
    expect(activityRow(connected, activity({ status: "published" })).retry).toBeNull();
  });
});

describe("why a search may be short", () => {
  const savedIndex: ComputerInspection = { ...snapshot, indexedAt: 2000 };

  it("requires offline computers to come online for search", () => {
    expect(searchCaveats(offline, null, [])).toEqual(["Search needs this computer online."]);
  });

  it("says an outdated server cannot be searched, but not while it is still loading its configuration", () => {
    expect(searchCaveats({ ...connected, serverConfig: outdatedServer }, null, [])).toEqual([
      "Update this computer’s T3 server to search its files.",
    ]);
    expect(searchCaveats(connected, null, [])).toEqual([]);
  });

  it("passes on what the computer and the browser reported, and says when it is still indexing", () => {
    const indexing: ComputerInspection = {
      ...savedIndex,
      indexing: true,
      errors: ["File index reached its bounded scan limit."],
    };
    expect(
      searchCaveats(connected, indexing, ["Could not save offline data: quota exceeded", null]),
    ).toEqual([
      "Could not save offline data: quota exceeded",
      "File index reached its bounded scan limit.",
      "Indexing; results are incomplete. Refresh to try again.",
    ]);
  });
});

describe("the process list", () => {
  const result: ComputerInspection = {
    ...snapshot,
    processes: [
      {
        pid: 10,
        name: "cmake",
        cpuPercent: 12.5,
        memoryBytes: 1000,
        command: "cmake --build .",
        owner: "simon",
        jobId: "job:scandy-control-abc",
      },
      {
        pid: 11,
        name: "node",
        cpuPercent: null,
        memoryBytes: 2000,
        command: null,
        owner: null,
        jobId: null,
      },
      {
        pid: 12,
        name: "ld",
        cpuPercent: 1,
        memoryBytes: 10,
        command: null,
        owner: "simon",
        jobId: "job:gone",
      },
    ],
  };
  const activities = [
    activity({
      id: "job:scandy-control-abc",
      kind: "job",
      label: "scandy-control",
      status: "running",
    }),
    activity({ id: "job:utility-def", kind: "job", label: "utility", status: "active" }),
    activity({ id: "k1", kind: "transfer", status: "running" }),
  ];

  it("names a process's job only from what the computer said, and keeps unknown figures unknown", () => {
    const { processes } = processList(connected, result, activities);
    expect(processes[0]).toMatchObject({
      command: "cmake --build .",
      owner: "simon",
      job: { id: "job:scandy-control-abc", title: "scandy-control" },
    });
    expect(processes[1]).toMatchObject({ cpuPercent: null, command: null, owner: null, job: null });
    expect(processes[2]?.job).toEqual({ id: "job:gone", title: "gone" });
  });

  it("lists as running only the jobs the computer reports running", () => {
    const { jobs, totalCount } = processList(connected, result, activities);
    expect(jobs.map((job) => job.title)).toEqual(["scandy-control"]);
    expect(totalCount).toBe(3);
  });
});
