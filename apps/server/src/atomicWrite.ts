import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/**
 * Windows refuses to rename over or away from a file another process holds open
 * without delete sharing, such as a virus scanner or the search indexer. The same
 * codes also mean a denial that never clears, so retries need a bound.
 */
const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// About 2 seconds in total. Settings and keybinding saves wait on this while holding
// their write lock, so a denial that is not a brief scan has to surface quickly.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (platform !== "win32") return yield* fs.rename(tempPath, input.filePath);

      // A retry must not replace a save another process landed while this one
      // waited, so it gives up once the target is no longer the file seen here.
      // A read-only target fails with the same EPERM as a held one but never clears.
      const targetVersion = fs.stat(input.filePath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, input.filePath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, input.filePath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
