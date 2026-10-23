import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import type { KeepReceipt, WorkenvConfig } from "./WorkenvConfig.ts";

/** Fixtures for the computers tests: a workenv library reached through a scripted ProcessRunner. */

/** JSON for fixtures: values go through Schema, as everywhere else in the server. */
const json = Schema.fromJsonString(Schema.Unknown);
export const toJson = (value: unknown): string => Schema.encodeSync(json)(value);
export const fromJson = (text: string): unknown => Schema.decodeSync(json)(text);

export const SNAPSHOT = "a".repeat(64);
export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

export const output = (stdout = "", code = 0, stderr = ""): ProcessRunOutput => ({
  stdout,
  stderr,
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

export const workenvConfig = (state = "/state"): WorkenvConfig => ({
  state,
  projects: {
    t3: { source: "/current/t3", keep: { audience: "private", backup_required: true } },
  },
  keep: {
    library_root: "/library",
    library_id: "library-uuid",
    ssh_host: "archive",
    interface_path: "/etc/library-interface.json",
    rclone: "rclone",
    ssh_executable: "ssh",
  },
});

export const interfaceJson = (overrides: { uuid?: string; root?: string } = {}) =>
  toJson({
    library: {
      root: overrides.root ?? "/library",
      filesystem: { uuid: overrides.uuid ?? "library-uuid" },
    },
    backup: {
      repository: "/data/work-backup/restic (restic 0.16.4)",
      receipt: {
        schema: "workenv-backup-receipt/2",
        latest: "/var/lib/workenv/backup/latest.json",
      },
    },
    colleague_read: { address: "100.1.2.3", port: 2022 },
  });

/** One published bundle: its receipt as this computer recorded it and the files the library holds. */
export function makeBundle(options: {
  id: string;
  files: Record<string, string>;
  project?: string;
  reason?: string;
}) {
  const destination = `projects/t3/evidence/2026-10-22-evidence-${options.id.slice(0, 12)}`;
  const writerPath = `/library/${destination}`;
  const snapshot = Object.fromEntries(
    Object.entries(options.files).map(([name, text]) => [
      name,
      { type: "file", mode: 420, bytes: Buffer.byteLength(text), sha256: sha256(text) },
    ]),
  );
  const receipt: KeepReceipt = {
    id: options.id,
    source: "/deleted/job/evidence",
    project: options.project ?? "t3",
    reason: options.reason ?? "Evidence",
    audience: "private",
    collection: "evidence",
    destination,
    status: "published",
    created_at: "2026-10-22T10:00:00Z",
    published_at: 1_792_000_000,
    backup_required: true,
    backup: "pending",
    backup_error: "Required backup receipt does not identify this exact published bundle",
    library_id: "library-uuid",
    library_root: "/library",
    library_ssh: "archive",
    writer_path: writerPath,
    reference: `sftp://simon@100.1.2.3:2022/${destination.slice("projects/".length)}/README.md`,
    origin: { host: "sliara" },
    snapshot,
  };
  const { writer_path: _writerPath, reference: _reference, ...recorded } = receipt;
  const manifest = toJson({ ...recorded, status: "verified" });
  const manifestSha256 = [
    ...Object.entries(options.files).map(([name, text]) => `${sha256(text)}  payload/${name}`),
    `${sha256("readme")}  README.md`,
    `${sha256(manifest)}  manifest.json`,
  ].join("\n");
  return {
    receipt,
    destination,
    writerPath,
    manifestSha256: sha256(`${manifestSha256}\n`),
    files: {
      [`${writerPath}/manifest.json`]: manifest,
      [`${writerPath}/MANIFEST.sha256`]: `${manifestSha256}\n`,
      ...Object.fromEntries(
        Object.entries(options.files).map(([name, text]) => [
          `${writerPath}/payload/${name}`,
          text,
        ]),
      ),
    } as Record<string, string>,
  };
}

/** The library's backup receipt covering `bundles`, as workenv's backup service writes it. */
export const latestReceipt = (
  bundles: ReadonlyArray<{ writerPath: string; manifestSha256: string }>,
  snapshot = SNAPSHOT,
) =>
  toJson({
    schema: "workenv-backup-receipt/2",
    repository: "/data/work-backup/restic",
    snapshot_id: snapshot,
    backup_finished: "2026-10-22T07:41:01-04:00",
    confirmed_at: "2026-10-22T07:50:42-04:00",
    items: bundles.map((bundle) => ({
      path: bundle.writerPath,
      manifest_sha256: bundle.manifestSha256,
      status: "confirmed",
      method: "snapshot content hashed against manifest",
      content_verified_snapshot: snapshot,
    })),
  });

export interface ScriptedLibrary {
  /** Library paths to their text; changes made by a test are seen by later commands. */
  readonly files: Record<string, string>;
  readonly calls: ProcessRunInput[];
  readonly runner: ProcessRunner["Service"];
}

/**
 * A ProcessRunner standing in for rclone (cat, copyto, lsjson, copy), for ssh (`admin` receives the
 * remote command) and for the workenv command (`workenv` receives its arguments).
 */
export function scriptedLibrary(
  fs: FileSystem.FileSystem,
  script: {
    files: Record<string, string>;
    admin?: (command: string, files: Record<string, string>) => ProcessRunOutput;
    workenv?: (args: readonly string[]) => ProcessRunOutput | Effect.Effect<ProcessRunOutput>;
    listing?: ReadonlyArray<{ Path: string; Size: number; ModTime: string }>;
    /** Listings of particular library folders; `listing` answers every other one. */
    listings?: Record<string, ReadonlyArray<{ Path: string; Size: number; ModTime: string }>>;
  },
): ScriptedLibrary {
  const calls: ProcessRunInput[] = [];
  const remote = (value: string) => value.replace(/^:sftp:/, "");
  const runner = ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        const [verb, source, target] = input.args;
        if (input.command === "rclone") {
          if (verb === "cat") {
            const text = script.files[remote(source!)];
            return text === undefined ? output("", 3, "directory not found") : output(text);
          }
          if (verb === "copyto") {
            const text = script.files[remote(source!)];
            if (text === undefined) return output("", 4, "object not found");
            yield* fs.writeFileString(target!, text);
            return output();
          }
          if (verb === "lsjson") {
            const folder = remote(input.args.find((arg) => arg.startsWith(":sftp:")) ?? "");
            return output(toJson(script.listings?.[folder] ?? script.listing ?? []));
          }
          if (verb === "copy") {
            const list = yield* fs.readFileString(
              input.args[input.args.indexOf("--files-from-raw") + 1]!,
            );
            for (const relative of list.split("\n").filter(Boolean)) {
              const text = script.files[`${remote(source!)}/${relative}`];
              if (text === undefined) continue;
              const file = `${target}/${relative}`;
              yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
              yield* fs.writeFileString(file, text);
            }
            return output();
          }
        }
        if (input.command === "ssh")
          return (
            script.admin?.(input.args.at(-1)!, script.files) ??
            output("", 1, "no scripted ssh command")
          );
        if (/workenv(\.cmd)?$/.test(input.command)) {
          const result = script.workenv?.(input.args);
          return result === undefined
            ? output("", 2, "no scripted workenv")
            : Effect.isEffect(result)
              ? yield* result
              : result;
        }
        return output("", 127, `unexpected command ${input.command}`);
      }).pipe(Effect.orDie),
  });
  return { files: script.files, calls, runner };
}
