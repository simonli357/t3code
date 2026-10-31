// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { contained } from "./SessionMoveFiles.ts";
import * as Schema from "effect/Schema";
import { captureCodexMoveHistory, CodexMoveRollout } from "./CodexMoveHistory.ts";

const Cell = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
  Schema.Struct({ blob: Schema.String }),
]);
type Cell = typeof Cell.Type;
const Table = Schema.Struct({
  name: Schema.String,
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Cell)),
});
type Table = typeof Table.Type;
export const CodexMoveState = Schema.Struct({
  nativeIds: Schema.Array(Schema.String),
  rollouts: Schema.optional(Schema.Array(CodexMoveRollout)),
  databases: Schema.Array(Schema.Struct({ name: Schema.String, tables: Schema.Array(Table) })),
});
export type CodexMoveState = typeof CodexMoveState.Type;
export const decodeCodexMoveState = Schema.decodeUnknownSync(Schema.fromJsonString(CodexMoveState));
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const fields = (db: NodeSqlite.DatabaseSync, table: string) =>
  db
    .prepare("PRAGMA table_info(" + quote(table) + ")")
    .all()
    .map((row) => String(row.name));
const cell = (value: unknown): Cell => {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  throw new Error("Unsupported value in the native Codex state store.");
};

/** Read only the selected thread family, never account credentials or unrelated sessions. */
export async function captureCodexMoveState(
  home: string,
  nativeId: string,
): Promise<CodexMoveState> {
  if (!uuid(nativeId)) throw new Error("Invalid native session identifier.");
  const nativeIds = new Set([nativeId]);
  const databases: Array<{ name: string; tables: Table[] }> = [];
  const names = (await NodeFSP.readdir(home))
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  for (const name of names) {
    if (!/^state_\d+\.sqlite$/.test(name)) continue;
    const filename = NodePath.join(home, name);
    if (!(await NodeFSP.lstat(filename)).isFile()) continue;
    const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; BEGIN;");
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      if (
        !names.includes("threads") ||
        !db.prepare("SELECT 1 FROM threads WHERE id = ?").get(nativeId)
      ) {
        db.exec("COMMIT;");
        continue;
      }
      if (names.includes("thread_spawn_edges")) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const id of Array.from(nativeIds))
            for (const edge of db
              .prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?")
              .all(id)) {
              if (uuid(edge.child_thread_id) && !nativeIds.has(edge.child_thread_id)) {
                nativeIds.add(edge.child_thread_id);
                changed = true;
              }
            }
          if (nativeIds.size > 512)
            throw new Error("The native session family is too large to move in one operation.");
        }
      }
      const ids = [...nativeIds];
      const placeholders = ids.map(() => "?").join(",");
      const tables: Table[] = [];
      for (const table of names) {
        if (
          table !== "threads" &&
          table !== "guardian_review_feedback" &&
          !table.startsWith("thread_")
        )
          continue;
        if (/auth|credential|secret/.test(table)) continue;
        const columns = fields(db, table);
        const predicate =
          table === "threads" ? "id" : columns.includes("thread_id") ? "thread_id" : null;
        let rows: Record<string, unknown>[];
        if (table === "thread_spawn_edges")
          rows = db
            .prepare(
              "SELECT * FROM thread_spawn_edges WHERE parent_thread_id IN (" +
                placeholders +
                ") AND child_thread_id IN (" +
                placeholders +
                ") LIMIT 100001",
            )
            .all(...ids, ...ids);
        else if (predicate)
          rows = db
            .prepare(
              "SELECT * FROM " +
                quote(table) +
                " WHERE " +
                quote(predicate) +
                " IN (" +
                placeholders +
                ") LIMIT 100001",
            )
            .all(...ids);
        else continue;
        if (rows.length > 100_000)
          throw new Error("A native state table exceeds the transfer budget.");
        tables.push({
          name: table,
          columns,
          rows: rows.map((row) =>
            columns.map((column) => {
              if (
                table === "threads" &&
                column === "rollout_path" &&
                typeof row[column] === "string"
              )
                return NodePath.relative(home, row[column]).replaceAll("\\", "/");
              return cell(row[column]);
            }),
          ),
        });
      }
      db.exec("COMMIT;");
      databases.push({ name, tables });
      break; // Older state_N files are abandoned native caches, not additional context.
    } finally {
      db.close();
    }
  }
  for (const prefix of ["goals", "memories", "queue"]) {
    const name = (await NodeFSP.readdir(home))
      .filter((entry) => new RegExp("^" + prefix + "_\\d+\\.sqlite$").test(entry))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
    if (!name) continue;
    const db = new NodeSqlite.DatabaseSync(contained(home, name), { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000; BEGIN;");
      const ids = [...nativeIds];
      const tables: Table[] = [];
      for (const entry of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
        const table = String(entry.name);
        const columns = fields(db, table);
        if (!columns.includes("thread_id")) continue;
        const rows = db
          .prepare(
            "SELECT * FROM " +
              quote(table) +
              " WHERE thread_id IN (" +
              ids.map(() => "?").join(",") +
              ") LIMIT 100001",
          )
          .all(...ids);
        if (rows.length > 100_000) throw new Error("Native state exceeds the transfer budget.");
        if (table === "queued_items" && rows.length)
          throw new Error("The native Codex prompt queue must finish before moving.");
        tables.push({
          name: table,
          columns,
          rows: rows.map((row) => columns.map((column) => cell(row[column]))),
        });
      }
      db.exec("COMMIT;");
      if (tables.length) databases.push({ name, tables });
    } finally {
      db.close();
    }
  }
  return {
    nativeIds: [...nativeIds],
    databases,
    rollouts: await captureCodexMoveHistory(home, [...nativeIds]),
  };
}

/** Native app-server creates/migrates its schema first. Merge just these thread rows. */
export async function installCodexMoveState(home: string, cwd: string, state: CodexMoveState) {
  if (
    !state.nativeIds.length ||
    state.nativeIds.length > 512 ||
    !state.nativeIds.every(uuid) ||
    state.databases.length > 4
  )
    throw new Error("Invalid native Codex state manifest.");
  const ids = [...state.nativeIds];
  for (const database of state.databases) {
    if (!/^(state|goals|memories|queue)_\d+\.sqlite$/.test(database.name))
      throw new Error("Invalid native Codex database name.");
    const filename = contained(home, database.name);
    if (!(await NodeFSP.lstat(filename)).isFile())
      throw new Error("The destination Codex state store is missing.");
    const db = new NodeSqlite.DatabaseSync(filename);
    try {
      db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
      for (const table of database.tables) {
        if (
          table.rows.length > 100_000 ||
          !table.columns.length ||
          table.rows.some((row) => row.length !== table.columns.length)
        )
          throw new Error("Invalid native state table.");
        if (
          table.name !== "threads" &&
          table.name !== "guardian_review_feedback" &&
          table.name !== "stage1_outputs" &&
          table.name !== "queued_items" &&
          table.name !== "queued_thread_revisions" &&
          !table.name.startsWith("thread_")
        )
          throw new Error("Unrelated native state table.");
        if (/auth|credential|secret/.test(table.name))
          throw new Error("Credentials cannot be moved as conversation state.");
        const targetColumns = fields(db, table.name);
        if (JSON.stringify(targetColumns) !== JSON.stringify(table.columns))
          throw new Error("The Codex state schemas differ. Align provider versions before moving.");
        const selected =
          table.name === "threads"
            ? "id"
            : table.columns.includes("thread_id")
              ? "thread_id"
              : null;
        if (selected && table.name !== "threads")
          db.prepare(
            "DELETE FROM " +
              quote(table.name) +
              " WHERE " +
              quote(selected) +
              " IN (" +
              ids.map(() => "?").join(",") +
              ")",
          ).run(...ids);
        if (table.name === "thread_spawn_edges")
          db.prepare(
            "DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (" +
              ids.map(() => "?").join(",") +
              ")",
          ).run(...ids);
      }
      for (const table of [...database.tables].sort(
        (a, b) => Number(b.name === "threads") - Number(a.name === "threads"),
      )) {
        const statement = db.prepare(
          "INSERT INTO " +
            quote(table.name) +
            " (" +
            table.columns.map(quote).join(",") +
            ") VALUES (" +
            table.columns.map(() => "?").join(",") +
            ") ON CONFLICT DO UPDATE SET " +
            table.columns.map((column) => quote(column) + " = excluded." + quote(column)).join(","),
        );
        for (const row of table.rows) {
          const values = row.map((value, index) => {
            const column = table.columns[index];
            if (table.name === "threads") {
              if (column === "rollout_path" && typeof value === "string")
                return contained(home, value);
              if (column === "cwd") return cwd;
              if (column === "archived") return 0;
              if (
                column === "archived_at" ||
                column === "project_id" ||
                column === "thread_section_id"
              )
                return null;
            }
            return value && typeof value === "object" ? Buffer.from(value.blob, "base64") : value;
          });
          const key = table.columns.indexOf(table.name === "threads" ? "id" : "thread_id");
          if (table.name === "thread_spawn_edges") {
            if (
              !["parent_thread_id", "child_thread_id"].every((name) =>
                ids.includes(String(values[table.columns.indexOf(name)])),
              )
            )
              throw new Error("Unrelated native thread edge.");
          } else if (key < 0 || !ids.includes(String(values[key])))
            throw new Error("Unrelated native session row.");
          statement.run(...values);
        }
      }
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    } finally {
      db.close();
    }
  }
}
