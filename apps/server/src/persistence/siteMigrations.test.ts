// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CUSTOM_BASELINE_DDL } from "./customBaselineSchema.ts";
import { verifyV1ImportCounts } from "./importReceipts.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import { CUSTOM_FORK_LEDGER } from "./siteMigrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const now = "2026-01-01T00:00:00.000Z";

// A database as the custom fork leaves it: upstream's V1 schema through 54, then its own 55-75.
const seedCustomFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  for (const statement of CUSTOM_BASELINE_DDL) yield* sql.unsafe(statement);
  yield* sql`ALTER TABLE projection_projects ADD COLUMN base_prompt TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN is_base TEXT NOT NULL DEFAULT 'false'`;
  for (const [id, name] of CUSTOM_FORK_LEDGER) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/tmp/project', '[]', ${now}, ${now})`;
  for (const thread of ["owner-a", "owner-b", "worker-1", "worker-2", "worker-3"]) {
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${thread}, 'project', ${thread}, '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now})`;
    for (const index of [0, 1, 2]) {
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`${thread}-${index}`}, ${thread}, ${index % 2 ? "assistant" : "user"}, ${`${thread} text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
    }
  }
  for (const [worker, owner] of [
    ["worker-1", "owner-a"],
    ["worker-2", "owner-a"],
    ["worker-3", "owner-b"],
  ] as const) {
    yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json) VALUES (${worker}, ${owner}, '{}')`;
    yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
      VALUES (${`job-${worker}`}, ${worker}, ${worker}, 'work', 'do it', ${now})`;
  }
  yield* sql`INSERT INTO custom_orchestrator_authority (thread_id) VALUES ('owner-a'), ('owner-b')`;
  yield* sql`INSERT INTO custom_session_moves (id, thread_id, target_thread_id, direction, peer_environment_id, input_json, created_at, updated_at)
    VALUES ('move-1', 'worker-1', 'worker-1-target', 'out', 'peer', '{}', ${now}, ${now})`;
  yield* sql`INSERT INTO session_workspaces (reservation_id, thread_id, binding_json, state, active)
    VALUES ('reservation-1', 'worker-1', '{}', 'ready', 1)`;
});

const makeDirectory = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-site-ledger-"));
const cleanup = (directory: string) =>
  Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

const read = <A>(path: string, use: (database: NodeSqlite.DatabaseSync) => A): A => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    return use(database);
  } finally {
    database.close();
  }
};
const rows = (path: string, sql: string) =>
  read(path, (database) => database.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>);
const ledger = (path: string) =>
  rows(
    path,
    "SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id",
  ).map((row) => `${row.id}:${row.name}`);
const tableNames = (path: string) =>
  rows(path, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
const upstreamLedger = migrationManifest.map(([id, name]) => `${id}:${name}`);

const withDatabase = <A, E>(path: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: path })), Effect.scoped);

const seeded = (
  directory: string,
  customize?: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>,
) => {
  const path = NodePath.join(directory, "statev2.sqlite");
  return withDatabase(
    path,
    Effect.gen(function* () {
      yield* seedCustomFork;
      if (customize) yield* customize(yield* SqlClient.SqlClient);
    }),
  ).pipe(Effect.as(path));
};

describe("custom fork ledger bootstrap", () => {
  it.effect("archives the custom ledger, runs upstream 55-72 and keeps custom rows", () => {
    const directory = makeDirectory();
    return Effect.gen(function* () {
      const path = yield* seeded(directory);
      const before = rows(path, "SELECT * FROM custom_workers ORDER BY thread_id");
      yield* withDatabase(path, runMigrations());
      assert.deepEqual(ledger(path), upstreamLedger);
      assert.deepEqual(
        rows(
          path,
          "SELECT migration_id AS id, name FROM site_migration_history_archive ORDER BY migration_id",
        ).map((row) => `${row.id}:${row.name}`),
        CUSTOM_FORK_LEDGER.map(([id, name]) => `${id}:${name}`),
      );
      assert.deepEqual(rows(path, "SELECT migration_id AS id, name FROM site_sql_migrations"), [
        { id: 1, name: "CustomBaseline" },
      ]);
      assert.deepEqual(rows(path, "SELECT * FROM custom_workers ORDER BY thread_id"), before);
      assert.equal(rows(path, "SELECT COUNT(*) AS count FROM custom_session_moves")[0]?.count, 1);
      assert.isTrue(tableNames(path).includes("orchestration_v2_projection_threads"));
      const receipt = JSON.parse(
        String(rows(path, "SELECT payload_json FROM site_import_receipts")[0]?.payload_json),
      );
      assert.equal(receipt.customCounts.custom_workers, 3);

      // Restarting changes nothing.
      const archive = rows(path, "SELECT * FROM site_migration_history_archive");
      const executed = yield* withDatabase(path, runMigrations());
      assert.deepEqual(executed, []);
      assert.deepEqual(rows(path, "SELECT * FROM site_migration_history_archive"), archive);
      assert.deepEqual(ledger(path), upstreamLedger);
    }).pipe(Effect.ensuring(cleanup(directory)));
  });

  const failsClosed = (
    name: string,
    customize: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError.SqlError>,
    message: RegExp,
  ) =>
    it.effect(`fails closed and leaves the database untouched: ${name}`, () => {
      const directory = makeDirectory();
      return Effect.gen(function* () {
        const path = yield* seeded(directory, customize);
        const before = { ledger: ledger(path), tables: tableNames(path) };
        const result = yield* Effect.result(withDatabase(path, runMigrations()));
        assert.isTrue(result._tag === "Failure");
        assert.match(String(result._tag === "Failure" ? result.failure : ""), message);
        assert.deepEqual({ ledger: ledger(path), tables: tableNames(path) }, before);
      }).pipe(Effect.ensuring(cleanup(directory)));
    });

  failsClosed(
    "custom ledger not fully migrated",
    (sql) => Effect.asVoid(sql`DELETE FROM effect_sql_migrations WHERE migration_id = 75`),
    /not fully migrated/,
  );
  failsClosed(
    "custom table missing a column",
    (sql) => Effect.asVoid(sql`ALTER TABLE custom_workers DROP COLUMN communication_anchor_at`),
    /custom schema baseline/,
  );
  failsClosed(
    "custom table missing",
    (sql) => Effect.asVoid(sql`DROP TABLE session_workspaces`),
    /missing table session_workspaces/,
  );
  failsClosed(
    "unknown ledger names",
    (sql) =>
      Effect.asVoid(
        sql`UPDATE effect_sql_migrations SET name = 'Elsewhere' WHERE migration_id = 55`,
      ),
    /would skip required schema migrations/,
  );

  it.effect("gives a fresh database the site ledger and custom tables", () => {
    const directory = makeDirectory();
    return Effect.gen(function* () {
      const path = NodePath.join(directory, "fresh.sqlite");
      yield* withDatabase(path, runMigrations());
      assert.deepEqual(ledger(path), upstreamLedger);
      assert.isTrue(tableNames(path).includes("custom_workers"));
      assert.deepEqual(rows(path, "SELECT migration_id AS id FROM site_sql_migrations"), [
        { id: 1 },
      ]);
      assert.isFalse(tableNames(path).includes("site_migration_history_archive"));
    }).pipe(Effect.ensuring(cleanup(directory)));
  });

  it.effect(
    "imports a custom V1 database through the server layers, unchanged and repeatably",
    () => {
      const directory = makeDirectory();
      const sourcePath = NodePath.join(directory, "state.sqlite");
      const destinationPath = NodePath.join(directory, "statev2.sqlite");
      return Effect.gen(function* () {
        yield* withDatabase(sourcePath, seedCustomFork);
        const original = NodeFS.readFileSync(sourcePath);
        const config = yield* ServerConfig.ServerConfig;
        const layerDatabase = SqlitePersistence.layerConfig.pipe(
          Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
        );
        const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(layerDatabase),
        );
        const layerImporter = LegacyV1ThreadImporter.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(layerStores, EventSink.layer.pipe(Layer.provide(layerStores))),
          ),
        );
        const importAll = Effect.gen(function* () {
          const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          yield* legacy.reconcileShells;
          yield* legacy.importPendingTranscripts;
          assert.equal(yield* legacy.pendingThreadCount, 0);
        }).pipe(Effect.provide(layerImporter));

        yield* importAll;
        assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
        assert.deepEqual(ledger(destinationPath), upstreamLedger);
        const checks = verifyV1ImportCounts({ sourcePath, destinationPath });
        assert.deepEqual(
          checks.filter((check) => !check.matches),
          [],
        );
        assert.equal(checks.find((check) => check.name === "threads")?.imported, 5);
        assert.equal(checks.find((check) => check.name === "messages")?.imported, 15);
        assert.equal(checks.find((check) => check.name === "custom_workers.owners")?.imported, 2);

        const receipts = NodeFS.readdirSync(NodePath.join(directory, "v2-import-receipts"));
        assert.equal(receipts.length, 1);
        const receipt = JSON.parse(
          NodeFS.readFileSync(NodePath.join(directory, "v2-import-receipts", receipts[0]!), "utf8"),
        );
        assert.equal(receipt.snapshot.ledger.length, 75);
        assert.equal(receipt.snapshot.tableCounts.custom_workers, 3);
        assert.match(receipt.snapshot.sha256, /^[0-9a-f]{64}$/);

        // A restart re-runs everything without duplicating events or receipts.
        const events = rows(
          destinationPath,
          "SELECT COUNT(*) AS count FROM orchestration_v2_events",
        );
        yield* importAll;
        assert.deepEqual(
          rows(destinationPath, "SELECT COUNT(*) AS count FROM orchestration_v2_events"),
          events,
        );
        assert.deepEqual(
          verifyV1ImportCounts({ sourcePath, destinationPath }).filter((check) => !check.matches),
          [],
        );
        assert.equal(NodeFS.readdirSync(NodePath.join(directory, "v2-import-receipts")).length, 1);
        assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.ensuring(cleanup(directory)),
      );
    },
  );
});
