import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Recovery, report batching and refresh must seek by state without a target ID.
  yield* sql`CREATE INDEX idx_worker_jobs_state_kind ON custom_worker_jobs(state, kind, reported)`;
});
