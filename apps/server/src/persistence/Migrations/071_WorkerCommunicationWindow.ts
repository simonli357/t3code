import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE custom_workers ADD COLUMN communication_anchor_at TEXT`;
  yield* sql`ALTER TABLE custom_worker_jobs ADD COLUMN communication_delivered_at TEXT`;
  yield* sql`CREATE INDEX custom_worker_jobs_undelivered
    ON custom_worker_jobs(worker_id, state)
    WHERE kind = 'work' AND communication_delivered_at IS NULL`;
  yield* sql`CREATE INDEX idx_projection_turns_pending_message
    ON projection_turns(thread_id, pending_message_id, row_id)`;
  yield* sql`CREATE INDEX idx_worker_first_running_event
    ON orchestration_events(stream_id, json_extract(payload_json, '$.session.activeTurnId'), sequence, occurred_at)
    WHERE event_type = 'thread.session-set' AND json_extract(payload_json, '$.session.status') = 'running'`;
  // Runtime notices must not scan a thread's activity history for each request.
  yield* sql`CREATE INDEX idx_worker_activity_request
    ON projection_thread_activities(thread_id, kind, json_extract(payload_json, '$.requestId'))`;
  yield* sql`CREATE INDEX idx_worker_activity_turn
    ON projection_thread_activities(thread_id, turn_id, kind, created_at)`;

  // One upgrade pass, using the same exact turn/event seeks as runtime recovery.
  // Legacy terminal/imported turns without running events retain started_at.
  // Active placeholders never fall back to requested_at: startup can be queued.
  yield* sql`UPDATE custom_worker_jobs AS j SET communication_delivered_at = COALESCE(
    (SELECT e.occurred_at FROM orchestration_events e
      WHERE e.stream_id = j.target_id AND e.event_type = 'thread.session-set'
        AND json_extract(e.payload_json, '$.session.status') = 'running'
        AND json_extract(e.payload_json, '$.session.activeTurnId') = COALESCE(j.turn_id,
          (SELECT t.turn_id FROM projection_turns t WHERE t.thread_id = j.target_id
            AND t.pending_message_id = 'worker-job:' || j.id ORDER BY t.row_id DESC LIMIT 1))
      ORDER BY e.sequence LIMIT 1),
    CASE WHEN j.state NOT IN ('queued', 'submitted') THEN COALESCE(
      (SELECT t.started_at FROM projection_turns t WHERE t.thread_id = j.target_id AND t.turn_id = j.turn_id),
      (SELECT t.started_at FROM projection_turns t WHERE t.thread_id = j.target_id
        AND t.pending_message_id = 'worker-job:' || j.id ORDER BY t.row_id DESC LIMIT 1)) END)
    WHERE j.kind = 'work' AND j.id NOT LIKE 'direct:%'`;
  yield* sql`UPDATE custom_workers SET communication_anchor_at = (
    SELECT MAX(MAX(COALESCE(j.communication_delivered_at, ''), COALESCE(j.dispatched_at, j.created_at)))
    FROM custom_worker_jobs j WHERE j.worker_id = custom_workers.thread_id
      AND j.kind = 'work' AND j.id NOT LIKE 'direct:%'
  )`;
});
