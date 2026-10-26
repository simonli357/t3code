import { ComputerOperationError, type ComputerFile } from "@t3tools/contracts";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { samePath } from "./paths.ts";
import { readNames } from "./ComputerDirectory.ts";
import { attributeToJob, readBootId, type Launched } from "./WorkenvProcesses.ts";

const command = Effect.fn(function* (command: string, args: readonly string[]) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({ command, args });
  if (result.code !== 0)
    return yield* new ComputerOperationError({ message: `${command} failed: ${result.stderr}` });
  return result.stdout;
});
const powershell = (script: string) =>
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
export const disks = Effect.fn(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    const rows = yield* powershell(
      "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.Size -gt 0 } | Select-Object DeviceID,Size,FreeSpace,VolumeName)",
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Array(
              Schema.Struct({
                DeviceID: Schema.String,
                Size: Schema.Number,
                FreeSpace: Schema.Number,
                VolumeName: Schema.NullOr(Schema.String),
              }),
            ),
          ),
        ),
      ),
    );
    return rows.map((r) => ({
      path: `${r.DeviceID}\\`,
      label: r.VolumeName || r.DeviceID,
      totalBytes: r.Size,
      availableBytes: r.FreeSpace,
      freeBytes: r.FreeSpace,
    }));
  }
  if (platform !== "linux")
    return yield* new ComputerOperationError({
      message: "Disk inspection supports Linux and Windows.",
    });
  const output = yield* command("df", ["-B1", "-P", "-l"]);
  return output
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line);
      return m
        ? [
            {
              path: m[5]!,
              label: m[1]!,
              totalBytes: Number(m[2]),
              freeBytes: Number(m[2]) - Number(m[3]),
              availableBytes: Number(m[4]),
            },
          ]
        : [];
    });
});
const BOOT_MOUNTS = new Set(["/boot", "/boot/efi", "/efi", "/boot/firmware"]);
/**
 * The filesystems of `disks` that are real volumes: on Linux, ones on a block device other than a
 * loop device (a mounted image is not a disk), once per device, boot partitions left to the
 * storage views' advanced details. `df` already hides most aliases of one device; this drops the
 * memory, kernel and image mounts it lists, which are not disks either.
 */
export function realVolumes<D extends { path: string; label: string }>(
  listed: readonly D[],
  platform: string,
): D[] {
  if (platform !== "linux") return [...listed];
  const byDevice = new Map<string, D>();
  for (const disk of listed) {
    if (!disk.label.startsWith("/dev/") || /^\/dev\/loop\d+$/.test(disk.label)) continue;
    if (BOOT_MOUNTS.has(disk.path)) continue;
    const known = byDevice.get(disk.label);
    if (!known || disk.path.length < known.path.length) byDevice.set(disk.label, disk);
  }
  return [...byDevice.values()];
}
type Sample = {
  pid: number;
  name: string;
  ticks: number;
  started: string;
  memoryBytes: number;
  command?: string | null;
  owner?: string | null;
  jobId?: string | null;
};
export function processUsage(
  before: readonly Sample[],
  after: readonly Sample[],
  totalDelta: number,
) {
  const prior = new Map(before.map((p) => [p.pid, p]));
  return after
    .map((p) => {
      const old = prior.get(p.pid);
      return {
        pid: p.pid,
        name: p.name,
        memoryBytes: p.memoryBytes,
        cpuPercent:
          old && old.started === p.started && totalDelta > 0 && p.ticks >= old.ticks
            ? Math.min(100, ((p.ticks - old.ticks) / totalDelta) * 100)
            : null,
        command: p.command ?? null,
        owner: p.owner ?? null,
        jobId: p.jobId ?? null,
      };
    })
    .sort((a, b) => b.memoryBytes - a.memoryBytes);
}
/** `uid` to user name from the passwd file; a uid without an entry is shown as its number. */
const userNames = Effect.fn("Computers.userNames")(function* (procRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = new Map<number, string>();
  const passwd = yield* fs
    .readFileString(`${procRoot.replace(/proc$/, "etc")}/passwd`)
    .pipe(Effect.orElseSucceed(() => ""));
  for (const line of passwd.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name && uid && /^\d+$/.test(uid) && !names.has(Number(uid))) names.set(Number(uid), name);
  }
  return names;
});
/**
 * `detail` adds each process's owner and command line, which costs two more reads per process;
 * only the second of the two CPU samples needs them.
 */
const sample = Effect.fn(function* (detail: boolean, procRoot = "/proc") {
  const fs = yield* FileSystem.FileSystem,
    platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    const rows = yield* powershell(
      "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-Process | ForEach-Object { try { [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;ticks=$_.TotalProcessorTime.TotalMilliseconds;started=$_.StartTime.ToUniversalTime().Ticks.ToString();memoryBytes=$_.WorkingSet64} } catch {} })",
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Array(
              Schema.Struct({
                pid: Schema.Number,
                name: Schema.String,
                ticks: Schema.Number,
                started: Schema.String,
                memoryBytes: Schema.Number,
              }),
            ),
          ),
        ),
      ),
    );
    return {
      rows: rows as Sample[],
      total: (yield* Clock.currentTimeMillis) * NodeOS.cpus().length,
    };
  }
  if (platform !== "linux")
    return yield* new ComputerOperationError({
      message: "Process sampling supports Linux and Windows.",
    });
  const pageSize = Number((yield* command("getconf", ["PAGESIZE"])).trim());
  const users = detail ? yield* userNames(procRoot) : new Map<number, string>();
  const read = Effect.fn(function* (pid: string) {
    const stat = yield* fs.readFileString(`${procRoot}/${pid}/stat`).pipe(Effect.option);
    if (Option.isNone(stat)) return null;
    const end = stat.value.lastIndexOf(")"),
      fields = stat.value.slice(end + 2).split(" ");
    // Zombies hold no memory and, as in workenv's own process table, are not processes to show.
    if (fields[0] === "Z") return null;
    const row: Sample = {
      pid: Number(pid),
      name: stat.value.slice(stat.value.indexOf("(") + 1, end),
      ticks: Number(fields[11]) + Number(fields[12]),
      started: fields[19]!,
      memoryBytes: Number(fields[21]) * pageSize,
    };
    if (!detail) return row;
    const uid = yield* fs.stat(`${procRoot}/${pid}`).pipe(
      Effect.map((info) => Option.getOrNull(info.uid)),
      Effect.orElseSucceed(() => null),
    );
    const commandLine = yield* fs
      .readFileString(`${procRoot}/${pid}/cmdline`)
      .pipe(Effect.orElseSucceed(() => ""));
    return {
      ...row,
      owner: uid === null ? null : (users.get(uid) ?? String(uid)),
      command: commandLine.split("\0", 1)[0] || null,
    };
  });
  const rows = (yield* Effect.forEach(
    (yield* fs.readDirectory(procRoot)).filter((n) => /^\d+$/.test(n)),
    read,
    { concurrency: 16 },
  )).flatMap((row) => (row ? [row] : []));
  const total = (yield* fs.readFileString(`${procRoot}/stat`))
    .split("\n")[0]!
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .reduce((a, n) => a + Number(n), 0);
  return { rows, total };
});
/**
 * The processes of this computer by memory, with CPU measured over a short interval. On Linux each
 * carries its owner and command, and `jobId` when workenv's launch records (`launched`) say a job
 * started it; the caller reads those records, this only matches live identities to them.
 */
export const processes = Effect.fn("Computers.processes")(function* (
  launched: readonly Launched[] = [],
  procRoot = "/proc",
) {
  const before = yield* sample(false, procRoot);
  // A measurement interval, not a wait for asynchronous work to finish.
  yield* Effect.sleep("250 millis");
  const after = yield* sample(true, procRoot);
  const platform = yield* HostProcessPlatform;
  if (platform === "linux" && launched.length) {
    const host = yield* HostProcessHostname,
      boot = yield* readBootId(procRoot);
    const byPid = new Map<number, Launched[]>();
    for (const item of launched) byPid.set(item.pid, [...(byPid.get(item.pid) ?? []), item]);
    for (const row of after.rows)
      row.jobId = attributeToJob(byPid, { pid: row.pid, start: row.started }, boot, host);
  }
  return processUsage(before.rows, after.rows, after.total - before.total);
});
/** Work one folder listing may spend measuring sizes; whatever is left unmeasured is reported. */
const FOLDER_ENTRY_BUDGET = 200_000;
const FOLDER_TIME_BUDGET_MS = 8_000;
const LISTING_LIMIT = 2_000;

/**
 * Bytes under one folder, counted as `du -x` would: allocated space, one count per hard-linked
 * file, nothing across links or onto another filesystem. Stops when the shared entry budget, this
 * folder's share of it, or the deadline runs out, and says so: the bytes are then a lower bound.
 */
const measureFolder = Effect.fn("Computers.measureFolder")(function* (
  root: string,
  real: string,
  device: number,
  budget: { entries: number; directories: number },
  share: number,
  deadline: number,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcessPlatform;
  const seen = new Set<string>();
  const stack = [{ path: root, real }];
  let bytes = 0,
    visited = 0,
    measured = 0,
    complete = true;
  scan: while (stack.length) {
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (budget.entries <= 0 || visited >= share || remaining <= 0) {
      complete = false;
      break;
    }
    const directory = stack.pop()!;
    const names = yield* readNames(directory.path, Math.min(budget.entries, share - visited)).pipe(
      Effect.timeoutOption(`${remaining} millis`),
      Effect.option,
    );
    if (Option.isNone(names) || Option.isNone(names.value)) {
      complete = false;
      continue;
    }
    complete &&= !names.value.value.truncated;
    for (const name of names.value.value.names) {
      if (
        budget.entries <= 0 ||
        visited >= share ||
        (visited % 256 === 0 && (yield* Clock.currentTimeMillis) >= deadline)
      ) {
        complete = false;
        break scan;
      }
      budget.entries--;
      visited++;
      const child = path.join(directory.path, name);
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isNone(info)) {
        complete = false;
        continue;
      }
      if (info.value.dev !== device) continue;
      const actual = yield* fs.realPath(child).pipe(Effect.option);
      if (Option.isNone(actual)) {
        complete = false;
        continue;
      }
      if (!samePath(platform, actual.value, path.join(directory.real, name))) continue;
      const identity = Option.isSome(info.value.ino)
        ? `${info.value.dev}:${info.value.ino.value}`
        : null;
      if (info.value.type === "Directory") {
        if (identity && seen.has(identity)) continue;
        if (identity) seen.add(identity);
        if (budget.directories <= 0) {
          complete = false;
          break scan;
        }
        budget.directories--;
        stack.push({ path: child, real: actual.value });
      } else if (info.value.type === "File") {
        if (Option.getOrElse(info.value.nlink, () => 1) > 1 && identity) {
          if (seen.has(identity)) continue;
          seen.add(identity);
        }
        const blocks = Option.getOrNull(info.value.blocks);
        bytes += blocks === null ? Number(info.value.size) : blocks * 512;
        measured++;
      }
    }
  }
  return { bytes, measured, complete };
});

/**
 * The immediate children of a folder, files with their size and folders with a measured one. The
 * measurement is bounded (see `FOLDER_ENTRY_BUDGET`): a folder that did not finish carries the
 * bytes counted so far with `sizeComplete: false`, or null when none were counted, and the
 * returned notices say how much of the listing is incomplete.
 */
export const folders = Effect.fn("Computers.folders")(function* (
  directory: string,
  entryBudget = FOLDER_ENTRY_BUDGET,
  directoryBudget = 20_000,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcessPlatform;
  if (!path.isAbsolute(directory))
    return yield* new ComputerOperationError({ message: "Choose an absolute folder path." });
  const deadline = (yield* Clock.currentTimeMillis) + FOLDER_TIME_BUDGET_MS;
  const listing = yield* readNames(directory, Math.min(LISTING_LIMIT, entryBudget)).pipe(
    Effect.mapError(
      (error) =>
        new ComputerOperationError({ message: `Cannot read ${directory}: ${error.message}` }),
    ),
  );
  const canonical = yield* fs.realPath(directory);
  const device = (yield* fs.stat(directory).pipe(Effect.option)).pipe(
    Option.map((info) => info.dev),
    Option.getOrNull,
  );
  const budget = {
    entries: Math.max(0, entryBudget - listing.names.length),
    directories: directoryBudget,
  };
  const children = yield* Effect.forEach(
    listing.names,
    (name) =>
      Effect.gen(function* () {
        const filename = path.join(directory, name);
        const info = yield* fs.stat(filename).pipe(Effect.option);
        if (Option.isNone(info)) return null;
        const real = yield* fs.realPath(filename).pipe(Effect.option);
        const linked = !(
          Option.isSome(real) && samePath(platform, real.value, path.join(canonical, name))
        );
        return {
          name,
          filename,
          info: info.value,
          real: Option.getOrNull(real),
          measurable: !linked && info.value.dev === device,
        };
      }),
    { concurrency: 16 },
  );
  const listed = children.flatMap((child) => (child ? [child] : []));
  const measurable = listed.filter((child) => child.info.type === "Directory" && child.measurable);
  const share = Math.max(
    2_000,
    Math.min(50_000, Math.floor(entryBudget / Math.max(1, measurable.length))),
  );
  const sizes = new Map<string, { bytes: number; measured: number; complete: boolean }>();
  yield* Effect.forEach(
    measurable,
    (child) =>
      Effect.gen(function* () {
        if (budget.directories <= 0) return { bytes: 0, measured: 0, complete: false };
        budget.directories--;
        return yield* measureFolder(
          child.filename,
          child.real!,
          device ?? child.info.dev,
          budget,
          share,
          deadline,
        );
      }).pipe(Effect.tap((size) => Effect.sync(() => sizes.set(child.filename, size)))),
    { concurrency: 4, discard: true },
  );
  let lowerBounds = 0,
    unmeasured = 0;
  const rows = listed.map((child): ComputerFile => {
    const directoryChild = child.info.type === "Directory";
    const size = sizes.get(child.filename);
    if (directoryChild && (!size || (!size.complete && size.measured === 0))) unmeasured++;
    else if (size && !size.complete) lowerBounds++;
    return {
      path: child.filename,
      name: child.name,
      project: "",
      area: "work",
      sizeBytes: !directoryChild
        ? Number(child.info.size)
        : size && (size.complete || size.measured > 0)
          ? size.bytes
          : null,
      ...(directoryChild ? { sizeComplete: size?.complete ?? false } : {}),
      modifiedAt: Option.getOrNull(Option.map(child.info.mtime, (date) => date.getTime())),
      directory: directoryChild,
      backup: "not-verified",
      backupVerifiedAt: null,
      reference: null,
    };
  });
  rows.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
  const notices = [
    ...(listing.truncated
      ? [`Only the first ${LISTING_LIMIT.toLocaleString("en-US")} entries are listed.`]
      : []),
    ...(lowerBounds
      ? [
          `${lowerBounds} folder${lowerBounds === 1 ? " is" : "s are"} larger than what was measured in the time allowed; their sizes are lower bounds.`,
        ]
      : []),
    ...(unmeasured
      ? [
          `${unmeasured} folder${unmeasured === 1 ? " was" : "s were"} not measured: links, other disks, or out of time.`,
        ]
      : []),
  ];
  return { rows, notices };
});
