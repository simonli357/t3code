import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  renewalIntentSql,
  renewalToolWaitsSql,
  workerWakeIntentSql,
} from "./WorkerRenewalQueries.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("renewal history queries", (it) => {
  it.effect("upgrades schema 71 and seeks relevant history through large unrelated history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
        event_type, command_id, occurred_at, actor_kind, payload_json, metadata_json) VALUES
        ('stop', 'thread', 'worker', 1, 'thread.turn-interrupt-requested', NULL, '2026-10-01', 'user', '{}', '{}')`;
      // Put both another thread's traffic and this thread's ordinary traffic
      // after its last intent; an absent intent is the worst case for a scan.
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<100001)
        INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
          event_type, command_id, occurred_at, actor_kind, payload_json, metadata_json)
        SELECT 'noise:'||i, 'thread', CASE WHEN i%2=0 THEN 'worker' ELSE 'other' END, i,
          CASE WHEN i%3=0 THEN 'thread.turn-start-requested' ELSE 'thread.message-sent' END,
          CASE WHEN i%2=0 THEN 'renewal:'||i ELSE 'worker-job:'||i END,
          '2026-10-01', 'server', '{}', '{}' FROM n`;
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES ('worker', 'turn', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00.000Z', '[]')`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at) VALUES
        ('start', 'worker', 'turn', 'tool', 'tool.started', '', '{"toolCallId":"call"}', '2026-10-01T00:00:00.000Z'),
        ('end', 'worker', 'turn', 'tool', 'tool.completed', '', '{"toolCallId":"call"}', '2026-10-01T00:30:00.000Z'),
        ('open', 'worker', 'turn', 'tool', 'tool.started', '', '{"toolCallId":"open"}', '2026-10-01T01:00:00.000Z')`;
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
        INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
        SELECT 'noise:'||i, 'worker', 'turn', 'info', 'provider.activity', '', '{}', '2026-10-01' FROM n`;
      expect(yield* runMigrations()).toEqual([[72, "WorkerRenewalIndexes"]]);
      expect(yield* runMigrations()).toEqual([]);
      for (const [query, index] of [
        [renewalIntentSql, "idx_worker_renewal_intent"],
        [workerWakeIntentSql, "idx_worker_wake_intent"],
        [renewalToolWaitsSql, "idx_worker_renewal_tool_wait"],
      ] as const) {
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, [
          "worker",
        ]);
        expect(
          plan.some((row) => row.detail.includes(index) && row.detail.includes("SEARCH")),
        ).toBe(true);
        expect(plan.some((row) => /SCAN |USE TEMP B-TREE/.test(row.detail))).toBe(false);
        expect(yield* sql.unsafe(query, ["absent"])).toEqual([]);
      }
      expect(yield* sql.unsafe(renewalIntentSql, ["worker"])).toEqual([
        { event_type: "thread.turn-interrupt-requested" },
      ]);
      // Unlike automatic renewal, manual handoff/wake intent includes the
      // latest renewal checkpoint. Worker-job starts remain excluded.
      expect(yield* sql.unsafe(workerWakeIntentSql, ["worker"])).toEqual([
        { event_type: "thread.turn-start-requested" },
      ]);
      expect(yield* sql.unsafe(renewalToolWaitsSql, ["worker"])).toEqual([
        { start: "2026-10-01T00:00:00.000Z", end: "2026-10-01T00:30:00.000Z" },
        { start: "2026-10-01T01:00:00.000Z", end: "2026-10-01T02:00:00.000Z" },
      ]);
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
        event_type, command_id, occurred_at, actor_kind, payload_json, metadata_json) VALUES
        ('resume', 'thread', 'worker', 100002, 'thread.turn-start-requested', 'human:resume', '2026-10-02', 'user', '{}', '{}')`;
      expect(yield* sql.unsafe(renewalIntentSql, ["worker"])).toEqual([
        { event_type: "thread.turn-start-requested" },
      ]);
    }),
  );
});
