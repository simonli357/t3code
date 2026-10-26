import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "upgrades populated custom39 history without changing rows and indexes later receipts",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('ordinary', 'thread', 'info', 'tool.completed', '', 'not JSON', '2026-10-23'),
             ('quota', 'thread', 'info', 'account.quota-state', '', '{"quotaStates":[]}', '2026-10-23'),
             ('warning', 'thread', 'info', 'runtime.warning', '', '{}', '2026-10-23')`;
      const before = yield* sql`SELECT rowid, * FROM projection_thread_activities ORDER BY rowid`;
      expect(yield* runMigrations({ toMigrationInclusive: 66 })).toEqual([
        [66, "AllocationQuotaEvidenceIndex"],
      ]);
      expect(yield* sql`SELECT rowid, * FROM projection_thread_activities ORDER BY rowid`).toEqual(
        before,
      );
      expect(yield* runMigrations({ toMigrationInclusive: 66 })).toEqual([]);
      const indexed = () => sql<{
        activity_id: string;
      }>`SELECT activity_id FROM projection_thread_activities
      INDEXED BY idx_projection_thread_activities_quota_evidence
      WHERE kind IN ('account.quota-state', 'runtime.error', 'runtime.warning') ORDER BY rowid`;
      expect((yield* indexed()).map((r) => r.activity_id)).toEqual(["quota", "warning"]);
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('later', 'thread', 'error', 'runtime.error', '', '{}', '2026-10-24')`;
      yield* sql`UPDATE projection_thread_activities SET kind = 'tool.completed' WHERE activity_id = 'warning'`;
      yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = 'quota'`;
      expect((yield* indexed()).map((r) => r.activity_id)).toEqual(["later"]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
