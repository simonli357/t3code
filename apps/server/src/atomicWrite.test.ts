import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { writeFileStringAtomically } from "./atomicWrite.ts";

it.layer(NodeServices.layer)("writeFileStringAtomically", (it) => {
  it.effect("renames once and surfaces a lock error at once off Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      let attempts = 0;
      const locked = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EBUSY", to));
          }),
      });

      const result = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, locked),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("waits out a Windows scanner holding the target, then replaces it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedTwice = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts <= 2
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedTwice),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      yield* advanceUntilDone(writing);

      assert.strictEqual(attempts, 3);
      assert.strictEqual(yield* fs.readFileString(filePath), "after");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("gives up on a Windows lock that does not clear and keeps the old contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const locked = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Deferred.succeed(firstAttempt, undefined).pipe(
              Effect.andThen(Effect.fail(renameError("EPERM", to))),
            );
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, locked),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.isAbove(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("does not replace a newer save that landed while the lock was held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      const firstAttempt = yield* Deferred.make<void>();
      let attempts = 0;
      const lockedOnce = FileSystem.make({
        ...fs,
        rename: (from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Deferred.succeed(firstAttempt, undefined).pipe(
                  Effect.andThen(Effect.fail(renameError("EBUSY", to))),
                )
              : fs.rename(from, to);
          }),
      });

      const stale = yield* writeFileStringAtomically({ filePath, contents: "stale" }).pipe(
        Effect.provideService(FileSystem.FileSystem, lockedOnce),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttempt);
      // Another process saves once the lock clears, before the waiting write retries.
      yield* writeFileStringAtomically({ filePath, contents: "newer" });

      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(stale)));
      assert.strictEqual(yield* fs.readFileString(filePath), "newer");
      assert.deepStrictEqual(yield* fs.readDirectory(root), ["settings.json"]);
    }),
  );

  it.effect("fails at once on a read-only Windows target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const filePath = path.join(root, "settings.json");
      yield* fs.writeFileString(filePath, "before");
      yield* Effect.acquireRelease(fs.chmod(filePath, 0o444), () =>
        fs.chmod(filePath, 0o644).pipe(Effect.ignore),
      );
      let attempts = 0;
      const denied = FileSystem.make({
        ...fs,
        rename: (_from, to) =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(renameError("EPERM", to));
          }),
      });

      const writing = yield* writeFileStringAtomically({ filePath, contents: "after" }).pipe(
        Effect.provideService(FileSystem.FileSystem, denied),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.exit,
        Effect.forkChild,
      );
      assert.isTrue(Exit.isFailure(yield* advanceUntilDone(writing)));
      assert.strictEqual(attempts, 1);
      assert.strictEqual(yield* fs.readFileString(filePath), "before");
    }),
  );
});

// Retries stat the real target between waits, and that I/O finishes outside the
// test clock, so the clock moves one wait at a time until the write settles.
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("100 millis");
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  });

const renameError = (code: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error(`${code}, rename`), { code }),
  });
