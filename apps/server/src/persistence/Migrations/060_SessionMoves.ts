import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_session_moves (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, target_thread_id TEXT NOT NULL,
    direction TEXT NOT NULL, peer_environment_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', locked INTEGER NOT NULL DEFAULT 1,
    input_json TEXT NOT NULL, manifest_json TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX custom_session_moves_locked_thread
    ON custom_session_moves(thread_id) WHERE locked = 1`;
  yield* sql`CREATE TABLE custom_session_move_job_aliases (
    incoming_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, thread_id TEXT NOT NULL
  )`;
});
