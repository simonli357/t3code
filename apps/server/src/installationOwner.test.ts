import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessHostname } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import { claimInstallation } from "./installationOwner.ts";
import * as Sqlite from "./persistence/Layers/Sqlite.ts";

const at = "2026-11-13T23:59:00.000Z";

/** Opens `<baseDir>/userdata/state.sqlite` as one server process would, then closes it. */
const withDatabase = <A, E>(
  baseDir: string,
  effect: Effect.Effect<
    A,
    E,
    SqlClient.SqlClient | ServerConfig.ServerConfig | FileSystem.FileSystem
  >,
) =>
  effect.pipe(
    Effect.provide(
      Sqlite.layerConfig.pipe(Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir))),
    ),
  );

const boot = (
  baseDir: string,
  options: { readonly host: string; readonly adoptUnrecorded: boolean },
) =>
  withDatabase(
    baseDir,
    Effect.gen(function* () {
      const claim = yield* claimInstallation({ adoptUnrecorded: options.adoptUnrecorded });
      return { copied: claim.copied, work: yield* readWork };
    }),
  ).pipe(Effect.provideService(HostProcessHostname, options.host));

/** Work an installation left running: what a copy taken mid-turn holds. */
const seedRunningWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const session = (threadId: string, status: string, payload: object) =>
    sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id,
        adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json)
      VALUES (${threadId}, 'claudeAgent', 'claude_xiyang', 'claudeAgent', 'full-access', ${status},
        ${at}, ${JSON.stringify({ resume: `native-${threadId}` })}, ${JSON.stringify(payload)})`;
  yield* session("running-turn", "running", { activeTurnId: "turn-running", cwd: "/work" });
  yield* session("released", "stopped", {
    activeTurnId: null,
    continueAfterServerUpdate: "turn-released",
  });
  yield* session("idle", "stopped", { activeTurnId: null });
  yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json, state, notify)
    VALUES ('worker', 'master', 'base', '{}', 'ready', 1)`;
  const job = (id: string, kind: string, target: string, state: string, reported = 0) =>
    sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, reported, resume_at)
      VALUES (${id}, 'worker', ${target}, ${kind}, 'prompt', ${at}, ${state}, ${reported},
        ${id === "assignment" ? "2026-11-14T00:30:00.000Z" : null})`;
  yield* job("assignment", "work", "worker", "queued");
  yield* job("in-flight", "work", "worker", "submitted");
  yield* job("finished", "work", "worker", "completed");
  yield* job("report", "done", "master", "queued");
  yield* job("peer-message", "message", "peer:env-sliara:thread", "queued");
  yield* job("delivered", "done", "master", "completed", 1);
  yield* sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json, state)
    VALUES ('successor', 'master', '{}', 'queued')`;
  yield* sql`INSERT INTO custom_session_renewals (thread_id, state) VALUES ('worker', 'checkpoint')`;
  yield* sql`INSERT INTO custom_session_moves (id, thread_id, target_thread_id, direction,
      peer_environment_id, state, locked, input_json, created_at, updated_at)
    VALUES ('move', 'idle', 'idle', 'out', 'env-sliara', 'copying', 1, '{}', ${at}, ${at})`;
  yield* sql`INSERT INTO custom_ownership_transactions (id, request_json, state, participants_json)
    VALUES ('preparing', '{}', 'preparing', '["env-sliara"]'),
      ('committed', '{}', 'committed', '["env-sliara"]'),
      ('done', '{}', 'complete', '["env-sliara"]')`;
  yield* sql`INSERT INTO custom_ownership_reservation (singleton, id, coordinator)
    VALUES (1, 'preparing', 'env-sliara')`;
  yield* sql`INSERT INTO custom_session_ownership_changes (id, request_json, result_json)
    VALUES ('change', '{}', '{}')`;
});

const readWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    sessions: yield* sql`SELECT thread_id, status, runtime_payload_json AS payload,
      resume_cursor_json AS cursor FROM provider_session_runtime ORDER BY thread_id`,
    jobs: yield* sql`SELECT id, state, reported FROM custom_worker_jobs ORDER BY id`,
    workers: yield* sql`SELECT thread_id, notify FROM custom_workers`,
    handoffs: yield* sql`SELECT thread_id, state FROM custom_orchestrator_handoffs`,
    renewals: yield* sql`SELECT thread_id, state FROM custom_session_renewals ORDER BY thread_id`,
    moves: yield* sql`SELECT id, state, locked FROM custom_session_moves`,
    ownership: yield* sql`SELECT id, state, participants_json AS participants
      FROM custom_ownership_transactions ORDER BY id`,
    reservations: yield* sql`SELECT id FROM custom_ownership_reservation`,
    announcements: yield* sql`SELECT id, announced FROM custom_session_ownership_changes`,
  };
});

const settledCopy = {
  sessions: [
    {
      thread_id: "idle",
      status: "stopped",
      payload: JSON.stringify({ activeTurnId: null }),
      cursor: JSON.stringify({ resume: "native-idle" }),
    },
    {
      thread_id: "released",
      status: "stopped",
      payload: JSON.stringify({
        activeTurnId: null,
        continueAfterServerUpdate: null,
        continueAfterServerUpdatePrepared: null,
      }),
      cursor: JSON.stringify({ resume: "native-released" }),
    },
    {
      thread_id: "running-turn",
      status: "stopped",
      payload: JSON.stringify({
        activeTurnId: null,
        cwd: "/work",
        continueAfterServerUpdate: null,
        continueAfterServerUpdatePrepared: null,
      }),
      cursor: JSON.stringify({ resume: "native-running-turn" }),
    },
  ],
  jobs: [
    { id: "assignment", state: "cancelled", reported: 1 },
    { id: "delivered", state: "completed", reported: 1 },
    { id: "finished", state: "completed", reported: 1 },
    { id: "in-flight", state: "cancelled", reported: 1 },
    { id: "peer-message", state: "cancelled", reported: 1 },
    { id: "report", state: "cancelled", reported: 1 },
  ],
  workers: [{ thread_id: "worker", notify: 0 }],
  handoffs: [{ thread_id: "successor", state: "cancelled" }],
  renewals: [
    { thread_id: "master", state: "error" },
    { thread_id: "worker", state: "error" },
  ],
  moves: [{ id: "move", state: "cancelled", locked: 0 }],
  ownership: [
    { id: "committed", state: "aborted", participants: "[]" },
    { id: "done", state: "complete", participants: '["env-sliara"]' },
    { id: "preparing", state: "aborted", participants: "[]" },
  ],
  reservations: [],
  announcements: [{ id: "change", announced: 1 }],
};

const tempBaseDir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

/** `VACUUM INTO`, as AGENTS.md "Test data" copies the live database. */
const copyDatabase = (from: string, to: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const target = path.join(to, "userdata", "state.sqlite");
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* withDatabase(
      from,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      }),
    );
  });

it.layer(NodeServices.layer)("installation claim", (it) => {
  it.effect("the installation that left work running keeps it after a crash or update", () =>
    Effect.gen(function* () {
      const original = yield* tempBaseDir("t3-installation-original-");
      assert.isFalse((yield* boot(original, { host: "myacer", adoptUnrecorded: true })).copied);
      yield* withDatabase(original, seedRunningWork);
      const seeded = yield* withDatabase(original, readWork);

      // A dev server's rule for unrecorded databases does not matter once recorded.
      const restarted = yield* boot(original, { host: "myacer", adoptUnrecorded: false });
      assert.isFalse(restarted.copied);
      assert.deepStrictEqual(restarted.work, seeded);
    }).pipe(Effect.scoped),
  );

  it.effect("a copy at another path settles everything that would run", () =>
    Effect.gen(function* () {
      const original = yield* tempBaseDir("t3-installation-original-");
      const copy = yield* tempBaseDir("t3-installation-copy-");
      yield* boot(original, { host: "myacer", adoptUnrecorded: true });
      yield* withDatabase(original, seedRunningWork);
      const seeded = yield* withDatabase(original, readWork);
      yield* copyDatabase(original, copy);

      const copied = yield* boot(copy, { host: "myacer", adoptUnrecorded: true });
      assert.isTrue(copied.copied);
      assert.deepStrictEqual(copied.work, settledCopy);

      // The copy is now its own installation; the original is untouched.
      const copyRestarted = yield* boot(copy, { host: "myacer", adoptUnrecorded: false });
      assert.isFalse(copyRestarted.copied);
      assert.deepStrictEqual(copyRestarted.work, settledCopy);
      const originalRestarted = yield* boot(original, { host: "myacer", adoptUnrecorded: true });
      assert.isFalse(originalRestarted.copied);
      assert.deepStrictEqual(originalRestarted.work, seeded);
    }).pipe(Effect.scoped),
  );

  it.effect("a copy on another computer at the same path settles everything that would run", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir("t3-installation-moved-");
      yield* boot(baseDir, { host: "myacer", adoptUnrecorded: true });
      yield* withDatabase(baseDir, seedRunningWork);

      const moved = yield* boot(baseDir, { host: "sliara", adoptUnrecorded: true });
      assert.isTrue(moved.copied);
      assert.deepStrictEqual(moved.work, settledCopy);
    }).pipe(Effect.scoped),
  );

  it.effect("an older build's database is adopted only by the installed server", () =>
    Effect.gen(function* () {
      const installed = yield* tempBaseDir("t3-installation-legacy-");
      const dev = yield* tempBaseDir("t3-installation-legacy-dev-");
      yield* withDatabase(installed, seedRunningWork);
      const seeded = yield* withDatabase(installed, readWork);
      yield* copyDatabase(installed, dev);

      const service = yield* boot(installed, { host: "myacer", adoptUnrecorded: true });
      assert.isFalse(service.copied);
      assert.deepStrictEqual(service.work, seeded);
      assert.isFalse((yield* boot(installed, { host: "myacer", adoptUnrecorded: false })).copied);

      const devServer = yield* boot(dev, { host: "myacer", adoptUnrecorded: false });
      assert.isTrue(devServer.copied);
      assert.deepStrictEqual(devServer.work, settledCopy);
    }).pipe(Effect.scoped),
  );
});
