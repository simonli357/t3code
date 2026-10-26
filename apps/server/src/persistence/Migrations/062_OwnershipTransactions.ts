import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE custom_orchestrator_handoffs ADD COLUMN ownership_started INTEGER NOT NULL DEFAULT 0`;
  // Decisions and reservations only. custom_workers remains the relationship authority.
  yield* sql`CREATE TABLE custom_ownership_transactions (
    id TEXT PRIMARY KEY, request_json TEXT NOT NULL, state TEXT NOT NULL,
    participants_json TEXT NOT NULL DEFAULT '[]', patch_json TEXT, result_json TEXT, error TEXT
  )`;
  // A short topology reservation per environment serializes intersecting ancestry
  // walks with moves/renewals. There is no clock-based expiry of an uncertain commit.
  yield* sql`CREATE TABLE custom_ownership_reservation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL, coordinator TEXT NOT NULL
  )`;
});
