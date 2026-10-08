import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { EnvironmentId } from "@t3tools/contracts";
import * as WorkerTools from "../mcp/toolkits/workers/tools.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Workers from "./WorkerControls.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { ServerProvider, TurnId } from "@t3tools/contracts";

const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const infrastructure = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository)),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-fork-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const instances = [
  ["codex", "codex", "gpt-6.1-sol", "reasoningEffort", "max"],
  ["codex_antoine", "codex", "gpt-6-astra", "reasoningEffort", "high"],
  ["claudeAgent", "claudeAgent", "claude-opus-5-5", "effort", "xhigh"],
  ["claude_eol", "claudeAgent", "claude-sonnet-5-5", "effort", "max"],
  ["deepseek_codex", "codex", "deepseek-flash", "reasoningEffort", "max"],
] as const;
const selections = instances.map(([id, , model, option, value]) => ({
  instanceId: ProviderInstanceId.make(id),
  model,
  options: [{ id: option, value }],
}));
const providerLayer = Layer.mock(ProviderService)({
  forkConversation: (id) => Effect.succeed({ threadId: `native-fork-${id}` }),
});
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const registry = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed(
    instances.map(([id, driver, model, option, value]) =>
      decodeProvider({
        driver,
        instanceId: id,
        displayName: id,
        enabled: true,
        installed: true,
        availability: "available",
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-06T12:00:00.000Z",
        models: [
          {
            slug: model,
            name: model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: option,
                  label: option,
                  type: "select",
                  options: [{ id: value, label: value }],
                },
              ],
            },
          },
        ],
      }),
    ),
  ),
});
const testLayer = Workers.layer.pipe(
  Layer.provideMerge(infrastructure),
  Layer.provideMerge(providerLayer),
  Layer.provideMerge(registry),
);
const timestamp = "2026-10-06T12:00:00.000Z";
const seed = Effect.fn(function* (prefix: string, index = 0) {
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const modelSelection = selections[index]!;
  const owner = ThreadId.make(`${prefix}-master`);
  const source = ThreadId.make(`${prefix}-base`);
  const worker = ThreadId.make(`${prefix}-worker`);
  const projectId = ProjectId.make(prefix);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`${prefix}-project`),
    projectId,
    title: prefix,
    workspaceRoot: `/tmp/${prefix}`,
    createdAt: timestamp,
  });
  for (const id of [owner, source]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: id,
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      historyImport: true,
      createdAt: timestamp,
    });
  }
  yield* engine.dispatch({
    type: "thread.history.import",
    commandId: CommandId.make(`history-${source}`),
    threadId: source,
    messages: [
      {
        messageId: MessageId.make(`base-message-${source}`),
        role: "assistant",
        text: "Inherited base context",
        createdAt: timestamp,
      },
    ],
  });
  yield* directory.upsert({
    threadId: source,
    provider: ProviderDriverKind.make(instances[index]![1]),
    providerInstanceId: modelSelection.instanceId,
    runtimeMode: "full-access",
    status: "stopped",
    resumeCursor: { threadId: `native-${source}` },
    runtimePayload: { cwd: `/tmp/${prefix}` },
  });
  return {
    owner,
    source,
    worker,
    input: {
      threadId: worker,
      sourceThreadId: source,
      title: `${prefix}_WORKER`,
      modelSelection,
      prompt: "first task",
    },
  };
});
const session = Effect.fn(function* (
  threadId: ThreadId,
  status: "running" | "ready" | "error",
  suffix: string,
) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`${threadId}-${suffix}`),
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: status === "running" ? TurnId.make(suffix) : null,
      lastError: status === "error" ? "Test provider error" : null,
      updatedAt: timestamp,
    },
    createdAt: timestamp,
  });
});
const reply = Effect.fn(function* (threadId: ThreadId, turn: string, text: string) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.message.assistant.delta",
    commandId: CommandId.make(`delta-${turn}`),
    threadId,
    messageId: MessageId.make(`assistant-${turn}`),
    delta: text,
    turnId: TurnId.make(turn),
    createdAt: timestamp,
  });
  yield* engine.dispatch({
    type: "thread.message.assistant.complete",
    commandId: CommandId.make(`reply-${turn}`),
    threadId,
    messageId: MessageId.make(`assistant-${turn}`),
    turnId: TurnId.make(turn),
    createdAt: timestamp,
  });
});
const directInput = Effect.fn(function* (threadId: ThreadId, suffix: string) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`direct-${suffix}`),
    threadId,
    message: {
      messageId: MessageId.make(`human-${suffix}`),
      role: "user",
      text: "continue directly",
      attachments: [],
    },
    modelSelection: selections[0]!,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: timestamp,
  });
});
it.layer(testLayer)("persistent workers", (it) => {
  it.effect("automatically wakes the master for a newly registered worker", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const events = yield* engine.subscribeDomainEvents;
      yield* service.start();
      const { owner, worker, input } = yield* seed("automatic");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "automatic-turn");
      yield* reply(worker, "automatic-turn", "automatic result");
      yield* session(worker, "ready", "automatic-completed");
      const reports = yield* events.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.turn-start-requested" && event.payload.threadId === owner,
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(reports).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  for (const [index, instance] of instances.entries()) {
    it.effect(
      `preserves ${instance[0]} profile, isolates base history, and deduplicates retries`,
      () =>
        Effect.gen(function* () {
          const service = yield* Workers.WorkerControls;
          const snapshots = yield* ProjectionSnapshotQuery;
          const { owner, source, worker, input } = yield* seed(`profile-${index}`, index);
          yield* service.spawn(owner, input);
          yield* service.spawn(owner, input);
          const result = (yield* service.list(owner))[0]!;
          expect(result.sourceThreadId).toBe(source);
          expect(result.ownerThreadId).toBe(owner);
          expect(result.modelSelection).toEqual(selections[index]);
          const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
          expect(thread.messages.filter((m) => m.text === "first task")).toHaveLength(1);
          expect(
            Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).messages,
          ).toHaveLength(1);
          expect(
            (yield* service.read(owner, { threadId: worker })).items.some((item) =>
              item.text.includes("Inherited base"),
            ),
          ).toBe(false);
          const mismatch = yield* service
            .spawn(owner, { ...input, prompt: "different" })
            .pipe(Effect.flip);
          expect(mismatch.message).toContain("different");
        }),
    );
  }
  it.effect("queues follow-ups and reports each result only when the master is idle", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("loop");
      yield* session(owner, "running", "master-turn");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "worker-first");
      const follow = {
        threadId: worker,
        clientRequestId: "correction",
        prompt: "fix the remaining problem",
      };
      expect((yield* service.send(owner, follow)).state).toBe("queued");
      yield* service.send(owner, follow);
      yield* reply(worker, "worker-first", "first result");
      yield* session(worker, "ready", "first-finished");
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        0,
      );
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).messages.filter(
          (m) => m.text === follow.prompt,
        ),
      ).toHaveLength(1);
      yield* session(owner, "ready", "master-finished");
      yield* service.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
          m.text.includes("T3 worker report"),
        ),
      ).toHaveLength(1);
      yield* session(owner, "running", "master-report");
      yield* session(owner, "ready", "master-report-finished");
      yield* session(worker, "running", "worker-second");
      yield* reply(worker, "worker-second", "corrected result");
      yield* session(worker, "ready", "second-finished");
      yield* service.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
          m.text.includes("T3 worker report"),
        ),
      ).toHaveLength(2);
      yield* service.drain();
      expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("completed");
    }),
  );
  it.effect("automatically reports direct worker turns without repeating assignment reports", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("direct");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "assigned-turn");
      yield* reply(worker, "assigned-turn", "assigned result");
      yield* session(worker, "ready", "assigned-finished");
      yield* service.drain();
      yield* session(owner, "running", "assigned-report");
      yield* session(owner, "ready", "assigned-report-finished");
      const events = yield* engine.subscribeDomainEvents;
      yield* service.start();
      yield* directInput(worker, "automatic");
      yield* session(worker, "running", "direct-turn");
      yield* reply(worker, "direct-turn", "direct result");
      yield* session(worker, "ready", "direct-finished");
      yield* events.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.turn-start-requested" && event.payload.threadId === owner,
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      yield* service.drain();
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages.filter((m) => m.text.includes("assigned result"))).toHaveLength(1);
      expect(messages.filter((m) => m.text.includes("direct result"))).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  it.effect("recovers direct worker results after restart and respects paused notifications", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("direct-restart");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "before-direct");
      yield* session(worker, "error", "original-failed");
      yield* service.drain();
      yield* session(owner, "running", "error-report");
      yield* session(owner, "ready", "error-report-finished");
      yield* service.control(owner, { threadId: worker, notifications: false });
      yield* directInput(worker, "restart");
      yield* session(worker, "running", "restart-direct-turn");
      yield* reply(worker, "restart-direct-turn", "recovered direct result");
      yield* session(worker, "ready", "restart-direct-finished");
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      yield* restarted.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
          m.text.includes("recovered direct result"),
        ),
      ).toHaveLength(0);
      yield* restarted.control(owner, { threadId: worker, notifications: true });
      yield* restarted.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
          m.text.includes("recovered direct result"),
        ),
      ).toHaveLength(1);
      const again = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      yield* again.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
          m.text.includes("recovered direct result"),
        ),
      ).toHaveLength(1);
    }),
  );
  it.effect("does not replay superseded direct turns or settled workers on upgrade", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("superseded");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "superseded-assignment");
      yield* session(worker, "ready", "superseded-assignment-finished");
      yield* service.drain();
      yield* session(owner, "running", "superseded-report");
      yield* session(owner, "ready", "superseded-report-finished");
      for (const name of ["old-direct", "latest-direct"]) {
        yield* directInput(worker, name);
        yield* session(worker, "running", name);
        yield* reply(worker, name, name);
        yield* session(worker, "ready", `${name}-finished`);
      }
      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-direct"),
        threadId: worker,
      });
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle-direct"),
        threadId: worker,
        reason: "user",
      });
      yield* service.drain();
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages.filter((m) => m.text.includes("latest-direct"))).toHaveLength(1);
      expect(messages.filter((m) => m.text.includes("old-direct"))).toHaveLength(0);
    }),
  );
  it.effect(
    "rejects changed settings before enqueue and explicitly adopts an intentional account switch",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, input } = yield* seed("adopt");
        yield* service.spawn(owner, input);
        yield* session(worker, "running", "adopt-active");
        const follow = {
          threadId: worker,
          clientRequestId: "accepted",
          prompt: "queued correction",
        };
        yield* service.send(owner, follow);
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("switch-account"),
          threadId: worker,
          modelSelection: selections[1]!,
        });
        expect((yield* service.send(owner, follow)).state).toBe("queued");
        const rejected = yield* service
          .send(owner, { ...follow, clientRequestId: "rejected" })
          .pipe(Effect.flip);
        expect(rejected.message).toContain("adoptCurrentSettings");
        expect(
          yield* sql`SELECT id FROM custom_worker_jobs WHERE id = ${`${worker}:rejected`}`,
        ).toHaveLength(0);
        const adopted = yield* service.control(owner, {
          threadId: worker,
          adoptCurrentSettings: true,
        });
        expect(adopted.modelSelection).toEqual(selections[1]);
        yield* session(worker, "ready", "adopt-finished");
        yield* service.drain();
        expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("submitted");
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
        expect(detail.modelSelection).toEqual(selections[1]);
        expect(detail.messages.filter((m) => m.text === follow.prompt)).toHaveLength(1);
        const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
        expect((yield* restarted.list(owner))[0]!.modelSelection).toEqual(selections[1]);
      }),
  );
  it.effect("keeps delivery checks when settings change after enqueue", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("late-switch");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "late-active");
      const follow = { threadId: worker, clientRequestId: "queued", prompt: "must not deliver" };
      yield* service.send(owner, follow);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("late-account"),
        threadId: worker,
        modelSelection: selections[1]!,
      });
      yield* session(worker, "ready", "late-finished");
      yield* service.drain();
      expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("error");
      yield* service.control(owner, { threadId: worker, adoptCurrentSettings: true });
      expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("error");
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).messages.some(
          (m) => m.text === follow.prompt,
        ),
      ).toBe(false);
    }),
  );
  it.effect("restricts adoption to the owner, valid profiles, and the master's permissions", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const { owner, worker, source, input } = yield* seed("adopt-invalid");
      yield* service.spawn(owner, input);
      expect(
        (yield* service
          .control(source, { threadId: worker, adoptCurrentSettings: true })
          .pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("invalid-effort"),
        threadId: worker,
        modelSelection: {
          ...selections[1]!,
          options: [{ id: "reasoningEffort", value: "invalid" }],
        },
      });
      expect(
        (yield* service
          .control(owner, { threadId: worker, adoptCurrentSettings: true })
          .pipe(Effect.flip)).message,
      ).toContain("does not support");
      expect((yield* service.list(owner))[0]!.modelSelection).toEqual(input.modelSelection);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("valid-profile"),
        threadId: worker,
        modelSelection: selections[1]!,
      });
      yield* engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("restrict-master"),
        threadId: owner,
        runtimeMode: "approval-required",
        createdAt: timestamp,
      });
      expect(
        (yield* service
          .control(owner, { threadId: worker, adoptCurrentSettings: true })
          .pipe(Effect.flip)).message,
      ).toContain("broader permissions");
      expect(
        (yield* service
          .send(owner, { threadId: worker, clientRequestId: "unsafe", prompt: "work" })
          .pipe(Effect.flip)).message,
      ).toContain("broader permissions");
      expect((yield* service.list(owner))[0]!.modelSelection).toEqual(input.modelSelection);
    }),
  );
  it.effect("rejects other masters and reports provider errors without substituting models", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const { owner, worker, source, input } = yield* seed("errors");
      yield* service.spawn(owner, input);
      expect(
        (yield* service.read(source, { threadId: worker }).pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      yield* session(worker, "running", "error-turn");
      yield* session(worker, "error", "provider-error");
      yield* service.drain();
      const request = (yield* service.list(owner))[0]!.latestRequest!;
      expect(request.state).toBe("error");
      expect(request.error).toBe("Test provider error");
      expect(
        (yield* service.wait(owner, { threadId: worker, requestId: request.requestId })).timedOut,
      ).toBe(false);
    }),
  );
  it.effect("recovers an accepted send and pending reports after service restart", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("restart");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "restart-turn");
      yield* service.send(owner, {
        threadId: worker,
        clientRequestId: "next",
        prompt: "second assignment",
      });
      // A crash after engine acceptance but before queue acknowledgement.
      yield* sql`UPDATE custom_worker_jobs SET state = 'queued' WHERE id = ${`spawn:${worker}`}`;
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      yield* restarted.drain();
      yield* reply(worker, "restart-turn", "durable result");
      yield* session(worker, "ready", "restart-complete");
      yield* restarted.drain();
      const master = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner));
      expect(master.messages.filter((m) => m.text.includes("durable result"))).toHaveLength(1);
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).messages.filter(
          (m) => m.text === "first task",
        ),
      ).toHaveLength(1);
      expect((yield* restarted.list(owner))[0]!.latestRequest!.state).toBe("submitted");
      const output = yield* restarted.read(owner, { threadId: worker });
      expect(output.items.some((item) => item.text === "durable result")).toBe(true);
      const again = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      expect((yield* again.read(owner, { threadId: worker })).items).toHaveLength(0);
    }),
  );
  it.effect("paginates long output without losing text or reloading base history", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const { owner, worker, input } = yield* seed("pagination");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "long-turn");
      const content = "long-result-".repeat(3000);
      yield* reply(worker, "long-turn", content);
      yield* session(worker, "ready", "long-complete");
      let output = "";
      for (let page = 0; page < 10; page++) {
        const result = yield* service.read(owner, { threadId: worker });
        output += result.items
          .filter((item) => item.kind === "assistant")
          .map((item) => item.text)
          .join("");
        if (!result.hasMore) break;
      }
      expect(output).toBe(content);
    }),
  );
  it.effect("reports startup failure even when no native turn was created", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const { owner, worker, input } = yield* seed("startup-error");
      yield* service.spawn(owner, input);
      yield* session(worker, "error", "startup-failed");
      yield* service.drain();
      expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("error");
    }),
  );
  it.effect("cancels queued work and can pause completion reports", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("control");
      yield* service.spawn(owner, input);
      yield* service.control(owner, { threadId: worker, notifications: false });
      const queued = yield* service.send(owner, {
        threadId: worker,
        clientRequestId: "cancel",
        prompt: "do not run",
      });
      yield* service.control(owner, { threadId: worker, cancelRequestId: queued.requestId });
      yield* session(worker, "running", "control-turn");
      yield* reply(worker, "control-turn", "held result");
      yield* session(worker, "ready", "control-finished");
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        0,
      );
      yield* service.control(owner, { threadId: worker, notifications: true });
      yield* service.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.some((m) =>
          m.text.includes("held result"),
        ),
      ).toBe(true);
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).messages.some(
          (m) => m.text === "do not run",
        ),
      ).toBe(false);
    }),
  );
  it.effect("rejects a stale dispatch atomically and retries its queued assignment", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("race");
      yield* service.spawn(owner, input);
      const queued = yield* service.send(owner, {
        threadId: worker,
        clientRequestId: "race",
        prompt: "next after human",
      });
      const sequence = yield* engine.latestSequence;
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("race-update"),
        threadId: worker,
        title: "new title",
      });
      const error = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`worker-job:${queued.requestId}:0`),
          threadId: worker,
          expectedThreadSequence: sequence,
          message: {
            messageId: MessageId.make(`worker-job:${queued.requestId}`),
            role: "user",
            text: "next after human",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: timestamp,
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("precondition changed");
      yield* session(worker, "running", "race-first");
      yield* session(worker, "ready", "race-first-done");
      yield* service.drain();
      yield* service.drain();
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).messages.filter(
          (m) => m.text === "next after human",
        ),
      ).toHaveLength(1);
    }),
  );
});

const mcpLayer = McpServer.toolkit(WorkerTools.WorkersToolkit).pipe(
  Layer.provide(WorkerTools.handlers),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(testLayer),
);
it.layer(mcpLayer)("worker MCP", (it) => {
  it.effect("uses the authenticated master for spawn, list, read and follow-up", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const { owner, worker, input } = yield* seed("mcp");
      const scope = {
        environmentId: EnvironmentId.make("test"),
        threadId: owner,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<Invocation.McpCapability>(),
        issuedAt: 1,
      };
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const call = (name: string, args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const spawned = yield* call("t3_worker_spawn", { ...input, ownerThreadId: "forged" });
      expect(spawned.isError).not.toBe(true);
      const listed = yield* call("t3_worker_list", {});
      expect(listed.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining(owner) }),
        ]),
      );
      expect((yield* call("t3_worker_read", { threadId: worker })).isError).not.toBe(true);
      expect(
        (yield* call("t3_worker_send", {
          threadId: worker,
          clientRequestId: "next",
          prompt: "follow-up",
        })).isError,
      ).not.toBe(true);
    }),
  );
});
