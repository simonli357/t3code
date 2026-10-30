// @effect-diagnostics nodeBuiltinImport:off - bounded traversal needs incremental opendir reads.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import { operationError } from "./WorkenvConfig.ts";

/** Reads only the names a bounded traversal can examine, closing the handle on every exit. */
export const readNames = Effect.fn("Computers.readDirectory")(function* (
  directory: string,
  limit: number,
) {
  let closed: Promise<void> = Promise.resolve();
  return yield* Effect.tryPromise({
    try: (signal) => {
      const reading = (async () => {
        const handle = await NodeFSP.opendir(directory);
        try {
          const names: string[] = [];
          while (names.length < limit && !signal.aborted) {
            const entry = await handle.read();
            if (!entry) return { names, truncated: false };
            names.push(entry.name);
          }
          return { names, truncated: signal.aborted || (await handle.read()) !== null };
        } finally {
          await handle.close();
        }
      })();
      closed = reading.then(
        () => undefined,
        () => undefined,
      );
      return reading;
    },
    catch: operationError,
  }).pipe(Effect.ensuring(Effect.promise(() => closed)));
});
