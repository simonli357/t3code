import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("056_FreshWorkers", (it) => {
  it.effect(
    "preserves existing ownership, plans, cursors and jobs while allowing no fork source",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`INSERT INTO custom_workers
        VALUES ('old', 'master', 'base', '{"legacy":true}', 42, 'ready', NULL, 0, 50, 7)`;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
        VALUES ('pending', 'old', 'old', 'work', 'continue', '2026-10-17')`;
        const workers = yield* sql`SELECT * FROM custom_workers`;
        const jobs = yield* sql`SELECT * FROM custom_worker_jobs`;
        yield* runMigrations({ toMigrationInclusive: 56 });
        expect(yield* sql`SELECT * FROM custom_workers`).toEqual(workers);
        expect(yield* sql`SELECT * FROM custom_worker_jobs`).toEqual(jobs);
        yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json)
        VALUES ('fresh', 'master', NULL, '{}')`;
        expect(yield* sql`SELECT source_id FROM custom_workers WHERE thread_id = 'fresh'`).toEqual([
          { source_id: null },
        ]);
        expect(yield* runMigrations({ toMigrationInclusive: 56 })).toHaveLength(0);
      }),
  );
});
