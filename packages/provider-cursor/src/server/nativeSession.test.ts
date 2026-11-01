// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpErrors from "effect-acp/errors";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { cursorNativeForkRuntime } from "./acpAdapter.ts";
import fixture from "./fixtures/native-store.json" with { type: "json" };
import {
  copyCursorNativeSession,
  cursorNativeSessionRoot,
  forkCursorNativeSession,
  prepareCursorNativeSession,
} from "./nativeSession.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function nativeStore() {
  const config = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cursor-native-"));
  roots.push(config);
  const environment = { CURSOR_CONFIG_DIR: config };
  const root = cursorNativeSessionRoot(environment, "win32");
  const id = fixture.metadata.agentId;
  const dir = NodePath.join(root, id);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "meta.json"), JSON.stringify(fixture.sidecar));
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "store.db"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);",
  );
  db.prepare("INSERT INTO meta VALUES('0',?)").run(
    Buffer.from(JSON.stringify(fixture.metadata)).toString("hex"),
  );
  for (const blob of fixture.blobs)
    db.prepare("INSERT INTO blobs VALUES(?,?)").run(blob.id, Buffer.from(blob.hex, "hex"));
  return { config, environment, root, id, db };
}
function metadata(db: NodeSqlite.DatabaseSync) {
  return JSON.parse(
    Buffer.from(
      String(db.prepare("SELECT value FROM meta WHERE key='0'").get()!.value),
      "hex",
    ).toString(),
  );
}

it("forks a copied native CLI shape including WAL-only history and opaque subagent blobs", () => {
  const source = nativeStore();
  try {
    source.db
      .prepare("INSERT INTO blobs VALUES(?,?)")
      .run("subagent-root", Buffer.from([0, 255, 33, 45]));
    const before = metadata(source.db);
    const id = forkCursorNativeSession(source.environment, source.id, source.config, "win32");
    const fork = new NodeSqlite.DatabaseSync(NodePath.join(source.root, id, "store.db"), {
      readOnly: true,
    });
    try {
      expect(fork.prepare("SELECT id,hex(data) AS data FROM blobs ORDER BY id").all()).toEqual(
        source.db.prepare("SELECT id,hex(data) AS data FROM blobs ORDER BY id").all(),
      );
      expect(metadata(fork)).toEqual({ ...before, agentId: id });
      expect(metadata(source.db)).toEqual(before);
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(source.root, id, "meta.json"), "utf8")),
      ).toEqual({
        ...fixture.sidecar,
        cwd: source.config,
      });
    } finally {
      fork.close();
    }
    // A new turn in the source cannot mutate the fork's complete snapshot.
    source.db.prepare("DELETE FROM blobs WHERE id='subagent-root'").run();
    const copied = new NodeSqlite.DatabaseSync(NodePath.join(source.root, id, "store.db"), {
      readOnly: true,
    });
    try {
      expect(copied.prepare("SELECT id FROM blobs WHERE id='subagent-root'").get()).toBeDefined();
    } finally {
      copied.close();
    }
  } finally {
    source.db.close();
  }
});

it("moves native files to a different account root and reverses the copy without losing context or options", () => {
  const source = nativeStore();
  source.db.close();
  const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cursor-move-"));
  roots.push(target);
  const id = "22222222-2222-4222-8222-222222222222";
  copyCursorNativeSession({
    sourceRoot: source.root,
    sourceId: source.id,
    destinationRoot: target,
    destinationId: id,
    cwd: target,
  });
  const reverseId = "33333333-3333-4333-8333-333333333333";
  copyCursorNativeSession({
    sourceRoot: target,
    sourceId: id,
    destinationRoot: source.root,
    destinationId: reverseId,
    cwd: source.config,
  });
  const copied = new NodeSqlite.DatabaseSync(NodePath.join(source.root, reverseId, "store.db"), {
    readOnly: true,
  });
  try {
    expect(metadata(copied)).toEqual({ ...fixture.metadata, agentId: reverseId });
  } finally {
    copied.close();
  }
});

it("downgrades persisted Run Everything per session while preserving all context and model metadata", () => {
  const source = nativeStore();
  source.db.close();
  prepareCursorNativeSession(source.environment, source.id, "approval-required", "win32");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(source.root, source.id, "store.db"), {
    readOnly: true,
  });
  try {
    expect(metadata(db)).toEqual({
      ...fixture.metadata,
      isRunEverything: false,
      approvalMode: "allowlist",
    });
  } finally {
    db.close();
  }
  prepareCursorNativeSession(source.environment, source.id, "auto", "win32");
  const auto = new NodeSqlite.DatabaseSync(NodePath.join(source.root, source.id, "store.db"), {
    readOnly: true,
  });
  try {
    expect(metadata(auto).approvalMode).toBe("auto-review");
  } finally {
    auto.close();
  }
});

it("refuses SDK or missing IDs, traversal, unknown metadata and overwrite without creating an empty replacement", () => {
  const source = nativeStore();
  try {
    expect(() =>
      forkCursorNativeSession(source.environment, "../escape", source.config, "win32"),
    ).toThrow("UUID");
    expect(() =>
      prepareCursorNativeSession(
        source.environment,
        "44444444-4444-4444-8444-444444444444",
        "full-access",
        "win32",
      ),
    ).toThrow("native store is missing");
    expect(() =>
      copyCursorNativeSession({
        sourceRoot: source.root,
        sourceId: source.id,
        destinationRoot: source.root,
        destinationId: source.id,
        cwd: source.config,
      }),
    ).toThrow("already exists");
    source.db.prepare("UPDATE meta SET value='{}'").run();
    expect(() =>
      forkCursorNativeSession(source.environment, source.id, source.config, "win32"),
    ).toThrow("encoding");
    expect(NodeFS.readdirSync(source.root)).toEqual([source.id]);
  } finally {
    source.db.close();
  }
});

it("refuses a store with rows but a missing native conversation root", () => {
  const source = nativeStore();
  try {
    source.db.prepare("DELETE FROM blobs WHERE id = ?").run(fixture.metadata.latestRootBlobId);
    expect(() =>
      forkCursorNativeSession(source.environment, source.id, source.config, "win32"),
    ).toThrow("conversation root is missing");
    expect(NodeFS.readdirSync(source.root)).toEqual([source.id]);
  } finally {
    source.db.close();
  }
});

it.effect(
  "removes an unbound native fork when CLI load fails and preserves the source for retry",
  () => {
    const source = nativeStore();
    source.db.close();
    const runtime = Layer.mock(AcpSessionRuntime.AcpSessionRuntime)({
      loadSession: () =>
        Effect.fail(new AcpErrors.AcpTransportError({ cause: "fixture load failure" })),
    });
    return Effect.gen(function* () {
      const wrapped = cursorNativeForkRuntime(
        yield* AcpSessionRuntime.AcpSessionRuntime,
        source.environment,
        source.config,
        "approval-required",
        "win32",
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = yield* wrapped.forkSession(source.id).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(NodeFS.readdirSync(source.root)).toEqual([source.id]);
      }
    }).pipe(Effect.provide(runtime));
  },
);
