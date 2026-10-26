import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import { folders, processes, processUsage, realVolumes } from "./ComputerTelemetry.ts";
import { output, toJson } from "./testSupport.ts";

describe("process usage", () => {
  it("uses CPU deltas, rejects reused pids, and carries owner, command and job", () => {
    const process = { pid: 12, name: "busy", ticks: 100, started: "one", memoryBytes: 1000 };
    expect(processUsage([process], [{ ...process, ticks: 125 }], 100)[0]?.cpuPercent).toBe(25);
    expect(
      processUsage([process], [{ ...process, ticks: 125, started: "two" }], 100)[0]?.cpuPercent,
    ).toBeNull();
    expect(processUsage([], [process], 100)[0]).toMatchObject({
      command: null,
      owner: null,
      jobId: null,
    });
    expect(
      processUsage(
        [],
        [{ ...process, command: "node x.js", owner: "simon", jobId: "job:t3-1" }],
        0,
      )[0],
    ).toMatchObject({
      command: "node x.js",
      owner: "simon",
      jobId: "job:t3-1",
    });
  });
});

it.layer(NodeServices.layer)("folder sizes", (it) => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-folders-" });
    const bytes = (size: number) => "x".repeat(size);
    yield* fs.makeDirectory(`${root}/big/nested`, { recursive: true });
    yield* fs.makeDirectory(`${root}/small`);
    for (const name of ["a", "b"])
      yield* fs.writeFileString(`${root}/big/${name}.bin`, bytes(100_000));
    yield* fs.writeFileString(`${root}/big/nested/c.bin`, bytes(100_000));
    yield* fs.link(`${root}/big/a.bin`, `${root}/big/a-again.bin`);
    yield* fs.writeFileString(`${root}/small/note.txt`, "ten bytes!");
    yield* fs.writeFileString(`${root}/file.bin`, bytes(5_000));
    yield* fs.symlink(`${root}/big`, `${root}/linked`);
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "outside-size-" });
    yield* fs.writeFileString(`${outside}/large.bin`, bytes(2_000_000));
    yield* fs.symlink(`${outside}/large.bin`, `${root}/big/outside-file`);
    return root;
  });
  const row = (rows: ReadonlyArray<{ name: string }>, name: string) =>
    rows.find((entry) => entry.name === name) as never as {
      sizeBytes: number | null;
      sizeComplete?: boolean;
      directory: boolean;
    };

  it.effect("measures each folder, counts a hard link once and does not follow links", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const { rows, notices } = yield* folders(root);
      const big = row(rows, "big");
      // Three 100,000-byte files, allocated in blocks; a double-counted hard link would exceed 400,000.
      expect(big.sizeBytes).toBeGreaterThanOrEqual(300_000);
      expect(big.sizeBytes).toBeLessThan(400_000);
      expect(big).toMatchObject({ directory: true, sizeComplete: true });
      expect(row(rows, "small")).toMatchObject({ directory: true, sizeComplete: true });
      expect(row(rows, "file.bin")).toMatchObject({ directory: false, sizeBytes: 5_000 });
      expect(rows[0]!.name).toBe("big");
      // The link to a folder is listed but not measured, and the listing says why.
      expect(row(rows, "linked")).toMatchObject({ sizeBytes: null, sizeComplete: false });
      expect(notices.join(" ")).toContain("not measured");
    }),
  );

  it.effect("stops at its entry budget and marks what it counted as a lower bound", () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const { rows, notices } = yield* folders(root, 4);
      const incomplete = rows.filter((entry) => entry.directory && entry.sizeComplete === false);
      // Whatever ran out of budget says so, and never reports more than is really there.
      expect(incomplete.length).toBeGreaterThan(1);
      for (const entry of incomplete) expect(entry.sizeBytes ?? 0).toBeLessThan(400_000);
      expect(notices.join(" ")).toMatch(/lower bounds|not measured/);
    }),
  );

  it.effect("keeps wholly unmeasurable contents null while a verified empty folder is zero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "unknown-size-" });
      yield* fs.makeDirectory(`${root}/unknown`);
      yield* fs.makeDirectory(`${root}/empty`);
      yield* fs.writeFileString(`${root}/unknown/secret`, "unmeasured");
      const denied = FileSystem.FileSystem.of({
        ...fs,
        stat: (file) =>
          file.endsWith("/secret")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "stat",
                  pathOrDescriptor: file,
                }),
              )
            : fs.stat(file),
      });
      const result = yield* folders(root).pipe(
        Effect.provideService(FileSystem.FileSystem, denied),
      );
      expect(result.rows.find((file) => file.name === "unknown")).toMatchObject({
        sizeBytes: null,
        sizeComplete: false,
      });
      expect(result.rows.find((file) => file.name === "empty")).toMatchObject({
        sizeBytes: 0,
        sizeComplete: true,
      });
    }),
  );

  it.effect("bounds folder metadata calls for a directories-only source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "wide-folder-" });
      yield* fs.makeDirectory(`${root}/child`);
      yield* Effect.forEach(
        Array.from({ length: 30 }, (_, i) => `${root}/child/d${i}`),
        (folder) => fs.makeDirectory(folder),
        { concurrency: 8, discard: true },
      );
      let stats = 0;
      const observed = FileSystem.FileSystem.of({
        ...fs,
        stat: (file) => {
          stats++;
          return fs.stat(file);
        },
      });
      const result = yield* folders(root, 8).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
      );
      expect(stats).toBeLessThanOrEqual(9);
      expect(result.rows[0]).toMatchObject({ sizeBytes: null, sizeComplete: false });
      expect(result.notices.join()).toContain("not measured");
      stats = 0;
      const queueLimited = yield* folders(root, 100, 3).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
      );
      expect(stats).toBeLessThanOrEqual(5);
      expect(queueLimited.rows[0]).toMatchObject({ sizeBytes: null, sizeComplete: false });
    }),
  );

  it.effect("refuses a relative path", () =>
    Effect.gen(function* () {
      const failure = yield* folders("relative/path").pipe(Effect.flip);
      expect(failure.message).toContain("absolute");
    }),
  );
});

describe("process listing", () => {
  const fixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-proc-" });
    const stat = (pid: number, state: string, start: string, rss: number) =>
      `${pid} (name with space) ${[state, "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "5", "3", "0", "0", "20", "0", "1", "0", start, "1048576", String(rss)].join(" ")}\n`;
    const entry = (pid: number, state: string, start: string, rss: number, cmdline: string) =>
      fs
        .makeDirectory(`${root}/proc/${pid}`, { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(`${root}/proc/${pid}/stat`, stat(pid, state, start, rss)),
          ),
          Effect.andThen(fs.writeFileString(`${root}/proc/${pid}/cmdline`, cmdline)),
        );
    yield* fs.makeDirectory(`${root}/proc/sys/kernel/random`, { recursive: true });
    yield* fs.writeFileString(`${root}/proc/sys/kernel/random/boot_id`, "boot-1\n");
    yield* fs.writeFileString(`${root}/proc/stat`, "cpu  100 0 100 800 0 0 0 0 0 0\n");
    yield* fs.makeDirectory(`${root}/etc`);
    // The processes belong to whoever runs this test, whose uid the fake passwd file names.
    yield* fs.writeFileString(
      `${root}/etc/passwd`,
      `tester:x:${process.getuid?.() ?? 0}:0::/home/tester:/bin/sh\n`,
    );
    yield* entry(
      4242,
      "S",
      "999",
      200,
      "curl\0--user\0a:b\0--token\0x\0-H\0Authorization: Bearer synthetic-secret\0",
    );
    yield* entry(77, "S", "50", 100, "");
    yield* entry(4343, "Z", "555", 0, "");
    yield* fs.writeFileString(`${root}/proc/not-a-pid`, "x");
    return `${root}/proc`;
  });
  const list = (procRoot: string, launched: Parameters<typeof processes>[0]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ready = yield* Deferred.make<void>();
      const observed = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (file, options) =>
          fs
            .readFileString(file, options)
            .pipe(
              Effect.tap(() =>
                file === `${procRoot}/stat` ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
            ),
      });
      const fiber = yield* processes(launched, procRoot).pipe(
        Effect.provideService(FileSystem.FileSystem, observed),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(output("4096\n")) }),
        ),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessHostname, "testhost"),
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* TestClock.adjust("250 millis");
      return yield* Fiber.join(fiber);
    });

  it.effect("shows each process's owner and command, and the job workenv launched it for", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const procRoot = yield* fixture;
        const rows = yield* list(procRoot, [
          { jobId: "job:t3-aaaa", pid: 4242, start: "999", boot: "boot-1", host: "testhost" },
        ]);
        // The zombie holds nothing and is not listed; the biggest process comes first.
        expect(rows.map((entry) => entry.pid)).toEqual([4242, 77]);
        expect(rows[0]).toMatchObject({
          name: "name with space",
          command: "curl",
          owner: "tester",
          jobId: "job:t3-aaaa",
          memoryBytes: 200 * 4096,
        });
        expect(rows[1]).toMatchObject({ command: null, jobId: null });
        const response = toJson(rows);
        for (const secret of [
          "a:b",
          "--user",
          "--token",
          '"x"',
          "Authorization",
          "synthetic-secret",
        ])
          expect(response).not.toContain(secret);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes nothing by name or place: only an identical recorded identity counts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const procRoot = yield* fixture;
        const rows = yield* list(procRoot, [
          { jobId: "job:reused-pid", pid: 4242, start: "1000", boot: "boot-1", host: "testhost" },
          { jobId: "job:other-boot", pid: 4242, start: "999", boot: "boot-0", host: "testhost" },
          { jobId: "job:other-host", pid: 4242, start: "999", boot: "boot-1", host: "elsewhere" },
          { jobId: "job:no-boot", pid: 4242, start: "999", boot: null, host: null },
        ]);
        expect(rows.every((entry) => entry.jobId === null)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the overview's list of disks", () => {
  const listed = (label: string, path: string) => ({ label, path });
  it("keeps real volumes once each and drops memory, kernel, image and boot mounts", () => {
    expect(
      realVolumes(
        [
          listed("/dev/nvme1n1p2", "/"),
          listed("tmpfs", "/run"),
          listed("efivarfs", "/sys/firmware/efi/efivars"),
          listed("/dev/loop3", "/snap/core/3"),
          listed("/dev/nvme1n1p1", "/boot/efi"),
          listed("/dev/nvme0n1p1", "/data"),
          listed("/dev/nvme0n1p1", "/srv/archive"),
          listed("/dev/sda1", "/media/user/stick"),
        ],
        "linux",
      ).map((disk) => disk.path),
    ).toEqual(["/", "/data", "/media/user/stick"]);
  });

  it("leaves a Windows drive list as it is", () => {
    const drives = [listed("Windows", "C:\\"), listed("Data", "D:\\")];
    expect(realVolumes(drives, "win32")).toEqual(drives);
  });
});
