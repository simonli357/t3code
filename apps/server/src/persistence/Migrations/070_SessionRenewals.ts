import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_session_renewals (
    thread_id TEXT PRIMARY KEY,
    warned INTEGER NOT NULL DEFAULT 0,
    successor_id TEXT,
    checkpoint_id TEXT,
    state TEXT NOT NULL DEFAULT 'watching',
    error TEXT
  )`;
});
