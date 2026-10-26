import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ComputerFile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  indexableRoots,
  indexFiles,
  mergeSorted,
  searchFiles,
  sortFiles,
} from "./ComputerFiles.ts";

const file = (name: string, project = "p", path = `/work/${project}/${name}`): ComputerFile => ({
  path,
  name,
  project,
  sizeBytes: 1,
  modifiedAt: null,
  directory: false,
  backup: "not-verified",
  reference: null,
});

describe("which roots are indexed", () => {
  const roots = (
    paths: string[],
    library: string | undefined,
    platform: NodeJS.Platform = "linux",
  ) =>
    indexableRoots(
      platform,
      paths.map((path) => ({ path })),
      library,
      (path) => (platform === "win32" ? path.slice(0, 3) : "/"),
    ).map((root) => root.path);
  it("skips filesystem roots, repeated roots and anything overlapping the kept library", () => {
    expect(
      roots(
        [
          "/",
          "/home/a",
          "/home/a",
          "/srv",
          "/srv/work-library",
          "/srv/work-library/projects/ara",
          "/data/b",
        ],
        "/srv/work-library",
      ),
    ).toEqual(["/home/a", "/data/b"]);
  });
  it("compares Windows paths without case", () => {
    expect(
      roots(["C:\\", "C:\\Users\\simon\\p", "D:\\LIBRARY\\x", "d:\\"], "d:\\library", "win32"),
    ).toEqual(["C:\\Users\\simon\\p"]);
  });
});

describe("searching files", () => {
  const files = sortFiles([
    file("zeta.txt"),
    file("Alpha.md"),
    file("beta.txt"),
    file("alpha.txt", "q"),
  ]);
  it("keeps one order, and a page is a slice of it", () => {
    expect(files.map((entry) => entry.name)).toEqual([
      "Alpha.md",
      "alpha.txt",
      "beta.txt",
      "zeta.txt",
    ]);
    expect(searchFiles(files, { limit: 2 }).files.map((entry) => entry.name)).toEqual([
      "Alpha.md",
      "alpha.txt",
    ]);
    expect(searchFiles(files, { limit: 2, offset: 2 })).toMatchObject({ total: 4 });
    expect(searchFiles(files, { limit: 2, offset: 3 }).files).toHaveLength(1);
  });
  it("takes pages of 200 by default and never more than 5000", () => {
    const many = sortFiles(Array.from({ length: 5_300 }, (_, i) => file(`f${i}.txt`)));
    expect(searchFiles(many, {}).files).toHaveLength(200);
    expect(searchFiles(many, { limit: 5_000 }).files).toHaveLength(5_000);
    expect(searchFiles(many, { limit: 100_000 }).files).toHaveLength(5_000);
    expect(searchFiles(many, { limit: 100_000, offset: 5_000 }).files).toHaveLength(300);
    expect(searchFiles(many, { limit: 100_000 }).total).toBe(5_300);
  });
  it("filters without reordering and reports the total of every match", () => {
    expect(searchFiles(files, { query: "ALPHA" })).toMatchObject({ total: 2 });
    expect(searchFiles(files, { extension: ".TXT", limit: 1 })).toMatchObject({ total: 3 });
    expect(searchFiles(files, { project: "q" }).files.map((entry) => entry.name)).toEqual([
      "alpha.txt",
    ]);
    expect(searchFiles(files, { query: "kept reason" }).total).toBe(0);
  });
  it("merges two ordered lists into one ordered list", () => {
    const merged = mergeSorted(
      sortFiles([file("b.txt"), file("d.txt")]),
      sortFiles([file("a.txt"), file("c.txt"), file("e.txt")]),
    );
    expect(merged.map((entry) => entry.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
    ]);
    expect(mergeSorted([], merged)).toHaveLength(5);
  });
});

it.layer(NodeServices.layer)("indexing project files", (it) => {
  it.effect(
    "follows a root that is itself a link, as a Windows junction is, but no link inside it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-" });
        yield* fs.makeDirectory(`${home}/real/src/deep`, { recursive: true });
        yield* fs.makeDirectory(`${home}/real/node_modules/dep`, { recursive: true });
        yield* fs.makeDirectory(`${home}/real/.hidden`, { recursive: true });
        yield* fs.makeDirectory(`${home}/outside`);
        yield* fs.writeFileString(`${home}/real/README.md`, "readme");
        yield* fs.writeFileString(`${home}/real/src/deep/main.ts`, "x");
        yield* fs.writeFileString(`${home}/real/node_modules/dep/index.js`, "skipped");
        yield* fs.writeFileString(`${home}/real/.hidden/secret.txt`, "skipped");
        yield* fs.writeFileString(`${home}/outside/other.txt`, "outside");
        yield* fs.symlink(`${home}/outside`, `${home}/real/escape`);
        yield* fs.symlink(`${home}/outside/other.txt`, `${home}/real/linked-file.txt`);
        // The project is configured through a link, as MyAlien's projects are.
        yield* fs.symlink(`${home}/real`, `${home}/project`);
        const { files, errors } = yield* indexFiles([
          { path: `${home}/project`, project: "utility" },
        ]);
        expect(errors).toEqual([]);
        expect(files.map((entry) => entry.path).sort()).toEqual([
          `${home}/project/README.md`,
          `${home}/project/src/deep/main.ts`,
        ]);
        expect(files.every((entry) => entry.project === "utility")).toBe(true);
      }),
  );

  it.effect(
    "never enters a folder it was told to skip, and reports a root that does not exist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-index-skip-" });
        yield* fs.makeDirectory(`${home}/p/state`, { recursive: true });
        yield* fs.writeFileString(`${home}/p/state/receipt.json`, "x");
        yield* fs.writeFileString(`${home}/p/keep.txt`, "x");
        const { files, errors } = yield* indexFiles(
          [
            { path: `${home}/p`, project: "p" },
            { path: `${home}/gone`, project: "gone" },
          ],
          [`${home}/p/state`],
        );
        expect(files.map((entry) => entry.name)).toEqual(["keep.txt"]);
        expect(errors).toEqual([`Cannot index ${home}/gone: it does not exist.`]);
      }),
  );
  it.effect(
    "bounds metadata calls and the queued directories in a wide directories-only source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "wide-index-" });
        yield* Effect.forEach(
          Array.from({ length: 30 }, (_, i) => `${root}/d${i}`),
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
        const directoryLimited = yield* indexFiles([{ path: root, project: "p" }], [], {
          files: 100,
          directories: 5,
          entries: 20,
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
        expect(stats).toBeLessThanOrEqual(5);
        expect(directoryLimited.errors.join()).toContain("bounded scan limit");
        stats = 0;
        const entryLimited = yield* indexFiles([{ path: root, project: "p" }], [], {
          files: 100,
          directories: 100,
          entries: 8,
        }).pipe(Effect.provideService(FileSystem.FileSystem, observed));
        expect(stats).toBe(8);
        expect(entryLimited.errors.join()).toContain("bounded scan limit");
      }),
  );
});
