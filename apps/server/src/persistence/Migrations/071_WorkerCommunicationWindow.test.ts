import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "071_WorkerCommunicationWindow",
  (it) => {
    it.effect(
      "backfills the existing assignment clock, preserving history and idempotent migration",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 70 });
          yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json) VALUES ('worker', 'master', '{}')`;
          yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, dispatched_at)
      VALUES ('old', 'worker', 'worker', 'work', 'old assignment', '2026-10-24T12:00:00.000Z', '2026-10-24T13:00:00.000Z'),
        ('new', 'worker', 'worker', 'work', 'new assignment', '2026-10-25T12:00:00.000Z', NULL),
        ('done', 'worker', 'master', 'done', 'historical completion', '2026-10-25T12:30:00.000Z', NULL)`;
          yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json)
            VALUES ('delivered', 'master', '{}'), ('waiting', 'master', '{}')`;
          yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, turn_id)
            VALUES ('actual', 'delivered', 'delivered', 'work', '', '2026-10-25T12:00:00.000Z', 'completed', 'actual-turn'),
              ('placeholder', 'waiting', 'waiting', 'work', '', '2026-10-25T12:00:00.000Z', 'submitted', NULL)`;
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
            VALUES ('delivered', 'actual-turn', 'worker-job:actual', 'completed', '2026-10-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z', '[]'),
              ('waiting', NULL, 'worker-job:placeholder', 'pending', '2026-10-25T12:00:00.000Z', '2026-10-25T12:00:00.000Z', '[]')`;
          yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, actor_kind, payload_json, metadata_json) VALUES
            ('first', 'thread', 'delivered', 1, 'thread.session-set', '2026-10-25T14:00:00.000Z', 'server',
              '{"session":{"status":"running","activeTurnId":"actual-turn"}}', '{}'),
            ('later', 'thread', 'delivered', 2, 'thread.session-set', '2026-10-25T14:10:00.000Z', 'server',
              '{"session":{"status":"running","activeTurnId":"actual-turn"}}', '{}')`;
          yield* runMigrations({ toMigrationInclusive: 71 });
          expect(
            (yield* sql`SELECT communication_anchor_at FROM custom_workers WHERE thread_id='delivered'`)[0]
              ?.communication_anchor_at,
          ).toBe("2026-10-25T14:00:00.000Z");
          expect(
            (yield* sql`SELECT communication_delivered_at FROM custom_worker_jobs WHERE id='actual'`)[0]
              ?.communication_delivered_at,
          ).toBe("2026-10-25T14:00:00.000Z");
          expect(
            (yield* sql`SELECT communication_delivered_at FROM custom_worker_jobs WHERE id='placeholder'`)[0]
              ?.communication_delivered_at,
          ).toBeNull();
          expect(
            (yield* sql`SELECT communication_anchor_at FROM custom_workers WHERE thread_id = 'worker'`)[0]!
              .communication_anchor_at,
          ).toBe("2026-10-25T12:00:00.000Z");
          expect(yield* sql`SELECT * FROM custom_worker_jobs`).toHaveLength(5);
          expect(yield* runMigrations({ toMigrationInclusive: 71 })).toHaveLength(0);
        }),
    );
  },
);
