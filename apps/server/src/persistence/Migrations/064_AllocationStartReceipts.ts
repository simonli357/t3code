import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE provider_allocation_start_rejections (
    assignment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, start_intent TEXT NOT NULL,
    owner_id TEXT NOT NULL, reason TEXT NOT NULL)`;
});
