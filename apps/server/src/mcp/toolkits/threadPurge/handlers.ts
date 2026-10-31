import * as Effect from "effect/Effect";

import * as Purge from "../../../orchestration-v2/SettledThreadPurge.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadPurgeToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ThreadPurgeToolkit, {
  // Removing history is an environment-level action, so it takes a full-access caller.
  t3_purge_settled_threads: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const purge = yield* Purge.SettledThreadPurge;
      return yield* purge.purge(input);
    }),
  ),
});
