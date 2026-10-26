import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ComputerActivity, ComputerFile, HostResourcesSnapshot } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Computers from "./Computers.ts";
import {
  fromJson,
  interfaceJson,
  latestReceipt,
  makeBundle,
  output,
  scriptedLibrary,
  SNAPSHOT,
  toJson,
  workenvConfig,
} from "./testSupport.ts";

const bundle = makeBundle({
  id: "1".repeat(32),
  files: { "report.txt": "selected", "docs/notes.md": "notes" },
});
const KEY = "k".repeat(24);
const SECOND_KEY = "m".repeat(24);
const secondBundle = makeBundle({ id: "2".repeat(32), files: { "other.txt": "other" } });
const LATEST = "/var/lib/workenv/backup/latest.json";
const publishedReceipt = (extra: Record<string, unknown> = {}) =>
  toJson({ ...bundle.receipt, ...extra });
const keepReceipt = toJson({
  source: "/work/evidence",
  project: "t3",
  reason: "why",
  status: "published",
  created_at: "2026-10-22T10:00:00Z",
});

/**
 * A computers service over a real temporary state folder, with the file system observed so a test
 * can wait for a record to be written instead of waiting for time to pass.
 */
const harness = Effect.gen(function* () {
  const base = yield* FileSystem.FileSystem;
  const root = yield* base.makeTempDirectoryScoped({ prefix: "t3-computers-" });
  const home = `${root}/home`,
    serverConfig = Context.get(
      yield* Layer.build(ServerConfig.layerTest(root, { prefix: "t3-computers-state-" })),
      ServerConfig.ServerConfig,
    );
  yield* base.makeDirectory(`${home}/.config/workenv`, { recursive: true });
  const renamed = yield* Queue.unbounded<{ file: string; text: string }>();
  const failing = yield* Ref.make(false);
  const failedWrites = yield* Queue.unbounded<string>();
  /** When set, the next record written for an action stops until the test lets it go. */
  const hold = yield* Ref.make<{
    entered: Deferred.Deferred<void>;
    release: Deferred.Deferred<void>;
  } | null>(null);
  const observed = FileSystem.FileSystem.of({
    ...base,
    rename: (from, to) =>
      Effect.gen(function* () {
        if (to.includes("/computers/") && (yield* Ref.get(failing)) && to.includes("/actions/")) {
          yield* Queue.offer(failedWrites, to);
          return yield* PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: to,
          });
        }
        const held = to.includes("/actions/") ? yield* Ref.getAndSet(hold, null) : null;
        if (held) {
          yield* Deferred.succeed(held.entered, undefined);
          yield* Deferred.await(held.release);
        }
        yield* base.rename(from, to);
        if (to.includes("/computers/"))
          yield* Queue.offer(renamed, {
            file: to,
            text: yield* base.readFileString(to).pipe(Effect.orElseSucceed(() => "")),
          });
      }),
  });
  const state = `${root}/workenv-state`;
  yield* base.makeDirectory(`${state}/keep/requests`, { recursive: true });
  const library = scriptedLibrary(base, {
    listing: [
      {
        Path: `t3/evidence/${bundle.destination.split("/").at(-1)}/manifest.json`,
        Size: 100,
        ModTime: "2026-10-22T11:51:11-04:00",
      },
    ],
    files: { "/etc/library-interface.json": interfaceJson(), ...bundle.files },
    admin: (command) =>
      command.includes("snapshots") ? output(toJson([{ id: SNAPSHOT }])) : output(),
  });
  const start = (
    scope: Scope.Closeable,
    runner: ProcessRunner.ProcessRunner["Service"] = library.runner,
    fileSystem: FileSystem.FileSystem = observed,
    resources: Effect.Effect<HostResourcesSnapshot> = Effect.die("not read in these tests"),
  ) =>
    Layer.buildWithScope(
      Computers.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, serverConfig),
            Layer.succeed(HostResources.HostResources, { read: resources }),
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              getProjectShells: () => Effect.succeed([]),
              getShellSnapshot: () =>
                Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: "" }),
            } as never),
            Layer.succeed(FileSystem.FileSystem, fileSystem),
            NodePath.layer,
            Layer.succeed(ProcessRunner.ProcessRunner, runner),
          ),
        ),
      ),
      scope,
    ).pipe(
      Effect.map((context) => Context.get(context, Computers.Computers)),
      Effect.provideService(HostProcessEnvironment, { HOME: home }),
    );
  const configure = (config = workenvConfig(state)) =>
    base.writeFileString(`${home}/.config/workenv/keep.json`, toJson(config));
  /** Waits for the next record written under the computers folder that satisfies `matches`. */
  const written = (matches: (file: string, text: string) => boolean) =>
    Effect.gen(function* () {
      for (;;) {
        const next = yield* Queue.take(renamed);
        if (matches(next.file, next.text)) return next;
      }
    });
  const settled = (id: string) =>
    written(
      (file, text) =>
        file.endsWith(`/actions/${id}.json`) &&
        (text.includes('"status":"completed"') || text.includes('"status":"failed"')),
    ).pipe(Effect.map((record) => fromJson(record.text) as ComputerActivity));
  const actionFiles = base
    .readDirectory(`${serverConfig.stateDir}/computers/actions`)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  return {
    base,
    root,
    home,
    state,
    serverConfig,
    library,
    failing,
    failedWrites,
    hold,
    start,
    configure,
    written,
    settled,
    actionFiles,
  };
});

const inspect = (
  service: Computers.Computers["Service"],
  section: "files" | "activity" | "folders" | "disks" | "holdings" | "holding",
  more: object = {},
) =>
  service
    .inspect({ section, ...more })
    .pipe(Effect.provideService(HostProcessEnvironment, { HOME: "" }));

it.layer(NodeServices.layer)("the computers service", (it) => {
  it.effect("pages the file list in one stable order, however large the pages", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const files: ComputerFile[] = Array.from({ length: 25 }, (_, i) => ({
        path: `/work/p/${String(24 - i)}.txt`,
        name: `${["delta", "Alpha", "charlie", "bravo", "echo"][i % 5]}-${24 - i}.txt`,
        project: "p",
        sizeBytes: i,
        modifiedAt: null,
        directory: false,
        backup: "not-verified",
        reference: null,
      }));
      yield* h.base.makeDirectory(`${h.serverConfig.stateDir}/computers`, { recursive: true });
      yield* h.base.writeFileString(
        `${h.serverConfig.stateDir}/computers/files.json`,
        toJson({ files, indexedAt: 1, errors: [] }),
      );
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      const pages = [];
      for (const offset of [0, 10, 20])
        pages.push(yield* inspect(service, "files", { limit: 10, offset }));
      expect(pages.map((page) => page.files.length)).toEqual([10, 10, 5]);
      expect(pages.map((page) => page.totalFiles)).toEqual([25, 25, 25]);
      expect(new Set(pages.map((page) => page.indexedAt)).size).toBe(1);
      const names = pages.flatMap((page) => page.files.map((file) => file.name));
      expect(new Set(names).size).toBe(25);
      // Name order, by one collator: what a client that pages through sees is already sorted.
      const collator = new Intl.Collator();
      expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
      expect((yield* inspect(service, "files", { limit: 6_000 })).files).toHaveLength(25);
      expect((yield* inspect(service, "files", { query: "alpha", limit: 2 })).totalFiles).toBe(5);
      expect((yield* inspect(service, "files")).files).toHaveLength(25);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "serves repeated folder requests from one measurement, and measures again when asked",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const folder = `${h.root}/measured`;
        yield* h.base.makeDirectory(folder);
        yield* h.base.writeFileString(`${folder}/a.txt`, "a".repeat(1_000));
        const scope = yield* Scope.make();
        const service = yield* h.start(scope);
        const names = (result: { files: ReadonlyArray<{ name: string }> }) =>
          result.files.map((file) => file.name).sort();
        expect(names(yield* inspect(service, "folders", { path: folder }))).toEqual(["a.txt"]);
        yield* h.base.writeFileString(`${folder}/b.txt`, "b");
        // Clients poll a folder detail every few seconds; the folder is not walked again each time.
        expect(names(yield* inspect(service, "folders", { path: folder }))).toEqual(["a.txt"]);
        expect(names(yield* inspect(service, "folders", { path: folder, refresh: true }))).toEqual([
          "a.txt",
          "b.txt",
        ]);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("recovers an action that was running when the server stopped", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const actions = `${h.serverConfig.stateDir}/computers/actions`;
      yield* h.base.makeDirectory(actions, { recursive: true });
      const running: ComputerActivity = {
        id: "stopped",
        kind: "backup",
        label: "Verify library backups",
        status: "running",
        updatedAt: 5,
        detail: null,
        source: null,
        retryable: false,
      };
      const done: ComputerActivity = {
        ...running,
        id: "done",
        status: "completed",
        detail: "fine",
        kind: "transfer",
      };
      const pendingTransfer: ComputerActivity = {
        ...running,
        id: "pending-transfer",
        kind: "transfer",
        status: "pending",
      };
      const failedTransfer: ComputerActivity = {
        ...pendingTransfer,
        id: "failed-transfer",
        status: "failed",
        detail: "Transfer failed.",
        retryable: true,
      };
      const failedBackup: ComputerActivity = {
        ...running,
        id: "failed-backup",
        status: "failed",
        detail: "Backup failed.",
        retryable: true,
      };
      yield* h.base.writeFileString(`${actions}/stopped.json`, toJson(running));
      yield* h.base.writeFileString(`${actions}/done.json`, toJson(done));
      yield* h.base.writeFileString(`${actions}/pending-transfer.json`, toJson(pendingTransfer));
      yield* h.base.writeFileString(`${actions}/failed-transfer.json`, toJson(failedTransfer));
      yield* h.base.writeFileString(`${actions}/failed-backup.json`, toJson(failedBackup));
      yield* h.base.writeFileString(`${actions}/half-written.json.abc.tmp`, "{");
      yield* h.base.writeFileString(`${actions}/damaged.json`, "{not json");
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      const { activities, errors } = yield* inspect(service, "activity");
      const byId = Object.fromEntries(activities.map((activity) => [activity.id, activity]));
      expect(byId["stopped"]).toMatchObject({ status: "failed", retryable: false });
      expect(byId["stopped"]!.detail).toContain("Interrupted when the server stopped");
      for (const id of ["stopped", "failed-backup"]) {
        expect(byId[id]).toMatchObject({ status: "failed", retryable: false });
        expect(byId[id]!.detail).toContain("native workenv backup row");
        expect(
          (fromJson(yield* h.base.readFileString(`${actions}/${id}.json`)) as ComputerActivity)
            .retryable,
        ).toBe(false);
      }
      expect(byId["done"]).toEqual(done);
      for (const id of ["pending-transfer", "failed-transfer"]) {
        expect(byId[id]).toMatchObject({ status: "failed", retryable: false });
        expect(byId[id]!.detail).toContain("native workenv transfer or handoff row");
      }
      expect(errors.join(" ")).toContain("damaged.json");
      // The record on disk was corrected too, and the half-written file is gone.
      expect(
        (fromJson(yield* h.base.readFileString(`${actions}/stopped.json`)) as ComputerActivity)
          .status,
      ).toBe("failed");
      expect(yield* h.base.exists(`${actions}/half-written.json.abc.tmp`)).toBe(false);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "records an action before it runs, refuses identical requests, and records its result",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        const gate = yield* Deferred.make<void>();
        const library = scriptedLibrary(h.base, {
          files: {},
          workenv: () => Deferred.await(gate).pipe(Effect.as(output(keepReceipt))),
        });
        const scope = yield* Scope.make();
        const service = yield* h.start(scope, library.runner);
        const request = { action: "keep", path: "/work/evidence", reason: "why" } as const;
        const first = (yield* service.act(request)).activity;
        expect(first).toMatchObject({
          kind: "transfer",
          status: "pending",
          source: "/work/evidence",
        });
        // Written to disk before anything ran...
        const initial = fromJson(
          yield* h.base.readFileString(
            `${h.serverConfig.stateDir}/computers/actions/${first.id}.json`,
          ),
        ) as ComputerActivity;
        expect(initial.status).toBe("pending");
        // ...and the same request while it runs is the same action.
        expect((yield* service.act(request).pipe(Effect.flip)).message).toContain(
          "already running",
        );
        expect(yield* h.actionFiles).toHaveLength(1);
        yield* Deferred.succeed(gate, undefined);
        const final = yield* h.settled(first.id);
        expect(final).toMatchObject({ id: first.id, status: "completed", retryable: false });
        expect(final.detail).toBe("Published to the library.");
        const { activities } = yield* inspect(service, "activity");
        expect(activities.find((activity) => activity.id === first.id)?.status).toBe("completed");
        expect(library.calls.filter((call) => call.args[0] === "keep")).toHaveLength(1);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "persists an interrupted result when the server stops during an action, and shows it after a restart",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        const started = yield* Deferred.make<void>();
        // This keep never finishes on its own: it is still running when the server stops.
        const library = scriptedLibrary(h.base, {
          files: {},
          workenv: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const scope = yield* Scope.make();
        const service = yield* h.start(scope, library.runner);
        const { activity } = yield* service.act({
          action: "keep",
          path: "/work/evidence",
          reason: "why",
        });
        yield* Deferred.await(started);
        yield* Scope.close(scope, Exit.void);
        // Closing the scope waited for the interrupted action to write its record.
        const record = fromJson(
          yield* h.base.readFileString(
            `${h.serverConfig.stateDir}/computers/actions/${activity.id}.json`,
          ),
        ) as ComputerActivity;
        expect(record.status).toBe("failed");
        expect(record.detail).toContain("Interrupted");
        const again = yield* h.start(yield* Scope.make());
        const { activities } = yield* inspect(again, "activity");
        expect(activities.find((row) => row.id === activity.id)).toMatchObject({
          status: "failed",
          label: "Keep evidence",
        });
      }),
  );

  it.effect("keeps only the newest 200 finished actions on disk and in the list", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const actions = `${h.serverConfig.stateDir}/computers/actions`;
      yield* h.base.makeDirectory(actions, { recursive: true });
      for (let i = 0; i < 205; i++) {
        const record: ComputerActivity = {
          id: `old-${i}`,
          kind: "transfer",
          label: `Keep ${i}`,
          status: "completed",
          updatedAt: i + 1,
          detail: null,
          source: null,
          retryable: false,
        };
        yield* h.base.writeFileString(`${actions}/old-${i}.json`, toJson(record));
      }
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      const { activities } = yield* inspect(service, "activity");
      expect(activities).toHaveLength(200);
      expect(activities.some((activity) => activity.id === "old-4")).toBe(false);
      expect(activities.some((activity) => activity.id === "old-5")).toBe(true);
      expect(yield* h.actionFiles).toHaveLength(200);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("runs an action to its end when the caller goes away right after it was recorded", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      const library = scriptedLibrary(h.base, { files: {}, workenv: () => output(keepReceipt) });
      const scope = yield* Scope.make();
      const service = yield* h.start(scope, library.runner);
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      yield* Ref.set(h.hold, { entered, release });
      const caller = yield* service
        .act({ action: "keep", path: "/work/evidence", reason: "why" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      // The record is being written; the caller is told to stop. Recording, starting and handing the
      // action to the server must not be cut in half by that.
      yield* Effect.forkChild(Fiber.interrupt(caller));
      yield* Deferred.succeed(release, undefined);
      const final = yield* h.written(
        (file, text) =>
          file.includes("/actions/") &&
          (text.includes('"status":"completed"') || text.includes('"status":"failed"')),
      );
      expect((fromJson(final.text) as ComputerActivity).status).toBe("completed");
      expect(library.calls.filter((call) => call.args[0] === "keep")).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "starts nothing, and keeps no record, when an action is refused or cannot be recorded",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        const scope = yield* Scope.make();
        const service = yield* h.start(scope);
        for (const input of [
          { action: "keep", path: "relative/path", reason: "why" },
          { action: "keep", path: "/work/evidence", reason: "two\nlines" },
          { action: "restore", path: "/library/x" },
          { action: "retry", requestId: "missing" },
          { action: "backup" },
        ] as const)
          expect((yield* service.act(input).pipe(Effect.flip)).message.length).toBeGreaterThan(0);
        yield* Ref.set(h.failing, true);
        const failure = yield* service
          .act({ action: "keep", path: "/work/evidence", reason: "why" })
          .pipe(Effect.flip);
        expect(failure.message).toBeTruthy();
        expect(h.library.calls.filter((call) => call.command.endsWith("workenv"))).toHaveLength(0);
        expect(yield* h.actionFiles).toEqual([]);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "says so when the result of an action cannot be saved, and keeps it correct in memory",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        const gate = yield* Deferred.make<void>();
        const library = scriptedLibrary(h.base, {
          files: {},
          workenv: () => Deferred.await(gate).pipe(Effect.as(output(keepReceipt))),
        });
        const scope = yield* Scope.make();
        const service = yield* h.start(scope, library.runner);
        const { activity } = yield* service.act({
          action: "keep",
          path: "/work/evidence",
          reason: "why",
        });
        yield* Ref.set(h.failing, true);
        yield* Deferred.succeed(gate, undefined);
        // The result is written three times, and none of them can succeed: it is reported, not lost.
        for (let attempt = 0; attempt < 3; attempt++) yield* Queue.take(h.failedWrites);
        let reported: ReadonlyArray<string> = [];
        let row: ComputerActivity | undefined;
        for (let check = 0; check < 5 && !reported.length; check++) {
          const result = yield* inspect(service, "activity");
          row = result.activities.find((entry) => entry.id === activity.id);
          reported = result.errors.filter((error) => error.includes("Cannot save the result"));
        }
        expect(reported).toHaveLength(1);
        expect(row).toMatchObject({ status: "completed", detail: "Published to the library." });
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "retries a published keep's backup without its job or source, and remembers the verification",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        // The keep was published long ago; its job and source are gone, and only a backup is missing.
        yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
        h.library.files[LATEST] = latestReceipt([bundle]);
        const scope = yield* Scope.make();
        const service = yield* h.start(scope);
        const before = (yield* inspect(service, "activity")).activities;
        expect(before.find((row) => row.id === KEY)).toMatchObject({
          status: "published",
          retryable: false,
        });
        expect(before.find((row) => row.id === `backup:${KEY}`)).toMatchObject({
          kind: "backup",
          status: "failed",
          retryable: true,
        });
        const { activity } = yield* service.act({ action: "retry", requestId: KEY });
        expect(activity.kind).toBe("backup");
        const final = yield* h.settled(activity.id);
        expect(final).toMatchObject({ status: "completed", retryable: false });
        expect(final.detail).toContain("Backup confirmed for 1 keep");
        expect(h.library.calls.filter((call) => call.command.endsWith("workenv"))).toHaveLength(0);
        const after = (yield* inspect(service, "activity")).activities;
        expect(after.find((row) => row.id === `backup:${KEY}`)).toMatchObject({
          status: "completed",
          retryable: false,
        });
        expect(
          (yield* inspect(service, "files")).files.every(
            (file) => file.backup === "confirmed" && file.restorable === true,
          ),
        ).toBe(true);
        // The verification is on disk: a restarted server still knows the bundle is backed up.
        yield* Scope.close(scope, Exit.void);
        expect(
          yield* h.base.exists(
            `${h.serverConfig.stateDir}/computers/proofs/${bundle.receipt.id}.json`,
          ),
        ).toBe(true);
        const restartedScope = yield* Scope.make();
        const restarted = yield* h.start(restartedScope);
        expect(
          (yield* inspect(restarted, "files")).files.every((file) => file.backup === "confirmed"),
        ).toBe(true);
        yield* Scope.close(restartedScope, Exit.void);
      }),
  );

  it.effect("verifies all waiting backups only when requestId is omitted", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
      yield* h.base.writeFileString(
        `${h.state}/keep/requests/${SECOND_KEY}.json`,
        toJson(secondBundle.receipt),
      );
      Object.assign(h.library.files, secondBundle.files, {
        [LATEST]: latestReceipt([bundle, secondBundle]),
      });
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      const { activity } = yield* service.act({ action: "backup" });
      expect(yield* h.settled(activity.id)).toMatchObject({
        status: "completed",
        detail: "Backup confirmed for 2 keeps.",
        retryable: false,
      });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("retries only the bundle identified by a native backup row", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
      yield* h.base.writeFileString(
        `${h.state}/keep/requests/${SECOND_KEY}.json`,
        toJson(secondBundle.receipt),
      );
      Object.assign(h.library.files, secondBundle.files, { [LATEST]: latestReceipt([bundle]) });
      const scope = yield* Scope.make(),
        service = yield* h.start(scope);
      const native = (yield* inspect(service, "activity")).activities.find(
        (row) => row.id === `backup:${KEY}`,
      )!;
      expect(native.retryable).toBe(true);
      const { activity } = yield* service.act({ action: "backup", requestId: native.id });
      expect(yield* h.settled(activity.id)).toMatchObject({
        status: "completed",
        detail: "Backup confirmed for 1 keep.",
        retryable: false,
      });
      expect(
        h.library.calls.some((call) =>
          call.args.some(
            (arg) => arg.includes(secondBundle.writerPath) || arg.includes("systemctl"),
          ),
        ),
      ).toBe(false);
      expect(
        yield* h.base.exists(
          `${h.serverConfig.stateDir}/computers/proofs/${secondBundle.receipt.id}.json`,
        ),
      ).toBe(false);
      expect(
        (yield* inspect(service, "activity")).activities.find(
          (row) => row.id === `backup:${SECOND_KEY}`,
        ),
      ).toMatchObject({ status: "failed", retryable: true });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("offers Retry only on the native backup row after a synthetic backup fails", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
      h.library.files[LATEST] = latestReceipt([]);
      const scope = yield* Scope.make(),
        service = yield* h.start(scope);
      const { activity } = yield* service.act({ action: "backup", requestId: `backup:${KEY}` });
      const failed = yield* h.settled(activity.id);
      expect(failed).toMatchObject({ status: "failed", retryable: false });
      expect(failed.detail).toContain("native workenv backup row");
      expect(
        (yield* inspect(service, "activity")).activities
          .filter((row) => row.kind === "backup" && row.retryable)
          .map((row) => row.id),
      ).toEqual([`backup:${KEY}`]);
      const calls = h.library.calls.length;
      expect(
        (yield* service.act({ action: "backup", requestId: activity.id }).pipe(Effect.flip))
          .message,
      ).toContain("Select a published keep");
      expect(h.library.calls).toHaveLength(calls);
      expect(yield* h.actionFiles).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "rejects unknown, stale and empty explicit backup ids while another backup is pending",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
        yield* h.base.writeFileString(
          `${h.state}/keep/requests/${SECOND_KEY}.json`,
          toJson(secondBundle.receipt),
        );
        const scope = yield* Scope.make(),
          service = yield* h.start(scope);
        yield* h.base.remove(`${h.state}/keep/requests/${SECOND_KEY}.json`);
        yield* TestClock.adjust("2 seconds");
        for (const id of [
          "5d0c4b7a-6c2e-4a3b-9a55-0f1a2b3c4d5e",
          `backup:${SECOND_KEY}`,
          "",
          "backup:",
        ])
          expect(
            (yield* service.act({ action: "backup", requestId: id }).pipe(Effect.flip)).message,
          ).toContain("Select a published keep");
        expect(h.library.calls).toHaveLength(0);
        expect(yield* h.actionFiles).toHaveLength(0);
        expect(
          (yield* inspect(service, "activity")).activities.find(
            (row) => row.id === `backup:${KEY}`,
          ),
        ).toMatchObject({ retryable: true });
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "finds a bundle only the library holds, lists its files, and restores one of them",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        // No receipt for this bundle exists on this computer: another computer published it.
        const scope = yield* Scope.make();
        const service = yield* h.start(scope);
        expect((yield* inspect(service, "files")).files).toEqual([]);
        yield* h.written((file) => file.includes("/computers/catalog/"));
        const listed = yield* inspect(service, "files");
        expect(listed.files.map((file) => file.path).sort()).toEqual([
          `${bundle.writerPath}/payload/docs/notes.md`,
          `${bundle.writerPath}/payload/report.txt`,
        ]);
        // Named exactly as the computer that published it names it, so clients show one entry.
        expect(listed.files[0]).toMatchObject({
          reference: bundle.receipt.reference,
          restorable: true,
          backup: "published",
        });
        h.library.files[LATEST] = latestReceipt([bundle]);
        const verified = yield* service.act({ action: "backup", requestId: bundle.receipt.id! });
        expect(yield* h.settled(verified.activity.id)).toMatchObject({
          status: "completed",
          retryable: false,
        });
        const destination = `${h.root}/restored-from-library`;
        const { activity } = yield* service.act({
          action: "restore",
          path: `${bundle.writerPath}/payload/report.txt`,
          destination,
        });
        expect(yield* h.settled(activity.id)).toMatchObject({ status: "completed" });
        expect(yield* h.base.readFileString(`${destination}/report.txt`)).toBe("selected");
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("answers the storage sections from the same service, with kept bundles under Archives", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      // The first look starts the library catalog in the background, as the file search does.
      yield* inspect(service, "holdings", { groups: [] });
      yield* h.written((file) => file.includes("/computers/catalog/"));
      const holdings = (yield* inspect(service, "holdings", { groups: ["archives"] })).storageHoldings!;
      expect(holdings.groups.map((group) => group.group)).toEqual([
        "workspaces",
        "archives",
        "backups",
        "other",
      ]);
      const archives = holdings.groups[1]!;
      expect(archives).toMatchObject({ status: "complete", count: 1 });
      expect(archives.entries[0]).toMatchObject({
        id: `archive:${bundle.receipt.id}`,
        title: "Evidence",
        subtitle: "t3 · evidence",
        // The library is reached over ssh: its bytes are not on this computer.
        local: false,
        size: { bytes: "selected".length + "notes".length, basis: "manifest", complete: true },
        archive: { backup: "published", files: 2 },
      });
      // Other groups carry totals only, because only Archives was asked for.
      expect(holdings.groups.filter((group) => group.entries.length).map((group) => group.group)).toEqual([
        "archives",
      ]);
      const disks = (yield* inspect(service, "disks")).storageDisks!;
      expect(disks.host.length).toBeGreaterThan(0);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("restores a kept file onto this computer and records the restore", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
      const scope = yield* Scope.make();
      const service = yield* h.start(scope);
      const destination = `${h.root}/restored`;
      const { activity } = yield* service.act({
        action: "restore",
        path: `${bundle.writerPath}/payload/docs/notes.md`,
        destination,
      });
      expect(activity).toMatchObject({ kind: "restore", status: "running" });
      expect(yield* h.settled(activity.id)).toMatchObject({
        status: "completed",
        detail: "File restored and its SHA-256 verified.",
      });
      expect(yield* h.base.readFileString(`${destination}/docs/notes.md`)).toBe("notes");
      yield* Scope.close(scope, Exit.void);
    }),
  );
  it.effect("reserves a normalized action before the first asynchronous record write", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      const library = scriptedLibrary(h.base, { files: {}, workenv: () => output(keepReceipt) });
      const scope = yield* Scope.make(),
        service = yield* h.start(scope, library.runner);
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      yield* Ref.set(h.hold, { entered, release });
      const first = yield* service
        .act({ action: "keep", path: "/work/./evidence", reason: "why" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(
        (yield* service
          .act({ action: "keep", path: "/work/evidence", reason: "why" })
          .pipe(Effect.flip)).message,
      ).toContain("already running");
      expect(library.calls).toHaveLength(0);
      yield* Deferred.succeed(release, undefined);
      const accepted = yield* Fiber.join(first);
      expect(yield* h.settled(accepted.activity.id)).toMatchObject({ status: "completed" });
      expect(yield* h.actionFiles).toHaveLength(1);
      const next = yield* service.act({ action: "keep", path: "/work/evidence", reason: "why" });
      expect(yield* h.settled(next.activity.id)).toMatchObject({ status: "completed" });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("releases an operation reservation after its first record write fails", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.configure();
      const library = scriptedLibrary(h.base, { files: {}, workenv: () => output(keepReceipt) });
      const scope = yield* Scope.make(),
        service = yield* h.start(scope, library.runner);
      yield* Ref.set(h.failing, true);
      const request = { action: "keep", path: "/work/evidence", reason: "why" } as const;
      expect((yield* service.act(request).pipe(Effect.result))._tag).toBe("Failure");
      yield* Ref.set(h.failing, false);
      const next = yield* service.act(request);
      expect(yield* h.settled(next.activity.id)).toMatchObject({ status: "completed" });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "refuses different restores to the same normalized destination until publication finishes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const runner = ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.gen(function* () {
              if (input.args[0] === "copyto") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* h.library.runner.run(input);
            }),
        });
        const scope = yield* Scope.make(),
          service = yield* h.start(scope, runner);
        const destination = `${h.root}/restored`;
        const first = yield* service.act({
          action: "restore",
          path: `${bundle.writerPath}/payload/report.txt`,
          destination,
        });
        yield* Deferred.await(entered);
        const conflict = yield* service
          .act({
            action: "restore",
            path: `${bundle.writerPath}/payload/docs/notes.md`,
            destination: `${h.root}/./restored`,
          })
          .pipe(Effect.flip);
        expect(conflict.message).toContain("already being written");
        yield* Deferred.succeed(release, undefined);
        expect(yield* h.settled(first.activity.id)).toMatchObject({ status: "completed" });
        yield* h.base.remove(destination, { recursive: true });
        const next = yield* service.act({
          action: "restore",
          path: `${bundle.writerPath}/payload/docs/notes.md`,
          destination,
        });
        expect(yield* h.settled(next.activity.id)).toMatchObject({ status: "completed" });
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("only offers native workenv ids for Retry after a dashboard Keep fails", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const config = workenvConfig(h.state),
        source = `${h.root}/output`;
      yield* h.base.makeDirectory(source);
      yield* h.configure({
        ...config,
        projects: { t3: { source: h.root, keep: { audience: "private", backup_required: true } } },
      });
      const failedReceipt = {
        ...bundle.receipt,
        source,
        status: "pending",
        error: "transfer failed",
      };
      let calls = 0;
      const library = scriptedLibrary(h.base, {
        files: {},
        workenv: () =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1) {
              yield* h.base.writeFileString(
                `${h.state}/keep/requests/${KEY}.json`,
                toJson(failedReceipt),
              );
              return output(toJson(failedReceipt), 1);
            }
            return output(toJson({ ...failedReceipt, status: "published", error: null }));
          }).pipe(Effect.orDie),
      });
      const scope = yield* Scope.make(),
        service = yield* h.start(scope, library.runner);
      const first = yield* service.act({ action: "keep", path: source, reason: "why" });
      const failed = yield* h.settled(first.activity.id);
      expect(failed).toMatchObject({ status: "failed", retryable: false });
      expect(failed.detail).toContain("native workenv");
      const rows = (yield* inspect(service, "activity")).activities;
      expect(
        rows.filter((row) => row.kind === "transfer" && row.retryable).map((row) => row.id),
      ).toEqual([KEY]);
      const retry = yield* service.act({ action: "retry", requestId: KEY });
      expect(yield* h.settled(retry.activity.id)).toMatchObject({
        status: "completed",
        retryable: false,
      });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  for (const changed of ["snapshot", "manifest"] as const)
    it.effect(
      `downgrades persisted confirmation after explicit verification finds a changed ${changed}`,
      () =>
        Effect.gen(function* () {
          const h = yield* harness;
          yield* h.configure();
          yield* h.base.writeFileString(`${h.state}/keep/requests/${KEY}.json`, publishedReceipt());
          let snapshots = [{ id: SNAPSHOT }];
          const library = scriptedLibrary(h.base, {
            files: { ...h.library.files, [LATEST]: latestReceipt([bundle]) },
            admin: (command) =>
              command.includes("snapshots") ? output(toJson(snapshots)) : output(),
          });
          const scope = yield* Scope.make(),
            service = yield* h.start(scope, library.runner);
          const first = yield* service.act({ action: "backup", requestId: KEY });
          expect(yield* h.settled(first.activity.id)).toMatchObject({ status: "completed" });
          const confirmed = (yield* inspect(service, "files")).files;
          expect(confirmed.length).toBeGreaterThan(0);
          expect(
            confirmed.every(
              (file) =>
                file.backup === "confirmed" &&
                file.backupVerifiedAt !== null &&
                file.area === "archive",
            ),
          ).toBe(true);
          const saved = fromJson(
            yield* h.base.readFileString(
              `${h.serverConfig.stateDir}/computers/proofs/${bundle.receipt.id}.json`,
            ),
          ) as { proof: unknown };
          yield* h.base.writeFileString(
            `${h.state}/keep/requests/${KEY}.json`,
            publishedReceipt({
              backup: "confirmed",
              backup_receipt: saved.proof,
              backup_error: null,
            }),
          );
          if (changed === "snapshot") snapshots = [];
          else library.files[`${bundle.writerPath}/MANIFEST.sha256`] = "changed";
          const second = yield* service.act({ action: "backup", requestId: KEY });
          expect(yield* h.settled(second.activity.id)).toMatchObject({
            status: "failed",
            retryable: false,
          });
          const downgraded = (yield* inspect(service, "files")).files;
          expect(
            downgraded.every(
              (file) => file.backup === "published" && file.backupVerifiedAt === null,
            ),
          ).toBe(true);
          yield* Scope.close(scope, Exit.void);
          const restartScope = yield* Scope.make(),
            restarted = yield* h.start(restartScope, library.runner);
          expect(
            (yield* inspect(restarted, "files")).files.every(
              (file) => file.backup === "published" && file.backupVerifiedAt === null,
            ),
          ).toBe(true);
          yield* Scope.close(restartScope, Exit.void);
        }),
    );

  it.effect(
    "indexes validated job outputs, evidence and inputs outside all project roots, excluding repo and tmp",
    () =>
      Effect.gen(function* () {
        const h = yield* harness,
          primary = `${h.root}/primary`,
          job = `${h.root}/jobs/t3-${"a".repeat(24)}`;
        for (const folder of [
          primary,
          ...["repo", "tmp", "outputs", "evidence", "inputs"].map((area) => `${job}/${area}`),
        ])
          yield* h.base.makeDirectory(folder, { recursive: true });
        yield* h.base.writeFileString(`${primary}/primary.txt`, "source");
        for (const folder of ["repo", "tmp", "outputs", "evidence", "inputs"])
          yield* h.base.writeFileString(`${job}/${folder}/${folder}.txt`, folder);
        yield* h.base.writeFileString(
          `${job}/.workenv.json`,
          toJson({ root: job, project: "t3", status: "active" }),
        );
        const config = workenvConfig(h.state);
        yield* h.configure({
          ...config,
          jobs_root: `${h.root}/jobs`,
          projects: { t3: { ...config.projects.t3!, source: primary } },
        });
        const scope = yield* Scope.make(),
          service = yield* h.start(scope);
        yield* inspect(service, "files");
        yield* h.written((file) => file.endsWith("/files.json"));
        const result = yield* inspect(service, "files");
        expect(
          result.files
            .filter((file) => file.area !== "archive")
            .map((file) => file.name)
            .sort(),
        ).toEqual(["evidence.txt", "inputs.txt", "outputs.txt", "primary.txt"]);
        expect(result.files.find((file) => file.name === "primary.txt")).toMatchObject({
          project: "t3",
          area: "project",
        });
        expect(
          result.files
            .filter((file) => file.area !== "archive" && file.name !== "primary.txt")
            .every((file) => file.project === "t3" && file.area === "work"),
        ).toBe(true);
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect(
    "removes surplus and orphaned proof records at startup and when receipts disappear",
    () =>
      Effect.gen(function* () {
        const h = yield* harness;
        yield* h.configure();
        const requests = new Map<string, string>(),
          proofs = new Map<string, string>();
        const proofFolder = `${h.serverConfig.stateDir}/computers/proofs`,
          requestFolder = `${h.state}/keep/requests`;
        const proof = {
          schema: "workenv-backup-receipt/2",
          path: bundle.writerPath,
          snapshot_id: SNAPSHOT,
          content_verified_snapshot: SNAPSHOT,
          manifest_sha256: bundle.manifestSha256,
          method: "snapshot content hashed against manifest",
          confirmed_at: "2026-10-22T10:00:00Z",
        };
        for (let i = 1; i <= 5001; i++) {
          const id = i.toString(16).padStart(32, "0");
          requests.set(`${id}.json`, toJson({ ...bundle.receipt, id }));
          proofs.set(`${id}.json`, toJson({ id, proof, at: i }));
        }
        proofs.set(`${"f".repeat(32)}.json`, toJson({ id: "f".repeat(32), proof, at: 1 }));
        const info = yield* h.base.stat(requestFolder);
        const virtual = FileSystem.FileSystem.of({
          ...h.base,
          readDirectory: (folder, options) =>
            folder === proofFolder
              ? Effect.succeed([...proofs.keys()])
              : folder === requestFolder
                ? Effect.succeed([...requests.keys()])
                : h.base.readDirectory(folder, options),
          stat: (file) =>
            file.startsWith(`${requestFolder}/`) ? Effect.succeed(info) : h.base.stat(file),
          readFileString: (file, options) =>
            file.startsWith(`${requestFolder}/`)
              ? Effect.succeed(requests.get(file.slice(requestFolder.length + 1))!)
              : file.startsWith(`${proofFolder}/`)
                ? Effect.succeed(proofs.get(file.slice(proofFolder.length + 1))!)
                : h.base.readFileString(file, options),
          remove: (file, options) =>
            file.startsWith(`${proofFolder}/`)
              ? Effect.sync(() => {
                  proofs.delete(file.slice(proofFolder.length + 1));
                })
              : h.base.remove(file, options),
        });
        const scope = yield* Scope.make(),
          service = yield* h.start(scope, h.library.runner, virtual);
        expect(proofs.size).toBe(5000);
        expect(proofs.has(`${"f".repeat(32)}.json`)).toBe(false);
        const removed = [...proofs.keys()][0]!;
        requests.delete(removed);
        yield* TestClock.adjust("2 seconds");
        yield* inspect(service, "files");
        expect(proofs.size).toBe(4999);
        expect(proofs.has(removed)).toBe(false);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});

const GIB = 2 ** 30;
const reading: HostResourcesSnapshot = {
  sampledAt: 5_000,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 6 * GIB,
  totalMemoryBytes: 16 * GIB,
};
/** `df -B1 -P -l` output for filesystems given as device, size, used and mount point. */
const df = (rows: ReadonlyArray<readonly [string, number, number, string]>) =>
  [
    "Filesystem 1-blocks Used Available Capacity Mounted on",
    ...rows.map(
      ([device, total, used, mount]) =>
        `${device} ${total} ${used} ${total - used} ${Math.round((used / total) * 100)}% ${mount}`,
    ),
  ].join("\n");

it.layer(NodeServices.layer)("the computers capacity reading", (it) => {
  const linux = Effect.provideService(HostProcessPlatform, "linux");
  /** A runner that only knows `df`, counting how often the disks were measured. */
  const disksRunner = (text: string | null) => {
    const calls: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.command);
          return input.command === "df" && text !== null
            ? output(text)
            : output("", 1, "df: cannot read");
        }),
    });
    return { calls, runner };
  };

  it.effect("is bounded and always includes the disk that holds the work", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const loops = Array.from(
        { length: 18 },
        (_, index) =>
          [`/dev/loop${index}`, 100 * 2 ** 20, 100 * 2 ** 20, `/snap/core/${index}`] as const,
      );
      const { runner } = disksRunner(
        df([
          ["/dev/nvme0n1p2", 900 * GIB, 780 * GIB, "/"],
          ["/dev/sda1", 2000 * GIB, 500 * GIB, "/data"],
          ...loops,
        ]),
      );
      const scope = yield* Scope.make();
      const service = yield* h.start(scope, runner, h.base, Effect.succeed(reading)).pipe(linux);
      yield* TestClock.setTime(10_000);
      const capacity = yield* service.capacity({ workPath: "/snap/core/17/jobs" }).pipe(linux);
      expect(capacity.disks).toHaveLength(16);
      expect(capacity.disks.slice(0, 2).map((disk) => disk.path)).toEqual(["/data", "/"]);
      // The smallest mounts are dropped first, but not the one the work would be written to.
      expect(capacity.disks.map((disk) => disk.path)).toContain("/snap/core/17");
      expect(capacity.workDisk).toBe("/snap/core/17");
      expect(capacity.resources).toEqual(reading);
      expect(capacity.os).toBe("linux");
      // Reported as measured: the oldest reading is the CPU and memory sample.
      expect(capacity.sampledAt).toBe(5_000);
      // Where the work goes is not known: no disk is named rather than a wrong one.
      expect((yield* service.capacity().pipe(linux)).workDisk).toBeNull();
      expect((yield* service.capacity({ workPath: "/data/jobs/x" }).pipe(linux)).workDisk).toBe(
        "/data",
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("shares one disk measurement with the overview and measures again when it is old", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { calls, runner } = disksRunner(df([["/dev/nvme0n1p2", 900 * GIB, 780 * GIB, "/"]]));
      const scope = yield* Scope.make();
      const service = yield* h.start(scope, runner, h.base, Effect.succeed(reading)).pipe(linux);
      yield* service.capacity().pipe(linux);
      const overview = yield* service.inspect({ section: "overview" }).pipe(linux);
      expect(overview.disks.map((disk) => disk.path)).toEqual(["/"]);
      expect(calls).toEqual(["df"]);
      yield* TestClock.adjust("31 seconds");
      yield* service.capacity().pipe(linux);
      expect(calls).toEqual(["df", "df"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("keeps the overview's disk list to real volumes", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { runner } = disksRunner(
        df([
          ["/dev/nvme0n1p2", 900 * GIB, 780 * GIB, "/"],
          ["tmpfs", 8 * GIB, 0, "/run"],
          ["/dev/loop4", 100 * 2 ** 20, 100 * 2 ** 20, "/snap/core/4"],
          ["/dev/nvme0n1p1", 1 * GIB, 0.1 * GIB, "/boot/efi"],
        ]),
      );
      const scope = yield* Scope.make();
      const service = yield* h.start(scope, runner, h.base, Effect.succeed(reading)).pipe(linux);
      const overview = yield* service.inspect({ section: "overview" }).pipe(linux);
      expect(overview.disks.map((disk) => disk.path)).toEqual(["/"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("counts Workenv jobs, and says nothing when Workenv is not installed", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { runner } = disksRunner(df([["/dev/nvme0n1p2", 900 * GIB, 780 * GIB, "/"]]));
      const scope = yield* Scope.make();
      const service = yield* h.start(scope, runner, h.base, Effect.succeed(reading)).pipe(linux);
      expect((yield* service.capacity().pipe(linux)).jobs).toBeNull();
      const jobs = `${h.root}/jobs`;
      for (const [name, status] of [
        [`t3-${"a".repeat(24)}`, "active"],
        [`t3-${"b".repeat(24)}`, "active"],
        [`t3-${"c".repeat(24)}`, "expired"],
      ] as const) {
        yield* h.base.makeDirectory(`${jobs}/${name}`, { recursive: true });
        yield* h.base.writeFileString(
          `${jobs}/${name}/.workenv.json`,
          toJson({ project: "t3", root: `${jobs}/${name}`, status }),
        );
      }
      yield* h.configure({ ...workenvConfig(h.state), jobs_root: jobs });
      // None has a process Workenv recorded as live, so none counts as running.
      expect((yield* service.capacity().pipe(linux)).jobs).toEqual({ active: 2, running: 0 });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("reports what it could not read instead of failing or inventing numbers", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const { runner } = disksRunner(null);
      const scope = yield* Scope.make();
      const service = yield* h
        .start(scope, runner, h.base, Effect.succeed({ ...reading, cpuUtilization: null }))
        .pipe(linux);
      const capacity = yield* service.capacity({ workPath: "/work" }).pipe(linux);
      expect(capacity.disks).toEqual([]);
      expect(capacity.workDisk).toBeNull();
      expect(capacity.resources.cpuUtilization).toBeNull();
      expect(capacity.notices).toEqual(["Disks could not be read: df failed: df: cannot read"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
