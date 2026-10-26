import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE model_selection_policies (version INTEGER PRIMARY KEY, policy_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE model_selection_decisions (assignment_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, decision_json TEXT NOT NULL)`;
});
