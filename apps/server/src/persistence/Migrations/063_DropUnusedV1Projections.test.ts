import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("063_DropUnusedV1Projections", (it) => {
  it.effect("retains complete V1 history for lazy import and recovery", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01', '2026-01-01')
      `;

      yield* runMigrations({ toMigrationInclusive: 63 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tables = new Set(rows.map((row) => row.name));
      for (const retained of [
        "projection_thread_activities",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_state",
        "checkpoint_diff_blobs",
      ]) {
        assert.isTrue(tables.has(retained), retained);
      }
      for (const kept of [
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_pull_requests",
      ]) {
        assert.isTrue(tables.has(kept), kept);
      }
      assert.deepEqual(yield* sql`SELECT message_id FROM projection_thread_messages`, [
        { message_id: "message-1" },
      ]);
    }),
  );
});
