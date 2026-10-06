import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_workers (
    thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_id TEXT NOT NULL,
    plan_json TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'creating', error TEXT, notify INTEGER NOT NULL DEFAULT 1,
    read_seq INTEGER NOT NULL DEFAULT 0, read_offset INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX custom_workers_owner ON custom_workers(owner_id)`;
  yield* sql`CREATE TABLE custom_worker_jobs (
    id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, target_id TEXT NOT NULL,
    kind TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0,
    turn_id TEXT, error TEXT, reported INTEGER NOT NULL DEFAULT 0,
    dispatched_at TEXT
  )`;
  yield* sql`CREATE INDEX custom_worker_jobs_queue ON custom_worker_jobs(target_id, state)`;
});
