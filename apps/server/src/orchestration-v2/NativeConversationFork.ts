import {
  CommandId,
  ThreadId,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Result = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerSession: OrchestrationV2ProviderSession,
});
const encode = Schema.encodeSync(Schema.fromJsonString(Result));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Result));
export class NativeConversationForkError extends Schema.TaggedError<NativeConversationForkError>()(
  "NativeConversationForkError", { message: Schema.String },
) {}

/** Reserve before invoking a non-idempotent native API. A crash at that boundary
 * requires inspection; replaying the request must never create another clone. */
export const retainNativeConversationFork = Effect.fn("NativeConversationFork.retain")(
  function* <E, R>(input: {
    commandId: CommandId;
    targetThreadId: ThreadId;
    sourceFingerprint: string;
    clone: Effect.Effect<typeof Result.Type, E, R>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const inserted = yield* sql`INSERT INTO orchestration_v2_native_conversation_forks
      (target_thread_id, command_id, source_fingerprint)
      VALUES (${input.targetThreadId}, ${input.commandId}, ${input.sourceFingerprint})
      ON CONFLICT DO NOTHING RETURNING target_thread_id`;
    if (inserted.length === 0) {
      const saved = (yield* sql<{
        command_id: string; source_fingerprint: string; result_json: string | null;
      }>`SELECT * FROM orchestration_v2_native_conversation_forks WHERE target_thread_id = ${input.targetThreadId}`)[0];
      if (!saved || saved.command_id !== input.commandId || saved.source_fingerprint !== input.sourceFingerprint)
        return yield* new NativeConversationForkError({ message: "This fork request or source changed. Inspect the retained destination before starting another fork." });
      if (saved.result_json === null)
        return yield* new NativeConversationForkError({ message: `Native fork outcome is uncertain. Inspect destination ${input.targetThreadId}; this request will not clone again.` });
      return yield* decode(saved.result_json);
    }
    const result = yield* input.clone;
    yield* sql`UPDATE orchestration_v2_native_conversation_forks SET result_json = ${encode(result)} WHERE target_thread_id = ${input.targetThreadId}`;
    return result;
  },
);
