import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, ProviderDriverKind, ProviderInstanceId, ProviderSessionId, ProviderThreadId, RunId, ThreadId, type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

it.effect.each(["completed", "running", "weak", "unsupported"] as const)("whole-session fork handles %s without sending a turn", (scenario) => {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const calls: ProviderAdapter.ProviderAdapterV2ForkThreadInput[] = [];
  const modelSelection = { instanceId, model: "test-model", options: { reasoningEffort: "high" } };
  const capabilities = scenario === "unsupported" ? { ...CodexProviderCapabilitiesV2, threads: { ...CodexProviderCapabilitiesV2.threads, supportsFork: false } } : CodexProviderCapabilitiesV2;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    driver, instanceId, getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) => Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        driver, instanceId, providerSessionId: input.providerSessionId,
        providerSession: { id: input.providerSessionId, driver, providerInstanceId: instanceId, status: "ready", cwd: input.runtimePolicy.cwd ?? "/tmp", model: input.modelSelection.model, capabilities, createdAt: now, updatedAt: now, lastError: null },
        events: Stream.never,
        ensureThread: () => Effect.die("must fork native history"),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: () => Effect.die("Fork must not send a prompt"),
        steerTurn: () => Effect.die("unused"), interruptTurn: () => Effect.die("unused"), respondToRuntimeRequest: () => Effect.die("unused"), readThreadSnapshot: () => Effect.die("unused"), rollbackThread: () => Effect.die("unused"),
        forkThread: (fork) => Effect.sync(() => {
          calls.push(fork);
          return { ...fork.sourceProviderThread, id: ProviderThreadId.make("clone-native"), appThreadId: fork.targetThreadId, providerSessionId: input.providerSessionId, nativeThreadRef: { driver, nativeId: "independent-native-history", strength: "strong" as const }, forkedFrom: { providerThreadId: fork.sourceProviderThread.id } };
        }), close: Effect.void,
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const source = ThreadId.make("source"), target = ThreadId.make("target");
    const native: OrchestrationV2ProviderThread = { id: ProviderThreadId.make("source-native"), driver, providerInstanceId: instanceId, providerSessionId: ProviderSessionId.make("source-session"), appThreadId: source, ownerNodeId: null, nativeThreadRef: { driver, nativeId: "source-history", strength: scenario === "weak" ? "weak" : "strong" }, nativeConversationHeadRef: null, status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 2, handoffIds: [], forkedFrom: null, createdAt: now, updatedAt: now };
    yield* orchestrator.dispatch({ type: "thread.create", commandId: CommandId.make("create"), threadId: source, projectId: ProjectId.make("project"), title: "source", modelSelection, runtimeMode: "full-access", interactionMode: "plan", branch: "feature", worktreePath: null, createdBy: "user", creationSource: "web" });
    yield* sink.write({ events: [{ id: EventId.make("native"), type: "provider-thread.updated", threadId: source, occurredAt: now, payload: native }] });
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run-${ordinal}`);
      yield* sink.write({ events: [{ id: EventId.make(`run-${ordinal}`), type: "run.created", threadId: source, runId, occurredAt: now, payload: { id: runId, threadId: source, ordinal, providerInstanceId: instanceId, modelSelection, providerThreadId: native.id, userMessageId: MessageId.make(`message-${ordinal}`), rootNodeId: null, activeAttemptId: null, status: scenario === "running" && ordinal === 2 ? "running" : "completed", queuePosition: null, requestedAt: now, startedAt: now, completedAt: now, checkpointId: null, contextHandoffId: null } }] });
    }
    const before = yield* orchestrator.getThreadProjection(source);
    const command = { type: "thread.fork" as const, commandId: CommandId.make("whole-fork"), wholeSession: true, nativeOnly: true, sourceThreadId: source, targetThreadId: target, sourcePoint: { type: "latest_stable" as const }, createdBy: "user" as const, creationSource: "web" as const };
    if (scenario !== "completed") {
      yield* orchestrator.dispatch(command).pipe(Effect.flip);
      assert.equal(calls.length, 0);
      assert.isNull(yield* orchestrator.getThreadShell(target));
    } else {
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch(command);
      assert.equal(calls.length, 1);
      assert.isUndefined(calls[0]!.providerTurnId);
      assert.deepEqual(calls[0]!.modelSelection, modelSelection);
      const fork = yield* orchestrator.getThreadProjection(target);
      assert.deepEqual(fork.thread.modelSelection, before.thread.modelSelection);
      assert.equal(fork.thread.runtimeMode, "full-access");
      assert.equal(fork.thread.interactionMode, "plan");
      assert.equal(fork.thread.isBase, false);
      assert.equal(fork.thread.activeProviderThreadId, "clone-native");
      assert.deepEqual(fork.thread.forkedFrom, { type: "run", threadId: source, runId: "run-2" });
      assert.equal(fork.contextTransfers[0]?.status, "consumed");
      assert.equal(fork.providerThreads[0]?.nativeThreadRef?.nativeId, "independent-native-history");
      assert.equal(fork.runs.length, 0);
    }
    assert.deepEqual(yield* orchestrator.getThreadProjection(source), before);
  }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name: `conversation-fork-${scenario}` }, ProviderAdapterRegistry.layerFromAdapters([adapter]), { runEffectWorker: false })));
});
