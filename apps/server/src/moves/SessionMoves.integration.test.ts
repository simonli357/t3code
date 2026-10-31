// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type EnvironmentId,
  EventId,
  OrchestratorMcpFailure,
  ProviderThreadId,
  type SessionMoveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerRequests from "../peer/PeerRequests.ts";
import {
  defaultProviders,
  layerRuntime,
  master,
  model,
  project,
  seed,
} from "../workers/integration.testkit.ts";
import * as SessionMoves from "./SessionMoves.ts";

const NATIVE_ID = "0248b7d6-1ead-447d-894b-5edbafe089df";
const ROLLOUT = `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${NATIVE_ID}.jsonl`;
const idA = "environment:a" as EnvironmentId;
const idB = "environment:b" as EnvironmentId;

const tmp = (name: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-moves-${name}-`));
const sha = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

type Handler = PeerRequests.PeerRequests["Service"]["handle"];
interface Network {
  readonly handlers: Map<string, Handler>;
  /** Peer operations that fail once as an outage, keyed by the operation name. */
  readonly outages: Set<string>;
}

const layerPeers = (self: EnvironmentId, other: EnvironmentId, network: Network) =>
  Layer.mergeAll(
    Layer.mock(PeerLinks.PeerLinks)({
      list: Effect.succeed([{ environmentId: other, label: `Peer ${other}` } as never]),
    }),
    Layer.effect(
      PeerRequests.PeerRequests,
      Effect.sync(() => {
        const topics = new Map<string, PeerRequests.PeerRequestHandler>();
        const handle: Handler = (from, topic, body) => {
          const handler = topics.get(topic);
          return handler
            ? handler(from, body)
            : Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: topic }));
        };
        network.handlers.set(self, handle);
        return PeerRequests.PeerRequests.of({
          register: (topic, handler) => Effect.sync(() => void topics.set(topic, handler)),
          handle,
          call: (environmentId, topic, body) => {
            const operation = (body as { readonly op?: string }).op ?? "";
            if (network.outages.delete(operation))
              return Effect.fail(
                new PeerRequests.PeerUnavailable({ environmentId, message: "offline" }),
              );
            return network.handlers.get(environmentId)!(self, topic, body).pipe(
              Effect.mapError((cause) => new PeerRequests.PeerRejected({ message: cause.message })),
            );
          },
        });
      }),
    ),
  );

const layerWorld = (
  self: EnvironmentId,
  other: EnvironmentId,
  network: Network,
  world: string,
  codexHome: string,
) =>
  SessionMoves.layer.pipe(
    Layer.provideMerge(layerPeers(self, other, network)),
    Layer.provideMerge(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(world, { prefix: `t3-moves-${self}-` })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      layerRuntime(defaultProviders, {
        environmentId: self,
        label: `Peer ${self}`,
        workspaceRoot: world,
        codexHome,
      }),
    ),
  );

interface World {
  readonly context: Context.Context<Layer.Success<ReturnType<typeof layerWorld>>>;
  readonly root: string;
  readonly codexHome: string;
}

const makeWorld = Effect.fn("makeWorld")(function* (
  self: EnvironmentId,
  other: EnvironmentId,
  network: Network,
) {
  const root = tmp(self.replace(/\W/g, ""));
  git(root, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  const codexHome = tmp(`${self.replace(/\W/g, "")}-codex`);
  const scope = yield* Effect.scope;
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(codexHome, { recursive: true, force: true });
    }),
  );
  const context = yield* Layer.build(layerWorld(self, other, network, root, codexHome));
  return { context, root, codexHome } satisfies World;
});

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

const inWorld = <A, E, R>(world: World, effect: Effect.Effect<A, E, R>) =>
  Effect.provideContext(effect, world.context);

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

const newNetwork = (): Network => ({ handlers: new Map(), outages: new Set() });

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
