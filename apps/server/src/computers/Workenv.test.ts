import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProcessRunner from "../processRunner.ts";
import { isWithin, samePath } from "./paths.ts";
import {
  archiveProblem,
  keepActivity,
  keepOutcome,
  manifestProblem,
  memberPlatformProblem,
  newReceiptCache,
  readReceipts,
  restoreKeep,
  retryProblem,
  routeProblem,
  runKeep,
} from "./Workenv.ts";
import type { KeepReceipt } from "./WorkenvConfig.ts";
import {
  fromJson,
  interfaceJson,
  makeBundle,
  output,
  scriptedLibrary,
  toJson,
  workenvConfig,
} from "./testSupport.ts";

const bundle = makeBundle({
  id: "1".repeat(32),
  files: { "report.txt": "selected", "other.txt": "other" },
});
const selected = `${bundle.writerPath}/payload/report.txt`;
const libraryFiles = () => ({
  "/etc/library-interface.json": interfaceJson(),
  ...bundle.files,
});

describe("what a computer can restore", () => {
  const config = workenvConfig();
  it("accepts a keep that still matches this computer's configuration", () => {
    expect(archiveProblem(config, bundle.receipt)).toBeNull();
    expect(routeProblem(config)).toBeNull();
  });
  it("names the configuration change that makes a keep unrestorable", () => {
    const changed = (patch: Partial<KeepReceipt>) =>
      archiveProblem(config, { ...bundle.receipt, ...patch });
    expect(changed({ audience: "team" })).toContain("audience");
    expect(changed({ project: "unknown" })).toContain("not set up");
    expect(changed({ library_id: "other-library" })).toContain("different library");
    expect(
      changed({
        destination: "projects/other/evidence/bundle",
        writer_path: "/library/projects/other/evidence/bundle",
      }),
    ).toContain("library location");
    expect(changed({ writer_path: "/library/elsewhere" })).toContain("archive location");
    expect(changed({ status: "pending" })).toContain("no published archive");
    expect(
      changed({ snapshot: { "../escape": { type: "file", sha256: "b".repeat(64) } } }),
    ).toContain("Invalid archive member");
    expect(changed({ snapshot: { "a.txt": { type: "file" } } })).toContain(
      "hash metadata is missing",
    );
  });
  it("reads the route from the configuration", () => {
    expect(routeProblem({ ...config, keep: { ...config.keep, route_blocked: true } })).toContain(
      "blocked",
    );
    const { ssh_host: _alias, ...withoutAlias } = config.keep;
    const { interface_path: _interface, ...withoutInterface } = config.keep;
    expect(routeProblem({ ...config, keep: withoutAlias })).toContain("alias");
    expect(routeProblem({ ...config, keep: withoutInterface })).toContain("interface");
    expect(routeProblem({ ...config, keep: { ...withoutAlias, writer_local: true } })).toBeNull();
  });
  it("rejects names Windows cannot create, only on Windows", () => {
    for (const name of ["CON", "docs/nul.txt", "a/b.", "what?.txt", "pipe|name"])
      expect(memberPlatformProblem(name, "win32")).toContain("Windows");
    expect(memberPlatformProblem("report.txt", "win32")).toBeNull();
    expect(memberPlatformProblem("CON", "linux")).toBeNull();
  });
  it("compares Windows paths without case or trailing separators", () => {
    expect(samePath("win32", "C:\\Users\\Simon\\", "c:\\users\\simon")).toBe(true);
    expect(samePath("linux", "/Users/Simon", "/users/simon")).toBe(false);
    expect(isWithin("win32", "C:\\Users\\simon\\jobs", "c:\\users\\SIMON\\jobs\\x\\evidence")).toBe(
      true,
    );
    expect(isWithin("win32", "C:\\Users\\simon\\jobs", "C:\\Users\\simon\\jobs-old")).toBe(false);
  });
  it("only retries a keep whose project, library and source still match", () => {
    const pending: KeepReceipt = {
      ...bundle.receipt,
      status: "pending",
      source: "/current/t3/evidence",
    };
    expect(retryProblem(config, pending, "linux", [])).toBeNull();
    expect(
      retryProblem(config, { ...pending, source: "/jobs/t3-1/evidence" }, "linux", ["/jobs/t3-1"]),
    ).toBeNull();
    expect(
      retryProblem(config, { ...pending, source: "/jobs/gone/evidence" }, "linux", []),
    ).toContain("no longer belongs");
    expect(retryProblem(config, { ...pending, audience: "team" }, "linux", [])).toContain(
      "audience",
    );
    expect(retryProblem(config, { ...pending, library_ssh: "other-alias" }, "linux", [])).toContain(
      "writer route",
    );
  });
  it("checks every archive member of the published manifest against the receipt", () => {
    const manifest = fromJson(bundle.files[`${bundle.writerPath}/manifest.json`]!) as KeepReceipt;
    expect(manifestProblem(manifest, bundle.receipt)).toBeNull();
    expect(manifestProblem({ ...manifest, id: "2".repeat(32) }, bundle.receipt)).toContain("(id)");
    const members = manifest.snapshot!;
    expect(
      manifestProblem(
        { ...manifest, snapshot: { ...members, "extra.txt": members["other.txt"]! } },
        bundle.receipt,
      ),
    ).toContain("different set");
    const { "other.txt": _dropped, ...fewer } = members;
    expect(
      manifestProblem(
        { ...manifest, snapshot: { ...fewer, "renamed.txt": members["other.txt"]! } },
        bundle.receipt,
      ),
    ).toContain("other.txt");
    // A member nobody asked to restore changed: the whole manifest is untrusted, not just the file.
    expect(
      manifestProblem(
        {
          ...manifest,
          snapshot: {
            ...members,
            "other.txt": { ...members["other.txt"]!, sha256: "c".repeat(64) },
          },
        },
        bundle.receipt,
      ),
    ).toContain("other.txt");
    expect(
      manifestProblem(
        {
          ...manifest,
          snapshot: { ...members, "other.txt": { ...members["other.txt"]!, type: "directory" } },
        },
        bundle.receipt,
      ),
    ).toContain("other.txt");
  });
});

it.layer(NodeServices.layer)("restoring from the library", (it) => {
  const restore = (
    receipt: KeepReceipt,
    script: Parameters<typeof scriptedLibrary>[1],
    config = workenvConfig(),
    pick = selected,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-" });
      const library = scriptedLibrary(fs, script);
      const result = yield* restoreKeep(config, receipt, pick, `${parent}/restored`, parent).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
        Effect.result,
      );
      return { result, library, parent, fs };
    });

  it.effect("restores one file of a remote library after its job and source are gone", () =>
    Effect.gen(function* () {
      const { result, library, parent, fs } = yield* restore(bundle.receipt, {
        files: libraryFiles(),
      });
      expect(result._tag).toBe("Success");
      expect(yield* fs.readDirectory(`${parent}/restored`)).toEqual(["report.txt"]);
      expect(yield* fs.readFileString(`${parent}/restored/report.txt`)).toBe("selected");
      const copies = library.calls.filter((call) => call.args[0] === "copyto");
      expect(copies).toHaveLength(1);
      expect(copies[0]?.args[1]).toBe(`:sftp:${selected}`);
      expect(copies[0]?.args.join(" ")).toContain("StrictHostKeyChecking=yes");
      // The library is identified through its interface file, which a remote library does have.
      expect(library.calls.map((call) => call.args[1])).toContain(
        ":sftp:/etc/library-interface.json",
      );
    }),
  );

  const refusedBeforeTransport: ReadonlyArray<[string, Partial<KeepReceipt>]> = [
    [
      "a member that escapes the archive",
      {
        snapshot: {
          "../escape": { type: "file", sha256: "b".repeat(64) },
          "report.txt": bundle.receipt.snapshot!["report.txt"]!,
        },
      },
    ],
    ["a project whose audience changed", { audience: "team" }],
    ["a different library", { library_root: "/elsewhere" }],
  ];
  for (const [name, patch] of refusedBeforeTransport)
    it.effect(`refuses ${name} before any transport or destination write`, () =>
      Effect.gen(function* () {
        const { result, library, parent, fs } = yield* restore(
          { ...bundle.receipt, ...patch },
          { files: libraryFiles() },
        );
        expect(result._tag).toBe("Failure");
        expect(library.calls).toHaveLength(0);
        expect(yield* fs.exists(`${parent}/restored`)).toBe(false);
      }),
    );

  it.effect(
    "refuses a blocked route and a Windows-reserved name without touching the library",
    () =>
      Effect.gen(function* () {
        const config = workenvConfig();
        const blocked = yield* restore(
          bundle.receipt,
          { files: libraryFiles() },
          { ...config, keep: { ...config.keep, route_blocked: true } },
        );
        expect(blocked.result._tag).toBe("Failure");
        expect(blocked.library.calls).toHaveLength(0);
        const reserved = makeBundle({ id: "3".repeat(32), files: { "CON.txt": "x" } });
        const fs = yield* FileSystem.FileSystem;
        const library = scriptedLibrary(fs, { files: { ...libraryFiles(), ...reserved.files } });
        const windows = yield* restoreKeep(
          config,
          reserved.receipt,
          `${reserved.writerPath}/payload/CON.txt`,
          "/tmp/never",
          "/unused-staging",
        ).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
          Effect.provideService(HostProcessPlatform, "win32"),
          Effect.result,
        );
        expect(windows._tag).toBe("Failure");
        expect(library.calls).toHaveLength(0);
      }),
  );

  it.effect("refuses a library whose interface names another filesystem", () =>
    Effect.gen(function* () {
      const { result, library } = yield* restore(bundle.receipt, {
        files: {
          ...libraryFiles(),
          "/etc/library-interface.json": interfaceJson({ uuid: "someone-elses" }),
        },
      });
      expect(result._tag === "Failure" && result.failure.message).toContain("different library");
      expect(library.calls.filter((call) => call.args[0] === "copyto")).toHaveLength(0);
    }),
  );

  it.effect("refuses a published manifest that differs from the receipt in any member", () =>
    Effect.gen(function* () {
      const manifest = fromJson(bundle.files[`${bundle.writerPath}/manifest.json`]!) as KeepReceipt;
      const tampered = {
        ...manifest,
        snapshot: {
          ...manifest.snapshot,
          // The file being restored is intact; a sibling is not.
          "other.txt": { ...manifest.snapshot!["other.txt"]!, sha256: "d".repeat(64) },
        },
      };
      const { result, library } = yield* restore(bundle.receipt, {
        files: { ...libraryFiles(), [`${bundle.writerPath}/manifest.json`]: toJson(tampered) },
      });
      expect(result._tag === "Failure" && result.failure.message).toContain("other.txt");
      expect(library.calls.filter((call) => call.args[0] === "copyto")).toHaveLength(0);
    }),
  );

  it.effect("rejects downloaded bytes with a wrong hash before publishing", () =>
    Effect.gen(function* () {
      const { result, parent, fs } = yield* restore(bundle.receipt, {
        files: { ...libraryFiles(), [selected]: "corrupted" },
      });
      expect(result._tag === "Failure" && result.failure.message).toContain("SHA-256");
      expect(yield* fs.exists(`${parent}/restored/report.txt`)).toBe(false);
    }),
  );

  it.effect("refuses a destination that already holds files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const destination = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-full-" });
      yield* fs.writeFileString(`${destination}/keep-me.txt`, "mine");
      const library = scriptedLibrary(fs, { files: libraryFiles() });
      const result = yield* restoreKeep(
        workenvConfig(),
        bundle.receipt,
        selected,
        destination,
        destination.slice(0, destination.lastIndexOf("/")),
      ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, library.runner), Effect.result);
      expect(result._tag).toBe("Failure");
      expect(library.calls).toHaveLength(0);
    }),
  );
  for (const swap of ["destination", "ancestor"] as const)
    it.effect(
      `refuses a ${swap} symlink substituted after download, leaving outside files untouched`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "restore-swap-" });
          const destination = `${root}/parent/chosen`,
            outside = `${root}/outside`;
          yield* fs.makeDirectory(destination, { recursive: true });
          yield* fs.makeDirectory(`${outside}/chosen`, { recursive: true });
          const library = scriptedLibrary(fs, { files: libraryFiles() });
          const hook = Effect.gen(function* () {
            const copy = library.calls.find((call) => call.args[0] === "copyto")!;
            const staged = copy.args[2]!;
            const directory = staged.slice(0, staged.lastIndexOf("/"));
            expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700);
            expect(staged.startsWith(destination)).toBe(false);
            const changed = swap === "destination" ? destination : `${root}/parent`;
            yield* fs.rename(changed, `${root}/previous`);
            yield* fs.symlink(outside, changed);
          }).pipe(Effect.orDie);
          const result = yield* restoreKeep(
            workenvConfig(),
            bundle.receipt,
            selected,
            destination,
            root,
            hook,
          ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, library.runner), Effect.result);
          expect(result._tag).toBe("Failure");
          expect(yield* fs.exists(`${outside}/report.txt`)).toBe(false);
          expect(yield* fs.exists(`${outside}/chosen/report.txt`)).toBe(false);
          expect((yield* fs.readDirectory(root)).some((name) => name.startsWith("restore-"))).toBe(
            false,
          );
        }),
    );

  it.effect("emits stalled for crash-left keep phases instead of claiming a live process", () =>
    Effect.sync(() => {
      for (const phase of ["copying", "verifying", "inspecting", "creating"]) {
        const row = keepActivity(
          {
            key: "crashed",
            file: "/unused",
            modifiedAt: 1,
            receipt: { ...bundle.receipt, status: phase, error: null },
          },
          true,
        );
        expect(row).toMatchObject({
          status: "stalled",
          detail: `Last recorded: ${phase}; its process was not found.`,
        });
      }
    }),
  );
});

it.layer(NodeServices.layer)("keep receipts", (it) => {
  it.effect(
    "reads a request workenv wrote before inspecting its selection, and rereads only what changed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-receipts-" });
        // As workenv writes a request that failed before it could inspect anything: no id, no created_at.
        const early = {
          source: "/gone/evidence",
          project: "t3",
          collection: "evidence",
          audience: "private",
          reason: "Evidence",
          backup_required: true,
          backup: "not verified",
          status: "pending",
          error: "ssh: connect to host 192.168.0.80 port 22: Connection timed out",
        };
        yield* fs.writeFileString(`${folder}/${"a".repeat(24)}.json`, toJson(early));
        yield* fs.writeFileString(`${folder}/${"b".repeat(24)}.json`, toJson(bundle.receipt));
        yield* fs.writeFileString(`${folder}/${"c".repeat(24)}.json`, "{damaged");
        yield* fs.writeFileString(`${folder}/${"b".repeat(24)}.lock`, "");
        const cache = newReceiptCache();
        const first = yield* readReceipts(folder, cache);
        expect(first.receipts.map((entry) => entry.key).sort()).toEqual([
          "a".repeat(24),
          "b".repeat(24),
        ]);
        expect(first.errors).toHaveLength(1);
        expect(first.errors[0]).toContain(`${"c".repeat(24)}.json`);
        const pending = first.receipts.find((entry) => entry.key === "a".repeat(24))!;
        expect(keepActivity(pending, true)).toMatchObject({
          status: "failed",
          retryable: true,
          label: "Evidence",
        });
        expect(keepActivity(pending, true).updatedAt).toBe(pending.modifiedAt);
        expect(keepActivity(pending, false)).toMatchObject({ retryable: false });
        expect(keepActivity(pending, false).detail).toContain("no longer exists");
        expect(
          keepActivity(
            first.receipts.find((entry) => entry.key === "b".repeat(24))!,
            false,
          ),
        ).toMatchObject({ status: "published", retryable: false, detail: null });
        // Nothing changed: nothing is parsed again.
        const parsed = cache.version;
        yield* readReceipts(folder, cache);
        expect(cache.version).toBe(parsed);
        // One file changed and one disappeared.
        yield* fs.writeFileString(
          `${folder}/${"a".repeat(24)}.json`,
          toJson({ ...early, error: "now a different failure message" }),
        );
        yield* fs.remove(`${folder}/${"c".repeat(24)}.json`);
        const second = yield* readReceipts(folder, cache);
        expect(cache.version).toBeGreaterThan(parsed);
        expect(second.errors).toEqual([]);
        expect(
          second.receipts.find((entry) => entry.key === "a".repeat(24))!.receipt.error,
        ).toContain("different failure");
      }),
  );
});

describe("workenv commands", () => {
  const handle = (stdout: string) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(Stream.make(stdout)),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("hands a hostile reason to workenv.cmd as one escaped argument", () => {
    const spawned: Array<{ command: string; args: ReadonlyArray<string>; shell: unknown }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const spawn = command as unknown as {
          command: string;
          args: ReadonlyArray<string>;
          options: { shell?: boolean | string };
        };
        spawned.push({ command: spawn.command, args: spawn.args, shell: spawn.options.shell });
        return handle(
          toJson({
            source: "x",
            project: "t3",
            reason: "r",
            status: "published",
            created_at: "2026-10-22T10:00:00Z",
          }),
        );
      }),
    );
    const hostile = 'why & "this" | that %PATH% ^ !x! (maybe) <>';
    return runKeep("C:\\Users\\simon\\jobs\\t3-1\\evidence & calc", hostile).pipe(
      Effect.provide(
        Layer.mergeAll(
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          ),
          NodePath.layerWin32,
        ),
      ),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessEnvironment, { USERPROFILE: "C:\\Users\\simon" }),
      Effect.provideService(
        SpawnExecutableResolution,
        () => "C:\\Users\\simon\\.local\\bin\\workenv.cmd",
      ),
      Effect.map((outcome) => {
        expect(outcome.status).toBe("completed");
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.shell).toBe(true);
        // The launcher, the verb, the path and the reason each stay one argument...
        expect(spawned[0]!.args).toHaveLength(4);
        // ...and nothing cmd.exe treats as syntax survives unescaped in any of them.
        for (const value of [spawned[0]!.command, ...spawned[0]!.args])
          expect(value.replace(/\^[\s\S]/g, "")).not.toMatch(/[()[\]%!^"`<>&|;, *?]/);
      }),
    );
  });

  it.effect("reports a keep that did not publish as failed, with workenv's reason", () =>
    Effect.gen(function* () {
      const library = scriptedLibrary(yield* FileSystem.FileSystem, {
        files: {},
        workenv: () =>
          output(
            toJson({
              source: "/x",
              project: "t3",
              reason: "r",
              status: "pending",
              error: "ssh: connect to host 192.168.0.80 port 22: Connection timed out",
              created_at: "2026-10-22T10:00:00Z",
            }),
            2,
          ),
      });
      const outcome = yield* runKeep("/x", "r").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
      );
      expect(outcome).toMatchObject({ status: "failed", retryable: false });
      expect(outcome.detail).toContain("Connection timed out");
      expect(library.calls[0]?.args).toEqual(["keep", "/x", "--reason", "r"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports workenv's own error when it prints no receipt", () =>
    Effect.gen(function* () {
      const library = scriptedLibrary(yield* FileSystem.FileSystem, {
        files: {},
        workenv: () =>
          output(
            "",
            2,
            "Workenv keep failed: Source has no unambiguous project mapping. Preserve the selected source.",
          ),
      });
      const failure = yield* runKeep("/x", "r").pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, library.runner),
        Effect.flip,
      );
      expect(failure.message).toContain("no unambiguous project mapping");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("treats a published keep as done even while its independent backup is pending", () => {
    const outcome = keepOutcome({
      ...bundle.receipt,
      backup: "pending",
      backup_error: "snapshot missing",
    });
    expect(outcome).toMatchObject({ status: "completed", retryable: false });
    expect(outcome.detail).toContain("snapshot missing");
    expect(keepOutcome({ ...bundle.receipt, backup_required: false }).detail).toBe(
      "Published to the library.",
    );
  });
});
