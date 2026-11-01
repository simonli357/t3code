import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveLegacyPiSession } from "./legacySession.ts";

it.layer(NodeServices.layer)("V1 Pi session continuity", (it) => {
  it.effect("resolves an exact native UUID and refuses ambiguous or missing sessions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const id = "01234567-1234-1234-1234-012345678901";
      const env = { PI_CODING_AGENT_SESSION_DIR: root };
      assert.isTrue(yield* resolveLegacyPiSession(id, env).pipe(Effect.isFailure));
      const session = path.join(root, `2026-11-01_${id}.jsonl`);
      yield* fs.writeFileString(session, `{"type":"session","id":"${id}"}\n`);
      assert.equal(yield* resolveLegacyPiSession(id, env), session);
      assert.equal(yield* resolveLegacyPiSession(session, env), session);
      yield* fs.writeFileString(
        path.join(root, `duplicate_${id}.jsonl`),
        `{"type":"session","id":"${id}"}\n`,
      );
      assert.isTrue(yield* resolveLegacyPiSession(id, env).pipe(Effect.isFailure));
    }),
  );
});
