import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { fail, type WorkenvConfig } from "./WorkenvConfig.ts";

const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
// rclone reads --sftp-ssh as one space-separated, CSV-quoted command line.
const csvQuote = (value: string) =>
  /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const brief = (text: string) =>
  text.trim().split("\n").find(Boolean)?.slice(0, 300) ?? "no details";

const Interface = Schema.Struct({
  /** How colleagues reach the library read-only; names the bundles in references. */
  colleague_read: Schema.optionalKey(
    Schema.Struct({ address: Schema.String, port: Schema.Number }),
  ),
  library: Schema.Struct({
    root: Schema.String,
    filesystem: Schema.Struct({ uuid: Schema.String }),
  }),
  backup: Schema.Struct({
    repository: Schema.String,
    receipt: Schema.Struct({ schema: Schema.String, latest: Schema.String }),
  }),
});
export type LibraryInterface = typeof Interface.Type;
const decodeInterface = Schema.decodeUnknownEffect(Schema.fromJsonString(Interface));
const Listing = Schema.Array(
  Schema.Struct({ Path: Schema.String, Size: Schema.Number, ModTime: Schema.String }),
);
const decodeListing = Schema.decodeUnknownEffect(Schema.fromJsonString(Listing));

export interface LibraryFile {
  readonly text: string;
  readonly sha256: string;
}
export interface ListedFile {
  /** Relative to `<library root>/projects`, e.g. `utility/evidence/<bundle>/manifest.json`. */
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number | null;
}

/**
 * The library as this computer's workenv configuration reaches it: through the pinned OpenSSH
 * alias (rclone's SFTP transport, nothing else) or directly when this computer is the library.
 * Everything here only reads, except `administer`, which runs fixed commands on the library host.
 */
export interface Library {
  readonly local: boolean;
  readonly read: (filename: string) => Effect.Effect<string, ReturnType<typeof fail>>;
  /** Text and the SHA-256 of its exact bytes; fails unless the bytes are valid UTF-8. */
  readonly fetch: (filename: string) => Effect.Effect<LibraryFile, ReturnType<typeof fail>>;
  readonly copyFile: (
    source: string,
    target: string,
  ) => Effect.Effect<void, ReturnType<typeof fail>>;
  /** Constant commands only: argv elements are joined into one remote command string. */
  readonly administer: (
    command: readonly string[],
  ) => Effect.Effect<string, ReturnType<typeof fail>>;
  readonly listManifests: (
    root: string,
  ) => Effect.Effect<ReadonlyArray<ListedFile>, ReturnType<typeof fail>>;
  /** The files directly in a library folder (not its subfolders). */
  readonly listFiles: (
    directory: string,
  ) => Effect.Effect<ReadonlyArray<ListedFile>, ReturnType<typeof fail>>;
  /** Downloads `paths` (relative to `directory`) into `into` in one transfer. */
  readonly fetchFiles: (
    directory: string,
    paths: readonly string[],
    into: string,
    listFile: string,
  ) => Effect.Effect<void, ReturnType<typeof fail>>;
}

const listed = (text: string) =>
  decodeListing(text).pipe(
    Effect.map((listing) =>
      listing.map((entry) => ({
        path: entry.Path,
        size: entry.Size,
        modifiedAt: Number.isFinite(Date.parse(entry.ModTime)) ? Date.parse(entry.ModTime) : null,
      })),
    ),
    Effect.mapError(() => fail("The library listing is not in the expected format.")),
  );

export const openLibrary = Effect.fn("WorkenvLibrary.open")(function* (config: WorkenvConfig) {
  const runner = yield* ProcessRunner.ProcessRunner,
    fs = yield* FileSystem.FileSystem;
  const policy = config.keep;
  if (policy.route_blocked) return yield* fail("The configured workenv library route is blocked.");
  const local = policy.writer_local === true;
  const host = policy.ssh_host;
  if (!local && (!host || !SSH_ALIAS.test(host)))
    return yield* fail("The pinned OpenSSH alias of the workenv library is not configured.");
  const sshCommand = policy.ssh_executable ?? "ssh";
  const sshArguments = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    host ?? "",
  ];
  const rclone = policy.rclone ?? "rclone";
  const transport = local
    ? []
    : [
        "--sftp-ssh",
        [sshCommand, ...sshArguments].map(csvQuote).join(" "),
        "--sftp-shell-type",
        "unix",
      ];
  const remote = (filename: string) => (local ? filename : `:sftp:${filename}`);
  const run = (input: ProcessRunner.ProcessRunInput) =>
    runner.run(input).pipe(Effect.mapError((error) => fail(error.message)));
  const rcloneRun = Effect.fn("WorkenvLibrary.rclone")(function* (
    what: string,
    args: readonly string[],
    options: Pick<ProcessRunner.ProcessRunInput, "timeout" | "maxOutputBytes"> = {},
  ) {
    const result = yield* run({ command: rclone, args: [...args, ...transport], ...options });
    if (result.code !== 0) return yield* fail(`${what}: ${brief(result.stderr)}`);
    return result;
  });
  const fetch = Effect.fn("WorkenvLibrary.fetch")(function* (filename: string) {
    if (local) {
      const bytes = yield* fs
        .readFile(filename)
        .pipe(Effect.mapError((error) => fail(`Cannot read ${filename}: ${error.message}`)));
      return {
        text: Buffer.from(bytes).toString("utf8"),
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }
    const result = yield* rcloneRun(`Cannot read ${filename}`, ["cat", remote(filename)], {
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.stdoutInvalidUtf8) return yield* fail(`${filename} is not valid UTF-8 text.`);
    return {
      text: result.stdout,
      sha256: NodeCrypto.createHash("sha256").update(result.stdout, "utf8").digest("hex"),
    };
  });
  return {
    local,
    read: (filename) => fetch(filename).pipe(Effect.map((file) => file.text)),
    fetch,
    copyFile: (source, target) =>
      rcloneRun(`Cannot copy ${source}`, ["copyto", remote(source), target], {
        timeout: "30 minutes",
      }).pipe(Effect.asVoid),
    administer: Effect.fn("WorkenvLibrary.administer")(function* (command: readonly string[]) {
      const result = yield* run(
        local
          ? { command: command[0]!, args: command.slice(1), timeout: "30 minutes" }
          : {
              command: sshCommand,
              args: [...sshArguments, command.join(" ")],
              timeout: "30 minutes",
            },
      );
      if (result.code !== 0)
        return yield* fail(`${command.slice(0, 2).join(" ")} failed: ${brief(result.stderr)}`);
      return result.stdout;
    }),
    // Depth 4 is projects/<project>/<collection>/<bundle>/manifest.json: payload folders, which
    // may hold thousands of files, are never listed.
    listManifests: Effect.fn("WorkenvLibrary.listManifests")(function* (root: string) {
      const result = yield* rcloneRun(
        "Cannot list the library bundles",
        [
          "lsjson",
          "-R",
          "--files-only",
          "--no-mimetype",
          "--max-depth",
          "4",
          "--include",
          "/*/*/*/manifest.json",
          remote(`${root}/projects`),
        ],
        { timeout: "5 minutes", maxOutputBytes: 32 * 1024 * 1024 },
      );
      return yield* listed(result.stdout);
    }),
    listFiles: Effect.fn("WorkenvLibrary.listFiles")(function* (directory: string) {
      const result = yield* rcloneRun(
        `Cannot list ${directory}`,
        ["lsjson", "--files-only", "--no-mimetype", remote(directory)],
        { timeout: "2 minutes", maxOutputBytes: 16 * 1024 * 1024 },
      );
      return yield* listed(result.stdout);
    }),
    fetchFiles: Effect.fn("WorkenvLibrary.fetchFiles")(function* (
      directory: string,
      paths: readonly string[],
      into: string,
      listFile: string,
    ) {
      yield* fs
        .writeFileString(listFile, `${paths.join("\n")}\n`)
        .pipe(Effect.mapError((error) => fail(`Cannot stage the download list: ${error.message}`)));
      yield* rcloneRun(
        `Cannot download from ${directory}`,
        ["copy", remote(directory), into, "--files-from-raw", listFile, "--transfers", "8"],
        { timeout: "30 minutes" },
      );
    }),
  } satisfies Library;
});

// Python's urllib.parse.quote, which the library helper uses to build the reference.
const quotePath = (value: string) =>
  value
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!*'()]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

/**
 * The reference the library helper records for a bundle (its README as colleagues read it), so a
 * bundle known only from its manifest is named exactly as it is in the keep receipt of the
 * computer that published it. Null when the library interface gives no colleague endpoint.
 */
export function libraryReference(contract: LibraryInterface, destination: string) {
  const endpoint = contract.colleague_read;
  return endpoint && destination.startsWith("projects/")
    ? `sftp://simon@${endpoint.address}:${endpoint.port}/${quotePath(destination.slice("projects/".length))}/README.md`
    : null;
}

/**
 * The library this computer's configuration names is the one that answers: its interface file
 * (the one workenv's own helper trusts) states the library root and the filesystem identity. A
 * remote library has no identity file of its own, so this is the check before any read of it.
 */
export const verifyLibrary = Effect.fn("WorkenvLibrary.verify")(function* (
  library: Library,
  config: WorkenvConfig,
) {
  const location = config.keep.interface_path;
  if (!location || !location.startsWith("/"))
    return yield* fail(
      "The workenv library interface is not configured, so the library identity cannot be verified.",
    );
  const text = yield* library.read(location);
  const contract = yield* decodeInterface(text).pipe(
    Effect.mapError(() => fail("The library interface file is not in the expected format.")),
  );
  if (
    contract.library.root !== config.keep.library_root ||
    contract.library.filesystem.uuid !== config.keep.library_id
  )
    return yield* fail(
      "The library interface describes a different library than this computer's workenv configuration.",
    );
  return contract;
});
