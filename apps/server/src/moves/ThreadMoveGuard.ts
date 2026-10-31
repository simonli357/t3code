import { type CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The move's own bookkeeping (archiving the source) is the only thing allowed through. */
export const MOVE_COMMAND_PREFIX = "server:move:";

export class ThreadMovingError extends Schema.TaggedError<ThreadMovingError>()(
  "ThreadMovingError",
  { threadId: ThreadId, state: Schema.String },
) {
  override get message(): string {
    return `This session is moving or has moved to another computer (${this.state}). Use the move receipt to continue or cancel the transfer.`;
  }
}

/**
 * Keeps a session with a locked move receipt single-writer: while it moves, and
 * afterwards on the archived source, nothing here changes it.
 */
export class ThreadMoveGuard extends Context.Service<
  ThreadMoveGuard,
  {
    readonly check: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<void, ThreadMovingError>;
  }
>()("t3/moves/ThreadMoveGuard") {}

export const layer = Layer.effect(
  ThreadMoveGuard,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ThreadMoveGuard.of({
      check: Effect.fn("ThreadMoveGuard.check")(function* ({ threadId, commandId }) {
        if (commandId.startsWith(MOVE_COMMAND_PREFIX)) return;
        const moving = yield* sql<{
          state: string;
        }>`SELECT state FROM custom_session_moves WHERE thread_id = ${threadId} AND locked = 1 LIMIT 1`.pipe(
          Effect.orElseSucceed(() => []),
        );
        if (moving.length > 0)
          return yield* new ThreadMovingError({ threadId, state: moving[0]!.state });
      }),
    });
  }),
);
