import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN is_base TEXT NOT NULL DEFAULT 'false'`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN base_prompt TEXT`;
  yield* sql`CREATE TABLE base_session_creations (request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, prompt TEXT NOT NULL)`;
  yield* sql`CREATE TABLE base_session_submissions (
    request_id TEXT PRIMARY KEY, input_json TEXT NOT NULL,
    source_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    command_json TEXT, state TEXT NOT NULL DEFAULT 'preparing', error TEXT
  )`;
});
