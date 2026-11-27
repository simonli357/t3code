import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

// WorkerControls issues these statements on the foreground connection.
const queries = {
  pendingReports: `SELECT j.* FROM custom_worker_jobs j
      JOIN custom_workers w ON w.thread_id = j.worker_id
      WHERE j.kind = 'done' AND j.state = 'queued' AND j.target_id NOT LIKE 'peer:%' AND w.notify = 1 AND w.owner_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM custom_session_moves m WHERE m.locked = 1
          AND (m.thread_id = j.worker_id OR m.thread_id = j.target_id))
        AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts r
          WHERE r.command_id = 'worker-report-visible:' || j.id AND r.status = 'accepted')
      ORDER BY j.rowid`,
  needsRecovery: `SELECT 1 FROM custom_worker_jobs WHERE state = 'queued' AND (kind = 'done' OR (target_id LIKE 'peer:%' AND kind NOT IN ('notice', 'blocked')) OR (kind IN ('notice', 'blocked') AND error IS NOT NULL) OR (kind = 'work' AND resume_when_clear = 1))
  UNION ALL SELECT 1 FROM custom_session_ownership_changes WHERE announced = 0
  UNION ALL SELECT 1 FROM custom_ownership_transactions WHERE state IN ('preparing', 'committed')
  UNION ALL SELECT 1 FROM custom_ownership_reservation LIMIT 1`,
  refreshJobs: `SELECT * FROM custom_worker_jobs
      WHERE kind = 'work' AND (state = 'submitted' OR (reported = 0 AND state IN ('completed', 'error', 'interrupted')
        AND worker_id IN (SELECT thread_id FROM custom_workers WHERE notify = 1)))
      ORDER BY rowid`,
  remoteWorkers: `SELECT w.* FROM custom_workers w WHERE w.state = 'remote' AND EXISTS (
        SELECT 1 FROM custom_worker_jobs j WHERE j.state = 'queued'
          AND ((j.worker_id = w.thread_id AND j.kind IN ('notice', 'done', 'blocked'))
            OR (j.id LIKE 'digest:%' AND instr(j.prompt, 'Worker: ' || w.thread_id || char(10)) > 0)))`,
};

it.effect("migration 79 indexes the four worker queue reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 78 });
    expect(yield* runMigrations({ toMigrationInclusive: 79 })).toEqual([
      [79, "WorkerJobStateIndex"],
    ]);
    for (const [name, query] of Object.entries(queries)) {
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
      expect(plan.map((row) => row.detail).join("\n"), name).toContain(
        "idx_worker_jobs_state_kind",
      );
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
