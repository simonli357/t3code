import { SessionMoveError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SessionMoves from "../../../moves/SessionMoves.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SessionMovesToolkit } from "./tools.ts";

/** The calling thread, when there is one; a client without a thread names the session itself. */
const caller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId),
);

export const layer = McpToolAccess.toLayer(SessionMovesToolkit, {
  t3_session_move: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const moves = yield* SessionMoves.SessionMoves;
      const actor = yield* caller;
      const threadId = input.threadId ?? actor;
      if (threadId === undefined)
        return yield* new SessionMoveError({
          message: "Name the threadId of the session to move.",
        });
      return yield* moves.request({ ...input, threadId }, actor);
    }),
  ),
  t3_session_move_status: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const moves = yield* SessionMoves.SessionMoves;
      return yield* moves.status(input, yield* caller);
    }),
  ),
});
