import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_native_conversation_forks (
    target_thread_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    source_fingerprint TEXT NOT NULL,
    result_json TEXT
  )`;
});
