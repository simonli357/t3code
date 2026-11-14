import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The installation that last ran this database: its host and the database's real path.
  // A server that finds another installation here is running a copy.
  yield* sql`CREATE TABLE custom_installation_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL,
    database_path TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  )`;
});
