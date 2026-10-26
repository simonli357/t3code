import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_orchestrator_authority (
    thread_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1,
    successor_id TEXT, retired_sequence INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
  )`;
  // Existing completed handoffs also retire their predecessors. Reclaim needs
  // a new direct user instruction, rather than an inherited historical prompt.
  yield* sql`INSERT INTO custom_orchestrator_authority
    (thread_id, active, successor_id, retired_sequence, revision)
    SELECT owner_id, 0, thread_id, (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events), 1
    FROM custom_orchestrator_handoffs WHERE state = 'completed' ORDER BY rowid
    ON CONFLICT(thread_id) DO UPDATE SET successor_id = excluded.successor_id`;
  yield* sql`CREATE TABLE custom_session_message_confirmations (
    id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, target_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, token TEXT NOT NULL, sender_state TEXT NOT NULL,
    target_state TEXT NOT NULL, expires_at TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`ALTER TABLE custom_worker_jobs ADD COLUMN policy_json TEXT`;
  yield* sql`ALTER TABLE custom_worker_jobs ADD COLUMN report_ids_json TEXT`;
  yield* sql`CREATE TABLE custom_worker_reclaims (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_json TEXT NOT NULL,
    user_message_id TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
});
