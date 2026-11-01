import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.effect("records pre-V2 grants without changing them or marking later V2 grants", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES ('v1-client', 'one-time-token', '["orchestration:operate"]',
        'browser-session-cookie', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`;
    yield* runMigrations({ toMigrationInclusive: 72 });
    const grants = yield* sql`SELECT * FROM imported_v1_auth_grants`;
    assert.deepStrictEqual(grants, [
      {
        session_id: "v1-client",
        scopes: '["orchestration:operate"]',
        issued_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const sessions = yield* sql`SELECT scopes FROM auth_sessions`;
    assert.deepStrictEqual(sessions, [{ scopes: '["orchestration:operate"]' }]);
    // Simulate a V2 database imported by the older build, which had no provenance table.
    yield* sql`DROP TABLE imported_v1_auth_grants`;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT * FROM imported_v1_auth_grants`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
