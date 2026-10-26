import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Inventory must not traverse ordinary tool/output history on every peer request.
  // Keep this predicate aligned with the inventory query's explicit kind filter.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_quota_evidence
    ON projection_thread_activities(kind, thread_id, created_at)
    WHERE kind IN ('account.quota-state', 'runtime.error', 'runtime.warning')
  `;
});
