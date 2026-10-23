import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Schema from "effect/Schema";
import * as Invocation from "../../McpInvocationContext.ts";
import {
  SessionMoveError,
  SessionMoveInput,
  SessionMoveResult,
  SessionMoveStatusInput,
  ThreadId,
} from "@t3tools/contracts";
import { SessionMoves } from "../../../orchestration/SessionMoves.ts";

const move = Tool.make("t3_session_move", {
  description:
    "Move THIS session, or a worker you own, to another linked computer using the SAME provider. Preserve the complete native session and resume identifier, T3 conversation and settings, attachments, workspace changes, and worker/report routing. No summary handoff or fresh-session fallback. Supply threadId, destination environment/projectId, and a stable requestId; providerInstanceId optionally maps the same provider to a destination account. Both computers need nativeSessionMoves support. A running session queues until its turn and background work finish. After requesting your own move, end your turn; do not wait inside it. Use t3_session_move_status to inspect/retry recovery. Only the destination can continue after commit; the source is retained as an archived copy. Existing terminal processes stay on their computer.",
  parameters: Schema.Struct({ ...SessionMoveInput.fields, threadId: Schema.optional(ThreadId) }),
  success: SessionMoveResult,
  failure: SessionMoveError,
  dependencies: [SessionMoves, Invocation.McpInvocationContext],
});
const moveStatus = Tool.make("t3_session_move_status", {
  description:
    "Inspect a native session move using its requestId. cancel=true safely cancels before ownership routing/commit begins; an uncertain commit must be resolved through its durable receipt. Copies are retained for recovery. Reuse the original move input/requestId when retrying; never create another transfer merely because a call timed out.",
  parameters: SessionMoveStatusInput,
  success: SessionMoveResult,
  failure: SessionMoveError,
  dependencies: [SessionMoves, Invocation.McpInvocationContext],
});

export const SessionMovesToolkit = Toolkit.make(move, moveStatus);
export const handlers = SessionMovesToolkit.toLayer(
  Effect.gen(function* () {
    const moves = yield* SessionMoves;
    const owner = Effect.map(Invocation.McpInvocationContext, (scope) => scope.threadId);
    return {
      t3_session_move: (input) =>
        owner.pipe(
          Effect.flatMap((id) => moves.request({ ...input, threadId: input.threadId ?? id }, id)),
        ),
      t3_session_move_status: (input) =>
        owner.pipe(Effect.flatMap((id) => moves.status(input, id))),
    };
  }),
);
