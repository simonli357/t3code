import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX idx_orch_events_type ON orchestration_events(event_type)`;
  yield* sql`CREATE INDEX idx_orch_events_approval_request_order
    ON orchestration_events(event_type, json_extract(payload_json, '$.requestId'), occurred_at DESC, sequence DESC)
    WHERE event_type = 'thread.approval-response-requested'
      AND json_extract(payload_json, '$.requestId') IS NOT NULL`;
  yield* sql`CREATE INDEX idx_activities_approval_request_first
    ON projection_thread_activities(kind, json_extract(payload_json, '$.requestId'), created_at, activity_id)
    WHERE kind = 'approval.requested' AND json_extract(payload_json, '$.requestId') IS NOT NULL`;
  yield* sql`CREATE INDEX idx_activities_approval_request_latest
    ON projection_thread_activities(kind, json_extract(payload_json, '$.requestId'), created_at DESC, activity_id DESC)
    WHERE (kind = 'approval.resolved' OR kind = 'provider.approval.respond.failed')
      AND json_extract(payload_json, '$.requestId') IS NOT NULL`;
  yield* sql`CREATE INDEX idx_activities_thread_request_latest
    ON projection_thread_activities(thread_id, json_extract(payload_json, '$.requestId'), created_at DESC, activity_id DESC, kind)
    WHERE json_extract(payload_json, '$.requestId') IS NOT NULL`;
  yield* sql`CREATE INDEX idx_turns_worker_claim
    ON projection_turns(thread_id, pending_message_id, row_id, requested_at, turn_id, state)
    WHERE turn_id IS NOT NULL AND pending_message_id IS NULL`;
  yield* sql`CREATE INDEX idx_worker_jobs_work_turn
    ON custom_worker_jobs(turn_id) WHERE kind = 'work'`;
  yield* sql`CREATE INDEX idx_turns_source_plan
    ON projection_turns(source_proposed_plan_thread_id, thread_id)
    WHERE source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_thread_id <> thread_id`;
  yield* sql`CREATE INDEX idx_turns_assistant_message
    ON projection_turns(assistant_message_id) WHERE assistant_message_id IS NOT NULL`;
  yield* sql`CREATE INDEX idx_messages_search_order
    ON projection_thread_messages(thread_id, is_streaming, CASE role WHEN 'user' THEN 0 ELSE 1 END, created_at DESC, message_id)
    WHERE is_streaming = 0`;
  yield* sql`CREATE INDEX idx_threads_message_search
    ON projection_threads(deleted_at, archived_at, thread_id, project_id, updated_at)`;
});
