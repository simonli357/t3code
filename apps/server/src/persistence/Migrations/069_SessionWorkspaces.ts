import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Reservations survive failed provisioning. Historical host incarnations stay
  // recorded when a native session moves back to this environment.
  yield* sql`CREATE TABLE session_workspaces (
    reservation_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    state TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    setup_complete INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX session_workspaces_active
    ON session_workspaces(thread_id) WHERE active = 1`;
});
