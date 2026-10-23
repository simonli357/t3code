import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("061_SessionOrganization", (it) => {
  it.effect(
    "retains existing plans, read cursors, notifications and durable work when releasing ownership",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        yield* sql`INSERT INTO custom_workers VALUES ('worker', 'master', 'source', '{"existing":true}', 42, 'ready', NULL, 0, 50, 7)`;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
      VALUES ('pending', 'worker', 'worker', 'work', 'continue', '2026-10-23')`;
        const workers = yield* sql`SELECT * FROM custom_workers`;
        const jobs = yield* sql`SELECT * FROM custom_worker_jobs`;
        yield* runMigrations();
        expect(yield* sql`SELECT * FROM custom_workers`).toEqual(workers);
        expect(yield* sql`SELECT * FROM custom_worker_jobs`).toEqual(jobs);
        yield* sql`UPDATE custom_workers SET owner_id = NULL WHERE thread_id = 'worker'`;
        expect(yield* sql`SELECT * FROM custom_workers`).toEqual(
          workers.map((row) => ({ ...row, owner_id: null })),
        );
        expect(yield* sql`SELECT * FROM custom_worker_jobs`).toEqual(jobs);
        yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json) VALUES ('release', '{}', '{}')`;
        expect(yield* runMigrations()).toHaveLength(0);
        expect(yield* sql`SELECT announced FROM custom_session_ownership_changes`).toEqual([
          { announced: 0 },
        ]);
      }),
  );
});
