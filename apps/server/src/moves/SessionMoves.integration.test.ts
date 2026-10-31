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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { master, model, project, seed } from "../workers/integration.testkit.ts";
import {
  type Computer,
  makeComputer,
  newNetwork,
  on as inWorld,
} from "../workers/peerWorld.testkit.ts";
import * as SessionMoves from "./SessionMoves.ts";

const NATIVE_ID = "0248b7d6-1ead-447d-894b-5edbafe089df";
const ROLLOUT = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${NATIVE_ID}.jsonl`;
const idA = "environment-a" as EnvironmentId;
const idB = "environment-b" as EnvironmentId;
type World = Computer;
const makeWorld = makeComputer;

const sha = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

const seedSession = Effect.fn("seedSession")(function* (world: World) {
  const at = yield* DateTime.now;
  yield* seed(master, world.root).pipe(Effect.provideContext(world.context));
  const sink = yield* EventSink.EventSinkV2.pipe(Effect.provideContext(world.context));
  const providerThreadId = ProviderThreadId.make("provider-thread:moving");
  yield* sink.write({
    events: [
      {
        id: EventId.make("seed:moving-provider-thread"),
        type: "provider-thread.updated",
        threadId: master,
        occurredAt: at,
        payload: {
          id: providerThreadId,
          driver: model.instanceId === "codex" ? ("codex" as never) : ("codex" as never),
          providerInstanceId: model.instanceId,
          providerSessionId: null,
          appThreadId: master,
          ownerNodeId: null,
          nativeThreadRef: { driver: "codex" as never, nativeId: NATIVE_ID, strength: "strong" },
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
  const rollout = NodePath.join(world.codexHome, ROLLOUT);
  NodeFS.mkdirSync(NodePath.dirname(rollout), { recursive: true });
  NodeFS.writeFileSync(
    rollout,
    `${JSON.stringify({ type: "session_meta", payload: { id: NATIVE_ID } })}\n${JSON.stringify({ type: "event_msg", payload: { text: "hello" } })}\n`,
  );
  return rollout;
});

const moveInput = (requestId: string, environment: EnvironmentId): SessionMoveInput => ({
  requestId: CommandId.make(requestId),
  threadId: master,
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
