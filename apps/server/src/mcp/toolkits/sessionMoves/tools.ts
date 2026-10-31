import {
  OrchestratorMcpFailure,
  SessionMoveError,
  SessionMoveInput,
  SessionMoveResult,
  SessionMoveStatusInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SessionMoves from "../../../moves/SessionMoves.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([SessionMoveError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    SessionMoves.SessionMoves,
  ],
};

const move = Tool.make("t3_session_move", {
  ...shared,
  description:
    "Move THIS session, or a worker you own, to another linked computer using the SAME provider. Preserve the complete native session and resume identifier, T3 conversation and settings, attachments and workspace changes. No summary handoff or fresh-session fallback. Supply threadId, destination environment/projectId, and a stable requestId; providerInstanceId optionally maps the same provider to a destination account. Both computers need nativeSessionMoves support. A running session queues until its turn and background work finish. After requesting your own move, end your turn; do not wait inside it. Use t3_session_move_status to inspect/retry recovery. Only the destination can continue after commit; the source is retained as an archived copy. Existing terminal processes stay on their computer.",
  parameters: Schema.Struct({ ...SessionMoveInput.fields, threadId: Schema.optional(ThreadId) }),
  success: SessionMoveResult,
}).annotate(Tool.Destructive, true);

const moveStatus = Tool.make("t3_session_move_status", {
  ...shared,
  description:
    "Inspect a native session move using its requestId. cancel=true safely cancels before ownership routing/commit begins; an uncertain commit must be resolved through its durable receipt. Copies are retained for recovery. Reuse the original move input/requestId when retrying; never create another transfer merely because a call timed out.",
  parameters: SessionMoveStatusInput,
  success: SessionMoveResult,
}).annotate(Tool.Destructive, true);

export const SessionMovesToolkit = Toolkit.make(move, moveStatus);
