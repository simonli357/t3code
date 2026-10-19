import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_workers_fresh (
    thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_id TEXT,
    plan_json TEXT NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'creating', error TEXT, notify INTEGER NOT NULL DEFAULT 1,
    read_seq INTEGER NOT NULL DEFAULT 0, read_offset INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO custom_workers_fresh
    SELECT thread_id, owner_id, source_id, plan_json, baseline, state, error, notify,
      read_seq, read_offset FROM custom_workers ORDER BY rowid`;
  yield* sql`DROP TABLE custom_workers`;
  yield* sql`ALTER TABLE custom_workers_fresh RENAME TO custom_workers`;
  yield* sql`CREATE INDEX custom_workers_owner ON custom_workers(owner_id)`;
});
