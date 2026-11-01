import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { NodeCrypto } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeBaseSessions } from "./BaseSessions.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectStore from "./ProjectStore.ts";

const baseId = ThreadId.make("prepared-base");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex-work"),
  model: "gpt-5",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const input = {
  type: "message.dispatch",
  commandId: CommandId.make("task-request"),
  threadId: baseId,
  messageId: MessageId.make("task-message"),
  text: "Implement the task",
  dispatchMode: { type: "start_immediately" },
  attachments: [],
  createdBy: "user",
  creationSource: "web",
} as const;
function harness() {
  const source = {
    id: baseId,
    isBase: true,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
  } as unknown as OrchestrationV2ThreadShell;
  const shells = new Map([[baseId, source]]);
  const accepted = new Map<string, OrchestrationV2Command>();
  const migratedMessages = new Map<ThreadId, Array<{ id: MessageId; runId: RunId }>>();
  const migratedRuns = new Map<ThreadId, Array<{ id: RunId; status: string }>>();
  let loseForkReply = false,
    loseSendReply = false;
  let acceptance = Effect.void;
  let providerFailed = false;
  const startReceipt = (commandId: string) =>
    ({
      id: commandId,
      commandId: CommandId.make(commandId),
      threadId: baseId,
      request: { type: "provider-turn.start", runId: RunId.make(commandId) },
      status: "succeeded",
      lastError: null,
    }) as EffectOutbox.OrchestrationEffectV2;
  const outbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
    listByCommandId: (commandId) =>
      Effect.sync(() => (accepted.has(commandId) ? [startReceipt(commandId)] : [])),
    awaitSettled: () => Effect.suspend(() => acceptance),
    get: (id) => Effect.sync(() => Option.some(startReceipt(id))),
  });
  const layer = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadRecords: (id) =>
      Effect.sync(
        () =>
          ({
            thread: shells.get(id),
            messages: migratedMessages.get(id) ?? [],
            runs: [
              ...(migratedRuns.get(id) ?? []),
              ...[...accepted.values()]
                .filter((command) => command.type === "message.dispatch" && command.threadId === id)
                .map((command) => ({
                  id: RunId.make(command.commandId),
                  status: providerFailed ? "failed" : "running",
                })),
            ],
          }) as never,
      ),
    getThreadEventSequence: () => Effect.sync(() => accepted.size),
    getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
    dispatch: (command) =>
      Effect.gen(function* () {
        if (!accepted.has(command.commandId)) {
          accepted.set(command.commandId, command as OrchestrationV2Command);
          if (command.type === "thread.fork")
            shells.set(command.targetThreadId, {
              ...source,
              id: command.targetThreadId,
              isBase: false,
            });
          if (command.type === "thread.create")
            shells.set(command.threadId, { ...source, id: command.threadId, isBase: false });
          if (command.type === "thread.metadata.update")
            shells.set(command.threadId, {
              ...shells.get(command.threadId)!,
              isBase: command.isBase,
            });
        }
        if (
          (command.type === "thread.fork" && loseForkReply) ||
          (command.type === "message.dispatch" && loseSendReply)
        ) {
          loseForkReply = false;
          loseSendReply = false;
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "lost reply after commit",
          });
        }
        return { sequence: accepted.size, storedEvents: [] };
      }),
  });
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Orchestrator.OrchestratorV2
      | SqlClient.SqlClient
      | Crypto.Crypto
      | EffectOutbox.EffectOutboxV2
    >,
  ) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(layer, outbox, NodeCrypto.layer, SqlitePersistence.layerMemory),
      ),
    );
  return {
    source,
    migratedMessages,
    migratedRuns,
    setAcceptance: (effect: Effect.Effect<void>) => {
      acceptance = effect;
    },
    failProvider: () => {
      providerFailed = true;
    },
    shells,
    accepted,
    run,
    loseFork: () => {
      loseForkReply = true;
    },
    loseSend: () => {
      loseSendReply = true;
    },
  };
}
it.effect(
  "retains a native fork through lost fork and send replies, preserving source profile and request identity",
  () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        let bases = yield* makeBaseSessions(orchestrator);
        const original = structuredClone(h.source);
        h.loseFork();
        yield* Effect.flip(bases.dispatch(input));
        assert.equal(h.shells.size, 2);
        // Recreating the service models process restart: only the SQL receipt survives.
        bases = yield* makeBaseSessions(orchestrator);
        h.loseSend();
        yield* Effect.flip(bases.dispatch(input));
        const retryPolicy = yield* bases.policyCommand(input);
        assert.equal(retryPolicy?.commandId, "base-send:task-request");
        assert.deepEqual(retryPolicy?.modelSelection, modelSelection);
        const result = yield* bases.dispatch(input);
        assert.isNull(yield* bases.policyCommand(input));
        const replay = yield* bases.dispatch(input);
        assert.equal(result.threadId, replay.threadId);
        assert.notEqual(result.threadId, baseId);
        assert.equal(h.accepted.size, 2);
        assert.deepEqual(h.source, original);
        assert.deepEqual(h.accepted.get("base-fork:task-request"), {
          type: "thread.fork",
          commandId: CommandId.make("base-fork:task-request"),
          sourceThreadId: baseId,
          targetThreadId: result.threadId!,
          sourcePoint: { type: "latest_stable" },
          nativeOnly: true,
          createdBy: "user",
          creationSource: "web",
        });
        assert.deepEqual(h.accepted.get("base-send:task-request")?.type, "message.dispatch");
        assert.deepEqual(h.shells.get(result.threadId!)?.modelSelection, modelSelection);
        assert.equal(h.shells.get(result.threadId!)?.runtimeMode, "full-access");
        assert.equal(h.shells.get(result.threadId!)?.interactionMode, "plan");
        assert.equal(h.shells.get(result.threadId!)?.isBase, false);
        const conflict = yield* Effect.flip(bases.dispatch({ ...input, text: "Different task" }));
        assert.include(String(conflict.cause), "another message");
        assert.equal(h.accepted.size, 2);
      }),
    );
  },
);
it.effect(
  "busy bases and automatic continuations refuse without making a fork; explicit refresh stays on the base",
  () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const bases = yield* makeBaseSessions(yield* Orchestrator.OrchestratorV2);
        h.shells.set(baseId, { ...h.source, status: "running" });
        const busy = yield* Effect.flip(bases.dispatch(input));
        assert.include(String(busy.cause), "busy");
        assert.equal(h.accepted.size, 0);
        h.shells.set(baseId, h.source);
        const background = yield* Effect.flip(
          bases.dispatch({ ...input, idleCompaction: "onReturn" }),
        );
        assert.include(String(background.cause), "cannot mutate");
        assert.equal(h.accepted.size, 0);
        const refreshed = yield* bases.dispatch({ ...input, initializeBase: true });
        assert.equal(refreshed.threadId, baseId);
        assert.equal(h.shells.size, 1);
        assert.equal(h.accepted.size, 1);
        assert.equal(h.shells.get(baseId)?.isBase, true);
      }),
    );
  },
);
it.effect(
  "create and initialize saves the project prompt once, and a retry does not duplicate creation or initialization",
  () => {
    const h = harness();
    let prompt = "Read the architecture first";
    const projectLayer = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.sync(() => Option.some({ basePrompt: prompt } as never)),
    });
    return h.run(
      Effect.gen(function* () {
        const bases = yield* makeBaseSessions(yield* Orchestrator.OrchestratorV2);
        const creation = {
          clientRequestId: "create-base",
          threadId: ThreadId.make("new-base"),
          projectId: ProjectId.make("project"),
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "plan" as const,
          createdAt: "2026-11-01T00:00:00.000Z",
        };
        const first = yield* bases.create(creation);
        prompt = "Changed prompt";
        yield* bases.create(creation);
        assert.equal(first.threadId, creation.threadId);
        assert.equal(h.accepted.size, 3);
        const message = h.accepted.get("base-send:base-create:create-base:initialize");
        assert.equal(message?.type, "message.dispatch");
        if (message?.type === "message.dispatch")
          assert.equal(message.text, "Read the architecture first");
        assert.equal(h.shells.get(creation.threadId)?.isBase, true);
      }).pipe(Effect.provide(projectLayer)),
    );
  },
);

it.effect(
  "does not acknowledge a Base task until provider acceptance; startup failure remains inspectable without another fork",
  () => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const accepted = yield* Deferred.make<void>();
        h.setAcceptance(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
        );
        const bases = yield* makeBaseSessions(yield* Orchestrator.OrchestratorV2);
        const pending = yield* bases.dispatch(input).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const sql = yield* SqlClient.SqlClient;
        const before = (yield* sql<{
          state: string;
          thread_id: string;
        }>`SELECT state, thread_id FROM base_session_submissions`)[0]!;
        assert.equal(before.state, "prepared");
        assert.isUndefined(pending.pollUnsafe());
        h.failProvider();
        yield* Deferred.succeed(accepted, undefined);
        const failed = yield* Effect.flip(Fiber.join(pending));
        assert.include(String(failed.cause), "did not accept");
        yield* Effect.flip(bases.dispatch(input));
        const after = (yield* sql<{
          state: string;
          thread_id: string;
        }>`SELECT state, thread_id FROM base_session_submissions`)[0]!;
        assert.equal(after.state, "failed");
        assert.equal(after.thread_id, before.thread_id);
        assert.equal(h.shells.size, 2);
        assert.equal(h.accepted.size, 2);
      }),
    );
  },
);

it.effect.each(["confirmed", "prepared", "completed", "uncertain", "cloning"] as const)(
  "recovers a migrated V1 %s Base receipt without a second native fork",
  (scenario) => {
    const h = harness();
    return h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const destination = ThreadId.make("v1-independent-fork");
        const messageId = MessageId.make("base-send:task-request");
        const runId = RunId.make("v1-run");
        h.shells.set(destination, { ...h.source, id: destination, isBase: false });
        const previous = {
          type: "thread.turn.start",
          commandId: input.commandId,
          threadId: input.threadId,
          message: { messageId: input.messageId, text: input.text, attachments: input.attachments },
        };
        const prepared = {
          ...previous,
          threadId: destination,
          commandId: "base-send:task-request",
          message: { ...previous.message, messageId },
        };
        const state =
          scenario === "confirmed" ? "started" : scenario === "cloning" ? "cloning" : "prepared";
        yield* sql`INSERT INTO base_session_submissions (request_id,input_json,source_id,thread_id,command_json,state) VALUES (${input.commandId},${JSON.stringify(previous)},${input.threadId},${destination},${scenario === "cloning" ? null : JSON.stringify(prepared)},${state})`;
        if (scenario === "completed" || scenario === "uncertain") {
          h.migratedMessages.set(destination, [{ id: messageId, runId }]);
          h.migratedRuns.set(destination, [
            { id: runId, status: scenario === "completed" ? "completed" : "interrupted" },
          ]);
        }
        const hydrated: ThreadId[] = [];
        const bases = yield* makeBaseSessions(yield* Orchestrator.OrchestratorV2, (id) =>
          Effect.sync(() => {
            hydrated.push(id);
          }),
        );
        if (scenario === "uncertain" || scenario === "cloning") {
          const error = yield* Effect.flip(bases.dispatch(input));
          assert.include(String(error.cause), destination);
          yield* Effect.flip(bases.dispatch(input));
          assert.equal(h.accepted.size, 0);
        } else {
          const result = yield* bases.dispatch(input);
          assert.equal(result.threadId, destination);
          yield* bases.dispatch(input);
          assert.equal(h.accepted.size, scenario === "prepared" ? 1 : 0);
          if (scenario === "prepared") {
            const sent = h.accepted.get("base-send:task-request");
            assert.equal(sent?.type, "message.dispatch");
            if (sent?.type === "message.dispatch") assert.equal(sent.messageId, messageId);
            assert.deepEqual(hydrated, [destination]);
          }
        }
        assert.isFalse([...h.accepted.values()].some((command) => command.type === "thread.fork"));
        assert.equal(h.source.isBase, true);
        const changed = yield* Effect.flip(bases.dispatch({ ...input, text: "Changed task" }));
        assert.include(String(changed.cause), "another message");
      }),
    );
  },
);
