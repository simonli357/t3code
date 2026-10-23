import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A released worker retains its plan, cursors and queued assignments. Null
  // ownership revokes the old master's authority without deleting that work.
  yield* sql`CREATE TABLE custom_workers_organization (
    thread_id TEXT PRIMARY KEY, owner_id TEXT, source_id TEXT,
    plan_json TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'creating', error TEXT, notify INTEGER NOT NULL DEFAULT 1,
    read_seq INTEGER NOT NULL DEFAULT 0, read_offset INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO custom_workers_organization SELECT * FROM custom_workers`;
  yield* sql`DROP TABLE custom_workers`;
  yield* sql`ALTER TABLE custom_workers_organization RENAME TO custom_workers`;
  yield* sql`CREATE INDEX custom_workers_owner ON custom_workers(owner_id)`;
  yield* sql`CREATE INDEX custom_worker_jobs_worker_kind ON custom_worker_jobs(worker_id, kind)`;
  // Idempotent receipts and an outbox, not a second relationship store.
  yield* sql`CREATE TABLE custom_session_ownership_changes (
    id TEXT PRIMARY KEY, request_json TEXT NOT NULL, result_json TEXT NOT NULL,
    announced INTEGER NOT NULL DEFAULT 0
  )`;
});
