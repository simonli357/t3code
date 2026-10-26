import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Recommended-vs-chosen record for each worker creation, keyed by the worker thread. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worker_recommendations (
    thread_id TEXT PRIMARY KEY,
    intent TEXT NOT NULL,
    record_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
