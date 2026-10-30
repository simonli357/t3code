import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromLibraryManifest, toSource, type ArchiveSource } from "./Archive.ts";
import { listNames, writeJson } from "./ComputerStore.ts";
import { routeProblem } from "./Workenv.ts";
import { decodeReceipt, fail, Receipt, type WorkenvConfig } from "./WorkenvConfig.ts";
import { libraryReference, openLibrary, verifyLibrary, type ListedFile } from "./WorkenvLibrary.ts";

/**
 * The library's own bundle manifests, as a cache on disk (`<dir>/<bundle id>.json`) and in memory.
 * Keeps made on other computers, and bundles this computer holds no receipt for, are found here.
 * A manifest is fetched once: it is read again only when the library lists it with another size
 * or time.
 */
const MANIFEST_LIMIT = 5_000;
// Small batches: each is stored as soon as it arrives, so an interrupted first sync keeps its progress.
const MANIFEST_BATCH = 40;
const BUNDLE_ID = /^[0-9a-f]{32}$/;
const MANIFEST_PATH = /^[^/]+\/[^/]+\/[^/]+\/manifest\.json$/;

const CatalogFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  modifiedAt: Schema.NullOr(Schema.Number),
  /** How the library names this bundle's README to colleagues; the same for every computer. */
  reference: Schema.NullOr(Schema.String),
  receipt: Receipt,
});
export const decodeCatalogFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFile));

export interface Catalog {
  readonly entries: Map<string, { readonly listing: ListedFile; readonly source: ArchiveSource }>;
  /** Manifests that are not in the keep format (older library bundles), by size and time, so they are not fetched again. */
  readonly ignored: Map<string, string>;
  /** Changes whenever `entries` does. */
  version: number;
  loaded: boolean;
}
export const newCatalog = (): Catalog => ({
  entries: new Map(),
  ignored: new Map(),
  version: 0,
  loaded: false,
});
const stampOf = (entry: ListedFile) => `${entry.size}:${entry.modifiedAt}`;

export const loadCatalog = Effect.fn("Computers.loadCatalog")(function* (
  catalog: Catalog,
  directory: string,
  workenv: WorkenvConfig,
) {
  if (catalog.loaded) return;
  catalog.loaded = true;
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  yield* Effect.forEach(
    yield* listNames(directory, ".json"),
    (name) => {
      const file = path.join(directory, name);
      return fs.readFileString(file).pipe(
        Effect.flatMap(decodeCatalogFile),
        Effect.tap((cached) =>
          Effect.sync(() => {
            catalog.entries.set(cached.path, {
              listing: { path: cached.path, size: cached.size, modifiedAt: cached.modifiedAt },
              source: toSource(
                "library",
                name.slice(0, -5),
                file,
                fromLibraryManifest(workenv, cached.receipt, cached.reference),
              ),
            });
          }),
        ),
        // A cache file that cannot be read is fetched again when the library lists it.
        Effect.ignore,
      );
    },
    { concurrency: 8, discard: true },
  );
  catalog.version++;
});

/**
 * Brings the catalog up to date with the library and returns the problems met on the way: a
 * library that cannot be reached fails; a manifest that cannot be read or does not match its place
 * is skipped and reported.
 */
export const refreshCatalog = Effect.fn("Computers.refreshCatalog")(function* (
  catalog: Catalog,
  workenv: WorkenvConfig,
  directories: { readonly cache: string; readonly staging: string },
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  yield* fs
    .makeDirectory(directories.cache, { recursive: true })
    .pipe(Effect.mapError((error) => fail(`Cannot prepare the catalog folder: ${error.message}`)));
  yield* loadCatalog(catalog, directories.cache, workenv);
  const blocked = routeProblem(workenv);
  if (blocked) return yield* fail(blocked);
  const library = yield* openLibrary(workenv);
  const contract = yield* verifyLibrary(library, workenv);
  const listing = (yield* library.listManifests(workenv.keep.library_root))
    .filter((entry) => MANIFEST_PATH.test(entry.path))
    .slice(0, MANIFEST_LIMIT);
  const present = new Set(listing.map((entry) => entry.path));
  for (const ignored of catalog.ignored.keys())
    if (!present.has(ignored)) catalog.ignored.delete(ignored);
  for (const [manifest, entry] of catalog.entries)
    if (!present.has(manifest)) {
      catalog.entries.delete(manifest);
      catalog.version++;
      yield* fs.remove(entry.source.file, { force: true }).pipe(Effect.ignore);
    }
  const changed = listing.filter((entry) => {
    const known = catalog.entries.get(entry.path)?.listing;
    if (catalog.ignored.get(entry.path) === stampOf(entry)) return false;
    return !known || known.size !== entry.size || known.modifiedAt !== entry.modifiedAt;
  });
  const problems: string[] = [];
  for (let from = 0; from < changed.length; from += MANIFEST_BATCH) {
    const batch = changed.slice(from, from + MANIFEST_BATCH);
    const staging = yield* fs
      .makeTempDirectory({ directory: directories.staging, prefix: "fetch-" })
      .pipe(Effect.mapError((error) => fail(`Cannot stage library manifests: ${error.message}`)));
    yield* Effect.gen(function* () {
      yield* library.fetchFiles(
        `${workenv.keep.library_root}/projects`,
        batch.map((entry) => entry.path),
        path.join(staging, "manifests"),
        path.join(staging, "list.txt"),
      );
      for (const entry of batch) {
        const text = yield* fs
          .readFileString(path.join(staging, "manifests", ...entry.path.split("/")))
          .pipe(Effect.result);
        if (text._tag === "Failure") {
          problems.push(`Cannot download the library manifest ${entry.path}.`);
          continue;
        }
        const read = yield* decodeReceipt(text.success).pipe(Effect.result);
        if (read._tag === "Failure") {
          // Older bundles (written before keeps had receipts) are not an error: they have no
          // files to list here, and they stay as they are.
          catalog.ignored.set(entry.path, stampOf(entry));
          continue;
        }
        const manifest = read.success;
        // A manifest describes the bundle it sits in; one that names another place is ignored.
        if (
          !manifest.id ||
          !BUNDLE_ID.test(manifest.id) ||
          manifest.destination !== `projects/${entry.path.slice(0, -"/manifest.json".length)}`
        ) {
          problems.push(
            `Ignored the library manifest ${entry.path}: it does not match its location.`,
          );
          continue;
        }
        const file = path.join(directories.cache, `${manifest.id}.json`);
        const reference = libraryReference(contract, manifest.destination);
        yield* writeJson(file, {
          path: entry.path,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          reference,
          receipt: manifest,
        });
        catalog.entries.set(entry.path, {
          listing: entry,
          source: toSource(
            "library",
            manifest.id,
            file,
            fromLibraryManifest(workenv, manifest, reference),
          ),
        });
        catalog.version++;
      }
    }).pipe(
      Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  }
  return problems.slice(0, 5);
});
