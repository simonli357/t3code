import { ThreadId, type ManagedSessionRef, type SessionOrganization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const reference = (id: string): ManagedSessionRef => {
  const match = /^peer:([^:]+):(.+)$/.exec(id);
  return {
    environmentId: match?.[1] ?? null,
    threadId: ThreadId.make(match?.[2] ?? id),
  };
};

/** One compact query for the shell batch, never peer calls or conversation reads. */
export const makeSessionOrganizationQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn(function* (threadIds: ReadonlyArray<ThreadId>) {
    const rows =
      threadIds.length === 0
        ? []
        : yield* sql<{
            thread_id: string;
            owner_id: string | null;
            environment_id: string | null;
            authority_environment_id: string | null;
            state: string;
            assignment_state: string | null;
            report_outcome: "done" | "blocked" | null;
            direct_input_at: string | null;
          }>`SELECT w.thread_id, w.owner_id, w.state,
    json_extract(w.plan_json, '$.environmentId') AS environment_id,
    json_extract(w.plan_json, '$.authorityEnvironmentId') AS authority_environment_id,
    (SELECT j.state FROM custom_worker_jobs j WHERE j.worker_id = w.thread_id AND j.kind = 'work' ORDER BY j.rowid DESC LIMIT 1) AS assignment_state,
    (SELECT j.kind FROM custom_worker_jobs j WHERE j.worker_id = w.thread_id AND j.kind IN ('done', 'blocked')
      AND j.rowid > COALESCE((SELECT k.rowid FROM custom_worker_jobs k WHERE k.worker_id = w.thread_id AND k.kind = 'work' ORDER BY k.rowid DESC LIMIT 1), 0)
      ORDER BY j.rowid DESC LIMIT 1) AS report_outcome,
    (SELECT CASE WHEN j.id LIKE 'direct:%' AND j.prompt != '' AND NOT EXISTS (SELECT 1 FROM projection_turns t WHERE t.thread_id = j.worker_id AND t.turn_id = j.turn_id AND t.pending_message_id LIKE 'worker-job:%') THEN j.created_at END FROM custom_worker_jobs j WHERE j.worker_id = w.thread_id AND j.kind = 'work' ORDER BY j.rowid DESC LIMIT 1) AS direct_input_at
    FROM custom_workers w WHERE ${sql.in("w.thread_id", threadIds)} OR ${sql.in("w.owner_id", threadIds)}`;
    const authorities =
      threadIds.length === 0
        ? []
        : yield* sql<{ thread_id: string; revision: number }>`
    SELECT thread_id, revision FROM custom_orchestrator_authority WHERE ${sql.in("thread_id", threadIds)}`;
    const result = new Map<ThreadId, SessionOrganization>(
      threadIds.map((id) => [
        id,
        {
          owner: null,
          workers: [],
          revision: 0,
          assignmentState: null,
          reportOutcome: null,
          directInputAt: null,
        },
      ]),
    );
    for (const authority of authorities) {
      const value = result.get(ThreadId.make(authority.thread_id));
      if (value)
        result.set(ThreadId.make(authority.thread_id), { ...value, revision: authority.revision });
    }
    for (const row of rows) {
      const id = ThreadId.make(row.thread_id);
      const value = result.get(id);
      if (value)
        result.set(id, {
          ...value,
          owner: row.owner_id === null ? null : reference(row.owner_id),
          authorityEnvironmentId: row.authority_environment_id,
          assignmentState: row.assignment_state,
          reportOutcome: row.report_outcome,
          directInputAt: row.direct_input_at,
        });
      if (row.owner_id === null) continue;
      const parentId = ThreadId.make(row.owner_id);
      const parent = result.get(parentId);
      if (parent)
        result.set(parentId, {
          ...parent,
          workers: [
            ...parent.workers,
            {
              environmentId: row.state === "remote" ? row.environment_id : null,
              threadId: id,
            },
          ],
        });
    }
    return result;
  });
});
