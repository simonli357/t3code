import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import { makeStorage, type StorageDeps } from "./Storage.ts";
import { output, toJson } from "./testSupport.ts";

/** A runner that finds no lsblk and no ssh: the inventory still answers from the mount table. */
const runner = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({ run: () => Effect.succeed(output("", 127, "not found")) }),
);

const deps = (
  directory: string,
  work: string | null,
  extra: Partial<StorageDeps> = {},
): StorageDeps => ({
  directory,
  workenv: Effect.succeed({ config: null, error: null }),
  workenvJobs: () => Effect.succeed([]),
  archive: () => Effect.succeed({ sources: [], problem: null }),
  verified: () => new Map(),
  sessions: Effect.succeed([]),
  shells: Effect.succeed({ projects: [], threads: [] }),
  agentWorkRoot: Effect.succeed(work),
  ...extra,
});

// These tests wait for a background worker that paces itself with real time, so they run live.
const live = Layer.mergeAll(NodeServices.layer, runner);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-storage-" });
  const work = `${base}/jobs`;
  const state = `${base}/state`;
  yield* fs.makeDirectory(state, { recursive: true });
  for (const folder of ["repo", "tmp", "cache", "build", "outputs", "extra"])
    yield* fs.makeDirectory(`${work}/job-one/${folder}`, { recursive: true });
  yield* fs.writeFileString(`${work}/job-one/repo/source.bin`, "s".repeat(300_000));
  yield* fs.writeFileString(`${work}/job-one/cache/dep.bin`, "d".repeat(200_000));
  yield* fs.writeFileString(`${work}/job-one/outputs/result.bin`, "o".repeat(100_000));
  yield* fs.writeFileString(`${work}/job-one/extra/other.bin`, "x".repeat(50_000));
  yield* fs.makeDirectory(`${work}/job-two`, { recursive: true });
  return { fs, base, work, state };
});
it.live("answers a request from caches, then fills in sizes from the background measurer", () =>
  Effect.gen(function* () {
    const { work, state } = yield* fixture;
    const storage = yield* makeStorage(deps(state, work));
    const first = yield* storage.holdings(false);
    const before = first.groups.find((group) => group.group === "workspaces")!;
    expect(before.entries.map((entry) => entry.title).toSorted()).toEqual(["job-one", "job-two"]);
    // The request itself measured nothing: sizes are unknown, and the view says it is measuring.
    expect(before.entries.every((entry) => entry.size.bytes === null)).toBe(true);
    expect(before.bytes).toBeNull();
    expect(first.measuring).toBe(true);

    yield* storage.settled;
    const after = (yield* storage.holdings(false)).groups.find(
      (group) => group.group === "workspaces",
    )!;
    const one = after.entries.find((entry) => entry.title === "job-one")!;
    expect(one.size).toMatchObject({ complete: true, basis: "allocated" });
    expect(one.size.bytes!).toBeGreaterThanOrEqual(650_000);
    expect(one.size.measuredAt).not.toBeNull();
    expect(after.bytes).toBeGreaterThanOrEqual(650_000);
    expect(after.unmeasured).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("remembers measurements across a restart instead of scanning again", () =>
  Effect.gen(function* () {
    const { work, state, fs } = yield* fixture;
    const first = yield* makeStorage(deps(state, work));
    yield* first.holdings(false);
    yield* first.settled;
    expect(yield* fs.exists(`${state}/storage-sizes.json`)).toBe(true);

    yield* Effect.gen(function* () {
      const restarted = yield* makeStorage(deps(state, work));
      const listed = yield* restarted.holdings(false);
      const group = listed.groups.find((entry) => entry.group === "workspaces")!;
      expect(
        group.entries.find((entry) => entry.title === "job-one")!.size.bytes,
      ).toBeGreaterThanOrEqual(650_000);
      expect(listed.measuring).toBe(false);
    }).pipe(Effect.scoped);
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("reads the parts of a workspace only when asked, and counts every folder once", () =>
  Effect.gen(function* () {
    const { work, state } = yield* fixture;
    const storage = yield* makeStorage(deps(state, work));
    const listed = yield* storage.holdings(false);
    const job = listed.groups[0]!.entries.find((entry) => entry.title === "job-one")!;
    const detail = (yield* storage.detail(job.id))!;
    expect(detail.parts.map((part) => part.key)).toEqual([
      "source",
      "tmp",
      "dependencies",
      "builds",
      "outputs",
      "other",
    ]);
    const bytes = Object.fromEntries(detail.parts.map((part) => [part.key, part.size.bytes]));
    expect(bytes.source!).toBeGreaterThanOrEqual(300_000);
    expect(bytes.dependencies!).toBeGreaterThanOrEqual(200_000);
    expect(bytes.outputs!).toBeGreaterThanOrEqual(100_000);
    expect(detail.parts.find((part) => part.key === "other")!.size.bytes!).toBeGreaterThanOrEqual(
      50_000,
    );
    expect(detail.notes.join(" ")).toMatch(/dependencies installed inside the repository/);
    expect(yield* storage.detail("workspace:/not/listed")).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("sends entries only for the groups asked for, with every group's totals", () =>
  Effect.gen(function* () {
    const { work, state } = yield* fixture;
    const storage = yield* makeStorage(deps(state, work));
    const headers = yield* storage.holdings(false, []);
    expect(headers.groups.map((group) => group.entries.length)).toEqual([0, 0, 0, 0]);
    expect(headers.groups[0]).toMatchObject({ count: 2, shown: 2 });
    const opened = yield* storage.holdings(false, ["workspaces"]);
    expect(opened.groups[0]!.entries).toHaveLength(2);
    expect(opened.groups.slice(1).every((group) => group.entries.length === 0)).toBe(true);
    // Every group is sent when none is named, as before.
    expect((yield* storage.holdings(false)).groups[0]!.entries).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("reports a session folder that no longer exists in a notice, not as an entry", () =>
  Effect.gen(function* () {
    const { work, state } = yield* fixture;
    const storage = yield* makeStorage(
      deps(state, work, {
        sessions: Effect.succeed([{ threadId: "t-1", root: `${work}/vanished` }]),
      }),
    );
    const listed = yield* storage.holdings(false);
    expect(listed.groups[0]!.entries.map((entry) => entry.title)).not.toContain("vanished");
    expect(listed.notices.join(" ")).toMatch(
      /1 session workspace record points at folders that no longer exist/,
    );
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live(
  "says kept results, backups and retention are unsupported when no lifecycle tool exists",
  () =>
    Effect.gen(function* () {
      const { work, state } = yield* fixture;
      const storage = yield* makeStorage(deps(state, work));
      const groups = (yield* storage.holdings(false)).groups;
      expect(groups.map((group) => group.group)).toEqual([
        "workspaces",
        "archives",
        "backups",
        "other",
      ]);
      expect(groups[0]).toMatchObject({ status: "partial" });
      expect(groups[1]).toMatchObject({ status: "unsupported", count: 0, bytes: null });
      expect(groups[2]).toMatchObject({ status: "unsupported", count: 0, bytes: null });
      expect(groups[1]!.reason).toMatch(/lifecycle tool/);
      for (const entry of groups[0]!.entries)
        expect(entry.workspace).toMatchObject({ state: "unknown", stateSource: "none" });
    }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live(
  "lists a project folder registered in T3 as retained source even without a lifecycle tool",
  () =>
    Effect.gen(function* () {
      const { work, state, base } = yield* fixture;
      const storage = yield* makeStorage(
        deps(state, work, {
          shells: Effect.succeed({
            projects: [{ id: "p1", title: "Storage app", workspaceRoot: `${base}/projects/app` }],
            threads: [],
          }),
        }),
      );
      const other = (yield* storage.holdings(false)).groups[3]!;
      expect(other.entries).toEqual([
        expect.objectContaining({
          title: "Storage app",
          subtitle: "Permanent source",
          other: expect.objectContaining({ classification: "permanent-source" }),
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(live)),
);

it.live("serves the real disk inventory of the machine it runs on", () =>
  Effect.gen(function* () {
    const { work, state } = yield* fixture;
    const storage = yield* makeStorage(deps(state, work));
    const disks = yield* storage.disks();
    expect(disks.os).toBe("linux");
    // lsblk is not available here: the volumes are still listed, under a disk that says so.
    expect(disks.notices.join(" ")).toMatch(/Physical disks could not be listed/);
    const volumes = disks.disks.flatMap((disk) => disk.volumes);
    expect(volumes.some((volume) => volume.mountPaths.includes("/"))).toBe(true);
    expect(
      volumes.every((volume) => volume.capacityBytes === null || volume.capacityBytes > 0),
    ).toBe(true);
    // The configured work root's volume is marked as holding agent work.
    expect(volumes.some((volume) => volume.holds.includes("agent-work"))).toBe(true);
    expect(toJson(disks)).toContain("sampledAt");
  }).pipe(Effect.scoped, Effect.provide(live)),
);
