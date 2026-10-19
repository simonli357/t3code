import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE custom_orchestrator_handoffs (
    thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', error TEXT,
    transferred_json TEXT NOT NULL DEFAULT '[]'
  )`;
});
