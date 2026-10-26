import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessHostname, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { handoffActivity, readHandoffs, readJobs } from "./WorkenvActivity.ts";
import type { WorkenvConfig } from "./WorkenvConfig.ts";
import { toJson } from "./testSupport.ts";

const KEY_A = "a".repeat(24),
  KEY_B = "b".repeat(24);

const linuxJob = (root: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  identity: ["codex", "/home/simonli/.codex", "session"],
  project: "scandy-control",
  root,
  repo: `${root}/repo`,
  source: "/data/scandy/ScandyControl",
  mode: "worktree",
  generation: 0,
  created_at: 1_792_000_000.1,
  creation_source: "startup",
  owner_uid: 1000,
  status: "active",
  lifecycle: "linux-worktree-v1",
  ...extra,
});
// What the Windows tool writes: backslash paths, no owner uid, and the verified Handle binary.
const windowsJob = (root: string) => ({
  ...linuxJob(root, {
    project: "utility",
    status: "expired",
    created_at: 1_791_990_000,
    owner_uid: null,
  }),
  repo: `${root}\\repo`,
  source: "C:\\Users\\simon\\Documents\\projects\\utility",
  windows_handle: { path: "C:\\tools\\handle64.exe", sha256: "f".repeat(64) },
  generation: 1,
});

/** A `/proc` entry: the fields after the command name, with the start time in field 19. */
const stat = (pid: number, state: string, start: string) =>
  `${pid} (worker) ${[state, "1", "1", "1", "0", "-1", "0", "0", "0", "0", "0", "5", "3", "0", "0", "20", "0", "1", "0", start, "1048576", "100"].join(" ")}\n`;

it.layer(NodeServices.layer)("workenv jobs", (it) => {
  const write = (fs: FileSystem.FileSystem, file: string, text: string) =>
    fs
      .makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(file, text)));

  it.effect("lists Linux and Windows job records from every jobs folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jobs-" });
      const config: WorkenvConfig = {
        state: `${home}/state`,
        jobs_root: `${home}/jobs`,
        projects: {
          "scandy-control": { source: "/data/scandy/ScandyControl" },
          utility: {
            source: "C:\\Users\\simon\\Documents\\projects\\utility",
            jobs_root: `${home}/windows-jobs`,
          },
        },
        keep: { library_root: "/library", library_id: "id" },
      };
      const linuxName = `scandy-control-${KEY_A}`,
        windowsName = `utility-${KEY_B}-r1`;
      yield* write(
        fs,
        `${home}/jobs/${linuxName}/.workenv.json`,
        toJson(linuxJob(`/home/simonli/jobs/${linuxName}`)),
      );
      yield* write(
        fs,
        `${home}/windows-jobs/${windowsName}/.workenv.json`,
        toJson(windowsJob(`C:\\Users\\simon\\jobs\\${windowsName}`)),
      );
      yield* write(fs, `${home}/jobs/broken-${"c".repeat(24)}/.workenv.json`, "{not json");
      // The agent last started in the Linux job after it was created: that is its latest activity.
      yield* write(
        fs,
        `${home}/state/sessions/${KEY_A}.last-start.json`,
        toJson({ observed_at: 1_792_000_100.5 }),
      );
      yield* write(
        fs,
        `${home}/state/sessions/${KEY_B}.last-start.json`,
        toJson({ observed_at: 1_792_999_999 }),
      );

      const { activities, errors } = yield* readJobs(config, `${home}/no-proc`).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(errors).toEqual([]);
      expect(activities).toHaveLength(2);
      const linux = activities.find((job) => job.id === `job:${linuxName}`)!;
      expect(linux).toMatchObject({
        kind: "job",
        label: "scandy-control",
        status: "active",
        source: `/home/simonli/jobs/${linuxName}`,
        retryable: false,
      });
      expect(linux.updatedAt).toBe(1_792_000_100_500);
      const windows = activities.find((job) => job.id === `job:${windowsName}`)!;
      expect(windows).toMatchObject({
        label: "utility",
        status: "expired",
        source: `C:\\Users\\simon\\jobs\\${windowsName}`,
      });
      // An expired job's observation file is not read: only active jobs have anything running.
      expect(windows.updatedAt).toBe(1_791_990_000_000);
    }),
  );

  it.effect("reports a jobs folder it cannot read", () =>
    Effect.gen(function* () {
      const config: WorkenvConfig = {
        state: "/nowhere",
        jobs_root: "/nowhere/jobs",
        projects: {},
        keep: { library_root: "/l", library_id: "i" },
      };
      const { activities, errors } = yield* readJobs(config);
      expect(activities).toEqual([]);
      expect(errors[0]).toContain("Cannot read the workenv jobs folder /nowhere/jobs");
    }),
  );

  const running = (platform: NodeJS.Platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-running-" });
      yield* write(fs, `${home}/proc/sys/kernel/random/boot_id`, "boot-1\n");
      yield* write(fs, `${home}/proc/4242/stat`, stat(4242, "S", "999"));
      yield* write(fs, `${home}/proc/4343/stat`, stat(4343, "Z", "555"));
      yield* write(fs, `${home}/proc/4444/stat`, stat(4444, "S", "1000"));
      const identity = (pid: number, start: string, host = "testhost") => ({
        pid,
        start,
        boot: "boot-1",
        host,
        parent: 1,
        uid: 1000,
      });
      const launch = (name: string, processes: unknown[]) =>
        write(
          fs,
          `${home}/jobs/${name}/processes/launch.json`,
          toJson({ launch_id: "launch", status: "running", processes }),
        ).pipe(
          Effect.andThen(
            write(
              fs,
              `${home}/jobs/${name}/.workenv.json`,
              toJson(linuxJob(`${home}/jobs/${name}`, { project: "t3" })),
            ),
          ),
        );
      yield* launch(`t3-${"1".repeat(24)}`, [identity(4242, "999")]);
      yield* launch(`t3-${"2".repeat(24)}`, [identity(4343, "555")]); // a zombie is not running
      yield* launch(`t3-${"3".repeat(24)}`, [identity(4444, "999")]); // that pid now belongs to another process
      yield* launch(`t3-${"4".repeat(24)}`, [identity(4242, "999", "other-host")]); // recorded on another computer
      yield* launch(`t3-${"5".repeat(24)}`, [identity(9999, "1")]); // gone
      const config: WorkenvConfig = {
        state: `${home}/state`,
        jobs_root: `${home}/jobs`,
        projects: { t3: { source: "/s" } },
        keep: { library_root: "/l", library_id: "i" },
      };
      const result = yield* readJobs(config, `${home}/proc`).pipe(
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(HostProcessHostname, "testhost"),
      );
      return result;
    });

  it.effect("calls a job running only while a process workenv recorded for it is alive", () =>
    Effect.gen(function* () {
      const { activities, launched } = yield* running("linux");
      const status = Object.fromEntries(
        activities.map((job) => [job.id.slice(-24, -23), job.status]),
      );
      expect(status).toEqual({
        "1": "running",
        "2": "active",
        "3": "active",
        "4": "active",
        "5": "active",
      });
      expect(activities.find((job) => job.status === "running")?.detail).toContain("running");
      expect(launched).toHaveLength(5);
    }),
  );

  it.effect("reports a crash-left creating job as stalled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "creating-job-" });
      const job = `${root}/jobs/t3-${KEY_A}`;
      yield* fs.makeDirectory(job, { recursive: true });
      yield* fs.writeFileString(
        `${job}/.workenv.json`,
        toJson(linuxJob(job, { status: "creating" })),
      );
      const result = yield* readJobs(
        {
          state: `${root}/state`,
          jobs_root: `${root}/jobs`,
          projects: {},
          keep: { library_root: "/library", library_id: "id" },
        },
        `${root}/no-proc`,
      );
      expect(result.activities[0]).toMatchObject({
        status: "stalled",
        detail: "Last recorded: creating; its process was not found.",
      });
    }),
  );

  it.effect("does not attribute processes on Windows, where the records cannot be matched", () =>
    Effect.gen(function* () {
      const { activities, launched } = yield* running("win32");
      expect(activities.every((job) => job.status === "active")).toBe(true);
      expect(launched).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("workenv handoffs", (it) => {
  const sender = (status: string, extra: Record<string, unknown> = {}) => ({
    version: 2,
    id: "h",
    source: "/jobs/a/outputs/x",
    status,
    role: "sender",
    reason: "Required temporary input for myalien:/c/jobs/b/inputs/x",
    destination: { host: "myalien", job: "/c/jobs/b", path: "/c/jobs/b/inputs/x" },
    ...extra,
  });

  it.effect("turns the sender and receiver receipts into activity, and flags unreadable ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-handoffs-" });
      const source = `${home}/outputs/x`;
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.makeDirectory(`${home}/state/handoffs`, { recursive: true });
      const put = (name: string, value: unknown) =>
        fs.writeFileString(
          `${home}/state/handoffs/${name}`,
          typeof value === "string" ? value : toJson(value),
        );
      yield* put(
        "delivered.json",
        sender("delivered", {
          source,
          source_verified_at: 1_792_000_200,
          reference: "myalien:/c/jobs/b/inputs/x/payload",
        }),
      );
      yield* put("failing.json", sender("pending", { source, error: "ssh: connect timed out" }));
      yield* put("orphaned.json", sender("pending", { error: "x" }));
      yield* put("legacy.json", sender("pending", { source, version: 1 }));
      yield* put("receiving.json", sender("pending", { role: "receiver" }));
      yield* put("cancelled.json", sender("cancelled", { cancel_reason: "no longer needed" }));
      yield* put("broken.json", { source: "/x" });
      yield* put("delivered.rclone.log", "ignored");
      const config: WorkenvConfig = {
        state: `${home}/state`,
        projects: {},
        keep: { library_root: "/l", library_id: "i" },
      };
      const { activities, receipts, errors } = yield* readHandoffs(config);
      expect(receipts).toHaveLength(6);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("broken.json");
      const by = (key: string) => activities.find((activity) => activity.id === `handoff:${key}`)!;
      expect(by("delivered")).toMatchObject({
        kind: "transfer",
        status: "completed",
        retryable: false,
        updatedAt: 1_792_000_200_000,
      });
      expect(by("delivered").label).toBe("Handoff to myalien: x");
      expect(by("failing")).toMatchObject({ status: "failed", retryable: true, source });
      expect(by("failing").detail).toContain("timed out");
      expect(by("orphaned")).toMatchObject({ status: "failed", retryable: false });
      expect(by("orphaned").detail).toContain("source no longer exists");
      expect(by("legacy").retryable).toBe(false);
      expect(by("legacy").detail).toContain("current workenv");
      expect(by("receiving")).toMatchObject({ retryable: false });
      expect(by("receiving").label).toBe("Incoming input x");
      expect(by("cancelled")).toMatchObject({ status: "cancelled", detail: "no longer needed" });
    }),
  );

  it("falls back to the receipt file time when a handoff has no verification time", () => {
    expect(
      handoffActivity("x", sender("pending") as never, { modifiedAt: 5, sourceExists: true })
        .updatedAt,
    ).toBe(5);
  });
});
