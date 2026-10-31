// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  EventId,
  ProviderThreadId,
  type SessionMoveInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { master, model, project, seed, setLatestRun } from "../workers/integration.testkit.ts";
import {
  type Computer,
  makeComputer,
  newNetwork,
  on as inWorld,
} from "../workers/peerWorld.testkit.ts";
import * as WorkerService from "../workers/WorkerService.ts";
import * as SessionMoves from "./SessionMoves.ts";

const NATIVE_ID = "0248b7d6-1ead-447d-894b-5edbafe089df";
const ROLLOUT = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${NATIVE_ID}.jsonl`;
const idA = "environment-a" as EnvironmentId;
const idB = "environment-b" as EnvironmentId;
type World = Computer;
const makeWorld = makeComputer;

const sha = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

const rolloutOf = (nativeId: string) =>
  `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${nativeId}.jsonl`;

/** Gives a thread of a computer a Codex session behind it, as a conversation that has already run would have. */
const bindNativeSession = Effect.fn("bindNativeSession")(function* (
  world: World,
  threadId: ThreadId,
  nativeId: string,
) {
  const at = yield* DateTime.now;
  const sink = yield* EventSink.EventSinkV2.pipe(Effect.provideContext(world.context));
  yield* sink.write({
    events: [
      {
        id: EventId.make(`seed:provider-thread:${threadId}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: at,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          driver: "codex" as never,
          providerInstanceId: model.instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: "codex" as never, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
        },
      },
    ],
  });
  const rollout = NodePath.join(world.codexHome, rolloutOf(nativeId));
  NodeFS.mkdirSync(NodePath.dirname(rollout), { recursive: true });
  NodeFS.writeFileSync(
    rollout,
    `${JSON.stringify({ type: "session_meta", payload: { id: nativeId } })}\n${JSON.stringify({ type: "event_msg", payload: { text: "hello" } })}\n`,
  );
  return rollout;
});

const seedSession = Effect.fn("seedSession")(function* (world: World) {
  yield* seed(master, world.root).pipe(Effect.provideContext(world.context));
  return yield* bindNativeSession(world, master, NATIVE_ID);
});

const moveInput = (
  requestId: string,
  environment: EnvironmentId,
  threadId: ThreadId = master,
): SessionMoveInput => ({
  requestId: CommandId.make(requestId),
  threadId,
  projectId: project,
  environment,
});

const startMoves = (world: World) =>
  inWorld(
    world,
    Effect.gen(function* () {
      const moves = yield* SessionMoves.SessionMoves;
      yield* moves.start();
      return moves;
    }),
  );

const rowsOf = (world: World, threadId = master) =>
  inWorld(
    world,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        direction: string;
        state: string;
        locked: number;
        error: string | null;
      }>`SELECT direction, state, locked, error FROM custom_session_moves WHERE thread_id = ${threadId} ORDER BY rowid`;
    }),
  );

const shellOf = (world: World) =>
  inWorld(
    world,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return yield* threads.getThreadShell(master);
    }),
  );

it.effect("moves a session out and back with the same native ID and one writer", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    const rollout = yield* seedSession(a);
    const movesA = yield* startMoves(a);
    yield* startMoves(b);

    const out = yield* inWorld(a, movesA.request(moveInput("move-out", idB)));
    assert.equal(out.state, "queued");
    yield* inWorld(a, movesA.drain());

    assert.deepEqual(
      (yield* rowsOf(a)).map((row) => [row.direction, row.state, row.error]),
      [["out", "complete", null]],
    );
    assert.deepEqual(
      (yield* rowsOf(b)).map((row) => [row.direction, row.state, row.locked]),
      [["in", "complete", 0]],
    );
    assert.equal(sha(NodePath.join(b.codexHome, ROLLOUT)), sha(rollout));
    const onB = yield* shellOf(b);
    assert.isNotNull(onB);
    assert.isNull(onB!.archivedAt);
    assert.isNotNull((yield* shellOf(a))!.archivedAt);

    // The source copy is now a parked, non-writable archive.
    const refused = yield* inWorld(
      a,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        return yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-parked"),
          threadId: master,
          title: "Edited on the source",
        });
      }).pipe(Effect.flip),
    );
    assert.include(JSON.stringify(refused), "ThreadMovingError");

    // Moving it back reuses the native ID on the original computer.
    NodeFS.appendFileSync(
      NodePath.join(b.codexHome, ROLLOUT),
      `${JSON.stringify({ type: "event_msg", payload: { text: "more" } })}\n`,
    );
    const movesB = Context.get(b.context, SessionMoves.SessionMoves);
    yield* inWorld(b, movesB.request(moveInput("move-back", idA)));
    yield* inWorld(b, movesB.drain());
    assert.equal(
      sha(NodePath.join(a.codexHome, ROLLOUT)),
      sha(NodePath.join(b.codexHome, ROLLOUT)),
    );
    assert.isNull((yield* shellOf(a))!.archivedAt);
    assert.isNotNull((yield* shellOf(b))!.archivedAt);
  }).pipe(Effect.scoped),
);

it.effect("cancels a move before commit and leaves the source writable", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    yield* seedSession(a);
    const movesA = yield* startMoves(a);
    yield* startMoves(b);

    network.outages.add("prepare");
    yield* inWorld(a, movesA.request(moveInput("move-cancelled", idB)));
    yield* inWorld(a, movesA.drain());
    assert.deepEqual(
      (yield* rowsOf(a)).map((row) => row.state),
      ["copying"],
    );

    const cancelled = yield* inWorld(
      a,
      movesA.status({ requestId: CommandId.make("move-cancelled"), cancel: true }),
    );
    assert.equal(cancelled.state, "cancelled");
    assert.deepEqual(
      (yield* rowsOf(a)).map((row) => row.locked),
      [0],
    );
    assert.isNull(yield* shellOf(b));
    assert.isNull((yield* shellOf(a))!.archivedAt);
  }).pipe(Effect.scoped),
);

it.effect("recovers a move interrupted at commit from its durable receipt", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    const rollout = yield* seedSession(a);
    const movesA = yield* startMoves(a);
    yield* startMoves(b);

    network.outages.add("commit");
    yield* inWorld(a, movesA.request(moveInput("move-restart", idB)));
    yield* inWorld(a, movesA.drain());
    assert.deepEqual(
      (yield* rowsOf(a)).map((row) => [row.state, row.locked]),
      [["committing", 1]],
    );
    assert.isNull((yield* shellOf(a))!.archivedAt);

    // A restarted server rebuilds the service over the same database and resumes the receipt.
    const restarted = yield* Layer.build(
      SessionMoves.layer.pipe(Layer.provide(Layer.succeedContext(a.context))),
    );
    const resumed = Context.get(restarted, SessionMoves.SessionMoves);
    yield* inWorld(a, resumed.drain());
    assert.deepEqual(
      (yield* rowsOf(a)).map((row) => row.state),
      ["complete"],
    );
    assert.equal(sha(NodePath.join(b.codexHome, ROLLOUT)), sha(rollout));
    assert.isNotNull((yield* shellOf(a))!.archivedAt);
  }).pipe(Effect.scoped),
);

const plain = (
  rows: ReadonlyArray<{
    readonly thread_id: string;
    readonly owner_id: string | null;
    readonly state: string;
  }>,
) => rows.map((row) => [row.thread_id, row.owner_id, row.state]);

const workerRows = (world: World) =>
  inWorld(
    world,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        thread_id: string;
        owner_id: string | null;
        state: string;
      }>`SELECT thread_id, owner_id, state FROM custom_workers ORDER BY thread_id`;
    }),
  );

const textsOf = (world: World, threadId: ThreadId) =>
  inWorld(
    world,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return (yield* orchestrator.getThreadProjection(threadId)).messages.map(
        (message) => message.text,
      );
    }),
  );

const childInput = (threadId: ThreadId) => ({
  threadId,
  title: "Child",
  modelSelection: model,
  prompt: "Work on the child task.",
  projectId: project,
});

it.effect("keeps a moved master's workers reporting to it, and brings them back with it", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    yield* seedSession(a);
    const movesA = yield* startMoves(a);
    const movesB = yield* startMoves(b);
    const workersA = Context.get(a.context, WorkerService.WorkerService);
    const workersB = Context.get(b.context, WorkerService.WorkerService);
    const child = ThreadId.make("thread:child");
    yield* inWorld(a, workersA.spawn(master, childInput(child)));
    yield* inWorld(a, setLatestRun(child, "completed"));
    yield* inWorld(a, workersA.drain());

    yield* inWorld(a, movesA.request(moveInput("master-out", idB)));
    yield* inWorld(a, movesA.drain());

    assert.deepEqual(plain(yield* workerRows(a)), [[child, `peer:${idB}:${master}`, "ready"]]);
    assert.deepEqual(plain(yield* workerRows(b)), [[child, master, "remote"]]);

    // The worker still runs here, and its report now reaches the master on the other computer.
    yield* inWorld(
      a,
      workersA.report(child, {
        clientRequestId: "child-done",
        outcome: "done",
        summary: "Child finished while its master was away.",
      }),
    );
    yield* inWorld(a, workersA.drain());
    yield* inWorld(b, workersB.drain());
    assert.isTrue(
      (yield* textsOf(b, master)).some((text) => text.includes("Child finished while its master")),
    );

    // The master comes home with its worker.
    yield* inWorld(b, setLatestRun(master, "completed"));
    yield* inWorld(b, movesB.request(moveInput("master-back", idA)));
    yield* inWorld(b, movesB.drain());
    assert.deepEqual(
      (yield* rowsOf(b)).map((row) => [row.direction, row.state, row.error]),
      [
        ["in", "complete", null],
        ["out", "complete", null],
      ],
    );
    assert.deepEqual(plain(yield* workerRows(a)), [[child, master, "ready"]]);
    assert.deepEqual(yield* workerRows(b), []);
  }).pipe(Effect.scoped),
);

it.effect("keeps a moved worker reporting to its master", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    yield* inWorld(a, seed(master, a.root));
    yield* inWorld(b, seed(ThreadId.make("thread:b-local"), b.root));
    const movesA = yield* startMoves(a);
    yield* startMoves(b);
    const workersA = Context.get(a.context, WorkerService.WorkerService);
    const workersB = Context.get(b.context, WorkerService.WorkerService);
    const worker = ThreadId.make("thread:moving-worker");
    yield* inWorld(a, workersA.spawn(master, childInput(worker)));
    yield* bindNativeSession(a, worker, "3eb759e7-b92c-43aa-9344-c277e5ca72aa");

    // An assignment the master has not yet seen finish keeps the session where it is.
    yield* inWorld(a, setLatestRun(worker, "completed"));
    yield* inWorld(a, movesA.request(moveInput("worker-out", idB, worker)));
    yield* inWorld(a, movesA.drain());
    const early = (yield* rowsOf(a, worker))[0]!;
    assert.include(early.error ?? "", "queued assignments");
    yield* inWorld(a, workersA.drain());
    yield* inWorld(a, movesA.drain());
    assert.deepEqual(
      (yield* rowsOf(a, worker)).map((row) => [row.state, row.error]),
      [["complete", null]],
    );
    assert.deepEqual(plain(yield* workerRows(a)), [[worker, master, "remote"]]);
    assert.deepEqual(plain(yield* workerRows(b)), [[worker, `peer:${idA}:${master}`, "ready"]]);

    yield* inWorld(
      b,
      workersB.report(worker, {
        clientRequestId: "moved-done",
        outcome: "done",
        summary: "Finished on the other computer.",
      }),
    );
    yield* inWorld(b, workersB.drain());
    yield* inWorld(a, workersA.drain());
    assert.isTrue(
      (yield* textsOf(a, master)).some((text) => text.includes("Finished on the other computer.")),
    );
    const listed = yield* inWorld(a, workersA.list(master));
    assert.deepEqual(
      listed.map((entry) => [entry.threadId, entry.environment]),
      [[worker, `Peer ${idB}`]],
    );
  }).pipe(Effect.scoped),
);

it.effect("holds ownership changes while a session is parked, but not for a cancelled copy", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    yield* seedSession(a);
    const movesA = yield* startMoves(a);
    yield* startMoves(b);
    const workersA = Context.get(a.context, WorkerService.WorkerService);
    const workersB = Context.get(b.context, WorkerService.WorkerService);
    const keeper = ThreadId.make("thread:keeper");
    yield* inWorld(a, seed(keeper, a.root));
    const assign = (clientRequestId: string, ownerThreadId: ThreadId | null) => ({
      clientRequestId,
      threadId: master,
      ownerThreadId,
      expectedOwnerThreadId: null,
      expectedRevision: 0,
    });

    // A cancelled incoming copy never held the session, though it keeps the copied thread.
    network.lostReplies.add("prepare");
    yield* inWorld(a, movesA.request(moveInput("cancelled-move", idB)));
    yield* inWorld(a, movesA.drain());
    yield* inWorld(a, movesA.status({ requestId: CommandId.make("cancelled-move"), cancel: true }));
    assert.deepEqual(
      (yield* rowsOf(b)).map((row) => [row.direction, row.state, row.locked]),
      [["in", "cancelled", 1]],
    );
    yield* inWorld(b, seed(keeper, b.root));
    const adopted = yield* inWorld(b, workersB.changeOwnership(assign("adopt-on-b", keeper)));
    assert.equal(adopted.ownerThreadId, keeper);

    yield* inWorld(a, movesA.request(moveInput("parked-move", idB)));
    yield* inWorld(a, movesA.drain());
    const refused = yield* inWorld(
      a,
      workersA.changeOwnership(assign("adopt-on-a", keeper)).pipe(Effect.flip),
    );
    assert.include(refused.message, "moving between computers");
  }).pipe(Effect.scoped),
);

const DSH_PARENT = "11111111-1111-4111-8111-111111111111";
const DSH_CHILD = "22222222-2222-4222-8222-222222222222";
const dshSessionFiles = {
  [`sessions/work-bucket/${DSH_PARENT}/transcript.jsonl`]: "parent turn\n",
  [`sessions/work-bucket/${DSH_CHILD}/transcript.jsonl`]: "child turn\n",
  [`sessions/work-bucket/${DSH_CHILD}/artifacts/note.txt`]: "a note\n",
  "attachments/v1/ab/cd.bin": "provider attachment",
};

/** A DeepSeek Harness session that was forked from another, with the files the harness keeps for both. */
const seedDshFork = Effect.fn("seedDshFork")(function* (world: World) {
  yield* seed(master, world.root).pipe(Effect.provideContext(world.context));
  const parent = ThreadId.make("thread:dsh-parent");
  yield* seed(parent, world.root).pipe(Effect.provideContext(world.context));
  const sink = yield* EventSink.EventSinkV2.pipe(Effect.provideContext(world.context));
  const at = yield* DateTime.now;
  const providerThread = (threadId: ThreadId, nativeId: string, forkedFrom?: string) => ({
    id: EventId.make(`seed:dsh-provider-thread:${threadId}`),
    type: "provider-thread.updated" as const,
    threadId,
    occurredAt: at,
    payload: {
      id: ProviderThreadId.make(`provider-thread:${threadId}`),
      driver: "deepseekHarness" as never,
      providerInstanceId: "deepseekHarness" as never,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "deepseekHarness" as never,
        nativeId,
        strength: "strong" as const,
      },
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom:
        forkedFrom === undefined ? null : { providerThreadId: ProviderThreadId.make(forkedFrom) },
      createdAt: at,
      updatedAt: at,
    },
  });
  yield* sink.write({
    events: [
      providerThread(parent, DSH_PARENT),
      providerThread(master, DSH_CHILD, `provider-thread:${parent}`),
    ],
  });
  // The thread runs on the harness under the retired model name, which the catalog keeps as an alias.
  yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("select-dsh"),
      threadId: master,
      modelSelection: { instanceId: "deepseekHarness" as never, model: "deepseek-v4-flash" },
    });
  }).pipe(Effect.provideContext(world.context));
  for (const [name, text] of Object.entries(dshSessionFiles)) {
    const file = NodePath.join(world.dshHome, name);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  }
});

it.effect(
  "moves a DeepSeek Harness session with its fork ancestry, assets and alias, and back",
  () =>
    Effect.gen(function* () {
      const network = newNetwork();
      const a = yield* makeWorld(idA, idB, network);
      const b = yield* makeWorld(idB, idA, network);
      yield* seedDshFork(a);
      const movesA = yield* startMoves(a);
      const movesB = yield* startMoves(b);

      yield* inWorld(a, movesA.request(moveInput("dsh-out", idB)));
      yield* inWorld(a, movesA.drain());
      assert.deepEqual(
        (yield* rowsOf(a)).map((row) => [row.state, row.error]),
        [["complete", null]],
      );
      // The same native IDs, the same files under the same names, the provider's own assets with them.
      for (const name of Object.keys(dshSessionFiles))
        assert.equal(sha(NodePath.join(b.dshHome, name)), sha(NodePath.join(a.dshHome, name)));
      assert.isNull((yield* shellOf(b))!.archivedAt);

      // Coming back replaces the copy left on this computer with the newer one.
      NodeFS.appendFileSync(
        NodePath.join(b.dshHome, `sessions/work-bucket/${DSH_CHILD}/transcript.jsonl`),
        "second turn on the other computer\n",
      );
      yield* inWorld(b, movesB.request(moveInput("dsh-back", idA)));
      yield* inWorld(b, movesB.drain());
      for (const name of Object.keys(dshSessionFiles))
        assert.equal(sha(NodePath.join(a.dshHome, name)), sha(NodePath.join(b.dshHome, name)));
      assert.include(
        NodeFS.readFileSync(
          NodePath.join(a.dshHome, `sessions/work-bucket/${DSH_CHILD}/transcript.jsonl`),
          "utf8",
        ),
        "second turn",
      );
      assert.isNull((yield* shellOf(a))!.archivedAt);
    }).pipe(Effect.scoped),
);

it.effect("refuses a DeepSeek Harness fork whose ancestry is missing on disk", () =>
  Effect.gen(function* () {
    const network = newNetwork();
    const a = yield* makeWorld(idA, idB, network);
    const b = yield* makeWorld(idB, idA, network);
    yield* seedDshFork(a);
    NodeFS.rmSync(NodePath.join(a.dshHome, `sessions/work-bucket/${DSH_PARENT}`), {
      recursive: true,
    });
    const movesA = yield* startMoves(a);
    yield* startMoves(b);
    yield* inWorld(a, movesA.request(moveInput("dsh-incomplete", idB)));
    yield* inWorld(a, movesA.drain());
    const [row] = yield* rowsOf(a);
    assert.include(row!.error ?? "", "ancestry is incomplete");
    assert.isNull(yield* shellOf(b));
  }).pipe(Effect.scoped),
);

const CLAUDE_ID = "33333333-3333-4333-8333-333333333333";

it.effect(
  "moves a Claude session into the destination's project directory for its new workspace",
  () =>
    Effect.gen(function* () {
      const network = newNetwork();
      const a = yield* makeWorld(idA, idB, network);
      const b = yield* makeWorld(idB, idA, network);
      yield* seed(master, a.root).pipe(Effect.provideContext(a.context));
      const sink = yield* EventSink.EventSinkV2.pipe(Effect.provideContext(a.context));
      const at = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("seed:claude-provider-thread"),
            type: "provider-thread.updated",
            threadId: master,
            occurredAt: at,
            payload: {
              id: ProviderThreadId.make("provider-thread:claude"),
              driver: "claudeAgent" as never,
              providerInstanceId: "claudeAgent" as never,
              providerSessionId: null,
              appThreadId: master,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: "claudeAgent" as never,
                nativeId: CLAUDE_ID,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: at,
              updatedAt: at,
            },
          },
        ],
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("select-claude"),
          threadId: master,
          modelSelection: { instanceId: "claudeAgent" as never, model: "claude-sonnet" },
        });
      }).pipe(Effect.provideContext(a.context));
      const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const sourceFile = NodePath.join(
        a.claudeHome,
        "projects",
        encode(a.root),
        `${CLAUDE_ID}.jsonl`,
      );
      NodeFS.mkdirSync(NodePath.dirname(sourceFile), { recursive: true });
      NodeFS.writeFileSync(
        sourceFile,
        `${JSON.stringify({
          type: "user",
          uuid: "44444444-4444-4444-8444-444444444444",
          sessionId: CLAUDE_ID,
          cwd: a.root,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "hello from the first computer" },
        })}\n`,
      );
      const movesA = yield* startMoves(a);
      yield* startMoves(b);

      yield* inWorld(a, movesA.request(moveInput("claude-out", idB)));
      yield* inWorld(a, movesA.drain());
      const [row] = yield* rowsOf(a);
      assert.deepEqual([row!.state, row!.error], ["complete", null]);
      // The destination files it where Claude looks for sessions of the workspace the move created.
      const landed = NodeFS.readdirSync(NodePath.join(b.claudeHome, "projects"))
        .map((directory) =>
          NodePath.join(b.claudeHome, "projects", directory, `${CLAUDE_ID}.jsonl`),
        )
        .filter((file) => NodeFS.existsSync(file));
      assert.lengthOf(landed, 1);
      assert.equal(sha(landed[0]!), sha(sourceFile));
    }).pipe(Effect.scoped),
);
