// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function cursorNativeSessionRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const config = environment.CURSOR_CONFIG_DIR?.trim();
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  const home = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  if (!config && !xdg && !home)
    throw new Error("Cursor native sessions require an explicit home directory.");
  return NodePath.resolve(
    config || (xdg ? NodePath.join(xdg, "cursor") : NodePath.join(home!, ".cursor")),
    "acp-sessions",
  );
}
function sessionDirectory(root: string, id: string): string {
  if (!uuid.test(id)) throw new Error("Cursor native session ID must be a UUID.");
  const directory = NodePath.join(root, id);
  // No account-crossing links, including directory junctions on Windows.
  if (NodeFS.existsSync(directory) && NodeFS.lstatSync(directory).isSymbolicLink())
    throw new Error("Cursor native session directory must not be a symbolic link.");
  return directory;
}
function readNativeMetadata(database: NodeSqlite.DatabaseSync): Record<string, unknown> {
  const row = database.prepare("SELECT value FROM meta WHERE key = '0'").get();
  if (typeof row?.value !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(row.value))
    throw new Error("Unsupported Cursor native metadata encoding.");
  const value: unknown = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof Reflect.get(value, "agentId") !== "string" ||
    typeof Reflect.get(value, "latestRootBlobId") !== "string"
  )
    throw new Error("Unsupported Cursor native metadata shape.");
  const metadata = value as Record<string, unknown>;
  const root = String(metadata.latestRootBlobId);
  if (
    root &&
    (!/^(?:[a-f0-9]{2})+$/i.test(root) ||
      !database.prepare("SELECT 1 FROM blobs WHERE id = ?").get(root))
  )
    throw new Error("Cursor native conversation root is missing; refusing to reset its context.");
  return metadata;
}
/** Copy every blob, including tool results, subagents and encryption metadata; never reconstruct from text. */
export function copyCursorNativeSession(input: {
  readonly sourceRoot: string;
  readonly sourceId: string;
  readonly destinationRoot: string;
  readonly destinationId: string;
  readonly cwd: string;
}): void {
  const source = sessionDirectory(input.sourceRoot, input.sourceId);
  const destination = sessionDirectory(input.destinationRoot, input.destinationId);
  if (NodeFS.existsSync(destination)) throw new Error("Cursor destination session already exists.");
  if (!NodePath.isAbsolute(input.cwd))
    throw new Error("Cursor destination workspace must be absolute.");
  for (const file of ["store.db", "meta.json"]) {
    if (!NodeFS.lstatSync(NodePath.join(source, file)).isFile())
      throw new Error("Cursor native session file is not a regular file.");
  }
  const sidecar: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(source, "meta.json"), "utf8"),
  );
  if (
    typeof sidecar !== "object" ||
    sidecar === null ||
    Reflect.get(sidecar, "schemaVersion") !== 1 ||
    typeof Reflect.get(sidecar, "cwd") !== "string"
  )
    throw new Error("Unsupported Cursor ACP sidecar.");
  NodeFS.mkdirSync(input.destinationRoot, { recursive: true });
  const staging = NodeFS.mkdtempSync(
    NodePath.join(NodePath.dirname(input.destinationRoot), ".t3-copy-"),
  );
  try {
    const snapshot = NodePath.join(staging, "store.db");
    const sourceDatabase = new NodeSqlite.DatabaseSync(NodePath.join(source, "store.db"), {
      readOnly: true,
    });
    try {
      const metadata = readNativeMetadata(sourceDatabase);
      if (metadata.agentId !== input.sourceId)
        throw new Error("Cursor native ID does not match its store.");
      sourceDatabase.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      sourceDatabase.close();
    }
    const copiedDatabase = new NodeSqlite.DatabaseSync(snapshot);
    try {
      const metadata = readNativeMetadata(copiedDatabase);
      // The blob encryption key and root reference must survive an ID change.
      metadata.agentId = input.destinationId;
      copiedDatabase
        .prepare("UPDATE meta SET value = ? WHERE key = '0'")
        .run(Buffer.from(JSON.stringify(metadata)).toString("hex"));
    } finally {
      copiedDatabase.close();
    }
    NodeFS.writeFileSync(
      NodePath.join(staging, "meta.json"),
      JSON.stringify({ ...sidecar, cwd: input.cwd }),
    );
    NodeFS.renameSync(staging, destination);
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}
export function forkCursorNativeSession(
  environment: NodeJS.ProcessEnv,
  sourceId: string,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const root = cursorNativeSessionRoot(environment, platform);
  const destinationId = NodeCrypto.randomUUID();
  copyCursorNativeSession({
    sourceRoot: root,
    sourceId,
    destinationRoot: root,
    destinationId,
    cwd,
  });
  return destinationId;
}
/** CLI load retains Run Everything in metadata even when --force is absent. Apply this session's policy. */
export function prepareCursorNativeSession(
  environment: NodeJS.ProcessEnv,
  id: string,
  mode: string,
  platform: NodeJS.Platform,
): void {
  const directory = sessionDirectory(cursorNativeSessionRoot(environment, platform), id);
  const file = NodePath.join(directory, "store.db");
  if (!NodeFS.existsSync(file) || !NodeFS.lstatSync(file).isFile())
    throw new Error(
      "Cursor CLI native store is missing. SDK agents and terminal-only chats cannot be resumed as ACP sessions; restore the original ACP store before continuing.",
    );
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  let metadata: Record<string, unknown>;
  try {
    metadata = readNativeMetadata(database);
  } finally {
    database.close();
  }
  if (metadata.agentId !== id) throw new Error("Cursor native ID does not match its store.");
  const isRunEverything = mode === "full-access";
  const approvalMode =
    mode === "auto" ? "auto-review" : isRunEverything ? "unrestricted" : "allowlist";
  if (metadata.isRunEverything === isRunEverything && metadata.approvalMode === approvalMode)
    return;
  const writer = new NodeSqlite.DatabaseSync(file);
  try {
    // Re-read in the transaction, preserving concurrently flushed conversation metadata.
    writer.exec("BEGIN IMMEDIATE");
    metadata = readNativeMetadata(writer);
    writer
      .prepare("UPDATE meta SET value = ? WHERE key = '0'")
      .run(
        Buffer.from(JSON.stringify({ ...metadata, isRunEverything, approvalMode })).toString("hex"),
      );
    writer.exec("COMMIT");
  } finally {
    writer.close();
  }
}
/** Roll back only the newly allocated fork when native load fails before it can be bound. */
export function discardCursorNativeFork(
  environment: NodeJS.ProcessEnv,
  id: string,
  platform: NodeJS.Platform,
): void {
  const directory = sessionDirectory(cursorNativeSessionRoot(environment, platform), id);
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
