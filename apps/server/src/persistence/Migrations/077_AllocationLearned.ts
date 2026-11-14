import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The coordinator's learned numbers: cost per working hour and each limit's share per dollar.
  yield* sql`CREATE TABLE IF NOT EXISTS allocation_learned (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    learned_at TEXT NOT NULL,
    learned_json TEXT NOT NULL
  )`;
  // Every other computer's last copy of the coordinator's policies and learned numbers, so a
  // start that cannot reach the coordinator decides with them instead of built-in defaults.
  yield* sql`CREATE TABLE IF NOT EXISTS allocation_policy_copy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    coordinator_environment_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    copy_json TEXT NOT NULL
  )`;
});
