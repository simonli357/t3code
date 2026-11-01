import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

class LegacyPiSessionResolutionError extends Schema.TaggedError<LegacyPiSessionResolutionError>()(
  "LegacyPiSessionResolutionError",
  {},
) {
  override get message() {
    return "The imported Pi session must resolve to exactly one native session file.";
  }
}

const decodeHeader = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("session"), id: Schema.String })),
);

/** V1's ACP bridge stored Pi UUIDs; RPC switch_session requires the corresponding file. */
export const resolveLegacyPiSession = Effect.fn("Pi.resolveLegacySession")(function* (
  nativeId: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nativeId)) return nativeId;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const root = environment.PI_CODING_AGENT_SESSION_DIR?.trim()
    ? path.resolve(expandHomePath(environment.PI_CODING_AGENT_SESSION_DIR, home))
    : path.join(
        expandHomePath(
          environment.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent"),
          home,
        ),
        "sessions",
      );
  const directories = [root];
  const matches: string[] = [];
  // Pi stores sessions directly in a custom directory or one workspace directory below the root.
  for (const directory of directories) {
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const name of entries) {
      const candidate = path.join(directory, name);
      if (directory === root && !name.endsWith(".jsonl")) {
        const stat = yield* fs.stat(candidate).pipe(Effect.option);
        if (Option.isSome(stat) && stat.value.type === "Directory") directories.push(candidate);
      }
      if (!name.endsWith(`_${nativeId}.jsonl`)) continue;
      const file = yield* fs.open(candidate, { flag: "r" });
      const bytes = new Uint8Array(16_384);
      const read = yield* file.read(bytes);
      if (read === 0) continue;
      const header = decodeHeader(
        new TextDecoder().decode(bytes.subarray(0, read)).split("\n")[0] ?? "",
      );
      if (Option.isSome(header) && header.value.id === nativeId) matches.push(candidate);
    }
  }
  // Never pick an arbitrary duplicate or silently start an empty conversation.
  if (matches.length !== 1) return yield* new LegacyPiSessionResolutionError({});
  return matches[0]!;
}, Effect.scoped);
