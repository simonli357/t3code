import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_worker_renewal_intent
    ON orchestration_events(stream_id, sequence, event_type)
    WHERE event_type IN ('thread.turn-interrupt-requested', 'thread.turn-start-requested')
      AND (command_id IS NULL OR (command_id NOT LIKE 'renewal:%' AND command_id NOT LIKE 'worker-job:%'))`;
  yield* sql`CREATE INDEX idx_worker_wake_intent
    ON orchestration_events(stream_id, sequence, event_type)
    WHERE aggregate_kind = 'thread' AND event_type IN ('thread.turn-interrupt-requested', 'thread.turn-start-requested')
      AND (command_id IS NULL OR command_id NOT LIKE 'worker-job:%')`;
  yield* sql`CREATE INDEX idx_worker_renewal_tool_wait
    ON projection_thread_activities(thread_id, turn_id, json_extract(payload_json, '$.toolCallId'), kind, created_at)
    WHERE kind IN ('tool.started', 'tool.completed') AND json_extract(payload_json, '$.toolCallId') IS NOT NULL`;
});
