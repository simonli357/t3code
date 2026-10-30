// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { CUSTOM_BASELINE_DDL } from "./customBaselineSchema.ts";

/**
 * Site migrations are this fork's own schema changes. They live in a ledger of their own so
 * they can never collide with the ids upstream hands out to `effect_sql_migrations`.
 */
const SITE_LEDGER_TABLE = "site_sql_migrations";
const SITE_ARCHIVE_TABLE = "site_migration_history_archive";
const SITE_RECEIPT_TABLE = "site_import_receipts";

/** The custom fork's own ids, which collide with upstream's 55-72 in `effect_sql_migrations`. */
export const CUSTOM_FORK_LEDGER: ReadonlyArray<readonly [id: number, name: string]> = [
  [55, "CustomWorkers"],
  [56, "FreshWorkers"],
  [57, "OrchestratorHandoffs"],
  [58, "WorkerCommunication"],
  [59, "RetirementWarning"],
  [60, "SessionMoves"],
  [61, "SessionOrganization"],
  [62, "OwnershipTransactions"],
  [63, "ProviderAllocation"],
  [64, "AllocationStartReceipts"],
  [65, "ModelSelection"],
  [66, "AllocationQuotaEvidenceIndex"],
  [67, "AllocationSessionEvidenceIndex"],
  [68, "BaseSessions"],
  [69, "SessionWorkspaces"],
  [70, "SessionRenewals"],
  [71, "WorkerCommunicationWindow"],
  [72, "WorkerRenewalIndexes"],
  [73, "WorkerRecommendations"],
  [74, "RemainingQueryIndexes"],
  [75, "UsageCapEnforcement"],
];

/** Custom columns on V1 tables upstream keeps, as added by the custom ledger 61 and 68. */
const CUSTOM_BASELINE_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
  readonly definition: string;
}> = [
  { table: "projection_projects", column: "base_prompt", definition: "TEXT" },
  { table: "projection_threads", column: "is_base", definition: "TEXT NOT NULL DEFAULT 'false'" },
];

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

const columnSignature = (column: ColumnInfo) =>
  `${column.name} ${column.type.toUpperCase()} notnull=${column.notnull} default=${column.dflt_value ?? "none"} pk=${column.pk}`;

// The expected shape comes from the baseline DDL itself, applied to a scratch database.
const expectedBaseline = () => {
  const scratch = new NodeSqlite.DatabaseSync(":memory:");
  try {
    for (const statement of CUSTOM_BASELINE_DDL) scratch.exec(statement);
    const tables = (
      scratch
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as unknown as ReadonlyArray<{ name: string }>
    ).map(({ name }) => ({
      name,
      columns: (
        scratch
          .prepare(`SELECT * FROM pragma_table_info(?)`)
          .all(name) as unknown as ReadonlyArray<ColumnInfo>
      ).map(columnSignature),
    }));
    const indexes = scratch
      .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`)
      .all() as unknown as ReadonlyArray<{ name: string; tbl_name: string }>;
    return { tables, indexes };
  } finally {
    scratch.close();
  }
};

/**
 * Compares the custom tables, their indexes and the custom columns on V1 tables with the ledger-75
 * baseline. Extra indexes are tolerated (hosts add hand-made ones); anything else must match.
 */
export const validateCustomSchema = Effect.fn("validateCustomSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const expected = expectedBaseline();
  const problems: Array<string> = [];
  for (const table of expected.tables) {
    const actual = yield* sql<ColumnInfo>`SELECT * FROM pragma_table_info(${table.name})`;
    if (actual.length === 0) {
      problems.push(`missing table ${table.name}`);
      continue;
    }
    const actualSignatures = actual.map(columnSignature);
    for (const signature of table.columns) {
      if (!actualSignatures.includes(signature)) {
        problems.push(`${table.name}: missing or different column (${signature})`);
      }
    }
    for (const signature of actualSignatures) {
      if (!table.columns.includes(signature)) {
        problems.push(`${table.name}: unexpected column (${signature})`);
      }
    }
  }
  const actualIndexes = yield* sql<{ readonly name: string; readonly tbl_name: string }>`
    SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'
  `;
  for (const index of expected.indexes) {
    if (!actualIndexes.some((row) => row.name === index.name && row.tbl_name === index.tbl_name)) {
      problems.push(`missing index ${index.name} on ${index.tbl_name}`);
    }
  }
  for (const { table, column } of CUSTOM_BASELINE_COLUMNS) {
    const columns = yield* sql<ColumnInfo>`SELECT * FROM pragma_table_info(${table})`;
    if (columns.length > 0 && !columns.some((row) => row.name === column)) {
      problems.push(`${table}: missing custom column ${column}`);
    }
  }
  return problems;
});

const countCustomTables = Effect.fn("countCustomTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const counts: Record<string, number> = {};
  for (const { name } of expectedBaseline().tables) {
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(name)}`;
    counts[name] = rows[0]?.count ?? 0;
  }
  return counts;
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const badState = (message: string) => new Migrator.MigrationError({ kind: "BadState", message });

/** True for a ledger written by the custom fork: every id from 55 up carries a custom name. */
export const hasCustomForkLedger = Effect.fn("hasCustomForkLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return false;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55
  `;
  return (
    rows.length > 0 &&
    rows.every((row) =>
      CUSTOM_FORK_LEDGER.some(([id, name]) => id === row.migration_id && name === row.name),
    )
  );
});

/**
 * Turns a custom-fork ledger into one upstream can continue: archives ids 55-75 and removes them
 * from `effect_sql_migrations`, so the migrator runs upstream's 55-72 next. The custom tables are
 * untouched and keep their rows. Run inside the caller's transaction so a rejection or a failed
 * upstream migration leaves the database exactly as found.
 */
export const archiveCustomForkLedger = Effect.fn("archiveCustomForkLedger")(function* (
  upstreamLedger: ReadonlyArray<readonly [id: number, name: string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
  const missingCustom = CUSTOM_FORK_LEDGER.filter(
    ([id]) => !rows.some((row) => row.migration_id === id),
  ).map(([id, name]) => `${id}_${name}`);
  if (missingCustom.length > 0) {
    return yield* badState(
      `This database comes from the custom fork but is not fully migrated (missing ${missingCustom.join(", ")}). Start the custom build until it is, then retry.`,
    );
  }
  const baseMismatches = upstreamLedger
    .filter(([id]) => id < 55)
    .filter(([id, name]) => !rows.some((row) => row.migration_id === id && row.name === name))
    .map(([id, name]) => `${id}_${name}`);
  if (baseMismatches.length > 0) {
    return yield* badState(
      `This custom-fork database does not carry upstream's migrations 1-54 (${baseMismatches.join(", ")}).`,
    );
  }
  const problems = yield* validateCustomSchema();
  if (problems.length > 0) {
    return yield* badState(
      `This custom-fork database does not match the custom schema baseline: ${problems.join("; ")}.`,
    );
  }
  const customCounts = yield* countCustomTables();
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(SITE_ARCHIVE_TABLE)} (
      source_ledger TEXT NOT NULL,
      migration_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT,
      archived_at TEXT NOT NULL,
      PRIMARY KEY (source_ledger, migration_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(SITE_RECEIPT_TABLE)} (
      receipt_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  const archivedAt = DateTime.formatIso(yield* DateTime.now);
  const archived = rows.filter((row) => row.migration_id >= 55);
  for (const row of archived) {
    yield* sql`
      INSERT OR IGNORE INTO ${sql(SITE_ARCHIVE_TABLE)}
        (source_ledger, migration_id, name, created_at, archived_at)
      VALUES ('custom-fork', ${row.migration_id}, ${row.name}, ${row.created_at}, ${archivedAt})
    `;
  }
  yield* sql`
    INSERT OR IGNORE INTO ${sql(SITE_RECEIPT_TABLE)} (receipt_id, payload_json, created_at)
    VALUES (
      'custom-ledger-archived',
      ${encodeJson({ archivedMigrationIds: archived.map((row) => row.migration_id), customCounts })},
      ${archivedAt}
    )
  `;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 55`;
  yield* Effect.log("Archived the custom fork's migration ledger").pipe(
    Effect.annotateLogs({ archived: archived.length }),
  );
});

/** Ensures the custom tables exist, as they do on a database imported from the custom fork. */
const customBaseline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of CUSTOM_BASELINE_DDL) yield* sql.unsafe(statement);
  for (const { table, column, definition } of CUSTOM_BASELINE_COLUMNS) {
    const columns = yield* sql<ColumnInfo>`SELECT * FROM pragma_table_info(${table})`;
    if (columns.length > 0 && !columns.some((row) => row.name === column)) {
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
});

const siteMigrationEntries = [[1, "CustomBaseline", customBaseline]] as const;

const runSite = Migrator.make({});

export const runSiteMigrations = Effect.fn("runSiteMigrations")(function* () {
  return yield* runSite({
    table: SITE_LEDGER_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        siteMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
});
