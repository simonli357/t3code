// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

export interface DatabaseDescription {
  readonly sizeBytes: number;
  readonly sha256: string;
  /** `effect_sql_migrations` as `id:name`, in id order. */
  readonly ledger: ReadonlyArray<string>;
  readonly tableCounts: Readonly<Record<string, number>>;
}

export interface V1ImportReceipt {
  readonly kind: "v1-import-snapshot";
  readonly createdAt: string;
  readonly source: {
    readonly path: string;
    readonly sizeBytes: number;
    readonly modifiedAt: string;
    readonly walBytes: number;
  };
  /** A consistent copy taken with SQLite's backup API; the V2 database starts as this file. */
  readonly snapshot: DatabaseDescription;
  readonly destinationPath: string;
  /** V2 never writes to the V1 file, so the file at `source.path` is the rollback point. */
  readonly recovery: string;
}

const sha256File = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    NodeFS.createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });

/** Table counts and migration history, read straight from the file without modifying it. */
const describeDatabaseContents = (path: string) => {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const tableCounts: Record<string, number> = {};
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ name: string }>;
    for (const { name } of tables) {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {
        count: number;
      };
      tableCounts[name] = row.count;
    }
    const ledger = tables.some((table) => table.name === "effect_sql_migrations")
      ? (
          database
            .prepare(`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`)
            .all() as unknown as ReadonlyArray<{ migration_id: number; name: string }>
        ).map((row) => `${row.migration_id}:${row.name}`)
      : [];
    return { ledger, tableCounts };
  } finally {
    database.close();
  }
};

export const describeDatabase = async (path: string): Promise<DatabaseDescription> => ({
  sizeBytes: NodeFS.statSync(path).size,
  sha256: await sha256File(path),
  ...describeDatabaseContents(path),
});

const sizeOrZero = (path: string) => {
  try {
    return NodeFS.statSync(path).size;
  } catch {
    return 0;
  }
};

export const makeV1ImportReceipt = async (input: {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly destinationPath: string;
  readonly createdAt: string;
}): Promise<V1ImportReceipt> => {
  const stat = NodeFS.statSync(input.sourcePath);
  return {
    kind: "v1-import-snapshot",
    createdAt: input.createdAt,
    source: {
      path: input.sourcePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      walBytes: sizeOrZero(`${input.sourcePath}-wal`),
    },
    snapshot: await describeDatabase(input.snapshotPath),
    destinationPath: input.destinationPath,
    recovery: `Start the build that wrote ${input.sourcePath}; the V2 import never modifies it.`,
  };
};

export interface ImportCountCheck {
  readonly name: string;
  readonly source: number;
  readonly imported: number;
  readonly matches: boolean;
}

/**
 * Compares what a V1 database held with what its V2 copy now serves. Run it after the legacy
 * importer drains: threads and messages are imported lazily, so earlier counts lag behind.
 */
export const verifyV1ImportCounts = (input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
}): ReadonlyArray<ImportCountCheck> => {
  const read = (path: string) => new NodeSqlite.DatabaseSync(path, { readOnly: true });
  const count = (database: NodeSqlite.DatabaseSync, sql: string) =>
    (database.prepare(sql).get() as { count: number }).count;
  const source = read(input.sourcePath);
  const imported = read(input.destinationPath);
  try {
    const checks: Array<readonly [string, string, string]> = [
      [
        "threads",
        `SELECT COUNT(*) AS count FROM projection_threads`,
        `SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
      ],
      [
        "messages",
        `SELECT COUNT(*) AS count FROM projection_thread_messages WHERE role IN ('user', 'assistant')`,
        `SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages`,
      ],
      [
        "projects",
        `SELECT COUNT(*) AS count FROM projection_projects`,
        `SELECT COUNT(*) AS count FROM projection_projects`,
      ],
    ];
    checks.push([
      "custom_workers.owners",
      `SELECT COUNT(DISTINCT owner_id) AS count FROM custom_workers`,
      `SELECT COUNT(DISTINCT owner_id) AS count FROM custom_workers`,
    ]);
    const customTables = (
      source
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'custom\\_%' ESCAPE '\\' OR name IN ('session_workspaces', 'worker_recommendations') OR name LIKE 'provider\\_allocation\\_%' ESCAPE '\\' OR name LIKE 'model\\_selection\\_%' ESCAPE '\\' OR name LIKE 'base\\_session\\_%' ESCAPE '\\' OR name = 'provider_usage_cap_latches') ORDER BY name`,
        )
        .all() as unknown as ReadonlyArray<{ name: string }>
    ).map((row) => row.name);
    for (const table of customTables) {
      if (checks.some(([name]) => name === table)) continue;
      checks.push([
        table,
        `SELECT COUNT(*) AS count FROM ${table}`,
        `SELECT COUNT(*) AS count FROM ${table}`,
      ]);
    }
    return checks.map(([name, sourceSql, importedSql]) => {
      const sourceCount = count(source, sourceSql);
      const importedCount = count(imported, importedSql);
      return {
        name,
        source: sourceCount,
        imported: importedCount,
        matches: sourceCount === importedCount,
      };
    });
  } finally {
    source.close();
    imported.close();
  }
};
