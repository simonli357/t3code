import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A queued assignment that waits for a provider usage reset is not dispatched before this time,
  // unless the exhaustion it waits on was visible in quota readings or caps and has cleared.
  yield* sql`ALTER TABLE custom_worker_jobs ADD COLUMN resume_at TEXT`;
  yield* sql`ALTER TABLE custom_worker_jobs ADD COLUMN resume_when_clear INTEGER NOT NULL DEFAULT 0`;
});
