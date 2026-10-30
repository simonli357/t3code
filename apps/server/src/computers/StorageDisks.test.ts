import { describe, expect, it } from "@effect/vitest";
import {
  buildLinuxDisks,
  buildWindowsDisks,
  classifyMount,
  parseLsblk,
  parseMountInfo,
  parseRemoteSource,
  parseSwaps,
  type FsUsage,
  type LinuxStorageInput,
  type WindowsReport,
} from "./StorageDisks.ts";
import { toJson } from "./testSupport.ts";

const GiB = 1024 ** 3;
const now = 1_792_000_000_000;

/** A `/proc/self/mountinfo` line: id parent major:minor root target options - fstype source. */
const line = (
  id: number,
  majmin: string,
  root: string,
  target: string,
  fstype: string,
  source: string,
) => `${id} 1 ${majmin} ${root} ${target} rw,relatime shared:1 - ${fstype} ${source} rw`;

const node = (fields: Record<string, unknown>) => ({
  rota: false,
  rm: false,
  hotplug: false,
  ...fields,
});
const lsblk = (...devices: unknown[]) => toJson({ blockdevices: devices });

const usage = (
  capacityGiB: number,
  usedGiB: number,
  availableGiB = capacityGiB - usedGiB,
): FsUsage => ({
  capacityBytes: capacityGiB * GiB,
  usedBytes: usedGiB * GiB,
  availableBytes: availableGiB * GiB,
});

const base = (overrides: Partial<LinuxStorageInput>): LinuxStorageInput => ({
  host: "laptop",
  now,
  mounts: [],
  blocks: [],
  usage: new Map(),
  loops: new Map(),
  swaps: [],
  resolveHost: () => null,
  reserves: [],
  reserveSource: null,
  workRoots: [],
  notices: [],
  ...overrides,
});

/** The shape of a workstation: a system SSD, a second data disk, a USB stick, and every kind of mount that is not a disk. */
const workstation = () => {
  const mounts = parseMountInfo(
    [
      line(32, "0:28", "/", "/run", "tmpfs", "tmpfs"),
      line(33, "259:4", "/", "/", "ext4", "/dev/nvme1n1p2"),
      line(35, "0:29", "/", "/dev/shm", "tmpfs", "tmpfs"),
      line(39, "0:33", "/", "/sys/firmware/efi/efivars", "efivarfs", "efivarfs"),
      line(41, "0:5", "/", "/proc", "proc", "proc"),
      line(49, "7:0", "/", "/snap/core/5", "squashfs", "/dev/loop0"),
      line(50, "7:1", "/", "/snap/firefox/8", "squashfs", "/dev/loop1"),
      line(62, "259:1", "/", "/data", "ext4", "/dev/nvme0n1p1"),
      line(64, "259:3", "/", "/boot/efi", "vfat", "/dev/nvme1n1p1"),
      // A bind of a folder of the root filesystem and a second mount of the data disk.
      line(65, "259:4", "/srv/library", "/mnt/library", "ext4", "/dev/nvme1n1p2"),
      line(66, "259:1", "/archive", "/srv/archive", "ext4", "/dev/nvme0n1p1"),
      line(70, "7:15", "/", "/srv/cold-view", "squashfs", "/dev/loop15"),
      line(71, "8:1", "/", "/media/user/STICK", "exfat", "/dev/sda1"),
      line(
        72,
        "0:117",
        "/",
        "/srv/library/projects/remote",
        "fuse.sshfs",
        "storage-host:/data/library/projects/remote",
      ),
      line(73, "0:60", "/", "/var/lib/docker/rootfs", "overlay", "overlay"),
    ].join("\n"),
  );
  const blocks = parseLsblk(
    lsblk(
      node({
        name: "sda",
        kname: "sda",
        "maj:min": "8:0",
        type: "disk",
        size: 64 * GiB,
        model: "Flash Disk",
        tran: "usb",
        rota: true,
        rm: true,
        hotplug: true,
        children: [
          node({
            name: "sda1",
            kname: "sda1",
            "maj:min": "8:1",
            type: "part",
            size: 64 * GiB,
            fstype: "exfat",
            label: "STICK",
            mountpoints: ["/media/user/STICK"],
            rm: true,
          }),
        ],
      }),
      node({ name: "nbd0", kname: "nbd0", "maj:min": "43:0", type: "disk", size: 0 }),
      node({
        name: "nvme0n1",
        kname: "nvme0n1",
        "maj:min": "259:0",
        type: "disk",
        size: 512 * GiB,
        model: "WD data",
        tran: "nvme",
        children: [
          node({
            name: "nvme0n1p1",
            kname: "nvme0n1p1",
            "maj:min": "259:1",
            type: "part",
            size: 512 * GiB,
            fstype: "ext4",
            label: "data-disk",
            mountpoints: ["/data", "/srv/archive"],
          }),
        ],
      }),
      node({
        name: "nvme1n1",
        kname: "nvme1n1",
        "maj:min": "259:2",
        type: "disk",
        size: 1000 * GiB,
        model: "Kingston 1TB",
        tran: "nvme",
        children: [
          node({
            name: "nvme1n1p1",
            kname: "nvme1n1p1",
            "maj:min": "259:3",
            type: "part",
            size: 1 * GiB,
            fstype: "vfat",
            parttypename: "EFI System",
            mountpoints: ["/boot/efi"],
          }),
          node({
            name: "nvme1n1p2",
            kname: "nvme1n1p2",
            "maj:min": "259:4",
            type: "part",
            size: 999 * GiB,
            fstype: "ext4",
            mountpoints: ["/", "/mnt/library"],
          }),
          node({
            name: "nvme1n1p3",
            kname: "nvme1n1p3",
            "maj:min": "259:5",
            type: "part",
            size: 8 * GiB,
            fstype: "swap",
            mountpoints: ["[SWAP]"],
          }),
        ],
      }),
      node({ name: "loop0", kname: "loop0", "maj:min": "7:0", type: "loop", size: 64 * 1024 ** 2 }),
    ),
  );
  const measured = new Map<string, FsUsage>([
    ["/", usage(930, 770, 100)],
    ["/boot/efi", usage(1, 0.1)],
    ["/data", usage(477, 400)],
    ["/media/user/STICK", usage(64, 10)],
    ["/run", usage(1.5, 0.02)],
    ["/dev/shm", usage(7, 0)],
    ["/srv/library/projects/remote", usage(2000, 1500)],
  ]);
  return base({
    mounts,
    blocks,
    usage: measured,
    loops: new Map([["loop15", "/srv/retained/cold.sqsh"]]),
    swaps: parseSwaps("Filename Type Size Used Priority\n/swap.img file 4194300 1024 -1\n"),
    resolveHost: (alias) => (alias === "storage-host" ? "10.0.0.7" : null),
  });
};

describe("mount classification", () => {
  it("keeps memory, kernel views, images, remote storage and block devices apart", () => {
    const kind = (fstype: string, source: string) =>
      classifyMount({ major: 0, minor: 1, root: "/", target: "/x", fstype, source });
    expect(kind("tmpfs", "tmpfs")).toBe("memory");
    expect(kind("efivarfs", "efivarfs")).toBe("pseudo");
    expect(kind("proc", "proc")).toBe("pseudo");
    expect(kind("overlay", "overlay")).toBe("pseudo");
    expect(kind("fuse.portal", "portal")).toBe("pseudo");
    expect(kind("squashfs", "/dev/loop3")).toBe("image");
    expect(kind("ext4", "/dev/loop4")).toBe("image");
    expect(kind("fuse.sshfs", "host:/path")).toBe("remote");
    expect(kind("nfs4", "server:/export")).toBe("remote");
    expect(kind("cifs", "//server/share")).toBe("remote");
    expect(kind("ext4", "/dev/nvme0n1p2")).toBe("block");
    expect(kind("ext4", "/dev/mapper/vg-root")).toBe("block");
    // Anything that is not a block device is a view, never a disk.
    expect(kind("fuse.unknownfs", "something")).toBe("pseudo");
  });

  it("reads host and backing location from the source a mount names", () => {
    const known = (alias: string) => (alias === "storage-host" ? "100.64.0.9" : null);
    expect(parseRemoteSource("storage-host:/data/library", "fuse.sshfs", known)).toEqual({
      host: "storage-host (100.64.0.9)",
      backing: "/data/library",
    });
    expect(parseRemoteSource("user@plain:/srv", "fuse.sshfs", () => null)).toEqual({
      host: "plain",
      backing: "/srv",
    });
    expect(parseRemoteSource("//nas/media", "cifs", known)).toEqual({
      host: "nas",
      backing: "//nas/media",
    });
    expect(parseRemoteSource("nas:/export", "nfs4", () => "nas")).toEqual({
      host: "nas",
      backing: "/export",
    });
  });
});

describe("the disk inventory of a Linux computer", () => {
  const inventory = buildLinuxDisks(workstation());
  const disk = (label: string) => inventory.disks.find((entry) => entry.label === label)!;

  it("lists only real physical disks, never loop devices or empty block devices", () => {
    expect(inventory.disks.map((entry) => entry.label).toSorted()).toEqual([
      "Flash Disk",
      "Kingston 1TB",
      "WD data",
    ]);
  });

  it("puts each filesystem on its own disk with its real capacity, used and available bytes", () => {
    const root = disk("Kingston 1TB").volumes.find((volume) => volume.mountPaths[0] === "/")!;
    expect(root).toMatchObject({
      role: "system",
      filesystem: "ext4",
      capacityBytes: 930 * GiB,
      usedBytes: 770 * GiB,
      availableBytes: 100 * GiB,
    });
    // Used and available are what the filesystem reports; they need not add up to the capacity.
    expect(root.usedBytes! + root.availableBytes!).not.toBe(root.capacityBytes);
    expect(disk("WD data").volumes[0]).toMatchObject({ label: "data-disk", role: "data" });
    expect(disk("Flash Disk")).toMatchObject({ media: "removable", bus: "USB" });
  });

  it("counts a bind mount or second mount of one filesystem as an alias, not as another volume", () => {
    const root = disk("Kingston 1TB").volumes;
    expect(root).toHaveLength(1);
    expect(root[0]!.mountPaths).toEqual(["/", "/mnt/library"]);
    expect(disk("WD data").volumes).toHaveLength(1);
    expect(disk("WD data").volumes[0]!.mountPaths).toEqual(["/data", "/srv/archive"]);
    expect(
      inventory.advanced
        .filter((mount) => mount.kind === "alias")
        .map((mount) => mount.label)
        .toSorted(),
    ).toEqual(["/mnt/library", "/srv/archive"]);
  });

  it("moves EFI and swap partitions out of the main list and into system details", () => {
    const kingston = disk("Kingston 1TB");
    expect(kingston.system.map((volume) => volume.role).toSorted()).toEqual(["boot", "swap"]);
    expect(kingston.volumes.map((volume) => volume.role)).toEqual(["system"]);
  });

  it("shows memory, kernel views and mounted images only as advanced details, with their backing", () => {
    const labels = inventory.advanced.map((mount) => mount.label);
    expect(labels).toContain("/run");
    expect(labels).toContain("/dev/shm");
    expect(inventory.advanced.find((mount) => mount.id === "memory:/run")).toMatchObject({
      kind: "memory",
      backing: "RAM; not disk space",
      capacityBytes: 1.5 * GiB,
    });
    expect(inventory.advanced.find((mount) => mount.kind === "pseudo")?.label).toMatch(
      /Kernel and system views \(3 mounts\)/,
    );
    expect(inventory.advanced.find((mount) => mount.id === "images:snap")).toMatchObject({
      label: "Package images (2 read-only mounts)",
    });
    expect(inventory.advanced.find((mount) => mount.id === "image:/srv/cold-view")).toMatchObject({
      kind: "image",
      backing: "/srv/retained/cold.sqsh",
    });
    expect(inventory.advanced.find((mount) => mount.kind === "other")?.label).toBe(
      "Swap file: /swap.img",
    );
    // None of them is among the disks or volumes.
    const everything = inventory.disks.flatMap((entry) => [...entry.volumes, ...entry.system]);
    for (const mount of [
      "/run",
      "/dev/shm",
      "/proc",
      "/sys/firmware/efi/efivars",
      "/srv/cold-view",
      "/var/lib/docker/rootfs",
    ])
      expect(everything.some((volume) => volume.mountPaths.includes(mount))).toBe(false);
  });

  it("labels remote storage with the actual host and the location behind it", () => {
    expect(inventory.remote).toEqual([
      expect.objectContaining({
        protocol: "sshfs",
        host: "storage-host (10.0.0.7)",
        backing: "/data/library/projects/remote",
        mountPaths: ["/srv/library/projects/remote"],
        capacityBytes: 2000 * GiB,
      }),
    ]);
    expect(
      inventory.disks
        .flatMap((entry) => entry.volumes)
        .some((volume) => volume.mountPaths.includes("/srv/library/projects/remote")),
    ).toBe(false);
  });

  it("reports a volume that could not be measured as unknown, never as zero", () => {
    const withoutData = workstation();
    const missing = new Map(withoutData.usage);
    missing.delete("/data");
    const result = buildLinuxDisks({ ...withoutData, usage: missing });
    const data = result.disks.find((entry) => entry.label === "WD data")!.volumes[0]!;
    expect(data).toMatchObject({
      capacityBytes: null,
      usedBytes: null,
      availableBytes: null,
      measuredAt: null,
    });
  });

  it("keeps block mounts that lsblk did not report, under a disk that says so", () => {
    const result = buildLinuxDisks({ ...workstation(), blocks: [] });
    const unidentified = result.disks.find((entry) => entry.id === "unidentified")!;
    expect(unidentified.model).toBeNull();
    expect(unidentified.volumes.map((volume) => volume.mountPaths[0]).toSorted()).toEqual([
      "/",
      "/data",
      "/media/user/STICK",
    ]);
  });
});

describe("configured reserves and agent-work headroom", () => {
  it("states the reserve and the headroom only where the configuration places agent work", () => {
    const result = buildLinuxDisks({
      ...workstation(),
      reserves: [
        { path: "/home/user/jobs", role: "agent-work", bytes: 60 * GiB },
        { path: "/srv/library", role: "library", bytes: 40 * GiB },
        { path: "/data/backup", role: "backup", bytes: 30 * GiB },
      ],
      workRoots: ["/home/user/jobs"],
      reserveSource: "the lifecycle tool's capacity configuration",
    });
    const root = result.disks.find((entry) => entry.label === "Kingston 1TB")!.volumes[0]!;
    const data = result.disks.find((entry) => entry.label === "WD data")!.volumes[0]!;
    // Work and library share the root filesystem: its reserve is the larger of the two.
    expect(root).toMatchObject({
      holds: expect.arrayContaining(["agent-work", "library"]),
      reserveBytes: 60 * GiB,
      availableBytes: 100 * GiB,
      headroomBytes: 40 * GiB,
    });
    // A backup reserve is a reserve, but no agent work lives there, so there is no work headroom.
    expect(data).toMatchObject({ holds: ["backup"], reserveBytes: 30 * GiB, headroomBytes: null });
    expect(result.reserveSource).toBe("the lifecycle tool's capacity configuration");
  });

  it("never turns an exhausted reserve into a negative number, nor a missing one into zero", () => {
    const tight = buildLinuxDisks({
      ...workstation(),
      reserves: [{ path: "/home/user/jobs", role: "agent-work", bytes: 200 * GiB }],
    });
    const root = tight.disks.find((entry) => entry.label === "Kingston 1TB")!.volumes[0]!;
    expect(root.headroomBytes).toBe(0);
    const unconfigured = buildLinuxDisks({ ...workstation(), workRoots: ["/home/user/jobs"] });
    const same = unconfigured.disks.find((entry) => entry.label === "Kingston 1TB")!.volumes[0]!;
    expect(same).toMatchObject({ holds: ["agent-work"], reserveBytes: null, headroomBytes: null });
    expect(unconfigured.reserveSource).toBeNull();
  });
});

describe("the disk inventory of a Windows computer", () => {
  const report: WindowsReport = {
    system: "C:",
    disks: [
      {
        index: 0,
        model: "NVMe system SSD 1TB",
        size: 1000 * GiB,
        iface: "SCSI",
        media: "Fixed hard disk media",
        bus: "NVMe",
        partitions: [
          { type: "GPT: System", size: 0.3 * GiB, volumes: [] },
          {
            type: "GPT: Basic Data",
            size: 600 * GiB,
            volumes: [
              { letter: "C:", label: "Windows", fs: "NTFS", size: 600 * GiB, free: 90 * GiB },
            ],
          },
          {
            type: "GPT: Basic Data",
            size: 399 * GiB,
            volumes: [
              { letter: "D:", label: "Projects", fs: "NTFS", size: 399 * GiB, free: 200 * GiB },
            ],
          },
          { type: "GPT: Unknown", size: 0.8 * GiB, volumes: [] },
        ],
      },
      {
        index: 1,
        model: "SATA data HDD 4TB",
        size: 4000 * GiB,
        iface: "SCSI",
        media: "Fixed hard disk media",
        bus: "SATA",
        partitions: [
          {
            type: "GPT: Basic Data",
            size: 2000 * GiB,
            volumes: [{ letter: "E:", label: null, fs: "NTFS", size: 2000 * GiB, free: 900 * GiB }],
          },
          {
            type: "GPT: Basic Data",
            size: 2000 * GiB,
            volumes: [
              { letter: "F:", label: "Archive", fs: "exFAT", size: 2000 * GiB, free: null },
            ],
          },
        ],
      },
      {
        index: 2,
        model: "Msft Virtual Disk",
        size: 256 * GiB,
        iface: "SCSI",
        media: "Fixed hard disk media",
        bus: null,
        partitions: [
          {
            type: "Installable File System",
            size: 256 * GiB,
            volumes: [{ letter: "V:", label: "wsl", fs: "NTFS", size: 256 * GiB, free: 100 * GiB }],
          },
        ],
      },
    ],
    network: [{ letter: "Z:", provider: "\\\\nas\\media", size: 8000 * GiB, free: 3000 * GiB }],
  };
  const inventory = buildWindowsDisks({
    host: "workstation",
    now,
    report,
    reserves: [{ path: "C:/Users/user/jobs", role: "agent-work", bytes: 20 * GiB }],
    reserveSource: "the lifecycle tool's capacity configuration",
    workRoots: ["C:/Users/user/jobs"],
    notices: [],
  });

  it("keeps C, D, E and F on the physical disks they belong to", () => {
    const system = inventory.disks.find((disk) => disk.model === "NVMe system SSD 1TB")!;
    const data = inventory.disks.find((disk) => disk.model === "SATA data HDD 4TB")!;
    expect(system.volumes.map((volume) => volume.id)).toEqual(["C:\\", "D:\\"]);
    expect(data.volumes.map((volume) => volume.id)).toEqual(["E:\\", "F:\\"]);
    expect(system.volumes[0]).toMatchObject({
      role: "system",
      label: "C: Windows",
      usedBytes: 510 * GiB,
      availableBytes: 90 * GiB,
      reserveBytes: 20 * GiB,
      headroomBytes: 70 * GiB,
      holds: ["agent-work"],
    });
    expect(system).toMatchObject({ bus: "NVMe" });
    expect(data.volumes[0]).toMatchObject({ label: "E:", role: "data", reserveBytes: null });
    // F: reports no free space: it is unknown, not full and not empty.
    expect(data.volumes[1]).toMatchObject({
      capacityBytes: 2000 * GiB,
      availableBytes: null,
      usedBytes: null,
    });
  });

  it("hides the EFI and recovery partitions under system details", () => {
    const system = inventory.disks.find((disk) => disk.model === "NVMe system SSD 1TB")!;
    expect(system.system.map((volume) => volume.role).toSorted()).toEqual(["boot", "recovery"]);
  });

  it("lists a virtual disk as a mounted image and a network drive as remote storage", () => {
    expect(inventory.disks.map((disk) => disk.model)).not.toContain("Msft Virtual Disk");
    expect(inventory.advanced).toEqual([
      expect.objectContaining({ kind: "image", backing: "Msft Virtual Disk" }),
    ]);
    expect(inventory.remote).toEqual([
      expect.objectContaining({
        host: "nas",
        backing: "\\\\nas\\media",
        protocol: "smb",
        mountPaths: ["Z:\\"],
      }),
    ]);
  });
});
