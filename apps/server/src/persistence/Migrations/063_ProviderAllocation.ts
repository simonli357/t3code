import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE provider_allocation_policy (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, policy_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE provider_allocation_reservations (
    id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    state TEXT NOT NULL, expires_at TEXT NOT NULL, reservation_json TEXT NOT NULL)`;
  yield* sql`CREATE UNIQUE INDEX provider_allocation_active_thread ON provider_allocation_reservations(environment_id, thread_id) WHERE state IN ('reserved', 'starting', 'consumed')`;
  yield* sql`CREATE TABLE provider_allocation_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
    decision_json TEXT NOT NULL, replay_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE provider_allocation_failed_starts (
    assignment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL)`;
});
