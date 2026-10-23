import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import { buildArchive, fromLibraryManifest, toSource } from "./Archive.ts";
import { decodeCatalogFile, loadCatalog, newCatalog, refreshCatalog } from "./LibraryCatalog.ts";
import { restoreKeep } from "./Workenv.ts";
import type { BackupProof, KeepReceipt } from "./WorkenvConfig.ts";
import {
  fromJson,
  interfaceJson,
  makeBundle,
  scriptedLibrary,
  SNAPSHOT,
  toJson,
  workenvConfig,
} from "./testSupport.ts";

const config = workenvConfig();
const one = makeBundle({
  id: "1".repeat(32),
  files: { "report.txt": "selected", "docs/notes.md": "notes" },
});
const two = makeBundle({
  id: "2".repeat(32),
  files: { "CON.txt": "reserved" },
  reason: "Reserved name",
});
const source = (origin: "request" | "receipt" | "library", receipt: KeepReceipt, key = "key") =>
  toSource(origin, key, `/state/${origin}/${key}.json`, receipt);
const build = (
  sources: Parameters<typeof buildArchive>[0],
  extra: Partial<Parameters<typeof buildArchive>[1]> = {},
) => buildArchive(sources, { config, platform: "linux", verified: new Map(), ...extra });
const proof: BackupProof = {
  schema: "workenv-backup-receipt/2",
  snapshot_id: SNAPSHOT,
  content_verified_snapshot: SNAPSHOT,
  manifest_sha256: one.manifestSha256,
  path: one.writerPath,
  method: "snapshot content hashed against manifest",
  confirmed_at: "2026-10-22T07:50:42-04:00",
};

describe("the kept archive", () => {
  it("lists each published file once, whichever receipts and manifests describe its bundle", () => {
    const archive = build([
      source("library", one.receipt, "from-library"),
      source("receipt", one.receipt, "from-receipt"),
      source("request", one.receipt, "from-request"),
      source("request", { ...two.receipt, status: "pending" }, "unpublished"),
      source("request", { ...two.receipt, id: "3".repeat(32), superseded: true }, "superseded"),
    ]);
    expect(archive.bundles).toHaveLength(1);
    // The computer's own request record wins: it is the one that carries the backup state.
    expect(archive.bundles[0]).toMatchObject({
      id: one.receipt.id,
      origin: "request",
      file: "/state/request/from-request.json",
    });
    expect(archive.files.map((file) => file.path).sort()).toEqual([
      `${one.writerPath}/payload/docs/notes.md`,
      `${one.writerPath}/payload/report.txt`,
    ]);
    expect(archive.files.find((file) => file.name === "notes.md")).toMatchObject({
      project: "t3",
      sizeBytes: 5,
      directory: false,
      modifiedAt: null,
      backup: "published",
      reference: one.receipt.reference,
      location: one.writerPath,
      computer: "archive",
      kept: { reason: "Evidence", keptAt: 1_792_000_000_000 },
      restorable: true,
      restoreUnavailableReason: null,
    });
  });

  it("keeps a superseded bundle that only workenv's receipts folder still describes", () => {
    const archive = build([source("receipt", { ...one.receipt, superseded: true })]);
    expect(archive.files).toHaveLength(2);
  });

  it("reports backup as confirmed from workenv's recorded proof or this server's own check", () => {
    const recorded = {
      ...one.receipt,
      backup: "confirmed",
      backup_receipt: proof,
      backup_error: null,
    };
    expect(
      build([source("request", recorded)]).files.every((file) => file.backup === "confirmed"),
    ).toBe(true);
    const verified = new Map([[one.receipt.id!, { proof, at: 1 }]]);
    expect(
      build([source("request", one.receipt)], { verified }).files.every(
        (file) => file.backup === "confirmed",
      ),
    ).toBe(true);
    // A proof for another path is not a proof for this bundle.
    const foreign = new Map([
      [one.receipt.id!, { proof: { ...proof, path: "/library/elsewhere" }, at: 1 }],
    ]);
    expect(build([source("request", one.receipt)], { verified: foreign }).files[0]!.backup).toBe(
      "published",
    );
  });

  it("says per file why it cannot be restored here", () => {
    const changed = build([source("request", { ...one.receipt, audience: "team" })]);
    expect(changed.files.every((file) => file.restorable === false)).toBe(true);
    expect(changed.files[0]!.restoreUnavailableReason).toContain("audience");
    const blocked = build([source("request", one.receipt)], {
      config: { ...config, keep: { ...config.keep, route_blocked: true } },
    });
    expect(blocked.files[0]!.restoreUnavailableReason).toContain("blocked");
    // A name Windows cannot create is refused for that file only, and only on Windows.
    const mixed = makeBundle({ id: "4".repeat(32), files: { "CON.txt": "x", "fine.txt": "y" } });
    const windows = build([source("request", mixed.receipt)], { platform: "win32" });
    expect(Object.fromEntries(windows.files.map((file) => [file.name, file.restorable]))).toEqual({
      "CON.txt": false,
      "fine.txt": true,
    });
    expect(build([source("request", mixed.receipt)]).files.every((file) => file.restorable)).toBe(
      true,
    );
  });

  it("slims a receipt to its listing data and names a library bundle like the publisher's receipt does", () => {
    const slim = toSource("request", "k", "/f.json", {
      ...one.receipt,
      snapshot: { ...one.receipt.snapshot, "bad\\name": { type: "file", sha256: "b".repeat(64) } },
    });
    expect(slim.receipt).not.toHaveProperty("snapshot");
    expect(slim.members).toHaveLength(3);
    expect(slim.snapshotProblem).toContain("Invalid archive member");
    const manifest = fromJson(one.files[`${one.writerPath}/manifest.json`]!) as KeepReceipt;
    expect(manifest.status).toBe("verified");
    const normalised = fromLibraryManifest(config, manifest, one.receipt.reference!);
    expect(normalised).toMatchObject({
      status: "published",
      writer_path: one.writerPath,
      reference: one.receipt.reference,
    });
  });
});

it.layer(NodeServices.layer)("the library catalog", (it) => {
  const listing = (bundle: typeof one, size = 100) => ({
    Path: `t3/evidence/${bundle.destination.split("/").at(-1)}/manifest.json`,
    Size: size,
    ModTime: "2026-10-22T11:51:11.595756667-04:00",
  });
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-" });
    yield* fs.makeDirectory(`${home}/cache`);
    const files: Record<string, string> = {
      "/etc/library-interface.json": interfaceJson(),
      ...one.files,
      ...two.files,
    };
    const library = scriptedLibrary(fs, { files, listing: [listing(one), listing(two)] });
    const directories = { cache: `${home}/cache`, staging: home };
    return { fs, home, library, directories, files };
  });
  const run = (
    library: ReturnType<typeof scriptedLibrary>,
    catalog: ReturnType<typeof newCatalog>,
    directories: { cache: string; staging: string },
  ) =>
    refreshCatalog(catalog, config, directories).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
      Effect.result,
    );
  const copies = (library: ReturnType<typeof scriptedLibrary>) =>
    library.calls.filter((call) => call.args[0] === "copy");

  it.effect(
    "finds bundles this computer holds no receipt for, named as their publisher names them",
    () =>
      Effect.gen(function* () {
        const { fs, library, directories } = yield* setup;
        const catalog = newCatalog();
        const result = yield* run(library, catalog, directories);
        expect(result._tag === "Success" && result.success).toEqual([]);
        expect(catalog.entries.size).toBe(2);
        const archive = build([...catalog.entries.values()].map((entry) => entry.source));
        expect(archive.files.map((file) => file.path)).toContain(
          `${one.writerPath}/payload/report.txt`,
        );
        // The same reference as the keep receipt of the computer that published it: clients show one entry.
        expect(archive.files.find((file) => file.path.endsWith("report.txt"))).toMatchObject({
          reference: one.receipt.reference,
          restorable: true,
          backup: "published",
        });
        expect(yield* fs.readDirectory(directories.cache)).toHaveLength(2);
        // Nothing is left staged between refreshes.
        expect(
          (yield* fs.readDirectory(directories.staging)).filter((name) =>
            name.startsWith("fetch-"),
          ),
        ).toEqual([]);
      }),
  );

  it.effect("fetches a manifest only when the library lists it new or changed", () =>
    Effect.gen(function* () {
      const { library, directories } = yield* setup;
      const catalog = newCatalog();
      yield* run(library, catalog, directories);
      expect(copies(library)).toHaveLength(1);
      yield* run(library, catalog, directories);
      expect(copies(library)).toHaveLength(1);
    }),
  );

  it.effect("keeps its cache across restarts and drops bundles the library no longer lists", () =>
    Effect.gen(function* () {
      const { fs, library, directories, files } = yield* setup;
      yield* run(library, newCatalog(), directories);
      const restarted = newCatalog();
      yield* loadCatalog(restarted, directories.cache, config).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
      );
      expect(restarted.entries.size).toBe(2);
      const gone = scriptedLibrary(fs, { files, listing: [listing(one)] });
      yield* run(gone, restarted, directories);
      expect(restarted.entries.size).toBe(1);
      expect(yield* fs.readDirectory(directories.cache)).toEqual([`${one.receipt.id}.json`]);
      expect(copies(gone)).toHaveLength(0);
    }),
  );

  it.effect(
    "skips older library bundles that are not in the keep format, without an error or a second download",
    () =>
      Effect.gen(function* () {
        const { fs, files, directories } = yield* setup;
        // As the real library holds: a bundle from before keeps had receipts, with a purpose and no files.
        files["/library/projects/utility/evidence/legacy-proof/manifest.json"] = toJson({
          id: "legacy-proof",
          project: "utility",
          audience: "private: simon",
          purpose: "GNU-escaped manifest proof",
          created_at: "2026-10-21T04:16:45-04:00",
        });
        const library = scriptedLibrary(fs, {
          files,
          listing: [
            listing(one),
            {
              Path: "utility/evidence/legacy-proof/manifest.json",
              Size: 90,
              ModTime: "2026-10-21T04:16:45-04:00",
            },
          ],
        });
        const catalog = newCatalog();
        const first = yield* run(library, catalog, directories);
        expect(first._tag === "Success" && first.success).toEqual([]);
        expect(catalog.entries.size).toBe(1);
        yield* run(library, catalog, directories);
        expect(copies(library)).toHaveLength(1);
      }),
  );

  it.effect("ignores a manifest that does not match its place in the library", () =>
    Effect.gen(function* () {
      const { fs, files, directories } = yield* setup;
      const liar = fromJson(one.files[`${one.writerPath}/manifest.json`]!) as KeepReceipt;
      files[`${two.writerPath}/manifest.json`] = toJson({ ...liar, destination: one.destination });
      const library = scriptedLibrary(fs, { files, listing: [listing(two)] });
      const catalog = newCatalog();
      const result = yield* run(library, catalog, directories);
      expect(result._tag === "Success" && result.success[0]).toContain(
        "does not match its location",
      );
      expect(catalog.entries.size).toBe(0);
    }),
  );

  it.effect("fails, keeping what it has, when the library cannot be identified", () =>
    Effect.gen(function* () {
      const { fs, library, directories, files } = yield* setup;
      const catalog = newCatalog();
      yield* run(library, catalog, directories);
      delete files["/etc/library-interface.json"];
      const failed = yield* run(scriptedLibrary(fs, { files, listing: [] }), catalog, directories);
      expect(failed._tag).toBe("Failure");
      expect(catalog.entries.size).toBe(2);
    }),
  );

  it.effect("bounds ignored manifests over repeated authoritative add/remove cycles", () =>
    Effect.gen(function* () {
      const { fs, directories } = yield* setup;
      const catalog = newCatalog();
      for (let i = 0; i < 5; i++) {
        const relative = `t3/evidence/old-${i}/manifest.json`;
        const library = scriptedLibrary(fs, {
          files: {
            "/etc/library-interface.json": interfaceJson(),
            [`/library/projects/${relative}`]: "{old-format",
          },
          listing: [{ Path: relative, Size: 1, ModTime: "2026-10-22T10:00:00Z" }],
        });
        expect((yield* run(library, catalog, directories))._tag).toBe("Success");
        expect(catalog.ignored.size).toBe(1);
        expect([...catalog.ignored.keys()]).toEqual([relative]);
      }
      const empty = scriptedLibrary(fs, {
        files: { "/etc/library-interface.json": interfaceJson() },
        listing: [],
      });
      yield* run(empty, catalog, directories);
      expect(catalog.ignored.size).toBe(0);
    }),
  );

  it.effect("restores a file of a bundle that exists only in the library", () =>
    Effect.gen(function* () {
      const { fs, home, library, directories } = yield* setup;
      const catalog = newCatalog();
      yield* run(library, catalog, directories);
      const entry = [...catalog.entries.values()].find(
        (candidate) => candidate.source.receipt.id === one.receipt.id,
      )!;
      const cached = yield* fs
        .readFileString(entry.source.file)
        .pipe(Effect.flatMap(decodeCatalogFile));
      const receipt = fromLibraryManifest(config, cached.receipt, cached.reference);
      yield* restoreKeep(
        config,
        receipt,
        `${one.writerPath}/payload/docs/notes.md`,
        `${home}/restored`,
        home,
      ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, library.runner));
      expect(yield* fs.readFileString(`${home}/restored/docs/notes.md`)).toBe("notes");
    }),
  );
});
