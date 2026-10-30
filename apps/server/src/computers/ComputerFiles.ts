import type { ComputerFile } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { isWithin, samePath } from "./paths.ts";
import { readNames } from "./ComputerDirectory.ts";

const excluded = new Set([
  ".git",
  "node_modules",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".t3",
  ".pnpm-store",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  "CMakeFiles",
  "target",
  "dist",
  "build",
  "Intermediate",
  "DerivedDataCache",
]);

const FILE_LIMIT = 100_000;
const DIRECTORY_LIMIT = 20_000;
const ENTRY_LIMIT = 200_000;

/**
 * The roots worth indexing. A filesystem root, the kept library, and anything that contains or
 * lies inside the library would index archive payloads, which are searched through their
 * manifests instead.
 */
export function indexableRoots<T extends { readonly path: string }>(
  platform: NodeJS.Platform,
  roots: readonly T[],
  libraryRoot: string | undefined,
  filesystemRootOf: (path: string) => string,
): T[] {
  return [...new Map(roots.map((root) => [root.path, root])).values()].filter(
    (root) =>
      !samePath(platform, filesystemRootOf(root.path), root.path) &&
      !(
        libraryRoot &&
        (isWithin(platform, libraryRoot, root.path) || isWithin(platform, root.path, libraryRoot))
      ),
  );
}

/**
 * Indexes the files under explicit project roots, never entering `skip` (workenv's own state).
 * A root may itself be a link or a Windows junction: that is how the project was configured, so
 * it is followed, and paths are reported as configured. Links found inside a root are not.
 */
export const indexFiles = Effect.fn("Computers.indexFiles")(function* (
  roots: readonly { path: string; project: string; area?: "project" | "work" }[],
  skip: readonly string[] = [],
  limits = { files: FILE_LIMIT, directories: DIRECTORY_LIMIT, entries: ENTRY_LIMIT },
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcess.Platform;
  const files: ComputerFile[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  const queue: { path: string; real: string; project: string; area: "project" | "work" }[] = [];
  let examined = 0,
    cursor = 0,
    truncated = false;
  for (const root of roots) {
    if (queue.length >= limits.directories) {
      truncated = true;
      break;
    }
    const real = yield* fs.realPath(root.path).pipe(Effect.option);
    if (Option.isNone(real)) errors.push(`Cannot index ${root.path}: it does not exist.`);
    else queue.push({ ...root, real: real.value, area: root.area ?? "project" });
  }
  // Only explicit project roots, with bounded work.
  scan: while (cursor < queue.length && examined < limits.entries && files.length < limits.files) {
    const directory = queue[cursor++]!;
    const key = platform === "win32" ? directory.real.toLowerCase() : directory.real;
    if (visited.has(key)) continue;
    visited.add(key);
    const entries = yield* readNames(directory.path, limits.entries - examined).pipe(
      Effect.catch((error) => {
        errors.push(`Cannot index ${directory.path}: ${error.message}`);
        return Effect.succeed({ names: [] as string[], truncated: false });
      }),
    );
    truncated ||= entries.truncated;
    for (const name of entries.names) {
      if (examined >= limits.entries || files.length >= limits.files) {
        truncated = true;
        break scan;
      }
      examined++;
      if (excluded.has(name) || name.startsWith(".")) continue;
      const filename = path.join(directory.path, name);
      if (skip.some((entry) => samePath(platform, entry, filename))) continue;
      const actual = yield* fs.realPath(filename).pipe(Effect.option);
      if (
        Option.isNone(actual) ||
        !samePath(platform, actual.value, path.join(directory.real, name))
      )
        continue;
      const stat = yield* fs.stat(filename).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      if (stat.value.type === "Directory") {
        if (queue.length >= limits.directories) {
          truncated = true;
          break scan;
        }
        queue.push({ ...directory, path: filename, real: actual.value });
      }
      if (stat.value.type === "File")
        files.push({
          path: filename,
          name,
          project: directory.project,
          area: directory.area,
          sizeBytes: Number(stat.value.size),
          modifiedAt: Option.getOrNull(Option.map(stat.value.mtime, (d) => d.getTime())),
          directory: false,
          backup: "not-verified",
          backupVerifiedAt: null,
          reference: null,
        });
    }
  }
  if (truncated || cursor < queue.length)
    errors.push("File index reached its bounded scan limit; narrow the configured project roots.");
  return { files, errors, indexedAt: yield* Clock.currentTimeMillis };
});

// One collator for every comparison: building one per call would cost more than the sort.
const collator = new Intl.Collator();
const compareFiles = (a: ComputerFile, b: ComputerFile) =>
  collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Name order, then path: the order the file list is kept and paged in. */
export const sortFiles = (files: readonly ComputerFile[]) => files.toSorted(compareFiles);

/** Merges two lists that are already in `sortFiles` order. */
export function mergeSorted(left: readonly ComputerFile[], right: readonly ComputerFile[]) {
  const merged: ComputerFile[] = [];
  let i = 0,
    j = 0;
  while (i < left.length && j < right.length)
    merged.push(compareFiles(left[i]!, right[j]!) <= 0 ? left[i++]! : right[j++]!);
  while (i < left.length) merged.push(left[i++]!);
  while (j < right.length) merged.push(right[j++]!);
  return merged;
}

const DEFAULT_PAGE = 200;
const MAX_PAGE = 5_000;

/**
 * One page of `files`, which must already be in `sortFiles` order: a page is a slice, and a
 * filter keeps the order, so no request sorts. `total` counts every match, whatever the page size.
 */
export function searchFiles(
  files: readonly ComputerFile[],
  input: {
    query?: string;
    project?: string;
    extension?: string;
    offset?: number;
    limit?: number;
  },
) {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const extension = input.extension?.replace(/^\./, "").toLowerCase();
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset ?? 0)) : 0;
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(input.limit ?? DEFAULT_PAGE)));
  if (!words.length && !extension && !input.project)
    return { files: files.slice(offset, offset + limit), total: files.length };
  const matches = files.filter(
    (file) =>
      (!input.project || file.project === input.project) &&
      (!extension || file.name.split(".").slice(1).at(-1)?.toLowerCase() === extension) &&
      words.every((word) =>
        `${file.name} ${file.path} ${file.kept?.reason ?? ""}`.toLowerCase().includes(word),
      ),
  );
  return { files: matches.slice(offset, offset + limit), total: matches.length };
}
