import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "indexes historical session lookup through custom41 upgrade without changing event bytes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
    VALUES ('binding','thread','thread',1,'thread.session-set','2026-10-23','provider','{"session":{"providerInstanceId":"old"}}','{}'),
           ('ordinary','thread','thread',2,'thread.activity-appended','2026-10-24','provider','not JSON','{}')`;
      const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      expect(yield* runMigrations()).toEqual([[67, "AllocationSessionEvidenceIndex"]]);
      expect(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`).toEqual(before);
      expect(yield* runMigrations()).toEqual([]);
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND event_type='thread.session-set' AND stream_id='thread' AND occurred_at<='2026-10-24' ORDER BY occurred_at DESC,sequence DESC LIMIT 1`;
      expect(plan.some((p) => p.detail.includes("idx_orch_events_allocation_session"))).toBe(true);
      const turnPlan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT payload_json FROM orchestration_events WHERE aggregate_kind='thread' AND event_type='thread.session-set' AND stream_id='thread' AND json_extract(payload_json, '$.session.activeTurnId')='turn' AND occurred_at<='2026-10-24' ORDER BY occurred_at DESC,sequence DESC LIMIT 1`;
      expect(
        turnPlan.some((p) => p.detail.includes("idx_orch_events_allocation_turn_session")),
      ).toBe(true);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
