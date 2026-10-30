// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - statfs has no Effect FileSystem counterpart.
import * as NodeFSP from "node:fs/promises";
import type {
  StorageDisk,
  StorageDisks,
  StorageRemoteMount,
  StorageSystemMount,
  StorageVolume,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { isWithin } from "./paths.ts";
import { fail } from "./WorkenvConfig.ts";

/**
 * The real disks of this computer and what is on them, told apart from everything else that a mount
 * table lists. A mount table is not a list of disks: memory, kernel views, mounted images, other
 * computers' storage and bind aliases of one filesystem all appear in it. They are sorted out here
 * (pure functions, tested on recorded mount tables) and the readers below only collect the inputs.
 */

/** A configured amount that must stay free on the volume holding `path`. */
export interface StorageReserve {
  readonly path: string;
  readonly role: "agent-work" | "library" | "backup" | "other";
  readonly bytes: number | null;
}

export interface MountRecord {
  readonly major: number;
  readonly minor: number;
  /** The directory of the filesystem this mount shows; anything but `/` is a bind of a subdirectory. */
  readonly root: string;
  readonly target: string;
  readonly fstype: string;
  readonly source: string;
}

export interface BlockNode {
  readonly kname: string;
  readonly majmin: string | null;
  readonly type: string;
  readonly size: number | null;
  readonly fstype: string | null;
  readonly model: string | null;
  readonly tran: string | null;
  readonly rotational: boolean | null;
  readonly removable: boolean | null;
  readonly label: string | null;
  readonly partitionType: string | null;
  readonly mountpoints: readonly string[];
  readonly children: readonly BlockNode[];
}

export interface FsUsage {
  readonly capacityBytes: number | null;
  readonly usedBytes: number | null;
  readonly availableBytes: number | null;
}

export interface SwapRecord {
  readonly path: string;
  readonly kind: string;
  readonly sizeBytes: number;
  readonly usedBytes: number;
}

export interface LinuxStorageInput {
  readonly host: string;
  readonly now: number;
  readonly mounts: readonly MountRecord[];
  readonly blocks: readonly BlockNode[];
  /** Usage by mount target; a mount without an entry could not be measured. */
  readonly usage: ReadonlyMap<string, FsUsage>;
  /** Image file behind each loop device, by kernel name (`loop3`). */
  readonly loops: ReadonlyMap<string, string>;
  readonly swaps: readonly SwapRecord[];
  /** The computer an ssh alias names, when it can be resolved. */
  readonly resolveHost: (alias: string) => string | null;
  readonly reserves: readonly StorageReserve[];
  readonly reserveSource: string | null;
  /** Agent work roots (the configured session work root) in addition to the reserves' own. */
  readonly workRoots: readonly string[];
  readonly notices: readonly string[];
}

const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** `/proc/self/mountinfo`: one mount per line, optional fields end at a lone `-`. */
export function parseMountInfo(text: string): MountRecord[] {
  const mounts: MountRecord[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const dash = fields.indexOf("-");
    if (fields.length < 10 || dash < 6) continue;
    const [major, minor] = (fields[2] ?? "").split(":").map(Number);
    if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor))
      continue;
    mounts.push({
      major,
      minor,
      root: unescapeMount(fields[3] ?? "/"),
      target: unescapeMount(fields[4] ?? ""),
      fstype: fields[dash + 1] ?? "",
      source: unescapeMount(fields[dash + 2] ?? ""),
    });
  }
  return mounts;
}

const decodeLsblk = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : null;
const flag = (value: unknown) =>
  typeof value === "boolean" ? value : value === "1" ? true : value === "0" ? false : null;

function blockNode(raw: unknown): BlockNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as Record<string, unknown>;
  const kname = text(node.kname) ?? text(node.name);
  if (!kname) return null;
  const points = Array.isArray(node.mountpoints)
    ? node.mountpoints
    : node.mountpoint !== undefined
      ? [node.mountpoint]
      : [];
  return {
    kname,
    majmin: text(node["maj:min"]),
    type: text(node.type) ?? "",
    size: num(node.size),
    fstype: text(node.fstype),
    model: text(node.model),
    tran: text(node.tran),
    rotational: flag(node.rota),
    removable: flag(node.rm) ?? flag(node.hotplug),
    label: text(node.label),
    partitionType: text(node.parttypename),
    mountpoints: points.flatMap((point) => (typeof point === "string" ? [point] : [])),
    children: Array.isArray(node.children)
      ? node.children.flatMap((child) => {
          const parsed = blockNode(child);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

/** `lsblk --json --bytes` output; an unreadable document has no devices. */
export function parseLsblk(json: string): BlockNode[] {
  const decoded = decodeLsblk(json);
  if (Option.isNone(decoded)) return [];
  const root = decoded.value as { blockdevices?: unknown } | null;
  return Array.isArray(root?.blockdevices)
    ? root.blockdevices.flatMap((raw) => {
        const parsed = blockNode(raw);
        return parsed ? [parsed] : [];
      })
    : [];
}

export function parseSwaps(content: string): SwapRecord[] {
  return content
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [path, kind, size, used] = line.trim().split(/\s+/);
      return path && kind && /^\d+$/.test(size ?? "") && /^\d+$/.test(used ?? "")
        ? [{ path, kind, sizeBytes: Number(size) * 1024, usedBytes: Number(used) * 1024 }]
        : [];
    });
}

const PSEUDO = new Set([
  "proc",
  "sysfs",
  "cgroup",
  "cgroup2",
  "devpts",
  "devtmpfs",
  "mqueue",
  "securityfs",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "pstore",
  "bpf",
  "binfmt_misc",
  "autofs",
  "hugetlbfs",
  "selinuxfs",
  "rpc_pipefs",
  "nsfs",
  "efivarfs",
  "overlay",
  "aufs",
  "fuse.portal",
  "fuse.gvfsd-fuse",
  "fuse.lxcfs",
  "fuse.snapfuse",
]);
const MEMORY = new Set(["tmpfs", "ramfs"]);
const REMOTE = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smb3",
  "smbfs",
  "afs",
  "ceph",
  "glusterfs",
  "lustre",
  "9p",
  "davfs",
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.s3fs",
  "fuse.davfs2",
  "fuse.nfs",
]);
const IMAGE = new Set(["squashfs", "erofs", "iso9660", "udf", "cramfs", "fuse.squashfuse"]);

type MountKind = "block" | "remote" | "memory" | "pseudo" | "image";
export function classifyMount(mount: MountRecord): MountKind {
  if (MEMORY.has(mount.fstype)) return "memory";
  if (/^\/dev\/loop\d+$/.test(mount.source) || IMAGE.has(mount.fstype)) return "image";
  if (REMOTE.has(mount.fstype)) return "remote";
  if (PSEUDO.has(mount.fstype)) return "pseudo";
  if (mount.source.startsWith("/dev/")) return "block";
  // A fuse filesystem or anything else that is not a block device is a view, not a disk.
  return "pseudo";
}

const BOOT_PATHS = new Set(["/boot", "/boot/efi", "/efi", "/boot/firmware"]);
const loopName = (source: string) => /^\/dev\/(loop\d+)$/.exec(source)?.[1] ?? null;

/** `host` and `backing` of a remote mount's source (`host:/path`, `//host/share`, `user@host:path`). */
export function parseRemoteSource(
  source: string,
  fstype: string,
  resolveHost: (alias: string) => string | null,
): { host: string | null; backing: string | null } {
  // An rclone remote is a name in the user's rclone configuration, not a computer.
  if (fstype === "fuse.rclone") return { host: null, backing: source || null };
  const unc = /^\/\/([^/]+)\/(.+)$/.exec(source);
  if (unc) return { host: unc[1] ?? null, backing: `//${unc[1]}/${unc[2]}` };
  const colon = source.indexOf(":");
  if (fstype === "9p") return { host: null, backing: source || null };
  if (colon > 0) {
    const alias = source.slice(0, colon).replace(/^[^@]*@/, "");
    const backing = source.slice(colon + 1) || "/";
    const resolved = resolveHost(alias);
    return {
      host: resolved && resolved !== alias ? `${alias} (${resolved})` : alias,
      backing,
    };
  }
  return { host: null, backing: source || null };
}

const EMPTY_USAGE: FsUsage = { capacityBytes: null, usedBytes: null, availableBytes: null };

function index(nodes: readonly BlockNode[]) {
  const byMajmin = new Map<string, { node: BlockNode; disk: BlockNode | null }>();
  const walk = (node: BlockNode, disk: BlockNode | null) => {
    const owner = node.type === "disk" ? node : disk;
    if (node.majmin && !byMajmin.has(node.majmin)) byMajmin.set(node.majmin, { node, disk: owner });
    for (const child of node.children) walk(child, owner);
  };
  for (const node of nodes) walk(node, null);
  return byMajmin;
}

const BUS: Record<string, string> = {
  nvme: "NVMe",
  sata: "SATA",
  ata: "SATA",
  usb: "USB",
  sas: "SAS",
  scsi: "SCSI",
  mmc: "SD/MMC",
};
const NOT_DISKS = /^(ram|zram|nbd|loop|sr|md|dm-)\d*$/;

/** Reserves apply to the volume holding their path; the most specific mount wins. */
function placeReserves(
  volumes: ReadonlyArray<{ readonly id: string; readonly paths: readonly string[] }>,
  reserves: readonly StorageReserve[],
  workRoots: readonly string[],
  platform: NodeJS.Platform,
) {
  const owner = (path: string) =>
    volumes
      .flatMap((volume) =>
        volume.paths
          .filter((candidate) => isWithin(platform, candidate, path))
          .map((candidate) => ({ id: volume.id, length: candidate.length })),
      )
      .toSorted((a, b) => b.length - a.length)[0]?.id ?? null;
  const placed = new Map<
    string,
    { reserve: number | null; holds: Set<StorageVolume["holds"][number]> }
  >();
  const entry = (id: string) => {
    const existing = placed.get(id);
    if (existing) return existing;
    const created = {
      reserve: null as number | null,
      holds: new Set<StorageVolume["holds"][number]>(),
    };
    placed.set(id, created);
    return created;
  };
  for (const reserve of reserves) {
    const id = owner(reserve.path);
    if (!id) continue;
    const target = entry(id);
    if (reserve.role !== "other") target.holds.add(reserve.role);
    if (reserve.bytes !== null) target.reserve = Math.max(target.reserve ?? 0, reserve.bytes);
  }
  for (const root of workRoots) {
    const id = owner(root);
    if (id) entry(id).holds.add("agent-work");
  }
  return placed;
}

const withReserve = (
  volume: StorageVolume,
  placed: ReturnType<typeof placeReserves>,
): StorageVolume => {
  const configured = placed.get(volume.id);
  if (!configured) return volume;
  const holds = [...configured.holds];
  const headroom =
    holds.includes("agent-work") && configured.reserve !== null && volume.availableBytes !== null
      ? Math.max(0, volume.availableBytes - configured.reserve)
      : null;
  return { ...volume, holds, reserveBytes: configured.reserve, headroomBytes: headroom };
};

export function buildLinuxDisks(input: LinuxStorageInput): StorageDisks {
  const { now, mounts, usage } = input;
  const blocks = index(input.blocks);
  const usageOf = (target: string) => usage.get(target) ?? EMPTY_USAGE;
  const kinds = mounts.map((mount) => ({ mount, kind: classifyMount(mount) }));

  // One volume per block device: the mount that shows the whole filesystem is its primary path, any
  // other mount of the same device is an alias of it.
  const byDevice = new Map<string, MountRecord[]>();
  for (const { mount, kind } of kinds) {
    if (kind !== "block") continue;
    const key = `${mount.major}:${mount.minor}`;
    byDevice.set(key, [...(byDevice.get(key) ?? []), mount]);
  }
  const volumes: Array<{ disk: BlockNode | null; volume: StorageVolume }> = [];
  const aliases: StorageSystemMount[] = [];
  const mountedKeys = new Set<string>();
  for (const [key, group] of byDevice) {
    mountedKeys.add(key);
    const ordered = group.toSorted(
      (a, b) =>
        Number(b.root === "/") - Number(a.root === "/") ||
        a.target.length - b.target.length ||
        a.target.localeCompare(b.target),
    );
    const primary = ordered[0]!;
    const known = blocks.get(key);
    const measured = usageOf(primary.target);
    const boot = ordered.some((mount) => BOOT_PATHS.has(mount.target));
    const label = known?.node.label ?? primary.target;
    const paths = [...new Set(ordered.map((mount) => mount.target))];
    for (const alias of ordered.slice(1))
      aliases.push({
        id: `alias:${alias.target}`,
        kind: "alias",
        label: alias.target,
        mountPaths: [alias.target],
        filesystem: alias.fstype,
        backing: `Same filesystem as ${primary.target}`,
        capacityBytes: null,
        usedBytes: null,
      });
    volumes.push({
      disk: known?.disk ?? null,
      volume: {
        id: primary.target,
        label,
        mountPaths: paths,
        filesystem: primary.fstype,
        device: primary.source,
        role: boot ? "boot" : paths.includes("/") ? "system" : "data",
        capacityBytes: measured.capacityBytes,
        usedBytes: measured.usedBytes,
        availableBytes: measured.availableBytes,
        reserveBytes: null,
        headroomBytes: null,
        holds: [],
        measuredAt: usage.has(primary.target) ? now : null,
      },
    });
  }

  // Partitions without a mount: swap, EFI, recovery, or simply unmounted.
  const unmounted: Array<{ disk: BlockNode; volume: StorageVolume }> = [];
  const walk = (node: BlockNode, disk: BlockNode | null) => {
    const owner = node.type === "disk" ? node : disk;
    const isLeaf = node.children.length === 0;
    if (
      owner &&
      node.type !== "disk" &&
      isLeaf &&
      !(node.majmin && mountedKeys.has(node.majmin)) &&
      node.mountpoints.every((point) => point === "[SWAP]" || point === "")
    ) {
      const swap = node.fstype === "swap" || node.mountpoints.includes("[SWAP]");
      const partition = node.partitionType?.toLowerCase() ?? "";
      unmounted.push({
        disk: owner,
        volume: {
          id: `/dev/${node.kname}`,
          label: node.label ?? `/dev/${node.kname}`,
          mountPaths: [],
          filesystem: node.fstype,
          device: `/dev/${node.kname}`,
          role: swap
            ? "swap"
            : partition.includes("efi")
              ? "boot"
              : /recovery|reserved|bios boot/.test(partition)
                ? "recovery"
                : "unmounted",
          capacityBytes: node.size,
          usedBytes: null,
          availableBytes: null,
          reserveBytes: null,
          headroomBytes: null,
          holds: [],
          measuredAt: null,
        },
      });
    }
    for (const child of node.children) walk(child, owner);
  };
  for (const node of input.blocks) walk(node, null);

  const placed = placeReserves(
    volumes.map(({ volume }) => ({ id: volume.id, paths: volume.mountPaths })),
    input.reserves,
    input.workRoots,
    "linux",
  );
  const diskNodes = input.blocks.filter(
    (node) => node.type === "disk" && !NOT_DISKS.test(node.kname) && (node.size ?? 0) > 0,
  );
  const disks: StorageDisk[] = diskNodes.map((disk) => {
    const own = volumes
      .filter((entry) => entry.disk?.kname === disk.kname)
      .map((entry) => withReserve(entry.volume, placed));
    const mine = own.filter((volume) => volume.role === "data" || volume.role === "system");
    const rest = [
      ...own.filter((volume) => volume.role !== "data" && volume.role !== "system"),
      ...unmounted.filter((entry) => entry.disk.kname === disk.kname).map((entry) => entry.volume),
    ];
    return {
      id: `/dev/${disk.kname}`,
      label: disk.model ?? `/dev/${disk.kname}`,
      model: disk.model,
      bus: disk.tran ? (BUS[disk.tran] ?? disk.tran.toUpperCase()) : null,
      media: disk.removable
        ? "removable"
        : disk.rotational === null
          ? null
          : disk.rotational
            ? "hdd"
            : "ssd",
      sizeBytes: disk.size,
      volumes: mine.toSorted((a, b) =>
        (a.mountPaths[0] ?? "").localeCompare(b.mountPaths[0] ?? ""),
      ),
      system: rest,
    };
  });
  // Block mounts whose disk lsblk did not report still are local storage; they are not dropped.
  const orphans = volumes
    .filter(({ disk }) => !disk || !diskNodes.some((node) => node.kname === disk.kname))
    .map((entry) => withReserve(entry.volume, placed));
  if (orphans.length)
    disks.push({
      id: "unidentified",
      label: "Local storage (disk not reported)",
      model: null,
      bus: null,
      media: null,
      sizeBytes: null,
      volumes: orphans.filter((volume) => volume.role === "data" || volume.role === "system"),
      system: orphans.filter((volume) => volume.role !== "data" && volume.role !== "system"),
    });

  const remote: StorageRemoteMount[] = kinds.flatMap(({ mount, kind }) => {
    if (kind !== "remote") return [];
    const measured = usageOf(mount.target);
    const where = parseRemoteSource(mount.source, mount.fstype, input.resolveHost);
    return [
      {
        id: mount.target,
        label: mount.target,
        protocol: mount.fstype.replace(/^fuse\./, ""),
        host: where.host,
        backing: where.backing,
        mountPaths: [mount.target],
        capacityBytes: measured.capacityBytes,
        usedBytes: measured.usedBytes,
        availableBytes: measured.availableBytes,
        measuredAt: usage.has(mount.target) ? now : null,
      },
    ];
  });

  const advanced: StorageSystemMount[] = [...aliases];
  const images = kinds.filter(({ kind }) => kind === "image");
  const snaps = images.filter(({ mount }) => mount.target.startsWith("/snap/"));
  if (snaps.length)
    advanced.push({
      id: "images:snap",
      kind: "image",
      label: `Package images (${snaps.length} read-only mounts)`,
      mountPaths: snaps.map(({ mount }) => mount.target).slice(0, 40),
      filesystem: "squashfs",
      backing: "Loop-mounted package files; they take space only as the files themselves.",
      capacityBytes: null,
      usedBytes: null,
    });
  for (const { mount } of images.filter(({ mount }) => !mount.target.startsWith("/snap/"))) {
    const loop = loopName(mount.source);
    advanced.push({
      id: `image:${mount.target}`,
      kind: "image",
      label: mount.target,
      mountPaths: [mount.target],
      filesystem: mount.fstype,
      backing: (loop ? input.loops.get(loop) : null) ?? "Image file not reported",
      capacityBytes: null,
      usedBytes: null,
    });
  }
  for (const { mount } of kinds.filter(({ kind }) => kind === "memory")) {
    const measured = usageOf(mount.target);
    advanced.push({
      id: `memory:${mount.target}`,
      kind: "memory",
      label: mount.target,
      mountPaths: [mount.target],
      filesystem: mount.fstype,
      backing: "RAM; not disk space",
      capacityBytes: measured.capacityBytes,
      usedBytes: measured.usedBytes,
    });
  }
  const pseudo = kinds.filter(({ kind }) => kind === "pseudo");
  if (pseudo.length)
    advanced.push({
      id: "pseudo",
      kind: "pseudo",
      label: `Kernel and system views (${pseudo.length} mounts)`,
      mountPaths: [...new Set(pseudo.map(({ mount }) => mount.target))].slice(0, 12),
      filesystem: [...new Set(pseudo.map(({ mount }) => mount.fstype))].slice(0, 10).join(", "),
      backing: null,
      capacityBytes: null,
      usedBytes: null,
    });
  for (const swap of input.swaps)
    advanced.push({
      id: `swap:${swap.path}`,
      kind: "other",
      label: `Swap ${swap.kind}: ${swap.path}`,
      mountPaths: [swap.path],
      filesystem: "swap",
      backing: null,
      capacityBytes: swap.sizeBytes,
      usedBytes: swap.usedBytes,
    });

  return {
    sampledAt: now,
    host: input.host,
    os: "linux",
    disks,
    remote,
    advanced,
    reserveSource: input.reserves.some((reserve) => reserve.bytes !== null)
      ? input.reserveSource
      : null,
    notices: [...input.notices],
  };
}

const WindowsVolume = Schema.Struct({
  letter: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  fs: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  free: Schema.NullOr(Schema.Number),
});
const WindowsPartition = Schema.Struct({
  type: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  volumes: Schema.Array(WindowsVolume),
});
const WindowsDisk = Schema.Struct({
  index: Schema.Number,
  model: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  iface: Schema.NullOr(Schema.String),
  media: Schema.NullOr(Schema.String),
  bus: Schema.NullOr(Schema.String),
  partitions: Schema.Array(WindowsPartition),
});
const WindowsNetwork = Schema.Struct({
  letter: Schema.String,
  provider: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  free: Schema.NullOr(Schema.Number),
});
const WindowsReport = Schema.Struct({
  disks: Schema.Array(WindowsDisk),
  network: Schema.Array(WindowsNetwork),
  /** Drive letter of the Windows system volume. */
  system: Schema.NullOr(Schema.String),
});
export type WindowsReport = typeof WindowsReport.Type;
const decodeWindowsReport = Schema.decodeUnknownEffect(Schema.fromJsonString(WindowsReport));

/** Collected by one PowerShell call; see `readWindowsDisks`. */
const WINDOWS_DISK_SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$physical=@{}
try { Get-PhysicalDisk | ForEach-Object { $physical[[string]$_.DeviceId]=[pscustomobject]@{bus=[string]$_.BusType;media=[string]$_.MediaType} } } catch {}
$disks=@(Get-CimInstance Win32_DiskDrive | ForEach-Object {
  $d=$_
  $extra=$physical[[string]$d.Index]
  $partitions=@(Get-CimAssociatedInstance -InputObject $d -ResultClassName Win32_DiskPartition | ForEach-Object {
    $p=$_
    $volumes=@(Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogicalDisk | ForEach-Object {
      [pscustomobject]@{letter=$_.DeviceID;label=$_.VolumeName;fs=$_.FileSystem;size=$_.Size;free=$_.FreeSpace}
    })
    [pscustomobject]@{type=$p.Type;size=$p.Size;volumes=$volumes}
  })
  [pscustomobject]@{index=[int]$d.Index;model=$d.Model;size=$d.Size;iface=$d.InterfaceType;media=$(if($extra -and $extra.media -and $extra.media -ne 'Unspecified'){$extra.media}else{$d.MediaType});bus=$(if($extra){$extra.bus}else{$null});partitions=$partitions}
})
$network=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=4' | ForEach-Object { [pscustomobject]@{letter=$_.DeviceID;provider=$_.ProviderName;size=$_.Size;free=$_.FreeSpace} })
ConvertTo-Json -Compress -Depth 6 -InputObject ([pscustomobject]@{disks=$disks;network=$network;system=$env:SystemDrive})`;

const windowsLetter = (value: string) =>
  /^[A-Za-z]:$/.test(value.replace(/[\\/]+$/, "")) ? `${value.replace(/[\\/]+$/, "")}\\` : value;

export function buildWindowsDisks(input: {
  readonly host: string;
  readonly now: number;
  readonly report: WindowsReport;
  readonly reserves: readonly StorageReserve[];
  readonly reserveSource: string | null;
  readonly workRoots: readonly string[];
  readonly notices: readonly string[];
}): StorageDisks {
  const { report, now } = input;
  const system = report.system?.toLowerCase() ?? null;
  const all: Array<{ disk: number; volume: StorageVolume }> = [];
  const hidden = new Map<number, StorageVolume[]>();
  const virtual: StorageSystemMount[] = [];
  const physicalDisks = report.disks.filter(
    (disk) => !/virtual/i.test(`${disk.model ?? ""} ${disk.iface ?? ""}`),
  );
  for (const disk of report.disks) {
    const isVirtual = !physicalDisks.includes(disk);
    disk.partitions.forEach((partition, position) => {
      for (const volume of partition.volumes) {
        const letter = volume.letter ?? `Disk ${disk.index} partition ${position + 1}`;
        if (isVirtual) {
          virtual.push({
            id: `image:${letter}`,
            kind: "image",
            label: volume.label ? `${letter} ${volume.label}` : letter,
            mountPaths: volume.letter ? [windowsLetter(volume.letter)] : [],
            filesystem: volume.fs,
            backing: disk.model ?? "Virtual disk",
            capacityBytes: volume.size,
            usedBytes:
              volume.size !== null && volume.free !== null ? volume.size - volume.free : null,
          });
          continue;
        }
        all.push({
          disk: disk.index,
          volume: {
            id: windowsLetter(letter),
            label: volume.label ? `${letter} ${volume.label}` : letter,
            mountPaths: volume.letter ? [windowsLetter(volume.letter)] : [],
            filesystem: volume.fs,
            device: `Disk ${disk.index}, partition ${position + 1}`,
            role: volume.letter?.toLowerCase() === system ? "system" : "data",
            capacityBytes: volume.size,
            usedBytes:
              volume.size !== null && volume.free !== null ? volume.size - volume.free : null,
            availableBytes: volume.free,
            reserveBytes: null,
            headroomBytes: null,
            holds: [],
            measuredAt: now,
          },
        });
      }
      if (!partition.volumes.length && !isVirtual) {
        const type = partition.type?.toLowerCase() ?? "";
        hidden.set(disk.index, [
          ...(hidden.get(disk.index) ?? []),
          {
            id: `disk${disk.index}:partition${position + 1}`,
            label: partition.type ?? `Partition ${position + 1}`,
            mountPaths: [],
            filesystem: null,
            device: `Disk ${disk.index}, partition ${position + 1}`,
            role: type.includes("system")
              ? "boot"
              : type.includes("reserved") || type.includes("unknown")
                ? "recovery"
                : "unmounted",
            capacityBytes: partition.size,
            usedBytes: null,
            availableBytes: null,
            reserveBytes: null,
            headroomBytes: null,
            holds: [],
            measuredAt: null,
          },
        ]);
      }
    });
  }
  const placed = placeReserves(
    all.map(({ volume }) => ({ id: volume.id, paths: volume.mountPaths })),
    input.reserves,
    input.workRoots,
    "win32",
  );
  const disks: StorageDisk[] = physicalDisks.map((disk) => {
    const bus = disk.bus ?? disk.iface;
    const media = /ssd|solid/i.test(disk.media ?? "")
      ? "ssd"
      : /removable|external/i.test(disk.media ?? "")
        ? "removable"
        : /hdd|fixed/i.test(disk.media ?? "")
          ? "hdd"
          : null;
    return {
      id: `disk${disk.index}`,
      label: disk.model ?? `Disk ${disk.index}`,
      model: disk.model,
      bus: bus && bus !== "Unknown" ? bus : null,
      media,
      sizeBytes: disk.size,
      volumes: all
        .filter((entry) => entry.disk === disk.index)
        .map((entry) => withReserve(entry.volume, placed))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
      system: hidden.get(disk.index) ?? [],
    };
  });
  const remote: StorageRemoteMount[] = report.network.map((drive) => {
    const unc = /^\\\\([^\\]+)\\(.+)$/.exec(drive.provider ?? "");
    return {
      id: windowsLetter(drive.letter),
      label: drive.letter,
      protocol: "smb",
      host: unc?.[1] ?? null,
      backing: drive.provider,
      mountPaths: [windowsLetter(drive.letter)],
      capacityBytes: drive.size,
      usedBytes: drive.size !== null && drive.free !== null ? drive.size - drive.free : null,
      availableBytes: drive.free,
      measuredAt: now,
    };
  });
  return {
    sampledAt: now,
    host: input.host,
    os: "windows",
    disks,
    remote,
    advanced: virtual,
    reserveSource: input.reserves.some((reserve) => reserve.bytes !== null)
      ? input.reserveSource
      : null,
    notices: [...input.notices],
  };
}

const STATFS_TIMEOUT_MS = 3_000;
const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * One `statfs` per mount at a time. A stale network mount can block the call indefinitely and each
 * blocked call holds a worker thread, so a call still pending is waited on again, never repeated.
 */
const pendingStatfs = new Map<string, Promise<FsUsage | null>>();
/** Mounts that did not answer in time, and when: they are not waited for again for a minute. */
const silent = new Map<string, number>();
const SILENT_FOR_MS = 60_000;
async function statFilesystem(target: string): Promise<FsUsage | null> {
  const since = silent.get(target);
  if (since !== undefined && Date.now() - since < SILENT_FOR_MS && pendingStatfs.has(target))
    return null;
  let started = pendingStatfs.get(target);
  if (!started) {
    silent.delete(target);
    started = NodeFSP.statfs(target)
      .then(
        (stats): FsUsage => ({
          capacityBytes: stats.blocks * stats.bsize,
          usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
          availableBytes: stats.bavail * stats.bsize,
        }),
        () => null,
      )
      .finally(() => {
        pendingStatfs.delete(target);
        silent.delete(target);
      });
    pendingStatfs.set(target, started);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      silent.set(target, Date.now());
      resolve(null);
    }, STATFS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([started, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** The inventory, and the mount table and usage it was built from (memory mounts feed the work folders). */
export interface DiskReading {
  readonly disks: StorageDisks;
  readonly mounts: readonly MountRecord[];
  readonly usage: ReadonlyMap<string, FsUsage>;
}

export interface StorageSettings {
  readonly reserves: readonly StorageReserve[];
  readonly reserveSource: string | null;
  readonly workRoots: readonly string[];
  readonly notices: readonly string[];
}

/** What ssh would connect to for an alias, from the local ssh configuration only (`ssh -G` connects to nothing). */
const resolveAliases = Effect.fn("StorageDisks.resolveAliases")(function* (
  aliases: ReadonlySet<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const resolved = new Map<string, string>();
  yield* Effect.forEach(
    [...aliases].filter((alias) => SSH_ALIAS.test(alias)).slice(0, 12),
    (alias) =>
      runner
        .run({ command: "ssh", args: ["-G", alias], timeout: "5 seconds", maxOutputBytes: 65536 })
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              const host = /^hostname (\S+)$/m.exec(result.stdout)?.[1];
              if (result.code === 0 && host) resolved.set(alias, host);
            }),
          ),
          Effect.ignore,
        ),
    { concurrency: 4, discard: true },
  );
  return resolved;
});

const readLinuxDisks = Effect.fn("StorageDisks.readLinux")(function* (
  settings: StorageSettings,
  procRoot = "/proc",
  sysRoot = "/sys",
) {
  const fs = yield* FileSystem.FileSystem,
    runner = yield* ProcessRunner.ProcessRunner,
    host = yield* HostProcess.Hostname;
  const now = yield* Clock.currentTimeMillis;
  const notices = [...settings.notices];
  const mounts = parseMountInfo(
    yield* fs.readFileString(`${procRoot}/self/mountinfo`).pipe(Effect.orElseSucceed(() => "")),
  );
  if (!mounts.length) notices.push("The mount table could not be read.");
  const lsblk = yield* runner
    .run({
      command: "lsblk",
      args: [
        "--json",
        "--bytes",
        "--output",
        "NAME,KNAME,MAJ:MIN,TYPE,SIZE,FSTYPE,MODEL,TRAN,ROTA,RM,HOTPLUG,LABEL,PARTTYPENAME,MOUNTPOINTS",
      ],
      timeout: "10 seconds",
      maxOutputBytes: 4 * 1024 * 1024,
    })
    .pipe(Effect.result);
  const blocks =
    lsblk._tag === "Success" && lsblk.success.code === 0 ? parseLsblk(lsblk.success.stdout) : [];
  if (!blocks.length)
    notices.push("Physical disks could not be listed (lsblk); volumes are shown without them.");
  const kinds = mounts.map((mount) => ({ mount, kind: classifyMount(mount) }));
  const usage = new Map<string, FsUsage>();
  const measure = ({ mount }: (typeof kinds)[number]) =>
    Effect.promise(() => statFilesystem(mount.target)).pipe(
      Effect.tap((measured) => Effect.sync(() => measured && usage.set(mount.target, measured))),
    );
  // Network mounts are asked two at a time: the ones that answer slowly must not hold up the rest.
  yield* Effect.all(
    [
      Effect.forEach(
        kinds.filter(({ kind }) => kind === "block" || kind === "memory"),
        measure,
        { concurrency: 8, discard: true },
      ),
      Effect.forEach(
        kinds.filter(({ kind }) => kind === "remote"),
        measure,
        { concurrency: 2, discard: true },
      ),
    ],
    { concurrency: 2, discard: true },
  );
  const loops = new Map<string, string>();
  yield* Effect.forEach(
    [...new Set(kinds.flatMap(({ mount }) => loopName(mount.source) ?? []))],
    (loop) =>
      fs.readFileString(`${sysRoot}/block/${loop}/loop/backing_file`).pipe(
        Effect.tap((file) => Effect.sync(() => file.trim() && loops.set(loop, file.trim()))),
        Effect.ignore,
      ),
    { concurrency: 8, discard: true },
  );
  const aliases = new Set(
    kinds.flatMap(({ mount, kind }) => {
      const colon = mount.source.indexOf(":");
      return kind === "remote" && colon > 0 && !mount.source.startsWith("//")
        ? [mount.source.slice(0, colon).replace(/^[^@]*@/, "")]
        : [];
    }),
  );
  const hosts = yield* resolveAliases(aliases);
  const swaps = parseSwaps(
    yield* fs.readFileString(`${procRoot}/swaps`).pipe(Effect.orElseSucceed(() => "")),
  );
  const disks = buildLinuxDisks({
    host,
    now,
    mounts,
    blocks,
    usage,
    loops,
    swaps,
    resolveHost: (alias) => hosts.get(alias) ?? null,
    reserves: settings.reserves,
    reserveSource: settings.reserveSource,
    workRoots: settings.workRoots,
    notices,
  });
  return { disks, mounts, usage } satisfies DiskReading;
});

const readWindowsDisks = Effect.fn("StorageDisks.readWindows")(function* (
  settings: StorageSettings,
) {
  const runner = yield* ProcessRunner.ProcessRunner,
    host = yield* HostProcess.Hostname;
  const now = yield* Clock.currentTimeMillis;
  const result = yield* runner
    .run({
      command: "powershell.exe",
      // Encoded, so a script of several lines needs no quoting on any shell or ssh hop.
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_DISK_SCRIPT, "utf16le").toString("base64"),
      ],
      timeout: "30 seconds",
      maxOutputBytes: 4 * 1024 * 1024,
    })
    .pipe(Effect.result);
  if (result._tag === "Failure" || result.success.code !== 0)
    return yield* fail(
      result._tag === "Failure"
        ? result.failure.message
        : `The disk query failed: ${result.success.stderr.trim().split("\n")[0] ?? "no details"}`,
    );
  const report = yield* decodeWindowsReport(result.success.stdout.trim()).pipe(
    Effect.mapError(() => fail("The disk query returned something unexpected.")),
  );
  return {
    disks: buildWindowsDisks({
      host,
      now,
      report,
      reserves: settings.reserves,
      reserveSource: settings.reserveSource,
      workRoots: settings.workRoots,
      notices: settings.notices,
    }),
    mounts: [],
    usage: new Map<string, FsUsage>(),
  } satisfies DiskReading;
});

export const readDiskInventory = Effect.fn("StorageDisks.read")(function* (
  settings: StorageSettings,
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return yield* readWindowsDisks(settings);
  if (platform === "linux") return yield* readLinuxDisks(settings);
  return yield* fail("The disk inventory supports Linux and Windows.");
});
