import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("058_WorkerCommunication", (it) => {
  it.effect(
    "retires existing predecessors and preserves queued work without granting confirmation",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
        yield* sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json, state)
        VALUES ('next', 'old', '{}', 'completed'), ('newest', 'next', '{}', 'completed'),
          ('incomplete', 'still-active', '{}', 'error')`;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
        VALUES ('legacy', 'worker', 'old', 'message', 'retained message', '2026-10-22')`;
        yield* runMigrations({ toMigrationInclusive: 58 });
        expect(
          yield* sql`SELECT thread_id, active, successor_id FROM custom_orchestrator_authority ORDER BY thread_id`,
        ).toEqual([
          { thread_id: "next", active: 0, successor_id: "newest" },
          { thread_id: "old", active: 0, successor_id: "next" },
        ]);
        expect(
          yield* sql`SELECT prompt, state, policy_json FROM custom_worker_jobs WHERE id = 'legacy'`,
        ).toEqual([{ prompt: "retained message", state: "queued", policy_json: null }]);
        expect(yield* sql`SELECT * FROM custom_session_message_confirmations`).toHaveLength(0);
        expect(yield* runMigrations({ toMigrationInclusive: 58 })).toHaveLength(0);
      }),
  );
});
