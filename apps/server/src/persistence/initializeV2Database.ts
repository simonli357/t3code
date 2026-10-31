import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { makeV1ImportReceipt } from "./importReceipts.ts";

const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

/**
 * Its copied legacy tables remain the source for lazy transcript import. A receipt beside the
 * V1 file records the snapshot's hash and counts before the copy is published.
 */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        // VACUUM INTO writes one compact file, so the copy does not carry the V1 free-page pool
        // (measured at about 3 GiB on the live database). The page-level backup is the fallback.
        try {
          database.exec(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`);
        } catch {
          NodeFS.rmSync(snapshotPath, { force: true });
          await NodeSqlite.backup(database, snapshotPath);
        }
      } finally {
        database.close();
      }
    });
    // Record the backup reference and counts/hashes before the copy can be used.
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const receipt = yield* Effect.tryPromise(() =>
      makeV1ImportReceipt({ sourcePath, snapshotPath, destinationPath, createdAt }),
    );
    const receiptDirectory = path.join(directory, "v2-import-receipts");
    yield* fs.makeDirectory(receiptDirectory, { recursive: true });
    const receiptPath = path.join(
      receiptDirectory,
      `v1-import-${receipt.createdAt.replaceAll(":", "-")}.json`,
    );
    yield* fs.writeFileString(`${receiptPath}.tmp`, `${encodeReceipt(receipt)}\n`);
    yield* fs.rename(`${receiptPath}.tmp`, receiptPath);
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs.link(snapshotPath, destinationPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        (_error) => Effect.void,
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
