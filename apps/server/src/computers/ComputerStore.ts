// @effect-diagnostics nodeBuiltinImport:off effectFnOpportunity:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Every record the computers service keeps is written whole to a temporary file and renamed over
 * its name, so a crash leaves the previous version or the new one and never half of either. A
 * failed write removes its temporary file.
 */
export const writeJson = Effect.fn("Computers.writeJson")(function* (
  filename: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${filename}.${NodeCrypto.randomUUID()}.tmp`;
  yield* encodeJson(value).pipe(
    Effect.flatMap((text) => fs.writeFileString(temporary, text)),
    Effect.andThen(fs.rename(temporary, filename)),
    Effect.tapError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
  );
});

/** Names in `folder` ending in `suffix`; a folder that cannot be read has none. */
export const listNames = Effect.fn("Computers.listNames")(function* (
  folder: string,
  suffix: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(folder).pipe(
    Effect.map((names) => names.filter((name) => name.endsWith(suffix))),
    Effect.orElseSucceed(() => [] as string[]),
  );
});
