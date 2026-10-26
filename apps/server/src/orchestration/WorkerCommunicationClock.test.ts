import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  pendingDeliverySql,
  refreshCommunicationClock,
  undeliveredStartsSql,
} from "./WorkerCommunicationClock.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("worker delivery query", (it) => {
  it.effect(
    "seeks only unresolved assignments and first delivery with large unrelated history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, communication_anchor_at)
        VALUES ('worker', 'master', '{}', '2026-10-25T12:00:00.000Z')`;
        // Same worker's old assignments must not amplify the event lookup either.
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, communication_delivered_at)
        SELECT 'old:'||i, 'worker', 'worker', 'work', '', '2020-01-01', 'completed', '2020-01-01' FROM n`;
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        SELECT 'worker', 'old:'||i, 'old-message:'||i, 'completed', '2020-01-01', '[]' FROM n`;
        yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json)
        SELECT 'noise:'||i, 'thread', 'worker', i, 'thread.message-sent', '2026-10-25T12:00:00.000Z', 'server', '{}', '{}' FROM n`;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state)
        VALUES ('assignment', 'worker', 'worker', 'work', '', '2026-10-25T12:00:00.000Z', 'submitted')`;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES ('worker', 'active', 'worker-job:assignment', 'running', '2026-10-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z', '[]')`;
        expect(yield* sql.unsafe(pendingDeliverySql, ["worker"])).toHaveLength(1);
        yield* refreshCommunicationClock(sql, "worker");
        // A projection placeholder is not proof of actual provider delivery.
        expect(yield* sql.unsafe(pendingDeliverySql, ["worker"])).toHaveLength(1);
        yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json) VALUES
        ('start', 'thread', 'worker', 100001, 'thread.session-set', '2026-10-25T14:00:00.000Z', 'server',
          '{"session":{"status":"running","activeTurnId":"active"}}', '{}'),
        ('heartbeat', 'thread', 'worker', 100002, 'thread.session-set', '2026-10-25T14:05:00.000Z', 'server',
          '{"session":{"status":"running","activeTurnId":"active"}}', '{}')`;
        for (const query of [undeliveredStartsSql, pendingDeliverySql]) {
          const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, [
            "worker",
          ]);
          expect(
            plan.some((row) => /SEARCH .*custom_worker_jobs_undelivered/.test(row.detail)),
          ).toBe(true);
          expect(plan.some((row) => /SCAN |USE TEMP B-TREE/.test(row.detail))).toBe(false);
          if (query === undeliveredStartsSql) {
            expect(plan.some((row) => row.detail.includes("idx_worker_first_running_event"))).toBe(
              true,
            );
            expect(
              plan.some((row) => row.detail.includes("idx_projection_turns_pending_message")),
            ).toBe(true);
          }
        }
        expect(yield* sql.unsafe(undeliveredStartsSql, ["worker"])).toEqual([
          { id: "assignment", delivered_at: "2026-10-25T14:00:00.000Z" },
        ]);
        yield* refreshCommunicationClock(sql, "worker");
        expect(yield* sql.unsafe(undeliveredStartsSql, ["worker"])).toEqual([]);
        expect(yield* sql.unsafe(pendingDeliverySql, ["worker"])).toEqual([]);
        // Repeated reconciliation/restart cannot discover a later heartbeat and reset.
        yield* refreshCommunicationClock(sql, "worker");
        expect(
          (yield* sql`SELECT communication_anchor_at FROM custom_workers`)[0]
            ?.communication_anchor_at,
        ).toBe("2026-10-25T14:00:00.000Z");
        expect(
          (yield* sql`SELECT communication_delivered_at FROM custom_worker_jobs WHERE id='assignment'`)[0]
            ?.communication_delivered_at,
        ).toBe("2026-10-25T14:00:00.000Z");
      }),
  );
});
