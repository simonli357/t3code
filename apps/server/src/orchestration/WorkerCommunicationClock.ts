import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Only unresolved active assignments participate. The turn and event lookups are exact
// indexed seeks; the partial event index seeks the first running event for that
// turn, never ordinary event history. Kept as one statement so plan regressions
// exercise the production query, including the outer candidate selection.
// Pin the partial candidate index: older SQLite planners otherwise prefer the
// worker/kind index and visit all historical jobs even with these predicates.
export const undeliveredStartsSql = `SELECT j.id, (
  SELECT e.occurred_at FROM orchestration_events e INDEXED BY idx_worker_first_running_event
  WHERE e.stream_id = j.target_id AND e.event_type = 'thread.session-set'
    AND json_extract(e.payload_json, '$.session.status') = 'running'
    AND json_extract(e.payload_json, '$.session.activeTurnId') = COALESCE(
      j.turn_id,
      (SELECT t.turn_id FROM projection_turns t
       WHERE t.thread_id = j.target_id AND t.pending_message_id = 'worker-job:' || j.id
       ORDER BY t.row_id DESC LIMIT 1))
  ORDER BY e.sequence LIMIT 1
) AS delivered_at FROM custom_worker_jobs j INDEXED BY custom_worker_jobs_undelivered
WHERE j.worker_id = ? AND j.kind = 'work' AND j.communication_delivered_at IS NULL
  AND j.state IN ('queued', 'submitted') AND j.id NOT LIKE 'direct:%'`;

export const pendingDeliverySql = `SELECT 1 FROM custom_worker_jobs INDEXED BY custom_worker_jobs_undelivered
WHERE worker_id = ? AND kind = 'work' AND communication_delivered_at IS NULL
  AND state IN ('queued', 'submitted') AND id NOT LIKE 'direct:%' LIMIT 1`;

// Event-driven reconciliation calls this before settling jobs. Routing also
// recovers an event committed just before shutdown. A delivery is recorded once,
// so historical jobs leave the lookup permanently, even after restart or move.
export const refreshCommunicationClock = Effect.fn("refreshCommunicationClock")(
  function* (sql: SqlClient.SqlClient, workerId: string) {
    const starts = yield* sql.unsafe<{ id: string; delivered_at: string | null }>(
      undeliveredStartsSql,
      [workerId],
    );
    for (const start of starts) {
      if (start.delivered_at === null) continue;
      const accepted = yield* sql`UPDATE custom_worker_jobs
        SET communication_delivered_at = ${start.delivered_at}
        WHERE id = ${start.id} AND communication_delivered_at IS NULL RETURNING id`;
      if (accepted.length)
        yield* sql`UPDATE custom_workers SET communication_anchor_at =
          MAX(COALESCE(communication_anchor_at, ''), ${start.delivered_at})
          WHERE thread_id = ${workerId}`;
    }
  },
  (effect, sql) => sql.withTransaction(effect),
);
