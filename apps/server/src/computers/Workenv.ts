// @effect-diagnostics nodeBuiltinImport:off - restore publication needs lstat and exclusive no-follow file descriptors.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import type { ComputerActivity } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ProcessRunner from "../processRunner.ts";
import {
  decodeHandoff,
  decodeReceipt,
  fail,
  messageOf,
  operationError,
  parseTime,
  workenvHome,
  type KeepReceipt,
  type WorkenvConfig,
} from "./WorkenvConfig.ts";
import { isWithin, samePath } from "./paths.ts";
import { openLibrary, verifyLibrary } from "./WorkenvLibrary.ts";

const COLLECTIONS = new Set(["evidence", "assets", "deliverables"]);
const HASH = /^[a-f0-9]{64}$/;
const IN_FLIGHT = new Set(["inspecting", "copying", "verifying", "creating"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const trimSlash = (value: string) => value.replace(/\/+$/, "");

/** Receipts are read once per change: a file is parsed again only when its stamp moves. */
export interface ReceiptFile {
  readonly key: string;
  readonly file: string;
  readonly modifiedAt: number | null;
  readonly receipt: KeepReceipt;
}
export interface ReceiptCache {
  readonly entries: Map<string, { stamp: string; value: ReceiptFile | null; error: string | null }>;
  version: number;
}
export const newReceiptCache = (): ReceiptCache => ({ entries: new Map(), version: 0 });

export const readReceipts = Effect.fn("Workenv.readReceipts")(function* (
  directory: string,
  cache: ReceiptCache,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const names = (yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))
    ? (yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[])))
        .filter((name) => name.endsWith(".json"))
        .slice(0, 20_000)
    : [];
  const seen = new Set<string>();
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);
        seen.add(file);
        const info = yield* fs.stat(file).pipe(Effect.option);
        const modifiedAt =
          info._tag === "Some" && info.value.mtime._tag === "Some"
            ? info.value.mtime.value.getTime()
            : null;
        const stamp = `${modifiedAt}:${info._tag === "Some" ? info.value.size : "?"}`;
        if (cache.entries.get(file)?.stamp === stamp) return;
        const parsed = yield* fs.readFileString(file).pipe(
          Effect.flatMap(decodeReceipt),
          Effect.map((receipt) => ({
            value: { key: name.slice(0, -5), file, modifiedAt, receipt } satisfies ReceiptFile,
            error: null,
          })),
          Effect.catch((cause) =>
            Effect.succeed({
              value: null,
              error: `Cannot read keep receipt ${name}: ${messageOf(cause)}`,
            }),
          ),
        );
        cache.entries.set(file, { stamp, ...parsed });
        cache.version++;
      }),
    { concurrency: 8, discard: true },
  );
  for (const file of cache.entries.keys())
    if (!seen.has(file)) {
      cache.entries.delete(file);
      cache.version++;
    }
  const all = [...cache.entries.values()];
  return {
    receipts: all.flatMap((entry) => (entry.value ? [entry.value] : [])),
    errors: all.flatMap((entry) => (entry.error ? [entry.error] : [])),
  };
});

export const isPublished = (receipt: Pick<KeepReceipt, "status" | "writer_path">) =>
  receipt.status === "published" && Boolean(receipt.writer_path);

export function keepActivity(file: ReceiptFile, sourceExists: boolean): ComputerActivity {
  const { key, receipt } = file;
  const published = receipt.status === "published";
  const cancelled = receipt.status === "cancelled";
  const status = published
    ? "published"
    : cancelled
      ? "cancelled"
      : IN_FLIGHT.has(receipt.status)
        ? "stalled"
        : receipt.error
          ? "failed"
          : "pending";
  const retryable = !published && !cancelled && sourceExists;
  return {
    id: key,
    kind: "transfer",
    label: receipt.reason,
    status,
    updatedAt: receipt.published_at
      ? receipt.published_at * 1000
      : (file.modifiedAt ?? parseTime(receipt.created_at) ?? 0),
    detail: published
      ? null
      : status === "stalled"
        ? `Last recorded: ${receipt.status}; its process was not found.`
        : [
            receipt.error,
            !cancelled && !sourceExists
              ? "The source no longer exists, so this keep cannot be retried."
              : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
    source: receipt.source,
    retryable,
  };
}

// --- what a computer can restore -------------------------------------------------------------

/** A path inside an archive that cannot be written on this platform, or null. */
export function memberPlatformProblem(name: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  return name
    .split("/")
    .some((part) => /[<>"|?*]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))
    ? "The file name cannot be created on Windows."
    : null;
}

function memberProblem(name: string): string | null {
  return !name ||
    name.includes("\\") ||
    name.includes(":") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
    ? `Invalid archive member: ${name}`
    : null;
}

/**
 * Whether this computer's configuration still describes the keep: the project, audience and
 * library location workenv would publish to today are the ones the keep was published with.
 * Needs neither the original job nor its source, so recovery works after both are cleaned up.
 */
export function configProblem(
  config: WorkenvConfig,
  receipt: Omit<KeepReceipt, "snapshot">,
): string | null {
  if (!isPublished(receipt) || !receipt.destination || !receipt.id)
    return "This keep has no published archive.";
  const policy = config.projects[receipt.project]?.keep;
  if (!policy) return `Project ${receipt.project} is not set up for keeping on this computer.`;
  if (policy.audience !== receipt.audience || !COLLECTIONS.has(receipt.collection ?? ""))
    return "The audience configured for this project differs from the one the keep was published for.";
  const parts = receipt.destination.split("/");
  if (
    parts.slice(0, -2).join("/") !== (policy.relative_path ?? `projects/${receipt.project}`) ||
    parts.at(-2) !== receipt.collection
  )
    return "The library location configured for this project differs from where the keep was published.";
  if (
    receipt.library_id !== config.keep.library_id ||
    receipt.library_root !== config.keep.library_root
  )
    return "This computer is configured for a different library than the one holding the keep.";
  if (receipt.writer_path !== `${trimSlash(config.keep.library_root)}/${receipt.destination}`)
    return "The recorded archive location differs from its library destination.";
  return null;
}

/** Every archive member is a plain relative path, and every file has a recorded hash. */
export function snapshotProblem(receipt: Pick<KeepReceipt, "snapshot">): string | null {
  if (!receipt.snapshot) return "The keep recorded no archive members.";
  for (const [name, entry] of Object.entries(receipt.snapshot)) {
    const problem = memberProblem(name);
    if (problem) return problem;
    if (entry.type !== "file" && entry.type !== "directory")
      return `Invalid archive member: ${name}`;
    if (entry.type === "file" && (!entry.sha256 || !HASH.test(entry.sha256)))
      return "Archive hash metadata is missing.";
  }
  return null;
}

export const archiveProblem = (config: WorkenvConfig, receipt: KeepReceipt) =>
  configProblem(config, receipt) ?? snapshotProblem(receipt);

export function routeProblem(config: WorkenvConfig): string | null {
  if (config.keep.route_blocked) return "The workenv library route is blocked on this computer.";
  if (!config.keep.writer_local && !config.keep.ssh_host)
    return "The pinned SSH alias of the workenv library is not configured on this computer.";
  if (!config.keep.interface_path)
    return "The workenv library interface is not configured on this computer.";
  return null;
}

/** Why `member` cannot be restored by this computer right now, or null. */
function restoreProblem(
  config: WorkenvConfig,
  receipt: KeepReceipt,
  platform: NodeJS.Platform,
  member?: string,
): string | null {
  return (
    archiveProblem(config, receipt) ??
    routeProblem(config) ??
    (member ? memberPlatformProblem(member, platform) : null)
  );
}

/**
 * Whether an unpublished keep may be retried. workenv's own retry refuses once its project,
 * audience, library or writer route changed, because a keep then names a different place; this
 * says so before any command runs.
 */
export function retryProblem(
  config: WorkenvConfig,
  receipt: KeepReceipt,
  platform: NodeJS.Platform,
  jobSources: readonly string[],
): string | null {
  const project = config.projects[receipt.project];
  if (
    !project?.keep ||
    project.keep.audience !== receipt.audience ||
    !COLLECTIONS.has(receipt.collection ?? "")
  )
    return "The project or audience configured for this keep changed; reconcile the original request first.";
  if (
    receipt.destination &&
    receipt.destination.split("/").slice(0, -2).join("/") !==
      (project.keep.relative_path ?? `projects/${receipt.project}`)
  )
    return "The library location configured for this project changed; reconcile the original request first.";
  if (
    (receipt.library_id && receipt.library_id !== config.keep.library_id) ||
    (receipt.library_root && receipt.library_root !== config.keep.library_root)
  )
    return "This computer is configured for a different library than the original request.";
  if (receipt.library_ssh !== undefined && receipt.library_ssh !== (config.keep.ssh_host ?? null))
    return "The library writer route changed; reconcile the original request first.";
  return [project.source, ...jobSources].some((root) => isWithin(platform, root, receipt.source))
    ? null
    : "The keep source no longer belongs to this project or a recorded job.";
}

/** The library's own manifest must still describe exactly what the receipt recorded. */
export function manifestProblem(manifest: KeepReceipt, receipt: KeepReceipt): string | null {
  for (const field of [
    "id",
    "library_id",
    "library_root",
    "destination",
    "collection",
    "source",
    "project",
    "audience",
    "reason",
    "created_at",
  ] as const)
    if (manifest[field] !== receipt[field])
      return `The published manifest differs from the keep receipt (${field}).`;
  const published = manifest.snapshot,
    recorded = receipt.snapshot;
  if (!published || !recorded) return "The published manifest does not list its archive members.";
  const names = Object.keys(recorded);
  if (Object.keys(published).length !== names.length)
    return "The published manifest lists a different set of archive members.";
  for (const name of names) {
    const left = published[name],
      right = recorded[name]!;
    if (
      !left ||
      left.type !== right.type ||
      left.bytes !== right.bytes ||
      left.sha256 !== right.sha256 ||
      left.mode !== right.mode
    )
      return `The published manifest differs from the keep receipt for ${name}.`;
  }
  return null;
}

/** Validates the empty folder a restore will publish into, without creating it. */
export const restoreDestination = Effect.fn("Workenv.restoreDestination")(function* (
  destination: string,
) {
  const path = yield* Path.Path,
    platform = yield* HostProcessPlatform;
  if (!path.isAbsolute(destination))
    return yield* fail("Choose an absolute empty destination folder.");
  const normalized = path.normalize(destination);
  return yield* Effect.tryPromise({
    try: async () => {
      const info = await NodeFSP.lstat(normalized).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (info) {
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          !samePath(platform, await NodeFSP.realpath(normalized), normalized) ||
          (await NodeFSP.readdir(normalized)).length
        )
          throw fail("Choose an empty destination folder that is not a link.");
      } else {
        const parent = path.dirname(normalized),
          parentInfo = await NodeFSP.lstat(parent);
        if (
          !parentInfo.isDirectory() ||
          parentInfo.isSymbolicLink() ||
          !samePath(platform, await NodeFSP.realpath(parent), parent)
        )
          throw fail("The parent of the destination folder must exist and must not be a link.");
      }
      return { path: normalized, exists: info !== null, dev: info?.dev, ino: info?.ino };
    },
    catch: operationError,
  });
});

export const restoreKeep = Effect.fn("Workenv.restoreFile")(function* (
  config: WorkenvConfig,
  receipt: KeepReceipt,
  selected: string,
  destination: string,
  stagingDirectory: string,
  beforePublish: Effect.Effect<void> = Effect.void,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        platform = yield* HostProcessPlatform;
      const prefix = `${receipt.writer_path}/payload/`;
      const member = selected.startsWith(prefix) ? selected.slice(prefix.length) : null;
      const problem = restoreProblem(config, receipt, platform, member ?? undefined);
      if (problem) return yield* fail(problem);
      const entry = member ? receipt.snapshot?.[member] : undefined;
      if (!member || !entry || entry.type !== "file")
        return yield* fail("Select exactly one recorded archive file.");
      const initial = yield* restoreDestination(destination);
      if (isWithin(platform, initial.path, path.resolve(stagingDirectory)))
        return yield* fail("Restore staging must be outside the destination.");
      const library = yield* openLibrary(config);
      yield* verifyLibrary(library, config);
      const manifest = yield* library
        .read(`${receipt.writer_path}/manifest.json`)
        .pipe(
          Effect.flatMap((text) =>
            decodeReceipt(text).pipe(
              Effect.mapError(() => fail("The published manifest is not in the expected format.")),
            ),
          ),
        );
      const mismatch = manifestProblem(manifest, receipt);
      if (mismatch) return yield* fail(mismatch);
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: stagingDirectory,
        prefix: "restore-",
      });
      yield* fs.chmod(staging, 0o700);
      const staged = path.join(staging, "file");
      yield* library.copyFile(selected, staged);
      const stagedHash = yield* fs.stream(staged).pipe(
        Stream.runFold(
          () => NodeCrypto.createHash("sha256"),
          (state, chunk) => state.update(chunk),
        ),
      );
      if (stagedHash.digest("hex") !== entry.sha256)
        return yield* fail("The downloaded file does not match its recorded SHA-256.");
      yield* beforePublish;
      yield* restoreDestination(initial.path);
      let publication: Promise<void> = Promise.resolve();
      yield* Effect.tryPromise({
        try: (signal) =>
          (publication = (async () => {
            const checkDirectory = async (directory: string) => {
              const info = await NodeFSP.lstat(directory);
              if (
                !info.isDirectory() ||
                info.isSymbolicLink() ||
                !samePath(platform, await NodeFSP.realpath(directory), directory)
              )
                throw fail("The restore destination changed or contains a link.");
              if (
                samePath(platform, directory, initial.path) &&
                initial.exists &&
                (info.dev !== initial.dev || info.ino !== initial.ino)
              )
                throw fail("The restore destination was replaced.");
            };
            if (!initial.exists) await NodeFSP.mkdir(initial.path);
            await checkDirectory(initial.path);
            if ((await NodeFSP.readdir(initial.path)).length)
              throw fail("The restore destination is no longer empty.");
            const parts = member.split("/");
            let parent = initial.path;
            for (const component of parts.slice(0, -1)) {
              await checkDirectory(initial.path);
              parent = path.join(parent, component);
              await NodeFSP.mkdir(parent).catch((error: unknown) => {
                if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
                  throw error;
              });
              await checkDirectory(parent);
            }
            await checkDirectory(initial.path);
            await checkDirectory(parent);
            // Node has no portable openat: a same-user ancestor swap between this check and open remains possible.
            const output = await NodeFSP.open(
              path.join(parent, parts.at(-1)!),
              NodeFS.constants.O_RDWR |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                (NodeFS.constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              const input = await NodeFSP.open(
                staged,
                NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
              );
              try {
                const buffer = Buffer.alloc(64 * 1024);
                for (;;) {
                  if (signal.aborted) throw fail("Restore was interrupted.");
                  const { bytesRead } = await input.read(buffer);
                  if (!bytesRead) break;
                  let written = 0;
                  while (written < bytesRead) {
                    const { bytesWritten } = await output.write(
                      buffer,
                      written,
                      bytesRead - written,
                    );
                    if (!bytesWritten) throw fail("Cannot write the restored file.");
                    written += bytesWritten;
                  }
                }
                const hash = NodeCrypto.createHash("sha256");
                let position = 0;
                for (;;) {
                  if (signal.aborted) throw fail("Restore was interrupted.");
                  const { bytesRead } = await output.read(buffer, 0, buffer.length, position);
                  if (!bytesRead) break;
                  hash.update(buffer.subarray(0, bytesRead));
                  position += bytesRead;
                }
                if (hash.digest("hex") !== entry.sha256)
                  throw fail("The restored file does not match its recorded SHA-256.");
              } finally {
                await input.close();
              }
            } finally {
              await output.close();
            }
          })()),
        catch: operationError,
      }).pipe(Effect.ensuring(Effect.promise(() => publication.catch(() => undefined))));
    }),
  );
});

// --- ordinary workenv commands ---------------------------------------------------------------

const runWorkenv = Effect.fn("Workenv.run")(function* (args: readonly string[]) {
  const runner = yield* ProcessRunner.ProcessRunner,
    path = yield* Path.Path,
    platform = yield* HostProcessPlatform;
  // ProcessRunner resolves .cmd launchers and escapes every argument for cmd.exe.
  const result = yield* runner
    .run({
      command: path.join(
        yield* workenvHome(),
        ".local",
        "bin",
        platform === "win32" ? "workenv.cmd" : "workenv",
      ),
      args,
      timeout: "30 minutes",
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.mapError((error) => fail(error.message)));
  // workenv prints the receipt even when it ends unpublished, exiting nonzero.
  if (!result.stdout.trim())
    return yield* fail(
      result.stderr.trim().split("\n").find(Boolean)?.slice(0, 300) ??
        `workenv exited with code ${result.code}.`,
    );
  return result.stdout;
});

/** What a finished `workenv keep` means for the action that ran it. */
export function keepOutcome(receipt: KeepReceipt) {
  if (receipt.status !== "published")
    return {
      status: "failed" as const,
      detail: receipt.error ?? `The keep ended as ${receipt.status}.`,
      retryable: false,
    };
  const backupPending = receipt.backup_required && receipt.backup !== "confirmed";
  return {
    status: "completed" as const,
    detail: backupPending
      ? `Published to the library. Independent backup is not confirmed yet: ${receipt.backup_error ?? "pending"}`
      : "Published to the library.",
    retryable: false,
  };
}

export const runKeep = Effect.fn("Workenv.keep")(function* (source: string, reason: string) {
  const stdout = yield* runWorkenv(["keep", source, "--reason", reason]);
  const receipt = yield* decodeReceipt(stdout).pipe(
    Effect.mapError(() => fail("workenv keep printed something other than a keep receipt.")),
  );
  return keepOutcome(receipt);
});

/** Retry one helper-owned sender handoff: workenv resumes it from its own receipt. */
export const runHandoff = Effect.fn("Workenv.handoff")(function* (
  source: string,
  host: string,
  destination: string,
) {
  const stdout = yield* runWorkenv(["handoff", source, `${host}:${destination}`]);
  const receipt = yield* decodeHandoff(stdout).pipe(
    Effect.mapError(() => fail("workenv handoff printed something other than a handoff receipt.")),
  );
  return receipt.status === "delivered"
    ? { status: "completed" as const, detail: "Delivered and verified.", retryable: false }
    : {
        status: "failed" as const,
        detail: receipt.error ?? `The handoff ended as ${receipt.status}.`,
        retryable: false,
      };
});
