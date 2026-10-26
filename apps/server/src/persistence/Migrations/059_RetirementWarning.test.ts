import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("059_RetirementWarning", (it) => {
  it.effect("preserves handoffs and durably records the one-time warning", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* sql`INSERT INTO custom_orchestrator_authority
        (thread_id, active, successor_id, retired_sequence, revision)
        VALUES ('old', 0, 'next', 123, 2)`;
      yield* runMigrations();
      expect(yield* sql`SELECT * FROM custom_orchestrator_authority`).toEqual([
        {
          thread_id: "old",
          active: 0,
          successor_id: "next",
          retired_sequence: 123,
          revision: 2,
          retirement_warned: 0,
        },
      ]);
      yield* sql`UPDATE custom_orchestrator_authority SET retirement_warned = 1 WHERE thread_id = 'old'`;
      expect(yield* runMigrations()).toHaveLength(0);
      expect(yield* sql`SELECT retirement_warned FROM custom_orchestrator_authority`).toEqual([
        { retirement_warned: 1 },
      ]);
    }),
  );
});
