/* oxlint-disable t3code/no-dom-test-environment, t3code/require-disposable-render -- Ported from the V1 suite, which mounts a React root under jsdom; converting it to the V2 browser project needs a Playwright pass that this package cannot launch. */
// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StorageEntry, StorageGroupId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComputersClockProvider } from "./computersClock";
import { DisksView } from "./DisksView";
import { HoldingsView } from "./HoldingsView";
import type {
  ComputerDisksModel,
  HoldingGroupModel,
  HoldingRow,
  HoldingsViewModel,
  StorageActions,
  VolumeModel,
} from "./storageViewModel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const GiB = 1024 ** 3;
const render = async (node: React.ReactNode) =>
  act(async () => {
    root.render(<ComputersClockProvider timestampFormat="12-hour">{node}</ComputersClockProvider>);
  });
const click = (element: Element | null | undefined) =>
  act(async () => {
    (element as HTMLElement).click();
  });
const trigger = (name: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(name));

const entry = (id: string, extra: Partial<StorageEntry> = {}): StorageEntry => ({
  id,
  group: "workspaces",
  title: `Job ${id}`,
  subtitle: "app · Session",
  host: "alpha",
  local: true,
  location: `/work/jobs/${id}`,
  disk: { disk: "System SSD", volume: "/" },
  size: { bytes: 3 * GiB, complete: true, measuredAt: 1000, basis: "allocated" },
  ram: [],
  workspace: {
    owner: { project: "app", master: null, workers: [], session: `Job ${id}` },
    state: "preservation-pending",
    stateSource: "lifecycle",
    lastActivityAt: 1000,
    expiresAt: null,
    retention: "Required independent backup is pending",
    preservation: ["Required independent backup is pending"],
    keeps: [],
  },
  notes: [],
  ...extra,
});
const row = (e: StorageEntry): HoldingRow => ({
  key: JSON.stringify(["alpha", e.id]),
  computerId: "alpha",
  entry: e,
  hostLabel: "Alpha",
  diskLabel: "System SSD · /",
  details: null,
  detailsAvailable: e.group === "workspaces",
});
const group = (
  id: HoldingGroupModel["id"],
  extra: Partial<HoldingGroupModel> = {},
): HoldingGroupModel => ({
  id,
  title: {
    workspaces: "Workspaces",
    archives: "Archives",
    backups: "Backups",
    other: "Other retained project data",
  }[id],
  description: "",
  open: false,
  rowsLoading: false,
  count: 0,
  countIsLowerBound: false,
  storedElsewhere: 0,
  bytes: null,
  measured: 0,
  unmeasured: 0,
  sharedBytes: null,
  ramBytes: null,
  measuring: false,
  coverage: [
    { computerId: "alpha", name: "Alpha", state: "complete", reason: null, lastKnownAt: null },
  ],
  rows: [],
  truncated: false,
  ...extra,
});

/** The page owns which groups are open; the view only reports the intent. */
function Harness({
  build,
  onExpandEntry,
}: {
  readonly build: (open: ReadonlySet<StorageGroupId>) => HoldingsViewModel;
  readonly onExpandEntry: StorageActions["onExpandEntry"];
}) {
  const [open, setOpen] = useState<ReadonlySet<StorageGroupId>>(new Set());
  const model = build(open);
  return (
    <HoldingsView
      model={{
        ...model,
        groups: model.groups.map((entry) => ({ ...entry, open: open.has(entry.id) })),
      }}
      actions={{
        onExpandEntry,
        onLoadMore: vi.fn(),
        onToggleGroup: (id, opened) =>
          setOpen((old) => {
            const next = new Set(old);
            if (opened) next.add(id);
            else next.delete(id);
            return next;
          }),
      }}
    />
  );
}

describe("the workspaces and archives view", () => {
  const model = (): HoldingsViewModel => ({
    loading: false,
    notices: [],
    groups: [
      group("workspaces", { count: 1, bytes: 3 * GiB, measured: 1, rows: [row(entry("a"))] }),
      group("archives", {
        count: 0,
        coverage: [
          {
            computerId: "alpha",
            name: "Alpha",
            state: "unsupported",
            reason: "Kept results need the lifecycle tool.",
            lastKnownAt: null,
          },
        ],
      }),
      group("backups"),
      group("other"),
    ],
  });

  it("opens with four collapsed groups; entries and their details appear only when opened", async () => {
    const onExpandEntry = vi.fn();
    await render(<Harness build={model} onExpandEntry={onExpandEntry} />);
    for (const title of ["Workspaces", "Archives", "Backups", "Other retained project data"])
      expect(trigger(title)).toBeDefined();
    // Nothing below a header is rendered yet, and nothing was read for it.
    expect(container.textContent).not.toContain("Job a");
    expect(onExpandEntry).not.toHaveBeenCalled();

    await click(trigger("Workspaces"));
    expect(container.textContent).toContain("Job a");
    // The entry is still closed: its retention reason is a detail.
    expect(container.textContent).not.toContain("No expiry is scheduled");
    expect(onExpandEntry).not.toHaveBeenCalled();

    await click(trigger("Job a"));
    expect(container.textContent).toContain("No expiry is scheduled");
    expect(container.textContent).toContain("Required independent backup is pending");
    expect(onExpandEntry).toHaveBeenCalledExactlyOnceWith("alpha", "a");
  });

  it("shows a truthful header, with a partial total called at least and unknown never as zero", async () => {
    const partial = model();
    await render(
      <HoldingsView
        model={{
          ...partial,
          groups: [
            group("workspaces", { count: 3, bytes: 5 * GiB, measured: 2, unmeasured: 1, rows: [] }),
            group("archives", { count: 2, bytes: null, rows: [] }),
            group("backups"),
            group("other"),
          ],
        }}
        actions={{ onExpandEntry: vi.fn(), onToggleGroup: vi.fn(), onLoadMore: vi.fn() }}
      />,
    );
    expect(trigger("Workspaces")?.textContent).toContain("3 workspaces");
    expect(trigger("Workspaces")?.textContent).toContain("≥ 5 GB on disk");
    expect(trigger("Workspaces")?.textContent).toContain("1 of 3 not fully measured");
    expect(trigger("Archives")?.textContent).toContain("Size not measured");
    expect(trigger("Archives")?.textContent).not.toMatch(/\b0 B\b/);
  });

  it("says a group is unsupported, with the reason, instead of looking empty", async () => {
    await render(<Harness build={model} onExpandEntry={vi.fn()} />);
    expect(trigger("Archives")?.textContent).toContain("Unsupported");
    await click(trigger("Archives"));
    expect(container.textContent).toContain("Kept results need the lifecycle tool.");
    expect(container.textContent).toContain("not supported on the connected computers");
  });

  it("asks for a group's entries only when it opens, and shows a skeleton until they arrive", async () => {
    const onToggleGroup = vi.fn();
    const closed = model();
    await render(
      <HoldingsView
        model={{
          ...closed,
          groups: closed.groups.map((entry) =>
            entry.id === "workspaces"
              ? { ...entry, open: true, rowsLoading: true, rows: [] }
              : entry,
          ),
        }}
        actions={{ onExpandEntry: vi.fn(), onToggleGroup, onLoadMore: vi.fn() }}
      />,
    );
    await click(trigger("Workspaces"));
    expect(onToggleGroup).toHaveBeenCalledExactlyOnceWith("workspaces", false);
    expect(container.querySelector('[aria-label="Loading entries"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Nothing is listed");
  });

  it("offers to load more entries when the computers have sent fewer than they hold", async () => {
    const onLoadMore = vi.fn();
    await render(
      <HoldingsView
        model={{
          loading: false,
          notices: [],
          groups: [
            group("workspaces", {
              open: true,
              count: 900,
              countIsLowerBound: true,
              truncated: true,
              rows: [row(entry("a"))],
            }),
            group("archives"),
            group("backups"),
            group("other"),
          ],
        }}
        actions={{ onExpandEntry: vi.fn(), onToggleGroup: vi.fn(), onLoadMore }}
      />,
    );
    expect(container.textContent).toContain("have sent 1 entries so far");
    await click(trigger("Load more entries"));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("lists RAM-backed paths with their usage and limit, apart from the disk size", async () => {
    const withRam = entry("r", {
      ram: [
        { path: "/work/jobs/r/scratch", usedBytes: 1 * GiB, limitBytes: 6 * GiB, measuredAt: 1 },
      ],
    });
    await render(
      <Harness
        build={() => ({
          loading: false,
          notices: [],
          groups: [
            group("workspaces", {
              count: 1,
              bytes: 3 * GiB,
              ramBytes: 1 * GiB,
              rows: [row(withRam)],
            }),
            group("archives"),
            group("backups"),
            group("other"),
          ],
        })}
        onExpandEntry={vi.fn()}
      />,
    );
    expect(trigger("Workspaces")?.textContent).toContain("1 GB in RAM, not counted as disk");
    await click(trigger("Workspaces"));
    await click(trigger("Job r"));
    expect(container.textContent).toContain("1 GB used of a 6 GB limit");
    expect(container.textContent).toContain("left out of the disk total");
  });
});

describe("the disks view", () => {
  const volume = (extra: Partial<VolumeModel> = {}): VolumeModel => ({
    id: "/",
    label: "/",
    mountPaths: ["/", "/srv/library"],
    filesystem: "ext4",
    device: "/dev/a1",
    role: "system",
    capacityBytes: 900 * GiB,
    usedBytes: 700 * GiB,
    availableBytes: 100 * GiB,
    reserveBytes: 60 * GiB,
    headroomBytes: 40 * GiB,
    holds: ["agent-work"],
    measuredAt: null,
    openable: true,
    ...extra,
  });
  const computer = (volumes: VolumeModel[]): ComputerDisksModel => ({
    computerId: "alpha",
    name: "Alpha",
    machineKind: null,
    connection: { status: "online" },
    state: "ready",
    message: null,
    sampledAt: "2026-10-26T14:00:00.000Z",
    lastKnown: false,
    disks: [
      {
        id: "/dev/a",
        title: "System SSD",
        detail: "NVMe · SSD",
        sizeBytes: 1000 * GiB,
        volumes,
        system: [
          {
            ...volume({
              id: "/boot/efi",
              label: "/boot/efi",
              mountPaths: ["/boot/efi"],
              role: "boot",
              holds: [],
            }),
          },
        ],
      },
    ],
    remote: [
      {
        id: "/mnt/shared",
        label: "/mnt/shared",
        protocol: "sshfs",
        host: "beta (10.0.0.7)",
        backing: "/srv/shared",
        capacityBytes: null,
        usedBytes: null,
        availableBytes: null,
        measuredAt: null,
      },
    ],
    advanced: [
      {
        id: "m",
        kind: "memory",
        label: "/dev/shm",
        mountPaths: ["/dev/shm"],
        filesystem: "tmpfs",
        backing: "RAM; not disk space",
        capacityBytes: 4 * GiB,
        usedBytes: 0,
      },
    ],
    reserveSource: "the capacity configuration of the lifecycle tool",
    notices: [],
  });

  it("keeps system and virtual detail under a collapsed Advanced section, and remote storage apart", async () => {
    await render(
      <DisksView
        model={{ computers: { status: "ready", data: [computer([volume()])] } }}
        actions={{ onOpenDisk: vi.fn() }}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("System SSD");
    expect(container.textContent).toContain("Remote storage");
    expect(container.textContent).toContain("On beta (10.0.0.7) · /srv/shared");
    expect(container.textContent).toContain("Advanced details");
    expect(container.textContent).not.toContain("/dev/shm");
    expect(container.textContent).not.toContain("/boot/efi");
    await click(trigger("Advanced details"));
    expect(container.textContent).toContain("/dev/shm");
    expect(container.textContent).toContain("RAM; not disk space");
    expect(container.textContent).toContain("/boot/efi");
  });

  it("shows used, available, reserve and agent headroom as separate figures", async () => {
    await render(
      <DisksView
        model={{ computers: { status: "ready", data: [computer([volume()])] } }}
        actions={{ onOpenDisk: vi.fn() }}
        onRetry={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("900 GB capacity");
    for (const [label, value] of [
      ["Used", "700 GB"],
      ["Available", "100 GB"],
      ["Reserve", "60 GB"],
      ["Agent headroom", "40 GB"],
    ] as const)
      expect(text).toContain(`${label}${value}`);
  });

  it("prints unknown amounts as unknown and a missing reserve as not configured, never as zero", async () => {
    await render(
      <DisksView
        model={{
          computers: {
            status: "ready",
            data: [
              computer([
                volume({
                  usedBytes: null,
                  availableBytes: null,
                  reserveBytes: null,
                  headroomBytes: null,
                }),
              ]),
            ],
          },
        }}
        actions={{ onOpenDisk: vi.fn() }}
        onRetry={vi.fn()}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("UsedNot measured");
    expect(text).toContain("AvailableNot measured");
    expect(text).toContain("ReserveNot configured");
    expect(text).toContain("Agent headroomUnknown");
    expect(text).not.toMatch(/(?:Used|Available|Reserve|Agent headroom)0 B/);
  });

  it("opens the folder breakdown of a volume that can be inspected", async () => {
    const onOpenDisk = vi.fn();
    await render(
      <DisksView
        model={{ computers: { status: "ready", data: [computer([volume()])] } }}
        actions={{ onOpenDisk }}
        onRetry={vi.fn()}
      />,
    );
    await click(container.querySelector('button[aria-label="/ on Alpha: show folder sizes"]'));
    expect(onOpenDisk).toHaveBeenCalledExactlyOnceWith({ computerId: "alpha", diskId: "/" });
  });

  it("says an unsupported computer is unsupported and shows no disks for it", async () => {
    await render(
      <DisksView
        model={{
          computers: {
            status: "ready",
            data: [
              {
                ...computer([]),
                state: "unsupported",
                message: "Update this computer’s T3 server to see its storage.",
                disks: [],
                remote: [],
                advanced: [],
                sampledAt: null,
              },
            ],
          },
        }}
        actions={{ onOpenDisk: vi.fn() }}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("Update this computer’s T3 server to see its storage.");
    expect(container.textContent).not.toContain("System SSD");
  });
});
