import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Existing V2 grants stay literal. Only migration 55 records V1 provenance.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS imported_v1_auth_grants (
    session_id TEXT PRIMARY KEY,
    scopes TEXT NOT NULL,
    issued_at TEXT NOT NULL
  )`;
});
