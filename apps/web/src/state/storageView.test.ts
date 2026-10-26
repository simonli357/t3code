import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type StorageDisks,
  type StorageEntry,
  type StorageGroupId,
  type StorageHoldings,
} from "@t3tools/contracts";
import { describeCoverage, describeGroupUsage } from "../components/computers/storageText";
import type { EnvironmentPresentation } from "./environments";
import {
  disksModel,
  holdingsModel,
  loadedGroups,
  mergeHoldings,
  noStorageData,
  type ComputerStorageData,
} from "./storageView";

const GiB = 1024 ** 3;
const environment = (
  id: string,
  label: string,
  phase: "connected" | "offline",
  storage: boolean | null,
) => ({
  environmentId: EnvironmentId.make(id),
  label,
  displayUrl: null,
  connection: { phase, error: phase === "offline" ? "Disconnected" : null, traceId: null },
  serverConfig:
    storage === null
      ? null
      : ({
          environment: {
            capabilities: { computers: true, computersStorage: storage },
            platform: { machine: "linux" },
          },
        } as unknown as NonNullable<EnvironmentPresentation["serverConfig"]>),
});
const alpha = environment("alpha", "Alpha", "connected", true);
const beta = environment("beta", "Beta", "connected", true);
const old = environment("old", "Old", "connected", false);
const away = environment("away", "Away", "offline", true);

const entry = (
  id: string,
  group: StorageGroupId,
  extra: Partial<StorageEntry> = {},
): StorageEntry => ({
  id,
  group,
  title: id,
  subtitle: null,
  host: "alpha",
  local: true,
  location: `/data/${id}`,
  disk: { disk: "System SSD", volume: "/" },
  size: { bytes: 1 * GiB, complete: true, measuredAt: 1000, basis: "allocated" },
  ram: [],
  notes: [],
  ...extra,
});
const holdings = (
  groups: Partial<
    Record<
      StorageGroupId,
      {
        entries: StorageEntry[];
        remote?: number;
        status?: "complete" | "partial" | "unsupported" | "unavailable";
        reason?: string;
      }
    >
  >,
  extra: Partial<StorageHoldings> = {},
): StorageHoldings => ({
  sampledAt: 5000,
  host: "alpha",
  measuring: false,
  notices: [],
  groups: (["workspaces", "archives", "backups", "other"] as const).map((id) => {
    const given = groups[id];
    const entries = given?.entries ?? [];
    const local = entries.filter((item) => item.local);
    return {
      group: id,
      status: given?.status ?? "complete",
      reason: given?.reason ?? null,
      count: entries.length,
      remote: entries.length - local.length,
      shown: entries.length,
      bytes: local.some((item) => item.size.bytes !== null)
        ? local.reduce((sum, item) => sum + (item.size.bytes ?? 0), 0)
        : null,
      measured: local.filter((item) => item.size.bytes !== null).length,
      unmeasured: local.filter((item) => item.size.bytes === null || !item.size.complete).length,
      sharedBytes: null,
      ramBytes: null,
      entries,
    };
  }),
  ...extra,
});
const data = (value: Partial<ComputerStorageData>): ComputerStorageData => ({
  ...noStorageData,
  readAt: 7000,
  ...value,
});

describe("the disks view", () => {
  const disks: StorageDisks = {
    sampledAt: 9000,
    host: "alpha",
    os: "linux",
    reserveSource: null,
    notices: [],
    advanced: [],
    remote: [],
    disks: [
      {
        id: "/dev/a",
        label: "System SSD",
        model: "System SSD",
        bus: "NVMe",
        media: "ssd",
        sizeBytes: 1000 * GiB,
        volumes: [
          {
            id: "/",
            label: "/",
            mountPaths: ["/"],
            filesystem: "ext4",
            device: "/dev/a1",
            role: "system",
            capacityBytes: 900 * GiB,
            usedBytes: null,
            availableBytes: null,
            reserveBytes: null,
            headroomBytes: null,
            holds: [],
            measuredAt: null,
          },
        ],
        system: [],
      },
    ],
  };

  it("carries unknown amounts through as null, never as zero", () => {
    const model = disksModel([alpha], { alpha: data({ disks }) }, true);
    if (model.computers.status !== "ready") throw new Error("not ready");
    const volume = model.computers.data[0]!.disks[0]!.volumes[0]!;
    expect(volume).toMatchObject({
      capacityBytes: 900 * GiB,
      usedBytes: null,
      availableBytes: null,
      reserveBytes: null,
      measuredAt: null,
      openable: true,
    });
    expect(model.computers.data[0]!.disks[0]!.detail).toBe("NVMe · SSD");
  });

  it("says a computer whose server predates the view is unsupported, and an offline one shows what was last known", () => {
    const model = disksModel([old, away, beta], { away: data({ disks }) }, true);
    if (model.computers.status !== "ready") throw new Error("not ready");
    const [awayModel, betaModel, oldModel] = [
      model.computers.data.find((computer) => computer.name === "Away")!,
      model.computers.data.find((computer) => computer.name === "Beta")!,
      model.computers.data.find((computer) => computer.name === "Old")!,
    ];
    expect(oldModel).toMatchObject({ state: "unsupported", disks: [] });
    expect(oldModel.message).toMatch(/Update this computer/);
    expect(awayModel).toMatchObject({ state: "ready", lastKnown: true });
    expect(awayModel.disks[0]!.volumes[0]!.openable).toBe(false);
    expect(betaModel.state).toBe("loading");
  });
});

describe("the workspaces and archives view", () => {
  it("is always four groups, in order, whatever the computers report", () => {
    const model = holdingsModel([alpha], {}, {}, true);
    expect(model.groups.map((group) => group.id)).toEqual([
      "workspaces",
      "archives",
      "backups",
      "other",
    ]);
    expect(model.groups.map((group) => group.title)).toEqual([
      "Workspaces",
      "Archives",
      "Backups",
      "Other retained project data",
    ]);
  });

  it("lists a bundle once, as the stored one, and adds no bytes for the computer that only kept it", () => {
    const stored = entry("archive:1", "archives", { host: "alpha", local: true });
    const kept = entry("archive:1", "archives", {
      host: "alpha",
      local: false,
      size: { bytes: 1 * GiB, complete: true, measuredAt: 1000, basis: "manifest" },
    });
    const model = holdingsModel(
      [alpha, beta],
      {
        beta: data({ holdings: holdings({ archives: { entries: [kept] } }) }),
        alpha: data({ holdings: holdings({ archives: { entries: [stored] } }) }),
      },
      {},
      true,
    );
    const archives = model.groups[1]!;
    expect(archives.rows).toHaveLength(1);
    expect(archives.rows[0]).toMatchObject({ computerId: "alpha", hostLabel: "Alpha" });
    expect(archives).toMatchObject({ count: 1, bytes: 1 * GiB, storedElsewhere: 0 });
  });

  it("counts an entry that lives on another computer separately and charges it to no disk here", () => {
    const remote = entry("archive:9", "archives", { host: "beta", local: false });
    const model = holdingsModel(
      [alpha],
      { alpha: data({ holdings: holdings({ archives: { entries: [remote] } }) }) },
      {},
      true,
    );
    expect(model.groups[1]).toMatchObject({ count: 1, storedElsewhere: 1, bytes: null });
    expect(model.groups[1]!.rows[0]).toMatchObject({ hostLabel: "beta" });
  });

  it("marks coverage by computer: complete, unsupported, offline with last known data, still loading", () => {
    const model = holdingsModel(
      // The page sorts computers by name before it maps them.
      [alpha, away, beta, old],
      {
        alpha: data({ holdings: holdings({ backups: { entries: [entry("b1", "backups")] } }) }),
        away: data({
          holdings: holdings({
            backups: { entries: [], status: "unsupported", reason: "No interface." },
          }),
        }),
      },
      {},
      true,
    );
    const backups = model.groups[2]!;
    expect(backups.coverage.map((item) => [item.name, item.state])).toEqual([
      ["Alpha", "complete"],
      ["Away", "offline"],
      ["Beta", "loading"],
      ["Old", "unsupported"],
    ]);
    expect(backups.coverage.find((item) => item.name === "Away")!.lastKnownAt).not.toBeNull();
    expect(describeCoverage(backups.coverage).overall).toBe("partial");
  });

  it("says a group is unsupported when every computer says so, not that it is empty", () => {
    const unsupported = holdings({
      archives: { entries: [], status: "unsupported", reason: "Needs the lifecycle tool." },
    });
    const model = holdingsModel(
      [alpha, beta],
      { alpha: data({ holdings: unsupported }), beta: data({ holdings: unsupported }) },
      {},
      true,
    );
    expect(model.groups[1]!.coverage.map((item) => item.state)).toEqual([
      "unsupported",
      "unsupported",
    ]);
    expect(describeCoverage(model.groups[1]!.coverage)).toMatchObject({
      overall: "unsupported",
      notes: [
        "Alpha: not supported. Needs the lifecycle tool.",
        "Beta: not supported. Needs the lifecycle tool.",
      ],
    });
  });

  it("offers details only for entries whose parts can be read, and passes loaded details through", () => {
    const workspace = entry("workspace:/jobs/a", "workspaces");
    const remoteArchive = entry("archive:2", "archives", { local: false, host: "beta" });
    const key = JSON.stringify(["alpha", "workspace:/jobs/a"]);
    const model = holdingsModel(
      [alpha],
      {
        alpha: data({
          holdings: holdings({
            workspaces: { entries: [workspace] },
            archives: { entries: [remoteArchive] },
          }),
        }),
      },
      { [key]: { status: "loading" } },
      true,
    );
    expect(model.groups[0]!.rows[0]).toMatchObject({
      detailsAvailable: true,
      details: { status: "loading" },
    });
    expect(model.groups[1]!.rows[0]).toMatchObject({ detailsAvailable: false, details: null });
  });

  it("says the count is a lower bound when computers list only their newest entries", () => {
    const base = holdings({ workspaces: { entries: [entry("w1", "workspaces")] } });
    const bounded: StorageHoldings = {
      ...base,
      groups: base.groups.map((group) =>
        group.group === "workspaces" ? { ...group, count: 5, shown: 1 } : group,
      ),
    };
    const model = holdingsModel([alpha], { alpha: data({ holdings: bounded }) }, {}, true);
    expect(model.groups[0]).toMatchObject({ count: 5, countIsLowerBound: true, truncated: true });
  });
});

describe("entries that arrive only for open groups", () => {
  const workspace = entry("workspace:/jobs/a", "workspaces");
  const archive = entry("archive:1", "archives");
  const everything = holdings({
    workspaces: { entries: [workspace] },
    archives: { entries: [archive] },
  });
  const totalsOnly: StorageHoldings = {
    ...everything,
    groups: everything.groups.map((group) => ({ ...group, entries: [] })),
  };

  it("replaces the entries of the groups asked for and keeps the last ones of the others", () => {
    const first = mergeHoldings(noStorageData, everything, ["workspaces", "archives"]);
    expect(first.loaded).toEqual(["workspaces", "archives"]);
    const next = mergeHoldings(
      { ...noStorageData, ...first },
      {
        ...totalsOnly,
        groups: totalsOnly.groups.map((group) =>
          group.group === "workspaces" ? { ...group, count: 7, entries: [] } : group,
        ),
      },
      ["workspaces"],
    );
    const groups = Object.fromEntries(next.holdings!.groups.map((group) => [group.group, group]));
    // Asked for: the new answer, with the entries it now has. Not asked for: new totals, old entries.
    expect(groups.workspaces).toMatchObject({ count: 7, entries: [] });
    expect(groups.archives!.entries).toEqual([archive]);
    expect(next.loaded).toEqual(["workspaces", "archives"]);
  });

  it("knows which groups a saved answer carries entries for", () => {
    expect(loadedGroups(everything)).toEqual(["workspaces", "archives", "backups", "other"]);
    expect(loadedGroups(totalsOnly)).toEqual(["backups", "other"]);
  });

  it("shows an open group as loading until its entries have arrived", () => {
    const waiting = data({ holdings: totalsOnly, loaded: [] });
    const open = new Set<StorageGroupId>(["workspaces"]);
    const before = holdingsModel([alpha], { alpha: waiting }, {}, true, open);
    expect(before.groups[0]).toMatchObject({ open: true, rowsLoading: true, rows: [] });
    expect(before.groups[1]).toMatchObject({ open: false, rowsLoading: false });
    const after = holdingsModel(
      [alpha],
      { alpha: data({ ...mergeHoldings(waiting, everything, ["workspaces"]) }) },
      {},
      true,
      open,
    );
    expect(after.groups[0]).toMatchObject({ rowsLoading: false });
    expect(after.groups[0]!.rows).toHaveLength(1);
  });
});

describe("group header sentences", () => {
  const group = (overrides: Partial<ReturnType<typeof holdingsModel>["groups"][number]> = {}) => ({
    ...holdingsModel([alpha], { alpha: data({ holdings: holdings({}) }) }, {}, true).groups[0]!,
    ...overrides,
  });

  it("never prints zero for a size that was not measured", () => {
    expect(describeGroupUsage(group({ count: 3, bytes: null })).bytes).toBe("Size not measured");
    expect(describeGroupUsage(group({ count: 3, bytes: null, measuring: true })).bytes).toBe(
      "Measuring…",
    );
  });

  it("calls a partial total a lower bound and names what the number leaves out", () => {
    const usage = describeGroupUsage(
      group({
        count: 4,
        bytes: 10 * GiB,
        unmeasured: 2,
        sharedBytes: 2 * GiB,
        ramBytes: 6 * GiB,
        storedElsewhere: 1,
      }),
    );
    expect(usage.count).toBe("4 workspaces");
    expect(usage.bytes).toBe("≥ 10 GB on disk");
    expect(usage.caveats).toEqual([
      "2 of 4 not fully measured",
      "up to 2 GB is hard-linked and may also be counted by another entry",
      "6 GB in RAM, not counted as disk",
      "1 stored on other computers, not counted here",
    ]);
  });

  it("states an exact total plainly and an empty group as empty", () => {
    expect(describeGroupUsage(group({ count: 1, bytes: 5 * GiB })).bytes).toBe("5 GB on disk");
    expect(describeGroupUsage(group({ id: "backups", count: 1, bytes: null })).count).toBe(
      "1 repository",
    );
    expect(describeGroupUsage(group({ id: "other", count: 0, bytes: null })).caveats).toEqual([
      "Nothing found",
    ]);
    expect(describeGroupUsage(group({ count: 7, countIsLowerBound: true })).count).toBe(
      "7+ workspaces",
    );
  });
});
