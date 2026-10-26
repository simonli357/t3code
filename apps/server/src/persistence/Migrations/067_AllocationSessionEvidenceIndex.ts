import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX idx_orch_events_allocation_session
    ON orchestration_events(stream_id, occurred_at, sequence)
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.session-set'`;
  yield* sql`CREATE INDEX idx_orch_events_allocation_turn_session
    ON orchestration_events(stream_id, json_extract(payload_json, '$.session.activeTurnId'), occurred_at, sequence)
    WHERE aggregate_kind = 'thread' AND event_type = 'thread.session-set'`;
});
