import { describe, expect, it } from "@effect/vitest";
import type { StorageDisks, StorageSize } from "@t3tools/contracts";
import {
  buildHoldings,
  locate,
  workspaceState,
  type ArchiveInfo,
  type BackupInfo,
  type HoldingsInput,
  type WorkspaceSource,
} from "./StorageHoldings.ts";
import type { LifecycleRecord } from "./StorageLifecycle.ts";

const GiB = 1024 ** 3;
const now = 1_792_000_000_000;
const ROOT = "/work/jobs";

const disks: StorageDisks = {
  sampledAt: now,
  host: "alpha",
  os: "linux",
  reserveSource: null,
  notices: [],
  advanced: [],
  remote: [
    {
      id: "/mnt/shared",
      label: "/mnt/shared",
      protocol: "sshfs",
      host: "beta",
      backing: "/srv/shared",
      mountPaths: ["/mnt/shared"],
      capacityBytes: null,
      usedBytes: null,
      availableBytes: null,
      measuredAt: null,
    },
  ],
  disks: [
    {
      id: "/dev/nvme0n1",
      label: "System SSD",
      model: "System SSD",
      bus: "NVMe",
      media: "ssd",
      sizeBytes: 1000 * GiB,
      volumes: [
        {
          id: "/",
          label: "/",
          mountPaths: ["/", "/srv/library"],
          filesystem: "ext4",
          device: "/dev/nvme0n1p2",
          role: "system",
          capacityBytes: 900 * GiB,
          usedBytes: 700 * GiB,
          availableBytes: 200 * GiB,
          reserveBytes: null,
          headroomBytes: null,
          holds: [],
          measuredAt: now,
        },
      ],
      system: [],
    },
    {
      id: "/dev/sdb",
      label: "Backup HDD",
      model: "Backup HDD",
      bus: "SATA",
      media: "hdd",
      sizeBytes: 500 * GiB,
      volumes: [
        {
          id: "/backup",
          label: "backup-disk",
          mountPaths: ["/backup"],
          filesystem: "ext4",
          device: "/dev/sdb1",
          role: "data",
          capacityBytes: 500 * GiB,
          usedBytes: 100 * GiB,
          availableBytes: 400 * GiB,
          reserveBytes: null,
          headroomBytes: null,
          holds: [],
          measuredAt: now,
        },
      ],
      system: [],
    },
  ],
};

const measured = (bytes: number, extra: Partial<StorageSize> = {}): StorageSize => ({
  bytes,
  complete: true,
  measuredAt: now - 1000,
  basis: "allocated",
  ...extra,
});

const source = (name: string, extra: Partial<WorkspaceSource> = {}): WorkspaceSource => ({
  root: `${ROOT}/${name}`,
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
  ...extra,
});

const record = (name: string, extra: Partial<LifecycleRecord> = {}): LifecycleRecord => ({
  job: `${ROOT}/${name}`,
  status: "active",
  observedAt: now - 5000,
  lastActivityAt: now - 3600_000,
  expiresAt: null,
  holdReasons: [],
  pending: [],
  allocatedBytes: null,
  allocationBasis: null,
  recoveryBytes: null,
  recoveryRefs: 0,
  ...extra,
});

const archive = (id: string, extra: Partial<ArchiveInfo> = {}): ArchiveInfo => ({
  id,
  title: `Evidence ${id}`,
  project: "app",
  collection: "evidence",
  source: `${ROOT}/job-a/outputs`,
  createdAt: now - 86_400_000,
  files: 4,
  logicalBytes: 10 * GiB,
  writerPath: `/srv/library/projects/app/evidence/${id}`,
  local: true,
  host: "alpha",
  backup: "confirmed",
  backupVerifiedAt: now - 3600_000,
  backupSnapshot: "bf674190",
  backupRequired: true,
  ...extra,
});

const input = (extra: Partial<HoldingsInput> = {}): HoldingsInput => ({
  host: "alpha",
  now,
  platform: "linux",
  disks,
  workspaces: [],
  lifecycle: [],
  lifecycleAvailable: true,
  jobRoots: [ROOT],
  archives: [],
  archiveProblem: null,
  archiveSupported: true,
  libraryPaths: new Set(),
  backups: [],
  backupProblem: null,
  backupSupported: true,
  retained: [],
  retainedSupported: true,
  sizes: () => null,
  ram: () => [],
  measuring: false,
  notices: [],
  ...extra,
});

const group = (result: ReturnType<typeof buildHoldings>, id: string) =>
  result.groups.find((entry) => entry.group === id)!;

describe("the four groups", () => {
  it("are always exactly Workspaces, Archives, Backups and Other, in that order", () => {
    const result = buildHoldings(input());
    expect(result.groups.map((entry) => entry.group)).toEqual([
      "workspaces",
      "archives",
      "backups",
      "other",
    ]);
  });

  it("say that a part is unsupported, with the reason, when the lifecycle tool is not installed", () => {
    const result = buildHoldings(
      input({
        lifecycleAvailable: false,
        archiveSupported: false,
        backupSupported: false,
        retainedSupported: false,
        jobRoots: [],
      }),
    );
    expect(group(result, "workspaces")).toMatchObject({ status: "unsupported", count: 0 });
    expect(group(result, "archives")).toMatchObject({ status: "unsupported", count: 0 });
    expect(group(result, "archives").reason).toMatch(/lifecycle tool/);
    expect(group(result, "backups")).toMatchObject({ status: "unsupported" });
    expect(group(result, "other")).toMatchObject({ status: "partial" });
    // No size anywhere: the totals are unknown, not zero.
    for (const entry of result.groups) expect(entry.bytes).toBeNull();
  });

  it("marks workspaces partial when no lifecycle tool reports retention", () => {
    const result = buildHoldings(
      input({ lifecycleAvailable: false, workspaces: [source("job-a")] }),
    );
    expect(group(result, "workspaces")).toMatchObject({ status: "partial", count: 1 });
    expect(group(result, "workspaces").entries[0]!.workspace).toMatchObject({
      state: "unknown",
      stateSource: "none",
    });
    expect(group(result, "workspaces").entries[0]!.workspace!.retention).toMatch(
      /removed manually/,
    );
  });
});

describe("workspaces", () => {
  it("take their state from the lifecycle record first and from the session otherwise", () => {
    expect(workspaceState(record("a", { status: "grace" }), undefined).state).toBe(
      "cleanup-eligible",
    );
    expect(
      workspaceState(record("a", { status: "held", pending: ["backup pending"] }), undefined).state,
    ).toBe("preservation-pending");
    expect(
      workspaceState(record("a", { status: "held", holdReasons: ["owner unresolved"] }), undefined)
        .state,
    ).toBe("held");
    expect(workspaceState(record("a", { status: "active" }), undefined)).toEqual({
      state: "active",
      stateSource: "lifecycle",
    });
    expect(workspaceState(undefined, { threadState: "running" })).toEqual({
      state: "active",
      stateSource: "session",
    });
    expect(workspaceState(undefined, { threadState: "archived" })).toEqual({
      state: "completed",
      stateSource: "session",
    });
    expect(workspaceState(undefined, undefined)).toEqual({ state: "unknown", stateSource: "none" });
    // The tool's record outranks what the session says.
    expect(workspaceState(record("a", { status: "grace" }), { threadState: "running" }).state).toBe(
      "cleanup-eligible",
    );
  });

  it("show the whole job with owner, disk, state, expiry and the concrete retention reason", () => {
    const result = buildHoldings(
      input({
        workspaces: [
          source("job-a", {
            threadId: "t-1",
            title: "Fix the importer",
            session: "Fix the importer",
            project: "app",
            master: "Release planning",
            threadState: "idle",
            threadUpdatedAt: now - 7200_000,
          }),
        ],
        lifecycle: [
          record("job-a", {
            status: "held",
            holdReasons: ["Required independent backup is pending"],
            pending: ["Required independent backup is pending"],
            allocatedBytes: 2 * GiB,
          }),
        ],
      }),
    );
    const entry = group(result, "workspaces").entries[0]!;
    expect(entry).toMatchObject({
      title: "Fix the importer",
      subtitle: "app · Worker of Release planning",
      host: "alpha",
      local: true,
      location: `${ROOT}/job-a`,
      disk: { disk: "System SSD", volume: "/" },
    });
    expect(entry.workspace).toMatchObject({
      owner: { project: "app", master: "Release planning", session: "Fix the importer" },
      state: "preservation-pending",
      stateSource: "lifecycle",
      lastActivityAt: now - 3600_000,
      retention: "Required independent backup is pending",
      preservation: ["Required independent backup is pending"],
    });
    // The lifecycle tool's number is a conservative estimate and is shown as one.
    expect(entry.size).toMatchObject({ bytes: 2 * GiB, complete: false, basis: "lifecycle" });
  });

  it("show an expiry only when the lifecycle tool records one", () => {
    const result = buildHoldings(
      input({
        workspaces: [source("grace"), source("active")],
        lifecycle: [
          record("grace", { status: "grace", expiresAt: now + 3600_000 }),
          record("active", { status: "active" }),
        ],
      }),
    );
    const byTitle = Object.fromEntries(
      group(result, "workspaces").entries.map((entry) => [entry.title, entry.workspace!]),
    );
    expect(byTitle.grace).toMatchObject({ state: "cleanup-eligible", expiresAt: now + 3600_000 });
    expect(byTitle.active).toMatchObject({ state: "active", expiresAt: null });
  });

  it("list RAM-backed paths under their job and leave them out of the disk total", () => {
    const result = buildHoldings(
      input({
        workspaces: [source("job-a")],
        sizes: (path) => (path === `${ROOT}/job-a` ? measured(3 * GiB) : null),
        ram: (root) =>
          root === `${ROOT}/job-a`
            ? [
                {
                  path: `${ROOT}/job-a/scratch`,
                  usedBytes: 6 * GiB,
                  limitBytes: 12 * GiB,
                  measuredAt: now,
                },
              ]
            : [],
      }),
    );
    const workspaces = group(result, "workspaces");
    expect(workspaces.entries[0]!.ram).toEqual([
      { path: `${ROOT}/job-a/scratch`, usedBytes: 6 * GiB, limitBytes: 12 * GiB, measuredAt: now },
    ]);
    expect(workspaces.bytes).toBe(3 * GiB);
    expect(workspaces.ramBytes).toBe(6 * GiB);
  });

  it("keep historical work outside the current job roots, and drop only what was removed", () => {
    const result = buildHoldings(
      input({
        lifecycle: [
          record("job-a"),
          {
            ...record("old"),
            job: "/legacy/trees/old-tree",
            status: "held",
            holdReasons: ["Ownership unresolved"],
          },
          { ...record("gone"), status: "removed", recoveryRefs: 2, recoveryBytes: 5 * GiB },
          { ...record("gone-too"), status: "removed", recoveryRefs: 1, recoveryBytes: 1 * GiB },
        ],
      }),
    );
    const titles = group(result, "workspaces").entries.map((entry) => entry.title);
    expect(titles.toSorted()).toEqual(["job-a", "old-tree"]);
    const legacy = group(result, "workspaces").entries.find((entry) => entry.title === "old-tree")!;
    expect(legacy.workspace).toMatchObject({ state: "held", retention: "Ownership unresolved" });
    const recovery = group(result, "other").entries.find((entry) => entry.id === "other:recovery")!;
    expect(recovery.other?.classification).toBe("recovery");
    expect(recovery.size).toMatchObject({ bytes: 6 * GiB, complete: false, basis: "lifecycle" });
    expect(recovery.subtitle).toBe("2 expired workspaces");
  });

  it("do not charge a network mount to this computer's disks", () => {
    const result = buildHoldings(
      input({
        workspaces: [{ ...source("x"), root: "/mnt/shared/jobs/x" }],
        sizes: () => measured(9 * GiB),
      }),
    );
    const workspaces = group(result, "workspaces");
    expect(workspaces.entries[0]).toMatchObject({ host: "beta", local: false });
    expect(workspaces.entries[0]!.size.bytes).toBeNull();
    expect(workspaces).toMatchObject({ count: 1, remote: 1, bytes: null });
  });
});

describe("group totals", () => {
  it("add only measured local bytes, and say how much is unmeasured, partial or shared", () => {
    const sizes: Record<string, StorageSize> = {
      [`${ROOT}/a`]: measured(4 * GiB, { sharedBytes: 1 * GiB }),
      [`${ROOT}/b`]: measured(2 * GiB, { complete: false }),
    };
    const result = buildHoldings(
      input({
        workspaces: [source("a"), source("b"), source("c")],
        sizes: (path) => sizes[path] ?? null,
      }),
    );
    expect(group(result, "workspaces")).toMatchObject({
      count: 3,
      measured: 2,
      // A lower bound and a missing size are both not yet known precisely.
      unmeasured: 2,
      bytes: 6 * GiB,
      sharedBytes: 1 * GiB,
    });
  });

  it("count every entry but keep only the bounded number", () => {
    const many = Array.from({ length: 30 }, (_, index) => source(`job-${index}`));
    const result = buildHoldings(input({ workspaces: many, keep: 25 }));
    expect(group(result, "workspaces")).toMatchObject({ count: 30, shown: 25 });
    expect(group(result, "workspaces").entries).toHaveLength(25);
  });
});

describe("archives", () => {
  it("show the location, source, recorded size and the verified backup of a local bundle", () => {
    const result = buildHoldings(input({ archives: [archive("a1")] }));
    const entry = group(result, "archives").entries[0]!;
    expect(entry).toMatchObject({
      title: "Evidence a1",
      host: "alpha",
      local: true,
      disk: { disk: "System SSD", volume: "/" },
      size: { bytes: 10 * GiB, basis: "manifest", complete: true },
    });
    expect(entry.archive).toMatchObject({
      source: `${ROOT}/job-a/outputs`,
      backup: "confirmed",
      backupSnapshot: "bf674190",
      files: 4,
    });
  });

  it("charge nothing to this computer for a bundle that lives on another one, and link the job to it", () => {
    const result = buildHoldings(
      input({
        workspaces: [source("job-a")],
        archives: [
          archive("local1"),
          archive("remote1", {
            local: false,
            host: "beta",
            logicalBytes: 50 * GiB,
            source: `${ROOT}/job-a/evidence`,
          }),
        ],
        sizes: (path) => (path === `${ROOT}/job-a` ? measured(1 * GiB) : null),
      }),
    );
    const archives = group(result, "archives");
    expect(archives).toMatchObject({ count: 2, remote: 1, bytes: 10 * GiB });
    const remote = archives.entries.find((entry) => entry.id === "archive:remote1")!;
    expect(remote).toMatchObject({ host: "beta", local: false, disk: null });
    expect(remote.notes.join(" ")).toMatch(/nothing is charged/);
    const job = group(result, "workspaces").entries[0]!;
    expect(job.size.bytes).toBe(1 * GiB);
    expect(job.workspace!.keeps).toEqual([
      { id: "local1", title: "Evidence local1", host: "alpha" },
      { id: "remote1", title: "Evidence remote1", host: "beta" },
    ]);
  });

  it("show a backup as not verified when no proof exists", () => {
    const result = buildHoldings(
      input({
        archives: [
          archive("a1", { backup: "published", backupVerifiedAt: null, backupSnapshot: null }),
        ],
      }),
    );
    expect(group(result, "archives").entries[0]!.archive).toMatchObject({
      backup: "published",
      backupVerifiedAt: null,
    });
  });
});

describe("backups", () => {
  const repository = (extra: Partial<BackupInfo> = {}): BackupInfo => ({
    id: "library",
    repository: "/backup/restic",
    description: "restic 0.16",
    localPath: "/backup/restic",
    host: null,
    scope: ["the work library"],
    retention: "Keeps 7 daily, 4 weekly snapshots",
    physicalId: null,
    libraryPhysicalId: null,
    latest: {
      snapshotId: "s1",
      confirmedAt: now - 3600_000,
      confirmedPaths: new Set(["/srv/library/projects/app/evidence/a1"]),
      repositoryBytes: null,
      repositoryBytesAt: null,
    },
    problem: null,
    ...extra,
  });

  it("show the repository's host, disk, coverage, latest verification and retention", () => {
    const result = buildHoldings(
      input({
        backups: [repository()],
        libraryPaths: new Set([
          "/srv/library/projects/app/evidence/a1",
          "/srv/library/projects/app/evidence/a2",
        ]),
      }),
    );
    const entry = group(result, "backups").entries[0]!;
    expect(entry).toMatchObject({
      title: "Library backup on alpha",
      host: "alpha",
      disk: { disk: "Backup HDD", volume: "backup-disk" },
    });
    expect(entry.backup).toMatchObject({
      covered: 1,
      expected: 2,
      verifiedAt: now - 3600_000,
      retention: "Keeps 7 daily, 4 weekly snapshots",
    });
    expect(entry.notes[0]).toMatch(/not independent copies/);
  });

  it("report occupied bytes only when they were measured or reported, otherwise unknown", () => {
    const unknown = buildHoldings(input({ backups: [repository()] }));
    expect(group(unknown, "backups").entries[0]!.size).toMatchObject({
      bytes: null,
      basis: "unavailable",
    });
    expect(group(unknown, "backups").entries[0]!.notes.join(" ")).toMatch(
      /not readable by this server/,
    );
    expect(group(unknown, "backups").bytes).toBeNull();

    const reported = buildHoldings(
      input({
        backups: [
          repository({
            latest: {
              snapshotId: "s1",
              confirmedAt: now,
              confirmedPaths: new Set(),
              repositoryBytes: 80 * GiB,
              repositoryBytesAt: now - 60_000,
            },
          }),
        ],
      }),
    );
    expect(group(reported, "backups").entries[0]!.size).toMatchObject({
      bytes: 80 * GiB,
      basis: "reported",
      measuredAt: now - 60_000,
    });

    const measuredRepository = buildHoldings(
      input({
        backups: [repository()],
        sizes: (path) => (path === "/backup/restic" ? measured(75 * GiB) : null),
      }),
    );
    expect(group(measuredRepository, "backups").entries[0]!.size.bytes).toBe(75 * GiB);
  });

  it("do not add repositories on other computers to this computer's disks, and say whether they are independent", () => {
    const result = buildHoldings(
      input({
        backups: [
          repository({ physicalId: "wwn:backup", libraryPhysicalId: "wwn:library" }),
          repository({
            id: "remote-copy",
            repository: "sftp:other:/backups/restic",
            localPath: null,
            host: "other",
            physicalId: "wwn:same",
            libraryPhysicalId: "wwn:same",
            latest: null,
            problem: "The latest backup receipt is not readable on this computer.",
          }),
        ],
        sizes: (path) => (path === "/backup/restic" ? measured(75 * GiB) : null),
      }),
    );
    const backups = group(result, "backups");
    expect(backups).toMatchObject({ count: 2, remote: 1, bytes: 75 * GiB });
    expect(backups.entries.map((entry) => entry.backup!.independent)).toEqual([true, false]);
    expect(backups.entries[1]).toMatchObject({
      title: "Backup remote-copy on other",
      host: "other",
      local: false,
      disk: null,
    });
    expect(backups.entries[1]!.notes.join(" ")).toMatch(/receipt is not readable/);
  });
});

describe("other retained project data", () => {
  it("classifies sources, original data and runtimes and says what protects them", () => {
    const result = buildHoldings(
      input({
        retained: [
          { path: "/data/app", title: "app", classification: "permanent-source", detail: null },
          { path: "/data/survey", title: "survey", classification: "original-data", detail: null },
          {
            path: "/opt/runtime",
            title: "runtime",
            classification: "project-runtime",
            detail: null,
          },
          {
            path: "/data/app",
            title: "app again",
            classification: "permanent-source",
            detail: null,
          },
        ],
      }),
    );
    const other = group(result, "other");
    // The same folder is listed once.
    expect(other.entries.map((entry) => entry.title).toSorted()).toEqual([
      "app",
      "runtime",
      "survey",
    ]);
    expect(
      other.entries.every((entry) =>
        entry.other!.protection?.startsWith("Outside the work folders"),
      ),
    ).toBe(true);
    expect(other.entries.find((entry) => entry.title === "survey")!.other!.classification).toBe(
      "original-data",
    );
    expect(other.bytes).toBeNull();
  });
});

describe("locating a path on a disk", () => {
  it("picks the most specific volume and reports a network mount as another computer", () => {
    expect(locate(disks, "linux", "/backup/restic/data")).toMatchObject({
      disk: "Backup HDD",
      volume: "backup-disk",
      remote: null,
    });
    expect(locate(disks, "linux", "/home/user")).toMatchObject({
      disk: "System SSD",
      remote: null,
    });
    expect(locate(disks, "linux", "/mnt/shared/jobs/x")).toMatchObject({
      disk: null,
      remote: "beta",
    });
    expect(locate(null, "linux", "/home/user")).toBeNull();
  });
});

describe("on Windows", () => {
  const drives: StorageDisks = {
    ...disks,
    os: "windows",
    remote: [],
    disks: [
      {
        ...disks.disks[0]!,
        volumes: [
          {
            ...disks.disks[0]!.volumes[0]!,
            id: "C:\\",
            label: "C: Windows",
            mountPaths: ["C:\\"],
          },
        ],
      },
      {
        ...disks.disks[1]!,
        volumes: [
          { ...disks.disks[1]!.volumes[0]!, id: "D:\\", label: "D: Data", mountPaths: ["D:\\"] },
        ],
      },
    ],
  };

  it("matches a folder to its drive and to its lifecycle record whatever the case and separators", () => {
    const result = buildHoldings({
      ...input({
        platform: "win32",
        disks: drives,
        jobRoots: ["C:/Users/user/jobs"],
        workspaces: [{ ...source("job-a"), root: "c:/users/USER/jobs/job-a", project: "app" }],
        lifecycle: [
          {
            ...record("job-a"),
            job: "C:\\Users\\user\\jobs\\job-a",
            status: "held",
            holdReasons: ["Required independent backup is pending"],
            pending: ["Required independent backup is pending"],
          },
          { ...record("old"), job: "D:\\legacy\\old-tree", status: "grace", expiresAt: now + 1000 },
        ],
        retained: [
          { path: "D:\\data\\app", title: "app", classification: "permanent-source", detail: null },
        ],
      }),
    });
    const workspaces = group(result, "workspaces");
    // One entry for the folder, not one per spelling.
    expect(workspaces.entries.map((entry) => entry.title).toSorted()).toEqual(
      ["app job-a", "old-tree"].toSorted(),
    );
    const job = workspaces.entries.find((entry) => entry.title === "app job-a")!;
    expect(job).toMatchObject({
      disk: { disk: "System SSD", volume: "C: Windows" },
      workspace: { state: "preservation-pending", stateSource: "lifecycle" },
    });
    expect(workspaces.entries.find((entry) => entry.title === "old-tree")).toMatchObject({
      disk: { disk: "Backup HDD", volume: "D: Data" },
      workspace: { state: "cleanup-eligible", expiresAt: now + 1000 },
    });
    const other = group(result, "other").entries[0]!;
    expect(other.disk).toEqual({ disk: "Backup HDD", volume: "D: Data" });
    // D:\data is not under the job root, so no lifecycle rule applies to it.
    expect(other.other!.protection).toMatch(/^Outside the work folders/);
  });
});
