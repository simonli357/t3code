import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { EnvironmentId } from "@t3tools/contracts";
import * as WorkerTools from "../mcp/toolkits/workers/tools.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
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
import { PeerLinks, PeerRejected, PeerUnavailable, findPeer } from "./PeerLinks.ts";
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
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
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
const providers = instances.map(([id, driver, model, option, value]) =>
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
);
// Lets a test hold a delivery pass inside its provider check.
let providerGate:
  | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
  | undefined;
const registry = Layer.mock(ProviderRegistry)({
  getProviders: Effect.suspend(() =>
    providerGate
      ? Deferred.succeed(providerGate.entered, undefined).pipe(
          Effect.andThen(Deferred.await(providerGate.release)),
          Effect.as(providers),
        )
      : Effect.succeed(providers),
  ),
});
const noPeers = Layer.succeed(
  PeerLinks,
  PeerLinks.of({
    localEnvironment: Effect.succeed({ environmentId: "env-local", label: "local" }),
    resolve: () => Effect.succeedNone,
    call: () => Effect.fail(new PeerRejected({ message: "No peers in this test." })),
  }),
);
const testLayer = Workers.layer.pipe(
  Layer.provideMerge(infrastructure),
  Layer.provideMerge(providerLayer),
  Layer.provideMerge(registry),
  Layer.provideMerge(noPeers),
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
  status: "running" | "ready" | "error" | "stopped",
  suffix: string,
  providerInstanceId?: ProviderInstanceId,
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
      ...(providerInstanceId ? { providerInstanceId } : {}),
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
const replyAndReport = Effect.fn(function* (threadId: ThreadId, turn: string, text: string) {
  yield* reply(threadId, turn, text);
  yield* (yield* Workers.WorkerControls).report(threadId, {
    clientRequestId: turn,
    outcome: "done",
    summary: text,
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
  it.effect(
    "handoff transfers live workers, queued reports and cursors, preserving retry identity",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const { owner, source, worker, input } = yield* seed("handoff-base");
        yield* service.spawn(owner, input);
        yield* session(worker, "running", "ongoing-worker");
        const follow = yield* service.send(owner, {
          threadId: worker,
          clientRequestId: "next",
          prompt: "next stage",
        });
        yield* service.control(owner, { threadId: worker, notifications: false });
        const report = {
          clientRequestId: "blocked",
          outcome: "blocked" as const,
          summary: "Need missing input",
        };
        const receipt = yield* service.report(worker, report);
        yield* sql`UPDATE custom_workers SET read_seq = 12, read_offset = 7 WHERE thread_id = ${worker}`;
        const successor = ThreadId.make("handoff-successor");
        const request = {
          ...input,
          threadId: successor,
          modelSelection: selections[2]!,
          title: "new_master_opus",
          prompt: "Review retained work, then finish.",
        };
        const result = yield* service.handoff(owner, request);
        expect(result.state).toBe("completed");
        expect(result.transferredWorkerIds).toEqual([worker]);
        expect(yield* service.list(owner)).toEqual([]);
        const owned = (yield* service.list(successor))[0]!;
        expect(owned.threadId).toBe(worker);
        expect(owned.latestRequest?.requestId).toBe(follow.requestId);
        expect(owned.latestRequest?.state).toBe("queued");
        expect(owned.modelSelection).toEqual(input.modelSelection);
        expect(
          (yield* sql`SELECT read_seq, read_offset FROM custom_workers WHERE thread_id = ${worker}`)[0],
        ).toEqual({ read_seq: 12, read_offset: 7 });
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).session?.activeTurnId,
        ).toBe("ongoing-worker");
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).modelSelection,
        ).toEqual(input.modelSelection);
        const next = Option.getOrThrow(yield* snapshots.getThreadDetailById(successor));
        expect(next.modelSelection).toEqual(selections[2]);
        expect(next.messages.some((m) => m.text === "Inherited base context")).toBe(true);
        expect(
          next.messages.filter((m) => m.text.startsWith("[T3 orchestrator handoff]")),
        ).toHaveLength(1);
        expect(yield* service.handoff(owner, request)).toEqual(result);
        expect(
          (yield* service
            .control(owner, { threadId: worker, notifications: true })
            .pipe(Effect.flip)).message,
        ).toContain("not a worker owned");
        yield* service.control(successor, { threadId: worker, notifications: true });
        expect((yield* service.report(worker, report)).requestId).toBe(receipt.requestId);
        const notices = Option.getOrThrow(yield* snapshots.getThreadDetailById(successor)).messages;
        expect(notices.filter((m) => m.text.includes("Need missing input"))).toHaveLength(1);
        const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
        expect(yield* restarted.handoffStatus(owner, { threadId: successor })).toEqual(result);
        expect((yield* restarted.list(successor))[0]!.threadId).toBe(worker);
      }),
  );
  it.effect("self-fork waits for the native turn to finish and survives a service restart", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { source: owner, input } = yield* seed("handoff-self");
      yield* session(owner, "running", "self-active");
      const successor = ThreadId.make("self-successor");
      const request = {
        title: input.title,
        prompt: input.prompt,
        selfFork: true,
        threadId: successor,
        modelSelection: selections[1]!,
      };
      expect((yield* service.handoff(owner, request)).state).toBe("queued");
      expect(Option.isNone(yield* snapshots.getThreadDetailById(successor))).toBe(true);
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      yield* session(owner, "ready", "self-finished");
      yield* restarted.drain();
      expect((yield* restarted.handoffStatus(owner, { threadId: successor })).state).toBe(
        "completed",
      );
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(successor)).modelSelection,
      ).toEqual(selections[1]);
    }),
  );
  it.effect(
    "delivered reports are not replayed after transfer and invalid profiles keep ownership",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, input } = yield* seed("handoff-delivered");
        yield* service.spawn(owner, input);
        const report = {
          clientRequestId: "done-once",
          outcome: "done" as const,
          summary: "Verified result",
        };
        yield* service.report(worker, report);
        const next = ThreadId.make("delivered-successor");
        expect(
          (yield* service
            .handoff(owner, {
              ...input,
              threadId: next,
              modelSelection: {
                ...input.modelSelection,
                options: [{ id: "reasoningEffort", value: "invalid" }],
              },
            })
            .pipe(Effect.flip)).message,
        ).toContain("does not support");
        expect((yield* service.list(owner))[0]!.threadId).toBe(worker);
        yield* service.handoff(owner, { ...input, threadId: next });
        yield* service.report(worker, report);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(next)).messages.some((m) =>
            m.text.includes("Verified result"),
          ),
        ).toBe(false);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.filter((m) =>
            m.text.includes("Verified result"),
          ),
        ).toHaveLength(1);
      }),
  );
  it.effect("fresh handoff starts without base history and rejects conflicting retries", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, input } = yield* seed("handoff-fresh");
      const request = {
        threadId: input.threadId,
        title: "successor",
        prompt: "Context summary",
        modelSelection: selections[2]!,
      };
      expect((yield* service.handoff(owner, request)).state).toBe("completed");
      const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(input.threadId));
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages[0]!.text).toContain("Context summary");
      expect(
        (yield* service.handoff(owner, { ...request, prompt: "different" }).pipe(Effect.flip))
          .message,
      ).toContain("different handoff");
    }),
  );
  it.effect(
    "failed preparation keeps original workers and can be cancelled before trying another source",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const { owner, worker, input } = yield* seed("handoff-failed");
        yield* service.spawn(owner, input);
        const failed = ThreadId.make("failed-successor");
        const request = { ...input, threadId: failed, sourceThreadId: owner };
        expect((yield* service.handoff(owner, request)).state).toBe("error");
        expect((yield* service.list(owner)).some((w) => w.threadId === worker)).toBe(true);
        expect(
          (yield* service.handoffStatus(owner, { threadId: failed, cancel: true })).state,
        ).toBe("cancelled");
        expect((yield* service.list(owner)).map((w) => w.threadId)).toEqual([worker]);
        expect(
          (yield* service.handoff(owner, {
            ...input,
            threadId: ThreadId.make("recovered-successor"),
          })).state,
        ).toBe("completed");
      }),
  );
  it.effect("queued handoff cancellation preserves ownership and rejects another master", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const { owner, source, worker, input } = yield* seed("handoff-cancel");
      yield* service.spawn(owner, input);
      yield* session(source, "running", "cancel-busy");
      const request = { ...input, threadId: ThreadId.make("cancel-successor") };
      expect((yield* service.handoff(owner, request)).state).toBe("queued");
      expect(
        (yield* service
          .handoffStatus(source, { threadId: request.threadId, cancel: true })
          .pipe(Effect.flip)).message,
      ).toContain("Unknown");
      expect(
        (yield* service.handoffStatus(owner, { threadId: request.threadId, cancel: true })).state,
      ).toBe("cancelled");
      yield* session(source, "ready", "cancel-ready");
      yield* service.drain();
      expect((yield* service.list(owner))[0]!.threadId).toBe(worker);
    }),
  );
  for (const [index, instance] of instances.entries()) {
    it.effect(`creates a fresh ${instance[0]} worker without copying a busy base`, () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory;
        const { owner, source, worker, input } = yield* seed(`fresh-${index}`);
        yield* session(source, "running", `busy-base-${index}`);
        const fresh = {
          threadId: worker,
          title: input.title,
          prompt: input.prompt,
          modelSelection: selections[index]!,
        };
        yield* service.spawn(owner, fresh);
        yield* service.spawn(owner, fresh);
        const result = (yield* service.list(owner))[0]!;
        expect(result.sourceThreadId).toBeNull();
        expect(result.ownerThreadId).toBe(owner);
        expect(result.modelSelection).toEqual(selections[index]);
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
        expect(detail.messages.map((message) => message.text)).toEqual(["first task"]);
        expect(detail.runtimeMode).toBe("full-access");
        expect(detail.branch).toBeNull();
        expect(detail.worktreePath).toBeNull();
        expect(Option.isNone(yield* directory.getBinding(worker))).toBe(true);
        expect(
          (yield* service.spawn(owner, { ...fresh, sourceThreadId: source }).pipe(Effect.flip))
            .message,
        ).toContain("different");
      }),
    );
  }
  it.effect(
    "fresh workers target the chosen project and inherit the master's permission and interaction modes",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, input } = yield* seed("fresh-project");
        const projectId = ProjectId.make("fresh-destination");
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("fresh-destination-create"),
          projectId,
          title: "destination",
          workspaceRoot: "/tmp/fresh-destination",
          createdAt: timestamp,
        });
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("fresh-owner-modes"),
          threadId: owner,
          runtimeMode: "approval-required",
          createdAt: timestamp,
        });
        yield* engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("fresh-owner-interaction"),
          threadId: owner,
          interactionMode: "plan",
          createdAt: timestamp,
        });
        yield* service.spawn(owner, {
          threadId: worker,
          projectId,
          title: input.title,
          prompt: input.prompt,
          modelSelection: selections[2]!,
        });
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
        expect(detail.projectId).toBe(projectId);
        expect(detail.runtimeMode).toBe("approval-required");
        expect(detail.interactionMode).toBe("plan");
        expect(detail.modelSelection).toEqual(selections[2]);
      }),
  );
  it.effect(
    "fresh workers recover creation, report outcomes and accept follow-ups in the same session",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const { owner, worker, input } = yield* seed("fresh-roundtrip");
        const fresh = {
          threadId: worker,
          title: input.title,
          prompt: input.prompt,
          modelSelection: input.modelSelection,
        };
        yield* service.spawn(owner, fresh);
        // Recover a crash after create/dispatch but before acknowledging either operation.
        yield* sql`UPDATE custom_workers SET state = 'creating' WHERE thread_id = ${worker}`;
        yield* sql`UPDATE custom_worker_jobs SET state = 'queued' WHERE id = ${`spawn:${worker}`}`;
        const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
        yield* restarted.spawn(owner, fresh);
        yield* session(worker, "running", "fresh-result");
        yield* replyAndReport(worker, "fresh-result", "fresh result verified");
        yield* session(worker, "ready", "fresh-finished");
        yield* restarted.drain();
        const master = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner));
        expect(
          master.messages.filter((message) => message.text.includes("fresh result verified")),
        ).toHaveLength(1);
        expect(
          (yield* restarted.read(owner, { threadId: worker })).items.some(
            (item) => item.text === "fresh result verified",
          ),
        ).toBe(true);
        yield* restarted.send(owner, {
          threadId: worker,
          clientRequestId: "follow",
          prompt: "next assignment",
        });
        const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
        expect(detail.messages.filter((message) => message.text === "first task")).toHaveLength(1);
        expect(
          detail.messages.filter((message) => message.text === "next assignment"),
        ).toHaveLength(1);
        expect((yield* restarted.list(owner))[0]!.sourceThreadId).toBeNull();
      }),
  );
  it.effect(
    "fresh spawning rejects unrelated destinations, missing projects and changed retry settings",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const { owner, source, worker, input } = yield* seed("fresh-invalid");
        const fresh = {
          threadId: worker,
          title: input.title,
          prompt: input.prompt,
          modelSelection: input.modelSelection,
        };
        expect(
          (yield* service.spawn(owner, { ...fresh, threadId: source }).pipe(Effect.flip)).message,
        ).toContain("already exists");
        expect(
          (yield* service
            .spawn(owner, { ...fresh, projectId: ProjectId.make("missing") })
            .pipe(Effect.flip)).message,
        ).toContain("project no longer exists");
        expect(yield* service.list(owner)).toHaveLength(0);
        yield* service.spawn(owner, fresh);
        expect(
          (yield* service
            .spawn(owner, { ...fresh, projectId: ProjectId.make("another") })
            .pipe(Effect.flip)).message,
        ).toContain("different");
        expect(
          (yield* service.spawn(owner, { ...fresh, prompt: "different task" }).pipe(Effect.flip))
            .message,
        ).toContain("different");
      }),
  );
  it.effect("does not notify for progress-only endings, empty turns, or restart completions", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("no-progress-report");
      yield* service.spawn(owner, input);
      for (const [id, text] of [
        ["progress", "Build running; waiting for capacity."],
        ["empty", ""],
        ["restart", "Restarting the interrupted work."],
      ]) {
        yield* session(worker, "running", id!);
        if (text) yield* reply(worker, id!, text);
        yield* session(worker, "ready", `${id}-end`);
        yield* service.drain();
      }
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        0,
      );
    }),
  );
  it.effect("authenticates self reports and delivers immediately with idempotent retries", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("explicit-report");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "explicit-turn");
      const report = {
        clientRequestId: "blocked-on-access",
        outcome: "blocked" as const,
        summary: "Verified access is missing; credentials need owner action.",
      };
      expect((yield* service.report(owner, report).pipe(Effect.flip)).message).toContain(
        "not a managed",
      );
      const first = yield* service.report(worker, report);
      const second = yield* service.report(worker, report);
      expect(first.requestId).toBe(second.requestId);
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
      expect(
        (yield* service.report(worker, { ...report, summary: "different" }).pipe(Effect.flip))
          .message,
      ).toContain("different assignment");
      yield* session(worker, "ready", "explicit-end");
      yield* service.drain();
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain("Outcome: blocked");
      expect(messages[0]!.text).toContain(report.summary);
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
    }),
  );
  it.effect("delivers explicit reports without waiting for background liveness", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const { owner, worker, input } = yield* seed("report-background");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "background-turn");
      const task = { threadId: worker, taskId: "verification", taskType: undefined };
      liveness.recordTaskLiveness({ ...task, status: "running", kind: "started" });
      yield* replyAndReport(worker, "background-turn", "Artifacts ready.");
      yield* session(worker, "ready", "background-end");
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
      liveness.recordTaskLiveness({ ...task, status: "completed", kind: "completed" });
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      yield* restarted.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
    }),
  );
  it.effect("cancels undelivered legacy completion notices on upgrade", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("legacy-report");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "legacy-turn");
      yield* reply(worker, "legacy-turn", "Still working");
      yield* session(worker, "ready", "legacy-end");
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
        VALUES (${"notice:spawn:" + worker + ":terminal"}, ${worker}, ${owner}, 'notice', 'obsolete progress', ${timestamp})`;
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        0,
      );
      const rows =
        yield* sql`SELECT state FROM custom_worker_jobs WHERE kind='notice' AND worker_id=${worker}`;
      expect(rows[0]!.state).toBe("cancelled");
    }),
  );
  it.effect("automatically wakes the master for a newly registered worker", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const events = yield* engine.subscribeDomainEvents;
      yield* service.start();
      const { owner, worker, input } = yield* seed("automatic");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "automatic-turn");
      yield* replyAndReport(worker, "automatic-turn", "automatic result");
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
  it.effect("delivers reports despite an outstanding master steer", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("steered-master");
      yield* service.spawn(owner, input);
      yield* session(owner, "running", "master-active");
      yield* directInput(owner, "master-steer");
      yield* replyAndReport(worker, "worker-result", "Finished the assignment");
      expect((yield* service.list(owner))[0]!.pendingReports).toBe(0);
      const master = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner));
      expect(master.messages.filter((m) => m.text.includes("T3 worker report"))).toHaveLength(1);
    }),
  );
  for (const kind of ["user-input.requested", "approval.requested"] as const) {
    it.effect(`delivers reports without resolving pending ${kind}`, () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const { owner, worker, input } = yield* seed(`pending-${kind}`);
        yield* service.spawn(owner, input);
        yield* session(owner, "running", "pending-master-turn");
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`pending-${kind}`),
          threadId: owner,
          activity: {
            id: EventId.make(`pending-${kind}`),
            tone: "approval",
            kind,
            summary: "Owner input required",
            payload: { requestId: "unanswered" },
            turnId: TurnId.make("pending-master-turn"),
            createdAt: timestamp,
          },
          createdAt: timestamp,
        });
        yield* replyAndReport(
          worker,
          `pending-worker-result-${kind}`,
          "Done with verified evidence",
        );
        expect((yield* service.list(owner))[0]!.pendingReports).toBe(0);
        const master = Option.getOrThrow(yield* snapshots.getThreadShellById(owner));
        expect(
          kind === "user-input.requested" ? master.hasPendingUserInput : master.hasPendingApprovals,
        ).toBe(true);
        expect(
          yield* sql`SELECT 1 FROM orchestration_events WHERE stream_id = ${owner}
          AND event_type = 'thread.turn-start-requested' AND command_id LIKE 'worker-job:%'`,
        ).toHaveLength(1);
      }),
    );
  }
  it.effect("coordinates across owners and providers without transferring ownership", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sender = yield* seed("peer-sender");
      const recipient = yield* seed("peer-recipient", 2);
      yield* service.spawn(recipient.owner, recipient.input);
      yield* session(recipient.worker, "running", "peer-active");
      const input = {
        threadId: recipient.worker,
        clientRequestId: "coordination",
        prompt: "Rescore against current main.",
      };
      expect((yield* service.send(sender.owner, input).pipe(Effect.flip)).message).toContain(
        "not a worker owned",
      );
      expect((yield* service.message(sender.owner, input)).state).toBe("dispatched");
      yield* service.message(sender.owner, input);
      expect(
        (yield* service.message(sender.owner, { ...input, prompt: "different" }).pipe(Effect.flip))
          .message,
      ).toContain("different assignment");
      const target = Option.getOrThrow(yield* snapshots.getThreadDetailById(recipient.worker));
      const messages = target.messages.filter((m) => m.text.includes("T3 session message"));
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain(`From session: ${sender.owner}`);
      expect(target.modelSelection).toEqual(recipient.input.modelSelection);
      expect((yield* service.list(recipient.owner))[0]!.ownerThreadId).toBe(recipient.owner);
      expect(yield* service.list(sender.owner)).toEqual([]);
      expect(
        (yield* service
          .control(sender.owner, { threadId: recipient.worker, notifications: false })
          .pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
    }),
  );
  it.effect("messages an idle session without a provider process and supports replies", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, source } = yield* seed("peer-idle");
      expect(Option.getOrThrow(yield* snapshots.getThreadShellById(owner)).session).toBeNull();
      expect(
        (yield* service.message(source, {
          threadId: owner,
          clientRequestId: "idle",
          prompt: "Result ready.",
        })).state,
      ).toBe("dispatched");
      expect(
        (yield* service.message(owner, {
          threadId: source,
          clientRequestId: "reply",
          prompt: "Rerun the dense row.",
        })).state,
      ).toBe("dispatched");
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).messages.some((m) =>
          m.text.includes("dense row"),
        ),
      ).toBe(true);
    }),
  );
  it.effect("persists stopped peer messages and dispatches on resume after restart", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, source } = yield* seed("peer-stop");
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("peer-stop-command"),
        threadId: source,
        createdAt: timestamp,
      });
      const input = { threadId: source, clientRequestId: "held", prompt: "Evidence is ready." };
      expect((yield* service.message(owner, input)).state).toBe("queued");
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).messages.filter((m) =>
          m.text.includes("Evidence is ready"),
        ),
      ).toHaveLength(1);
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      const events = yield* engine.subscribeDomainEvents;
      yield* restarted.start();
      yield* directInput(source, "peer-resume");
      yield* events.pipe(
        Stream.filter(
          (e) =>
            e.type === "thread.turn-start-requested" &&
            e.commandId?.startsWith("worker-job:message:") === true,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      // Retries do not wait for the background pass that is recording the delivery.
      yield* restarted.drain();
      expect((yield* restarted.message(owner, input)).state).toBe("dispatched");
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).messages.filter((m) =>
          m.text.includes("Evidence is ready"),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects self, missing and archived recipients", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const { owner, source } = yield* seed("peer-invalid");
      const input = { threadId: owner, clientRequestId: "invalid", prompt: "Coordination" };
      expect((yield* service.message(owner, input).pipe(Effect.flip)).message).toContain(
        "another session",
      );
      expect(
        (yield* service
          .message(owner, { ...input, threadId: ThreadId.make("absent-peer") })
          .pipe(Effect.flip)).message,
      ).toContain("no longer exists");
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-peer"),
        threadId: source,
      });
      expect(
        (yield* service.message(owner, { ...input, threadId: source }).pipe(Effect.flip)).message,
      ).toContain("archived");
    }),
  );
  it.effect(
    "shows reports after Stop without waking; resumes once without duplicate messages",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const { owner, worker, input } = yield* seed("stopped-master");
        yield* service.spawn(owner, input);
        yield* session(owner, "running", "master-active");
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("stop-master"),
          threadId: owner,
          createdAt: timestamp,
        });
        yield* replyAndReport(worker, "first-result", "Verified result one");
        yield* replyAndReport(worker, "second-result", "Verified result two");
        const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
        yield* restarted.drain();
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages,
        ).toHaveLength(2);
        const starts = () =>
          sql`SELECT 1 FROM orchestration_events WHERE stream_id = ${owner} AND event_type = 'thread.turn-start-requested' AND command_id LIKE 'worker-job:%'`;
        expect(yield* starts()).toHaveLength(0);
        yield* directInput(owner, "resume-master");
        yield* restarted.drain();
        yield* restarted.drain();
        expect(yield* starts()).toHaveLength(2);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages,
        ).toHaveLength(3);
        expect((yield* restarted.list(owner))[0]!.pendingReports).toBe(0);
      }),
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
  it.effect("queues busy-worker assignments but immediately reports to a running master", () =>
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
      yield* replyAndReport(worker, "worker-first", "first result");
      yield* session(worker, "ready", "first-finished");
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
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
      yield* replyAndReport(worker, "worker-second", "corrected result");
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
  it.effect("delivers explicit reports after direct worker input without duplicates", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("direct");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "assigned-turn");
      yield* replyAndReport(worker, "assigned-turn", "assigned result");
      yield* session(worker, "ready", "assigned-finished");
      yield* service.drain();
      yield* session(owner, "running", "assigned-report");
      yield* session(owner, "ready", "assigned-report-finished");
      const events = yield* engine.subscribeDomainEvents;
      yield* service.start();
      yield* directInput(worker, "automatic");
      yield* session(worker, "running", "direct-turn");
      yield* replyAndReport(worker, "direct-turn", "direct result");
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
  it.effect("recovers explicit reports after restart and respects paused notifications", () =>
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
      yield* replyAndReport(worker, "restart-direct-turn", "recovered direct result");
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
        0,
      );
      yield* engine.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle-direct"),
        threadId: worker,
        reason: "user",
      });
      yield* service.drain();
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages.filter((m) => m.text.includes("latest-direct"))).toHaveLength(0);
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
  for (const index of [1, 2]) {
    it.effect(
      `master switches an active worker to ${instances[index]![0]} for its next assignment`,
      () =>
        Effect.gen(function* () {
          const service = yield* Workers.WorkerControls;
          const snapshots = yield* ProjectionSnapshotQuery;
          const sql = yield* SqlClient.SqlClient;
          const { owner, worker, source, input } = yield* seed(`master-switch-${index}`);
          yield* service.spawn(owner, input);
          yield* session(worker, "running", `switch-active-${index}`);
          const follow = {
            threadId: worker,
            clientRequestId: "next",
            prompt: "continue on chosen account",
          };
          yield* service.send(owner, follow);
          const changed = yield* service.control(owner, {
            threadId: worker,
            modelSelection: selections[index]!,
          });
          expect(changed.modelSelection).toEqual(selections[index]);
          const active = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
          expect(active.session?.activeTurnId).toBe(`switch-active-${index}`);
          expect(active.messages.some((m) => m.text === follow.prompt)).toBe(false);
          expect(
            Option.getOrThrow(yield* snapshots.getThreadDetailById(source)).modelSelection,
          ).toEqual(input.modelSelection);
          const before =
            yield* sql`SELECT sequence FROM orchestration_events WHERE stream_id = ${worker} AND event_type = 'thread.meta-updated'`;
          yield* service.control(owner, { threadId: worker, modelSelection: selections[index]! });
          expect(
            yield* sql`SELECT sequence FROM orchestration_events WHERE stream_id = ${worker} AND event_type = 'thread.meta-updated'`,
          ).toHaveLength(before.length);
          yield* session(worker, "ready", `switch-finished-${index}`);
          yield* service.drain();
          expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("submitted");
          const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(worker));
          expect(detail.modelSelection).toEqual(selections[index]);
          expect(detail.messages.filter((m) => m.text === follow.prompt)).toHaveLength(1);
          const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
          expect((yield* restarted.list(owner))[0]!.modelSelection).toEqual(selections[index]);
        }),
    );
  }
  it.effect(
    "rejects unauthorized and invalid switches without changing worker or saved profile",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, source, input } = yield* seed("switch-rejected");
        yield* service.spawn(owner, input);
        expect(
          (yield* service
            .control(source, { threadId: worker, modelSelection: selections[1]! })
            .pipe(Effect.flip)).message,
        ).toContain("not a worker owned");
        expect(
          (yield* service
            .control(owner, {
              threadId: worker,
              modelSelection: { ...selections[1]!, model: "missing" },
            })
            .pipe(Effect.flip)).message,
        ).toContain("unavailable");
        expect(
          (yield* service
            .control(owner, {
              threadId: worker,
              modelSelection: selections[1]!,
              adoptCurrentSettings: true,
            })
            .pipe(Effect.flip)).message,
        ).toContain("not both");
        expect(
          (yield* service
            .control(owner, {
              threadId: worker,
              modelSelection: selections[1]!,
              cancelRequestId: `spawn:${worker}`,
            })
            .pipe(Effect.flip)).message,
        ).toContain("Only queued");
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("switch-permissions"),
          threadId: owner,
          runtimeMode: "approval-required",
          createdAt: timestamp,
        });
        expect(
          (yield* service
            .control(owner, { threadId: worker, modelSelection: selections[1]! })
            .pipe(Effect.flip)).message,
        ).toContain("broader permissions");
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(worker)).modelSelection,
        ).toEqual(input.modelSelection);
        expect((yield* service.list(owner))[0]!.modelSelection).toEqual(input.modelSelection);
      }),
  );
  it.effect("reports explicit completion after background work ends but not progress", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const { owner, worker, input } = yield* seed("self-started");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "self-assignment");
      yield* session(worker, "ready", "self-assignment-finished");
      yield* service.drain();
      yield* session(owner, "running", "self-assignment-report");
      yield* session(owner, "ready", "self-assignment-report-finished");
      const build = { threadId: worker, taskId: "build", taskType: undefined };
      liveness.recordTaskLiveness({ ...build, status: "running", kind: "started" });
      yield* session(worker, "running", "self-waiting");
      yield* reply(worker, "self-waiting", "build still running");
      yield* session(worker, "ready", "self-waiting-finished");
      yield* service.drain();
      liveness.recordTaskLiveness({ ...build, status: "completed", kind: "completed" });
      yield* session(worker, "running", "self-final");
      yield* replyAndReport(worker, "self-final", "build finished and checks pass");
      yield* session(worker, "ready", "self-final-finished");
      yield* service.drain();
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages.filter((m) => m.text.includes("build still running"))).toHaveLength(0);
      expect(
        messages.filter((m) => m.text.includes("build finished and checks pass")),
      ).toHaveLength(1);
    }),
  );
  it.effect("links an assignment to the turn a provider switch starts", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("handoff");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "handoff-assignment");
      yield* session(worker, "ready", "handoff-assignment-finished");
      yield* service.drain();
      yield* session(owner, "running", "handoff-report");
      yield* session(owner, "ready", "handoff-report-finished");
      yield* service.control(owner, { threadId: worker, modelSelection: selections[2]! });
      yield* service.send(owner, {
        threadId: worker,
        clientRequestId: "after-switch",
        prompt: "continue after switch",
      });
      yield* session(
        worker,
        "stopped",
        "previous-provider-stopped",
        input.modelSelection.instanceId,
      );
      yield* service.drain();
      expect((yield* service.list(owner))[0]!.latestRequest!.state).toBe("submitted");
      yield* session(worker, "running", "handoff-turn", selections[2]!.instanceId);
      yield* replyAndReport(worker, "handoff-turn", "result after switch");
      yield* session(worker, "ready", "handoff-finished", selections[2]!.instanceId);
      yield* service.drain();
      const latest = (yield* service.list(owner))[0]!.latestRequest!;
      expect(latest.state).toBe("completed");
      expect(latest.turnId).toBe("handoff-turn");
      const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
      expect(messages.filter((m) => m.text.includes("result after switch"))).toHaveLength(1);
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
      yield* replyAndReport(worker, "restart-turn", "durable result");
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
      yield* replyAndReport(worker, "control-turn", "held result");
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
  it.effect("holds paused runtime and explicit outcomes until reports resume", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("paused-outcomes");
      const reports = snapshots
        .getThreadDetailById(owner)
        .pipe(
          Effect.map((thread) =>
            Option.getOrThrow(thread).messages.filter((m) => m.text.includes("T3 worker report")),
          ),
        );
      yield* service.spawn(owner, input);
      yield* service.control(owner, { threadId: worker, notifications: false });
      yield* session(worker, "running", "paused-turn");
      yield* session(worker, "error", "paused-failure");
      yield* service.drain();
      yield* service.drain();
      const held = yield* service.report(worker, {
        clientRequestId: "paused",
        outcome: "blocked",
        summary: "Blocked while reports were paused.",
      });
      expect(held).toMatchObject({ state: "queued", held: true });
      expect(yield* reports).toHaveLength(0);
      yield* service.control(owner, { threadId: worker, notifications: true });
      yield* service.drain();
      const delivered = (yield* reports).map((m) => m.text);
      expect(delivered.filter((text) => text.includes("Test provider error"))).toHaveLength(1);
      expect(delivered.filter((text) => text.includes("Blocked while reports"))).toHaveLength(1);
      expect(delivered).toHaveLength(2);
    }),
  );
  it.effect("saves reports and messages while a delivery pass holds the queue", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, source, worker, input } = yield* seed("busy-queue");
      yield* service.spawn(owner, input);
      yield* session(worker, "running", "busy-queue-turn");
      yield* service.send(owner, {
        threadId: worker,
        clientRequestId: "next",
        prompt: "next stage",
      });
      yield* reply(worker, "busy-queue-turn", "first stage done");
      yield* session(worker, "ready", "busy-queue-idle");
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      providerGate = gate;
      const pass = yield* service.drain().pipe(Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const report = yield* service.report(worker, {
        clientRequestId: "while-busy",
        outcome: "done",
        summary: "Finished while the queue was busy.",
      });
      expect(report).toMatchObject({ state: "queued", held: false });
      const message = yield* service.message(source, {
        threadId: owner,
        clientRequestId: "while-busy",
        prompt: "Peer note while the queue was busy.",
      });
      expect(message.state).toBe("queued");
      providerGate = undefined;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(pass);
      yield* service.drain();
      const texts = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.map(
        (m) => m.text,
      );
      expect(texts.filter((text) => text.includes("Finished while the queue"))).toHaveLength(1);
      expect(texts.filter((text) => text.includes("Peer note while the queue"))).toHaveLength(1);
    }).pipe(Effect.ensuring(Effect.sync(() => (providerGate = undefined)))),
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
  for (const fresh of [false, true]) {
    it.effect(
      `uses the authenticated master for ${fresh ? "fresh" : "forked"} spawn, list, read and follow-up`,
      () =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const { owner, worker, input } = yield* seed(`mcp-${fresh ? "fresh" : "fork"}`);
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
          const spawnInput = fresh
            ? {
                threadId: worker,
                title: input.title,
                modelSelection: input.modelSelection,
                prompt: input.prompt,
              }
            : input;
          const spawned = yield* call("t3_worker_spawn", {
            ...spawnInput,
            ownerThreadId: "forged",
          });
          expect(spawned.isError).not.toBe(true);
          const detail = Option.getOrThrow(
            yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(worker),
          );
          expect(detail.messages.some((message) => message.text === "Inherited base context")).toBe(
            !fresh,
          );
          const switched = yield* call("t3_worker_control", {
            threadId: worker,
            modelSelection: selections[1]!,
          });
          expect(switched.isError).not.toBe(true);
          expect(switched.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("codex_antoine"),
              }),
            ]),
          );
          expect(
            (yield* call("t3_worker_report", {
              clientRequestId: "forged",
              outcome: "done",
              summary: "Cannot impersonate worker",
              threadId: worker,
            })).isError,
          ).toBe(true);
          const workerCall = yield* server
            .callTool({
              name: "t3_worker_report",
              arguments: {
                clientRequestId: "finished",
                outcome: "done",
                summary: "Evidence verified.",
              },
            })
            .pipe(
              Effect.provideService(Invocation.McpInvocationContext, {
                ...scope,
                threadId: worker,
              }),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(workerCall.isError).not.toBe(true);
          const peer = yield* seed(`mcp-peer-${fresh ? "fresh" : "fork"}`);
          expect(
            (yield* call("t3_session_send", {
              threadId: peer.owner,
              clientRequestId: "peer-auth",
              prompt: "Coordinate with the actual sender.",
              senderThreadId: "forged-sender",
            })).isError,
          ).not.toBe(true);
          const peerSnapshot = Option.getOrThrow(
            yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(peer.owner),
          );
          expect(peerSnapshot.messages[0]!.text).toContain(`From session: ${owner}`);
          expect(peerSnapshot.messages[0]!.text).not.toContain("forged-sender");
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
          const successor = ThreadId.make(`${worker}-successor`);
          expect(
            (yield* call("t3_orchestrator_handoff", {
              threadId: successor,
              title: "next_master",
              prompt: "Take over the retained work",
              modelSelection: selections[2]!,
            })).isError,
          ).not.toBe(true);
          expect(
            (yield* call("t3_orchestrator_handoff_status", { threadId: successor })).isError,
          ).not.toBe(true);
          expect((yield* (yield* Workers.WorkerControls).list(successor))[0]!.threadId).toBe(
            worker,
          );
        }),
    );
  }
});

// Two environments with their own databases, linked as the HTTP peer route would.
const peerHandlers = new Map<
  string,
  (from: string, request: unknown) => Effect.Effect<unknown, Workers.WorkerError>
>();
const offline = new Set<string>();
const linkedEnvironments = [
  { environmentId: "env-alpha", label: "alpha", url: "https://alpha.test", token: "alpha" },
  { environmentId: "env-beta", label: "beta", url: "https://beta.test", token: "beta" },
];
const environmentLayer = (environmentId: string) =>
  Workers.layer.pipe(
    Layer.provideMerge(infrastructure),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(registry),
    Layer.provideMerge(
      Layer.succeed(
        PeerLinks,
        PeerLinks.of({
          localEnvironment: Effect.succeed({
            environmentId,
            label: linkedEnvironments.find((peer) => peer.environmentId === environmentId)!.label,
          }),
          resolve: (nameOrId) =>
            Effect.succeed(
              findPeer(
                linkedEnvironments.filter((peer) => peer.environmentId !== environmentId),
                nameOrId,
              ),
            ),
          call: (target, request) => {
            const handler = peerHandlers.get(target);
            return handler && !offline.has(target)
              ? handler(environmentId, structuredClone(request)).pipe(
                  Effect.map((response) => structuredClone(response)),
                  Effect.mapError((error) => new PeerRejected({ message: error.message })),
                )
              : Effect.fail(new PeerUnavailable({ environmentId: target, message: "offline" }));
          },
        }),
      ),
    ),
  );
const linkedPair = Effect.gen(function* () {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const alpha = yield* Layer.build(environmentLayer("env-alpha")).pipe(Scope.provide(scope));
  const beta = yield* Layer.build(environmentLayer("env-beta")).pipe(Scope.provide(scope));
  for (const [id, context] of [
    ["env-alpha", alpha],
    ["env-beta", beta],
  ] as const)
    peerHandlers.set(id, (from, request) =>
      Workers.WorkerControls.pipe(
        Effect.flatMap((service) => service.receive(from, request)),
        Effect.provide(context),
      ),
    );
  offline.clear();
  const services = Effect.all([Workers.WorkerControls, ProjectionSnapshotQuery]);
  const [alphaWorkers, alphaSnapshots] = yield* services.pipe(Effect.provide(alpha));
  const [betaWorkers, betaSnapshots] = yield* services.pipe(Effect.provide(beta));
  const messages = (snapshots: typeof alphaSnapshots, id: ThreadId) =>
    snapshots
      .getThreadDetailById(id)
      .pipe(Effect.map((thread) => Option.getOrThrow(thread).messages.map((m) => m.text)));
  return { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, betaSnapshots, messages };
});

it.effect("messages a session in a linked environment, holding it while offline", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, betaSnapshots, messages } =
      yield* linkedPair;
    const sender = (yield* seed("msg-alpha").pipe(Effect.provide(alpha))).owner;
    const recipient = (yield* seed("msg-beta").pipe(Effect.provide(beta))).owner;
    const input = {
      threadId: recipient,
      clientRequestId: "status",
      prompt: "Is the shared build green?",
      environment: "beta",
    };
    offline.add("env-beta");
    expect((yield* alphaWorkers.message(sender, input)).state).toBe("queued");
    offline.delete("env-beta");
    yield* alphaWorkers.drain();
    expect(yield* alphaWorkers.message(sender, input)).toMatchObject({
      threadId: recipient,
      state: "dispatched",
    });
    yield* betaWorkers.drain();
    const received = (yield* messages(betaSnapshots, recipient)).filter((text) =>
      text.includes("Is the shared build green?"),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(`From session: ${sender} in environment alpha`);
    yield* betaWorkers.message(recipient, {
      threadId: sender,
      clientRequestId: "reply",
      prompt: "Green on main.",
      environment: "alpha",
    });
    yield* betaWorkers.drain();
    yield* alphaWorkers.drain();
    expect(
      (yield* messages(alphaSnapshots, sender)).filter((text) => text.includes("Green on main.")),
    ).toHaveLength(1);
    expect(
      (yield* alphaWorkers
        .message(sender, { ...input, clientRequestId: "x", environment: "gamma" })
        .pipe(Effect.flip)).message,
    ).toContain("No linked environment named gamma");
  }).pipe(Effect.scoped),
);

it.effect("owns, steers and hears from a worker in a linked environment", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, betaSnapshots, messages } =
      yield* linkedPair;
    const { owner } = yield* seed("own-alpha").pipe(Effect.provide(alpha));
    yield* seed("own-beta").pipe(Effect.provide(beta));
    const worker = ThreadId.make("own-remote-worker");
    const input = {
      threadId: worker,
      projectId: ProjectId.make("own-beta"),
      title: "remote_worker_sol",
      modelSelection: selections[0]!,
      prompt: "Measure the beta build",
      environment: "beta",
    };
    expect(yield* alphaWorkers.spawn(owner, input)).toMatchObject({
      threadId: worker,
      ownerThreadId: owner,
      environment: "beta",
    });
    expect((yield* alphaWorkers.spawn(owner, input)).threadId).toBe(worker);
    expect(Option.isNone(yield* alphaSnapshots.getThreadShellById(worker))).toBe(true);
    expect(yield* messages(betaSnapshots, worker)).toContain("Measure the beta build");
    expect(
      (yield* alphaWorkers.list(owner)).map((entry) => [entry.threadId, entry.environment]),
    ).toEqual([[worker, "beta"]]);

    const read = yield* alphaWorkers.read(owner, { threadId: worker });
    expect(read.worker).toMatchObject({ ownerThreadId: owner, environment: "beta" });
    expect(read.items.some((item) => item.text === "Measure the beta build")).toBe(true);
    expect(
      (yield* alphaWorkers.send(owner, {
        threadId: worker,
        clientRequestId: "logs",
        prompt: "Also check the logs",
      })).requestId,
    ).toBe(`${worker}:logs`);

    yield* betaWorkers.report(worker, {
      clientRequestId: "measured",
      outcome: "done",
      summary: "Beta build measured: 41 s",
    });
    yield* betaWorkers.drain();
    yield* alphaWorkers.drain();
    const reports = (yield* messages(alphaSnapshots, owner)).filter((text) =>
      text.includes("Beta build measured: 41 s"),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Worker environment: beta");

    offline.add("env-beta");
    expect((yield* alphaWorkers.list(owner))[0]).toMatchObject({
      threadId: worker,
      state: "unreachable",
      environment: "beta",
    });
    offline.delete("env-beta");
    const refusal = Effect.match({
      onFailure: (error: Workers.WorkerError) => error.message,
      onSuccess: () => "accepted",
    });
    expect(yield* betaWorkers.receive("env-gamma", { _tag: "ping" }).pipe(refusal)).toContain(
      "no peer link",
    );
    expect(
      yield* betaWorkers
        .receive("env-alpha", {
          _tag: "worker",
          owner: { threadId: owner, runtimeMode: "full-access", interactionMode: "default" },
          workerThreadId: "own-beta-master",
          op: "describe",
          input: {},
        })
        .pipe(refusal),
    ).toContain("not a worker owned from alpha");
  }).pipe(Effect.scoped),
);

it.effect("routes a linked worker's reports to the master's handoff successor", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, messages } = yield* linkedPair;
    const { owner } = yield* seed("handoff-alpha").pipe(Effect.provide(alpha));
    yield* seed("handoff-beta").pipe(Effect.provide(beta));
    const worker = ThreadId.make("handoff-remote-worker");
    yield* alphaWorkers.spawn(owner, {
      threadId: worker,
      projectId: ProjectId.make("handoff-beta"),
      title: "remote_worker_sol",
      modelSelection: selections[0]!,
      prompt: "Profile the beta tests",
      environment: "beta",
    });
    const successor = ThreadId.make("handoff-alpha-successor");
    yield* alphaWorkers.handoff(owner, {
      threadId: successor,
      title: "next_master",
      modelSelection: selections[0]!,
      prompt: "Take over the beta work",
    });
    expect((yield* alphaWorkers.list(successor)).map((entry) => entry.threadId)).toEqual([worker]);
    yield* betaWorkers.report(worker, {
      clientRequestId: "blocked",
      outcome: "blocked",
      summary: "Need the beta signing key",
    });
    yield* betaWorkers.drain();
    yield* alphaWorkers.drain();
    expect(
      (yield* messages(alphaSnapshots, successor)).some((text) =>
        text.includes("Need the beta signing key"),
      ),
    ).toBe(true);
    expect(
      (yield* alphaWorkers.send(successor, {
        threadId: worker,
        clientRequestId: "key",
        prompt: "Use the shared vault",
      })).requestId,
    ).toBe(`${worker}:key`);
  }).pipe(Effect.scoped),
);
