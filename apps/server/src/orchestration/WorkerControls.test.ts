import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { EnvironmentId } from "@t3tools/contracts";
import * as WorkerTools from "../mcp/toolkits/workers/tools.ts";
import * as AllocationTools from "../mcp/toolkits/allocation/tools.ts";
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import { ServerConfig } from "../config.ts";
import * as Settings from "../serverSettings.ts";
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
import * as Allocation from "../allocation/ProviderAllocation.ts";
import * as AllocationStore from "../allocation/AllocationStore.ts";
import * as AllocationAssignments from "../allocation/AllocationAssignments.ts";
import { defaultAllocationPolicy } from "@t3tools/contracts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
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
  Layer.provideMerge(Settings.layerTest()),
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
    list: Effect.succeed([]),
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

const allocationRegistry = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed(
    providers.map((p) => ({
      ...p,
      auth: { ...p.auth, email: `${p.instanceId}@example.test`, status: "authenticated" as const },
      usageLimits: {
        checkedAt: "1970-01-01T00:00:00.000Z",
        windows: [
          {
            id: "weekly",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 0,
            resetsAt: "1970-01-07T00:00:00.000Z",
            windowDurationMins: 10080,
          },
          {
            id: "short",
            kind: "session" as const,
            label: "Short",
            usedPercent: 0,
            resetsAt: "1970-01-01T04:00:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    })),
  ),
});
const allocatedWorkerLayer = AllocationAssignments.layer.pipe(
  Layer.provideMerge(Allocation.layer),
  Layer.provideMerge(AllocationStore.layer),
  Layer.provideMerge(Workers.layer),
  Layer.provideMerge(infrastructure),
  Layer.provideMerge(providerLayer),
  Layer.provideMerge(allocationRegistry),
  Layer.provideMerge(noPeers),
  Layer.provide(
    Layer.succeed(UsageMeasurements, {
      read: () =>
        Effect.succeed({
          observedAt: "1970-01-01T00:00:00.000Z",
          monitoredInstanceIds: [],
          retentionDays: 14,
          persistenceError: null,
          accounts: [],
          turns: [],
          totalMatchingTurns: 0,
          profiles: [],
          limitations: [],
        }),
    }),
  ),
);

for (const automatic of [false, true])
  it.effect(
    `allocated fresh workers use real ownership, dispatch and idempotent startup receipts (${automatic ? "model-selected observation recovery" : "exact"})`,
    () =>
      Effect.gen(function* () {
        const { owner, worker } = yield* seed("allocated-fresh", 1);
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          allocationCoordinatorEnvironmentId: "env-local",
        });
        const store = yield* AllocationStore.AllocationStore;
        yield* store.savePolicy({
          expectedVersion: 0,
          policy: {
            ...defaultAllocationPolicy,
            coordinatorEnvironmentId: "env-local",
            mode: "automatic",
          },
        });
        const assignments = yield* AllocationAssignments.AllocationAssignments;
        const request = {
          kind: "worker" as const,
          projectId: ProjectId.make("allocated-fresh"),
          title: "allocated_astra",
          prompt: "perform allocated work",
          request: {
            assignmentId: "integrated-start",
            environmentId: "env-local",
            threadId: worker,
            ...(automatic
              ? {
                  selection: "automatic" as const,
                  allowedDrivers: [ProviderDriverKind.make("codex")],
                  assessment: {
                    difficulty: 8,
                    stakes: 8,
                    difficultyReason: "Interacting state machines",
                    stakesReason: "Consequential startup",
                  },
                }
              : {
                  driver: ProviderDriverKind.make("codex"),
                  model: selections[1]!.model,
                  options: selections[1]!.options,
                }),
          },
        };
        if (automatic) {
          const policy = yield* store.policy;
          yield* store.savePolicy({
            expectedVersion: 1,
            policy: { ...policy, mode: "observation" },
          });
          expect((yield* assignments.start(request, owner)).state).toBe("observation");
          expect(yield* store.reservations).toHaveLength(0);
          expect(
            Option.isNone(yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(worker)),
          ).toBe(true);
          yield* store.savePolicy({ expectedVersion: 2, policy: { ...policy, mode: "automatic" } });
        }
        expect((yield* assignments.start(request, owner)).state).toBe("submitted");
        const workers = yield* Workers.WorkerControls;
        yield* workers.drain();
        const shell = Option.getOrThrow(
          yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(worker),
        );
        expect(shell.modelSelection).toEqual(selections[1]);
        expect(shell.messages.filter((m) => m.role === "user")).toHaveLength(1);
        expect((yield* workers.list(owner))[0]?.threadId).toBe(worker);
        yield* assignments.start(request, owner);
        yield* workers.drain();
        const repeated = Option.getOrThrow(
          yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(worker),
        );
        expect(repeated.messages.filter((m) => m.role === "user")).toHaveLength(1);
        expect(yield* store.reservations).toHaveLength(1);
        expect((yield* store.reservations)[0]?.request.assignmentId).toBe("integrated-start");
        expect((yield* store.reservations)[0]?.request.threadId).toBe(worker);
      }).pipe(Effect.provide(allocatedWorkerLayer)),
  );

for (const automatic of [false, true])
  it.effect(
    `allocated human sessions preserve their profile and release rejected startup from real receipts (${automatic ? "model-selected" : "exact"})`,
    () =>
      Effect.gen(function* () {
        yield* seed("allocated-human", 1);
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          allocationCoordinatorEnvironmentId: "env-local",
        });
        const store = yield* AllocationStore.AllocationStore;
        yield* store.savePolicy({
          expectedVersion: 0,
          policy: {
            ...defaultAllocationPolicy,
            coordinatorEnvironmentId: "env-local",
            mode: "automatic",
          },
        });
        const assignments = yield* AllocationAssignments.AllocationAssignments;
        const input = {
          kind: "session" as const,
          projectId: ProjectId.make("missing-project"),
          title: "new session",
          prompt: "task",
          request: {
            assignmentId: "human-failed",
            threadId: ThreadId.make("human-failed"),
            environmentId: "env-local",
            ...(automatic
              ? {
                  selection: "automatic" as const,
                  allowedDrivers: [ProviderDriverKind.make("codex")],
                  assessment: {
                    difficulty: 8,
                    stakes: 8,
                    difficultyReason: "Interacting state machines",
                    stakesReason: "Consequential startup",
                  },
                }
              : {
                  driver: ProviderDriverKind.make("codex"),
                  model: selections[1]!.model,
                  options: selections[1]!.options,
                }),
          },
        };
        expect(Exit.isFailure(yield* Effect.exit(assignments.start(input)))).toBe(true);
        yield* (yield* Allocation.ProviderAllocation).execute({ _tag: "snapshot" });
        expect((yield* store.reservations)[0]?.state).toBe("released");
        const valid = {
          ...input,
          projectId: ProjectId.make("allocated-human"),
          request: {
            ...input.request,
            assignmentId: "human-created",
            threadId: ThreadId.make("human-created"),
          },
        };
        expect((yield* assignments.start(valid)).state).toBe("submitted");
        expect((yield* assignments.start(valid)).state).toBe("submitted");
        const thread = Option.getOrThrow(
          yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(valid.request.threadId),
        );
        expect(thread.modelSelection).toEqual(selections[1]);
        expect(thread.messages.filter((m) => m.role === "user")).toHaveLength(1);
      }).pipe(Effect.provide(allocatedWorkerLayer)),
  );
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
const confirmedMessage = Effect.fn(function* (
  service: Workers.WorkerControls["Service"],
  sender: ThreadId,
  input: typeof Workers.MessageInput.Type,
) {
  const preview = yield* service.message(sender, input);
  return preview.confirmation
    ? yield* service.message(sender, { ...input, confirmationToken: preview.confirmation.token })
    : preview;
});
const session = Effect.fn(function* (
  threadId: ThreadId,
  status: "running" | "ready" | "error" | "stopped" | "interrupted",
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
const directInput = Effect.fn(function* (
  threadId: ThreadId,
  suffix: string,
  text = "continue directly",
) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`direct-${suffix}`),
    threadId,
    message: {
      messageId: MessageId.make(`human-${suffix}`),
      role: "user",
      text,
      attachments: [],
    },
    modelSelection: selections[0]!,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: timestamp,
  });
});
// Completed turns of the given hours, tool calls of the given seconds inside them, and compactions.
const workHistory = Effect.fn(function* (
  threadId: ThreadId,
  prefix: string,
  turnHours: ReadonlyArray<number>,
  toolSeconds: ReadonlyArray<number> = [],
  compactions = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const origin = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"));
  let start = origin;
  for (const [index, hours] of turnHours.entries()) {
    const end = start + hours * 3_600_000;
    yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
      VALUES (${threadId}, ${`${prefix}-turn-${index}`}, 'completed', ${at(start)}, ${at(start)}, ${at(end)}, '[]')`;
    start = end + 60_000;
  }
  const activity = (id: string, kind: string, payload: object, ms: number) =>
    sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
      VALUES (${id}, ${threadId}, ${`${prefix}-turn-0`}, 'tool', ${kind}, ${kind}, ${JSON.stringify(payload)}, ${at(ms)})`;
  let call = origin;
  for (const [index, seconds] of toolSeconds.entries()) {
    const toolCallId = `${prefix}-call-${index}`;
    yield* activity(`${toolCallId}-started`, "tool.started", { toolCallId }, call);
    yield* activity(
      `${toolCallId}-completed`,
      "tool.completed",
      { toolCallId },
      call + seconds * 1000,
    );
    call += seconds * 1000 + 1000;
  }
  for (let index = 0; index < compactions; index++)
    yield* activity(`${prefix}-compaction-${index}`, "context-compaction", {}, call + index);
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
        expect(yield* service.handoff(owner, request)).toMatchObject(result);
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
      yield* TestClock.setTime(Date.parse("2026-01-15T18:05:00Z"));
      const first = yield* service.report(worker, report);
      yield* TestClock.adjust("2 minutes");
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
      expect(messages[0]!.text.split("\n")[0]).toBe(`[T3 worker report — ${input.title} — 13:05]`);
      expect(messages[0]!.text).toContain("Outcome: blocked");
      expect(messages[0]!.text).toContain(report.summary);
      yield* service.drain();
      expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toHaveLength(
        1,
      );
    }),
  );
  for (const [instant, localTime, outcome] of [
    ["2026-01-15T18:05:59Z", "13:05", "done"],
    ["2026-07-15T18:05:59Z", "14:05", "blocked"],
    ["2026-07-16T00:05:00Z", "20:05", "done"],
    ["2026-01-16T05:00:00Z", "00:00", "blocked"],
  ] as const) {
    it.effect(`timestamps ${outcome} reports at ${instant} as ${localTime}`, () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, input } = yield* seed(`timestamp-${instant}`);
        yield* service.spawn(owner, input);
        yield* TestClock.setTime(Date.parse(instant));
        yield* service.report(worker, {
          clientRequestId: "timed",
          outcome,
          summary: "Timestamped result.",
        });
        yield* service.drain();
        const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]!.text.split("\n")[0]).toBe(
          `[T3 worker report — ${input.title} — ${localTime}]`,
        );
      }),
    );
  }
  it.effect("retries reports saved before timestamps without changing their text", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const sql = yield* SqlClient.SqlClient;
      const { owner, worker, input } = yield* seed("legacy-timestamp");
      yield* service.spawn(owner, input);
      yield* service.control(owner, { threadId: worker, notifications: false });
      const report = { clientRequestId: "legacy", outcome: "done" as const, summary: "Done." };
      const first = yield* service.report(worker, report);
      const saved = (yield* sql<{ prompt: string }>`SELECT prompt FROM custom_worker_jobs
        WHERE id = ${first.requestId}`)[0]!.prompt;
      const legacy = saved.replace(
        /^\[T3 worker report[^\n]*\]/,
        `[T3 worker report — ${input.title}]`,
      );
      yield* sql`UPDATE custom_worker_jobs SET prompt = ${legacy} WHERE id = ${first.requestId}`;
      yield* TestClock.adjust("1 day");
      expect((yield* service.report(worker, report)).requestId).toBe(first.requestId);
      expect(
        (yield* sql<{ prompt: string }>`SELECT prompt FROM custom_worker_jobs
        WHERE id = ${first.requestId}`)[0]!.prompt,
      ).toBe(legacy);
      expect(
        (yield* service.report(worker, { ...report, summary: "Changed." }).pipe(Effect.flip))
          .message,
      ).toContain("different assignment");
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
  it.effect("requires a message-specific confirmation and sends no warning to the recipient", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const sql = yield* SqlClient.SqlClient;
      const sender = yield* seed("confirm-sender");
      const target = yield* seed("confirm-target");
      const input = {
        threadId: target.owner,
        clientRequestId: "review",
        prompt: "Please inspect the shared result.",
      };
      const warning = yield* service.message(sender.owner, input);
      expect(warning.state).toBe("confirmation_required");
      expect(warning.confirmation?.recipient.projectId).toBe("confirm-target");
      expect(warning.confirmation?.warning).toContain("is it necessary?");
      expect(
        yield* sql`SELECT 1 FROM custom_worker_jobs WHERE id = ${warning.requestId}`,
      ).toHaveLength(0);
      const wrong = yield* service.message(sender.owner, {
        ...input,
        confirmationToken: "invented",
      });
      expect(wrong.state).toBe("confirmation_required");
      expect(
        (yield* service.message(sender.owner, { ...input, prompt: "changed" }).pipe(Effect.flip))
          .message,
      ).toContain("different message");
      const confirmed = yield* service.message(sender.owner, {
        ...input,
        confirmationToken: warning.confirmation!.token,
      });
      expect(confirmed.state).toBe("dispatched");
      yield* service.message(sender.owner, input);
      expect(
        yield* sql`SELECT 1 FROM custom_worker_jobs WHERE id = ${warning.requestId}`,
      ).toHaveLength(1);
    }),
  );
  it.effect("expires confirmations and requires a new review after recipient changes", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const { owner, source } = yield* seed("confirm-expiry");
      const input = {
        threadId: source,
        clientRequestId: "expiring",
        prompt: "Coordinate this task.",
      };
      const first = yield* service.message(owner, input);
      yield* TestClock.adjust("11 minutes");
      const expired = yield* service.message(owner, {
        ...input,
        confirmationToken: first.confirmation!.token,
      });
      expect(expired.state).toBe("confirmation_required");
      expect(expired.confirmation!.token).not.toBe(first.confirmation!.token);
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("rename-confirm"),
        threadId: source,
        title: "Different recipient title",
      });
      const changed = yield* service.message(owner, {
        ...input,
        confirmationToken: expired.confirmation!.token,
      });
      expect(changed.state).toBe("confirmation_required");
      expect(changed.confirmation!.recipient.title).toBe("Different recipient title");
      expect(changed.confirmation!.token).not.toBe(expired.confirmation!.token);
    }),
  );
  it.effect("rechecks queued messages after handoff and permits retired peers", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const sender = yield* seed("retire-sender");
      const target = yield* seed("retire-target");
      yield* engine.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("hold-peer"),
        threadId: target.owner,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      });
      const message = yield* confirmedMessage(service, sender.owner, {
        threadId: target.owner,
        clientRequestId: "stale",
        prompt: "A queued message.",
      });
      expect(message.state).toBe("queued");
      yield* directInput(target.owner, "retire-resume");
      const next = ThreadId.make("retire-target-next");
      yield* service.handoff(target.owner, {
        threadId: next,
        title: "next",
        prompt: "Take over",
        modelSelection: selections[0]!,
      });
      yield* service.drain();
      expect(
        (yield* sql<{
          state: string;
          error: string;
        }>`SELECT state, error FROM custom_worker_jobs WHERE id = ${message.requestId}`)[0],
      ).toMatchObject({
        state: "error",
        error: expect.stringContaining("changed since confirmation"),
      });
      const preview = yield* service.message(target.owner, {
        threadId: sender.owner,
        clientRequestId: "old",
        prompt: "New coordination",
      });
      expect(preview.state).toBe("confirmation_required");
      expect(preview.warning).toContain(next);
      const sent = yield* service.message(target.owner, {
        threadId: sender.owner,
        clientRequestId: "old",
        prompt: "New coordination",
        confirmationToken: preview.confirmation!.token,
      });
      expect(sent.state).toBe("dispatched");
      expect(sent.warning).toBeUndefined();
      const received = yield* confirmedMessage(service, sender.owner, {
        threadId: target.owner,
        clientRequestId: "back-to-former-master",
        prompt: "Intentional reply",
      });
      expect(received.state).toBe("dispatched");
    }),
  );
  it.effect("retired masters launch and supervise new workers with one persistent warning", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("retired-launch");
      const next = ThreadId.make("retired-launch-next");
      yield* service.spawn(owner, input);
      expect(
        (yield* service.handoff(owner, {
          threadId: next,
          title: "next",
          prompt: "Take over",
          modelSelection: selections[0]!,
        })).warning,
      ).toBeUndefined();
      // Inspection and failed ownership checks must not consume the warning.
      expect(yield* service.list(owner)).toHaveLength(0);
      expect(
        (yield* service.control(owner, { threadId: worker }).pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      expect(
        (yield* sql<{ retirement_warned: number }>`SELECT retirement_warned
        FROM custom_orchestrator_authority WHERE thread_id = ${owner}`)[0]!.retirement_warned,
      ).toBe(0);
      const launched = yield* Effect.forEach(
        [1, 2, 3],
        (index) =>
          service.spawn(owner, {
            projectId: ProjectId.make("retired-launch"),
            threadId: ThreadId.make(`retired-launch-fresh-${index}`),
            title: `fresh-${index}`,
            modelSelection: selections[0]!,
            prompt: "New assignment",
          }),
        { concurrency: "unbounded" },
      );
      expect(launched.filter((result) => result.warning)).toHaveLength(1);
      expect(launched.find((result) => result.warning)!.warning).toContain(
        "no confirmation or reclaim",
      );
      for (const result of launched) {
        expect(result.ownerThreadId).toBe(owner);
        expect(["queued", "submitted"]).toContain(result.latestRequest!.state);
      }
      yield* service.drain();
      expect(
        (yield* service.list(owner)).every((result) => result.latestRequest!.state === "submitted"),
      ).toBe(true);
      expect((yield* service.list(next)).map((result) => result.threadId)).toEqual([worker]);
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      const freshId = launched[0]!.threadId;
      yield* restarted.control(owner, { threadId: freshId, notifications: false });
      const report = yield* restarted.report(freshId, {
        clientRequestId: "done-after-retirement",
        outcome: "blocked",
        summary: "New work needs a decision.",
      });
      expect(
        (yield* sql<{ target_id: string }>`SELECT target_id FROM custom_worker_jobs
        WHERE id = ${report.requestId}`)[0]!.target_id,
      ).toBe(owner);
      yield* restarted.control(owner, { threadId: freshId, notifications: true });
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.some((message) =>
          message.text.includes("New work needs a decision."),
        ),
      ).toBe(true);
      const forked = yield* restarted.spawn(owner, {
        ...input,
        threadId: ThreadId.make("retired-launch-later-fork"),
      });
      expect(forked.warning).toBeUndefined();
      expect(
        (yield* restarted.send(owner, {
          threadId: freshId,
          clientRequestId: "follow-up",
          prompt: "Continue the new assignment",
        })).warning,
      ).toBeUndefined();
      expect(
        (yield* restarted.control(owner, { threadId: worker }).pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      const nextAgain = ThreadId.make("retired-launch-next-again");
      expect(
        (yield* restarted.handoff(owner, {
          threadId: nextAgain,
          title: "next again",
          prompt: "Take over the new work",
          modelSelection: selections[0]!,
        })).warning,
      ).toBeUndefined();
      yield* restarted.drain();
      expect(
        (yield* restarted.spawn(owner, {
          ...input,
          threadId: ThreadId.make("retired-launch-after-second-handoff"),
        })).warning,
      ).toBeUndefined();
    }),
  );
  it.effect("reclaims only selected historical workers after a new direct user instruction", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const { owner, worker, input } = yield* seed("reclaim");
      const other = ThreadId.make("reclaim-other");
      yield* service.spawn(owner, input);
      yield* service.spawn(owner, { ...input, threadId: other, title: "other" });
      yield* session(worker, "running", "reclaim-running");
      yield* service.control(owner, { threadId: worker, notifications: false });
      yield* service.report(worker, {
        clientRequestId: "held-result",
        outcome: "blocked",
        summary: "Needs a decision.",
      });
      yield* sql`UPDATE custom_workers SET read_seq = 12, read_offset = 7 WHERE thread_id = ${worker}`;
      const next = ThreadId.make("reclaim-next");
      yield* service.handoff(owner, {
        threadId: next,
        title: "next",
        prompt: "Take over",
        modelSelection: selections[0]!,
      });
      const request = {
        clientRequestId: "selected",
        workerThreadIds: [worker],
        userRequest: "Reclaim the original worker.",
      };
      expect((yield* service.reclaim(owner, request).pipe(Effect.flip)).message).toContain(
        "direct user",
      );
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("worker-peer-fake"),
        threadId: owner,
        message: {
          messageId: MessageId.make("worker-job:fake-user"),
          text: request.userRequest,
          attachments: [],
        },
        createdAt: timestamp,
      });
      expect((yield* service.reclaim(owner, request).pipe(Effect.flip)).message).toContain(
        "direct user",
      );
      yield* directInput(owner, "reclaim-user", request.userRequest);
      const result = yield* service.reclaim(owner, request);
      expect(result.workerThreadIds).toEqual([worker]);
      expect((yield* service.list(owner)).map((w) => w.threadId)).toEqual([worker]);
      expect((yield* service.list(next)).map((w) => w.threadId)).toEqual([other]);
      expect(
        (yield* sql`SELECT read_seq, read_offset FROM custom_workers WHERE thread_id = ${worker}`)[0],
      ).toEqual({ read_seq: 12, read_offset: 7 });
      expect(
        (yield* sql<{
          target_id: string;
        }>`SELECT target_id FROM custom_worker_jobs WHERE id = ${`report:${worker}:held-result`}`)[0]!
          .target_id,
      ).toBe(owner);
      expect(yield* service.reclaim(owner, request)).toEqual(result);
      expect(
        (yield* service.control(next, { threadId: worker, notifications: true }).pipe(Effect.flip))
          .message,
      ).toContain("not a worker owned");
      yield* service.control(owner, { threadId: worker, notifications: true });
      const snapshots = yield* ProjectionSnapshotQuery;
      expect(
        Option.getOrThrow(yield* snapshots.getThreadShellById(worker)).session?.activeTurnId,
      ).toBe("reclaim-running");
      const unrelated = yield* seed("reclaim-unrelated");
      yield* service.spawn(unrelated.owner, unrelated.input);
      expect(
        (yield* service
          .reclaim(owner, {
            ...request,
            clientRequestId: "no-stealing",
            workerThreadIds: [other, unrelated.worker],
          })
          .pipe(Effect.flip)).message,
      ).toContain("handed-off worker");
      expect((yield* service.list(next)).map((w) => w.threadId)).toEqual([other]);
    }),
  );
  it.effect("splits an undelivered digest when reclaiming a subset of workers", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const { owner, worker, input } = yield* seed("reclaim-digest");
      const second = ThreadId.make("reclaim-digest-second");
      const remaining = ThreadId.make("reclaim-digest-remaining");
      for (const workerId of [worker, second, remaining])
        yield* service.spawn(owner, { ...input, threadId: workerId, title: workerId });
      const next = ThreadId.make("reclaim-digest-next");
      yield* service.handoff(owner, {
        threadId: next,
        title: "next",
        prompt: "Take over",
        modelSelection: selections[0]!,
      });
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("stop-digest-master"),
        threadId: next,
        createdAt: timestamp,
      });
      yield* replyAndReport(worker, "digest-one", "First result");
      yield* replyAndReport(second, "digest-two", "Second result");
      yield* TestClock.adjust("21 minutes");
      yield* service.drain();
      expect(
        yield* sql`SELECT 1 FROM custom_worker_jobs WHERE id LIKE 'digest:%' AND state = 'queued'`,
      ).toHaveLength(1);
      const userRequest = "Reclaim the second worker only.";
      yield* directInput(owner, "reclaim-digest-user", userRequest);
      yield* service.reclaim(owner, {
        clientRequestId: "split",
        workerThreadIds: [second],
        userRequest,
      });
      expect((yield* service.list(owner)).map((w) => w.threadId)).toEqual([second]);
      expect((yield* service.list(next)).map((w) => w.threadId).sort()).toEqual(
        [worker, remaining].sort(),
      );
      expect(
        yield* sql`SELECT 1 FROM custom_worker_jobs WHERE id LIKE 'digest:%' AND state = 'cancelled'`,
      ).toHaveLength(1);
      expect(
        (yield* sql<{
          target_id: string;
        }>`SELECT target_id FROM custom_worker_jobs WHERE id = ${`report:${second}:digest-two`}`)[0]!
          .target_id,
      ).toBe(owner);
      expect(
        (yield* sql<{
          target_id: string;
        }>`SELECT target_id FROM custom_worker_jobs WHERE id = ${`report:${worker}:digest-one`}`)[0]!
          .target_id,
      ).toBe(next);
    }),
  );
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
      expect((yield* confirmedMessage(service, sender.owner, input)).state).toBe("dispatched");
      yield* confirmedMessage(service, sender.owner, input);
      expect(
        (yield* confirmedMessage(service, sender.owner, { ...input, prompt: "different" }).pipe(
          Effect.flip,
        )).message,
      ).toContain("different message");
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
        (yield* confirmedMessage(service, source, {
          threadId: owner,
          clientRequestId: "idle",
          prompt: "Result ready.",
        })).state,
      ).toBe("dispatched");
      expect(
        (yield* confirmedMessage(service, owner, {
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
      expect((yield* confirmedMessage(service, owner, input)).state).toBe("queued");
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
      expect((yield* confirmedMessage(restarted, owner, input)).state).toBe("dispatched");
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
      expect((yield* confirmedMessage(service, owner, input).pipe(Effect.flip)).message).toContain(
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
        (yield* confirmedMessage(service, owner, { ...input, threadId: source }).pipe(Effect.flip))
          .message,
      ).toContain("archived");
    }),
  );
  it.effect("holds finished reports while other workers run, then sends one digest", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const { owner, worker, input } = yield* seed("digest");
      const second = ThreadId.make("digest-worker-2");
      yield* service.spawn(owner, input);
      yield* service.spawn(owner, { ...input, threadId: second, title: "digest_WORKER_2" });
      const ownerTexts = () =>
        snapshots
          .getThreadDetailById(owner)
          .pipe(Effect.map((thread) => Option.getOrThrow(thread).messages.map((m) => m.text)));
      const starts = () =>
        sql`SELECT 1 FROM orchestration_events WHERE stream_id = ${owner} AND event_type = 'thread.turn-start-requested' AND command_id LIKE 'worker-job:%'`;

      yield* TestClock.setTime(Date.parse("2026-07-16T00:05:00Z"));
      yield* replyAndReport(worker, "digest-first", "First part finished");
      yield* service.drain();
      expect((yield* ownerTexts()).some((text) => text.includes("First part finished"))).toBe(
        false,
      );

      yield* TestClock.adjust("2 minutes");
      yield* service.report(second, {
        clientRequestId: "digest-blocked",
        outcome: "blocked",
        needs: "user",
        summary: "Needs the signing key",
      });
      yield* service.drain();
      const blocked = (yield* ownerTexts()).filter((text) =>
        text.includes("Needs the signing key"),
      );
      expect(blocked).toHaveLength(1);
      expect(blocked[0]).toContain("blocked, needs the user");
      expect(blocked[0]!.split("\n")[0]).toBe("[T3 worker report — digest_WORKER_2 — 20:07]");

      yield* TestClock.adjust("3 minutes");
      yield* replyAndReport(second, "digest-second", "Second part finished");
      yield* service.drain();
      const digests = (yield* ownerTexts()).filter((text) =>
        text.startsWith("[T3 worker reports — 2 finished]"),
      );
      expect(digests).toHaveLength(1);
      expect(digests[0]).toContain("First part finished");
      expect(digests[0]).toContain("Second part finished");
      expect(
        digests[0]!.split("\n").filter((line) => line.startsWith("[T3 worker report")),
      ).toEqual([
        "[T3 worker reports — 2 finished]",
        `[T3 worker report — ${input.title} — 20:05]`,
        "[T3 worker report — digest_WORKER_2 — 20:10]",
      ]);
      expect(yield* starts()).toHaveLength(2);
      expect((yield* service.list(owner)).map((entry) => entry.pendingReports)).toEqual([0, 0]);
    }),
  );
  it.effect("releases a held report after the digest wait", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("digest-wait");
      yield* service.spawn(owner, input);
      yield* service.spawn(owner, {
        ...input,
        threadId: ThreadId.make("digest-wait-worker-2"),
        title: "digest_wait_WORKER_2",
      });
      yield* TestClock.setTime(Date.parse("2026-01-16T04:55:00Z"));
      yield* replyAndReport(worker, "digest-wait-first", "Finished alone");
      const delivered = () =>
        snapshots
          .getThreadDetailById(owner)
          .pipe(
            Effect.map((thread) =>
              Option.getOrThrow(thread).messages.some((m) => m.text.includes("Finished alone")),
            ),
          );
      yield* service.drain();
      expect(yield* delivered()).toBe(false);
      yield* TestClock.adjust("21 minutes");
      yield* service.drain();
      expect(yield* delivered()).toBe(true);
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages[0]!.text.split(
          "\n",
        )[0],
      ).toBe(`[T3 worker report — ${input.title} — 23:55]`);
    }),
  );
  it.effect("rejects report summaries over 500 characters", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownExit(Workers.ReportInput);
      const report = { clientRequestId: "long", outcome: "done" };
      expect(Exit.isFailure(decode({ ...report, summary: "x".repeat(501) }))).toBe(true);
      expect(Exit.isSuccess(decode({ ...report, summary: "x".repeat(500) }))).toBe(true);
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
  for (const state of ["error", "interrupted"] as const) {
    it.effect(`preserves the ${state} report time across delayed delivery and restart`, () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        const { owner, worker, input } = yield* seed(`runtime-time-${state}`);
        yield* service.spawn(owner, input);
        yield* session(worker, "running", `timed-${state}-turn`);
        yield* session(worker, state, `timed-${state}-end`);
        // An in-flight session move parks delivery without suppressing report creation.
        yield* sql`INSERT INTO custom_session_moves
          (id, thread_id, target_thread_id, direction, peer_environment_id, input_json, created_at, updated_at)
          VALUES (${"hold-" + state}, ${owner}, ${owner}, 'out', 'peer', '{}', ${timestamp}, ${timestamp})`;
        yield* TestClock.setTime(Date.parse("2026-07-16T00:05:00Z"));
        yield* service.drain();
        const notices = yield* sql<{ prompt: string; state: string }>`SELECT prompt, state
          FROM custom_worker_jobs WHERE worker_id = ${worker} AND kind = 'notice'`;
        expect(notices).toHaveLength(1);
        expect(notices[0]!.prompt.split("\n")[0]).toBe(
          `[T3 worker report — ${input.title} — 20:05]`,
        );
        expect(notices[0]!.prompt).toContain(`Runtime state: ${state}`);
        expect(notices[0]!.state).toBe("queued");
        yield* TestClock.adjust("1 hour");
        yield* sql`UPDATE custom_session_moves SET locked = 0 WHERE id = ${"hold-" + state}`;
        const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
        yield* restarted.drain();
        const messages = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
        expect(messages).toHaveLength(1);
        expect(messages[0]!.text).toBe(notices[0]!.prompt);
      }),
    );
  }
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
      const message = yield* confirmedMessage(service, source, {
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
  it.effect("reports working time and flags workers and masters past their thresholds", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("work-time", 2);
      yield* service.spawn(owner, input);
      // 5 h of turns, a 2 h build wait and two short tool calls that still count as work.
      yield* workHistory(worker, "first", [2, 3], [7200, 30, 45], 1);
      yield* workHistory(owner, "master", [5.5]);
      const first = {
        clientRequestId: "first",
        outcome: "done" as const,
        summary: "First stage done.",
      };
      const report = yield* service.report(worker, first);
      yield* workHistory(worker, "second", [1]);
      expect((yield* service.report(worker, first)).requestId).toBe(report.requestId);
      yield* service.report(worker, {
        clientRequestId: "second",
        outcome: "done",
        summary: "Second stage done.",
      });
      const texts = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.map(
        (m) => m.text,
      );
      const under = texts.filter((text) => text.includes("First stage done."));
      expect(under).toHaveLength(1);
      expect(under[0]).toContain("Worker working time: 3.0 h over 2 turns, 1 compaction.\n");
      expect(under[0]).not.toContain("renew this worker");
      expect(under[0]).toContain("Your working time as master: 5.5 h over 1 turn, 0 compactions.");
      expect(under[0]).toContain(
        'Over the 5 h renewal threshold: renew yourself with the t3-fork-session "renew yourself" steps',
      );
      const over = texts.find((text) => text.includes("Second stage done."));
      expect(over).toContain(
        'Worker working time: 4.0 h over 3 turns, 1 compaction. Over the 3.5 h renewal threshold: renew this worker with the t3-fork-session "renew <worker>" steps',
      );
    }),
  );
  it.effect("applies renewal setting changes to the next report without a restart", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const settings = yield* Settings.ServerSettingsService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("tuned-time", 2);
      yield* service.spawn(owner, input);
      yield* workHistory(worker, "tuned", [2], [2400, 1200]);
      const report = (id: string) =>
        service.report(worker, { clientRequestId: id, outcome: "done", summary: `Tuned ${id}.` });
      yield* report("defaults");
      yield* settings.updateSettings({ workerRenewal: { workerHours: 1, toolWaitSeconds: 1800 } });
      yield* report("changed").pipe(
        Effect.ensuring(
          settings
            .updateSettings({ workerRenewal: { workerHours: 3.5, toolWaitSeconds: 60 } })
            .pipe(Effect.ignore),
        ),
      );
      const texts = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.map(
        (m) => m.text,
      );
      expect(texts.find((text) => text.includes("Tuned defaults."))).toContain(
        "Worker working time: 1.0 h over 1 turn, 0 compactions.",
      );
      expect(texts.find((text) => text.includes("Tuned changed."))).toContain(
        "Worker working time: 1.3 h over 1 turn, 0 compactions. Over the 1 h",
      );
    }),
  );
  it.effect("gives Codex workers and masters 1.5 times longer before renewal", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, worker, input } = yield* seed("codex-time", 0);
      yield* service.spawn(owner, input);
      yield* session(owner, "ready", "codex-master-session");
      yield* session(worker, "ready", "codex-worker-session");
      yield* workHistory(worker, "first", [4]);
      yield* workHistory(owner, "master", [6]);
      const report = (id: string, summary: string) =>
        service.report(worker, { clientRequestId: id, outcome: "done", summary });
      yield* report("under", "Codex stage one.");
      yield* workHistory(worker, "second", [1.5]);
      yield* report("over", "Codex stage two.");
      const texts = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages.map(
        (m) => m.text,
      );
      const under = texts.find((text) => text.includes("Codex stage one."));
      expect(under).toContain("Worker working time: 4.0 h over 1 turn, 0 compactions.\n");
      expect(under).toContain("Your working time as master: 6.0 h over 1 turn, 0 compactions.");
      expect(under).not.toContain("renewal threshold");
      expect(texts.find((text) => text.includes("Codex stage two."))).toContain(
        "Worker working time: 5.5 h over 2 turns, 0 compactions. Over the 5.25 h renewal threshold",
      );
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
it.effect(
  "model selection MCP previews and starts exactly one worker owned by the authenticated master",
  () =>
    Effect.gen(function* () {
      const { owner, worker } = yield* seed("model-mcp", 1);
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        allocationCoordinatorEnvironmentId: "env-local",
      });
      const store = yield* AllocationStore.AllocationStore;
      yield* store.savePolicy({
        expectedVersion: 0,
        policy: {
          ...defaultAllocationPolicy,
          coordinatorEnvironmentId: "env-local",
          mode: "automatic",
        },
      });
      const server = yield* McpServer.McpServer;
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        clientCapabilities: {},
        clientInfo: { name: "model-test", version: "1" },
        protocolVersion: "2025-06-18",
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "model-test", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const call = (name: string, args: Record<string, unknown>) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("env-local"),
            threadId: owner,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex_antoine"),
            capabilities: new Set<Invocation.McpCapability>(),
            issuedAt: 1,
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      const request = {
        selection: "automatic",
        assignmentId: "mcp-selected",
        threadId: worker,
        environmentId: "env-local",
        allowedDrivers: ["codex"],
        assessment: {
          difficulty: 8,
          stakes: 8,
          difficultyReason: "Interacting behavior",
          stakesReason: "Hard-to-detect failures",
        },
      };
      expect((yield* call("t3_allocate_account", { request, preview: true })).isError).not.toBe(
        true,
      );
      expect(yield* store.reservations).toHaveLength(0);
      const input = {
        request,
        kind: "worker",
        projectId: "model-mcp",
        title: "Selected worker",
        prompt: "Perform the scoped assignment",
        ownerThreadId: "forged-owner",
      };
      expect((yield* call("t3_start_allocated_assignment", input)).isError).not.toBe(true);
      const workers = yield* Workers.WorkerControls;
      yield* workers.drain();
      expect((yield* workers.list(owner)).map((w) => w.threadId)).toEqual([worker]);
      expect((yield* call("t3_start_allocated_assignment", input)).isError).not.toBe(true);
      yield* workers.drain();
      const thread = Option.getOrThrow(
        yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(worker),
      );
      expect(thread.modelSelection).toEqual(selections[1]);
      expect(thread.messages.filter((m) => m.role === "user")).toHaveLength(1);
      expect(yield* store.reservations).toHaveLength(1);
    }).pipe(
      Effect.provide(
        McpServer.toolkit(AllocationTools.AllocationToolkit).pipe(
          Layer.provide(AllocationTools.handlers),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(allocatedWorkerLayer),
        ),
      ),
    ),
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
          const preview = yield* (yield* Workers.WorkerControls).message(owner, {
            threadId: peer.owner,
            clientRequestId: "peer-auth",
            prompt: "Coordinate with the actual sender.",
          });
          expect(
            (yield* call("t3_session_send", {
              threadId: peer.owner,
              clientRequestId: "peer-auth",
              prompt: "Coordinate with the actual sender.",
              confirmationToken: preview.confirmation!.token,
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
          const newSpawn = { ...spawnInput, threadId: `${worker}-after-handoff` };
          const warned = yield* call("t3_worker_spawn", newSpawn);
          expect(warned.isError).not.toBe(true);
          expect(warned.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("informational warning"),
              }),
            ]),
          );
          const quietRetry = yield* call("t3_worker_spawn", newSpawn);
          expect(quietRetry.isError).not.toBe(true);
          expect(quietRetry.content).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("informational warning"),
              }),
            ]),
          );
          const userRequest = "Reclaim this worker at my request.";
          yield* directInput(owner, `mcp-reclaim-${fresh}`, userRequest);
          expect(
            (yield* call("t3_worker_reclaim", {
              clientRequestId: "mcp-reclaim",
              workerThreadIds: [worker],
              userRequest,
              ownerThreadId: "forged",
            })).isError,
          ).not.toBe(true);
          expect(
            (yield* (yield* Workers.WorkerControls).list(owner)).map((result) => result.threadId),
          ).toContain(worker);
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
const lostReplies = new Set<string>();
const linkedEnvironments = [
  { environmentId: "env-gamma", label: "gamma", url: "https://gamma.test", token: "gamma" },
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
          list: Effect.succeed(
            linkedEnvironments.filter((peer) => peer.environmentId !== environmentId),
          ),
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
                  Effect.flatMap((response) => {
                    const tag =
                      typeof request === "object" && request !== null && "_tag" in request
                        ? request._tag
                        : "";
                    return lostReplies.delete(`${target}:${tag}`)
                      ? Effect.fail(
                          new PeerUnavailable({
                            environmentId: target,
                            message: "Response lost after durable acceptance",
                          }),
                        )
                      : Effect.succeed(response);
                  }),
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
  const gamma = yield* Layer.build(environmentLayer("env-gamma")).pipe(Scope.provide(scope));
  for (const [id, context] of [
    ["env-alpha", alpha],
    ["env-beta", beta],
    ["env-gamma", gamma],
  ] as const)
    peerHandlers.set(id, (from, request) =>
      Workers.WorkerControls.pipe(
        Effect.flatMap((service) => service.receive(from, request)),
        Effect.provide(context),
      ),
    );
  offline.clear();
  lostReplies.clear();
  const services = Effect.all([Workers.WorkerControls, ProjectionSnapshotQuery]);
  const [alphaWorkers, alphaSnapshots] = yield* services.pipe(Effect.provide(alpha));
  const [betaWorkers, betaSnapshots] = yield* services.pipe(Effect.provide(beta));
  const messages = (snapshots: typeof alphaSnapshots, id: ThreadId) =>
    snapshots
      .getThreadDetailById(id)
      .pipe(Effect.map((thread) => Option.getOrThrow(thread).messages.map((m) => m.text)));
  const [gammaWorkers, gammaSnapshots] = yield* services.pipe(Effect.provide(gamma));
  return {
    gamma,
    gammaWorkers,
    gammaSnapshots,
    alpha,
    beta,
    alphaWorkers,
    betaWorkers,
    alphaSnapshots,
    betaSnapshots,
    messages,
  };
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
    const preview = yield* alphaWorkers.message(sender, input);
    expect(preview.state).toBe("confirmation_required");
    offline.add("env-beta");
    expect(
      (yield* alphaWorkers.message(sender, {
        ...input,
        confirmationToken: preview.confirmation!.token,
      })).state,
    ).toBe("queued");
    offline.delete("env-beta");
    yield* alphaWorkers.drain();
    expect(yield* confirmedMessage(alphaWorkers, sender, input)).toMatchObject({
      threadId: recipient,
      state: "dispatched",
    });
    yield* betaWorkers.drain();
    const received = (yield* messages(betaSnapshots, recipient)).filter((text) =>
      text.includes("Is the shared build green?"),
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toContain(`From session: ${sender} in environment alpha`);
    yield* confirmedMessage(betaWorkers, recipient, {
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
        .message(sender, { ...input, clientRequestId: "x", environment: "unlinked" })
        .pipe(Effect.flip)).message,
    ).toContain("No linked environment named unlinked");
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
    expect(yield* betaWorkers.receive("env-unlinked", { _tag: "ping" }).pipe(refusal)).toContain(
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

it.effect("adds each environment's working time to a linked worker's report", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, messages } = yield* linkedPair;
    const { owner } = yield* seed("time-alpha").pipe(Effect.provide(alpha));
    yield* seed("time-beta").pipe(Effect.provide(beta));
    const worker = ThreadId.make("time-remote-worker");
    yield* alphaWorkers.spawn(owner, {
      threadId: worker,
      projectId: ProjectId.make("time-beta"),
      title: "remote_time_worker_opus",
      modelSelection: selections[2]!,
      prompt: "Run the long job",
      environment: "beta",
    });
    yield* workHistory(worker, "remote", [4]).pipe(Effect.provide(beta));
    yield* workHistory(owner, "local", [1.5]).pipe(Effect.provide(alpha));
    yield* betaWorkers.report(worker, {
      clientRequestId: "long",
      outcome: "done",
      summary: "Long job finished",
    });
    yield* betaWorkers.drain();
    yield* alphaWorkers.drain();
    const report = (yield* messages(alphaSnapshots, owner)).find((text) =>
      text.includes("Long job finished"),
    );
    expect(report).toContain(
      "Worker working time: 4.0 h over 1 turn, 0 compactions. Over the 3.5 h",
    );
    expect(report).toContain(
      "Worker environment: beta\nYour working time as master: 1.5 h over 1 turn, 0 compactions.",
    );
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
    const newWorker = ThreadId.make("handoff-new-remote-worker");
    const newAssignment = {
      threadId: newWorker,
      projectId: ProjectId.make("handoff-beta"),
      title: "new_remote_worker_sol",
      modelSelection: selections[0]!,
      prompt: "Handle a new assignment",
      environment: "beta",
    };
    expect((yield* alphaWorkers.spawn(owner, newAssignment)).warning).toContain(successor);
    expect((yield* alphaWorkers.spawn(owner, newAssignment)).warning).toBeUndefined();
    yield* betaWorkers.report(newWorker, {
      clientRequestId: "new-blocker",
      outcome: "blocked",
      summary: "New assignment needs input",
    });
    yield* betaWorkers.drain();
    yield* alphaWorkers.drain();
    expect(
      (yield* messages(alphaSnapshots, owner)).some((text) =>
        text.includes("New assignment needs input"),
      ),
    ).toBe(true);
    expect(
      (yield* messages(alphaSnapshots, successor)).some((text) =>
        text.includes("New assignment needs input"),
      ),
    ).toBe(false);
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

it.effect(
  "refuses unconfirmed linked delivery and reclaims a linked worker without restarting it",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, alphaWorkers, betaWorkers, alphaSnapshots, messages } =
        yield* linkedPair;
      const a = yield* seed("reclaim-linked-alpha").pipe(Effect.provide(alpha));
      const b = yield* seed("reclaim-linked-beta").pipe(Effect.provide(beta));
      const rejected = yield* betaWorkers
        .receive("env-alpha", {
          _tag: "deliver",
          jobId: "unconfirmed",
          kind: "message",
          senderThreadId: a.owner,
          recipientThreadId: b.owner,
          prompt: "Bypass attempt",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(rejected)).toBe(true);
      if (Exit.isFailure(rejected))
        expect(String(rejected.cause)).toContain("requires confirmation");
      const worker = ThreadId.make("reclaim-linked-worker");
      yield* alphaWorkers.spawn(a.owner, { ...b.input, threadId: worker, environment: "beta" });
      const next = ThreadId.make("reclaim-linked-next");
      yield* alphaWorkers.handoff(a.owner, {
        threadId: next,
        title: "next",
        prompt: "Take over",
        modelSelection: selections[0]!,
      });
      const userRequest = "Reclaim my linked worker.";
      yield* directInput(a.owner, "reclaim-linked-user", userRequest).pipe(Effect.provide(alpha));
      yield* alphaWorkers.reclaim(a.owner, {
        clientRequestId: "linked",
        workerThreadIds: [worker],
        userRequest,
      });
      expect((yield* alphaWorkers.list(a.owner))[0]!.ownerThreadId).toBe(a.owner);
      expect(yield* alphaWorkers.list(next)).toHaveLength(0);
      expect(
        (yield* alphaWorkers
          .message(a.owner, {
            environment: "beta",
            threadId: worker,
            clientRequestId: "wrong-tool",
            prompt: "A follow-up",
          })
          .pipe(Effect.flip)).message,
      ).toContain("t3_worker_send");
      yield* alphaWorkers.send(a.owner, {
        threadId: worker,
        clientRequestId: "follow-up",
        prompt: "Finish the remaining work.",
      });
      yield* betaWorkers.report(worker, {
        clientRequestId: "after-reclaim",
        outcome: "blocked",
        summary: "Need the master's decision.",
      });
      yield* betaWorkers.drain();
      yield* alphaWorkers.drain();
      expect(
        (yield* messages(alphaSnapshots, a.owner)).some((text) =>
          text.includes("Need the master's decision."),
        ),
      ).toBe(true);
      expect(
        (yield* messages(alphaSnapshots, next)).some((text) =>
          text.includes("Need the master's decision."),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
);
it.layer(testLayer)("session organization", (it) => {
  it.effect(
    "assigns an existing independent conversation without changing its identity, settings or history",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory;
        const { owner, source } = yield* seed("organization-adopt");
        const before = Option.getOrThrow(yield* snapshots.getThreadDetailById(source));
        const native = yield* directory.getBinding(source);
        const input = {
          clientRequestId: "adopt",
          threadId: source,
          ownerThreadId: owner,
          expectedOwnerThreadId: null,
          expectedRevision: 0,
        };
        const result = yield* service.changeOwnership(input);
        expect(yield* service.changeOwnership(input)).toEqual(result);
        expect(result.revision).toBe(1);
        const after = Option.getOrThrow(yield* snapshots.getThreadDetailById(source));
        expect(after.messages).toEqual(before.messages);
        expect(after.modelSelection).toEqual(before.modelSelection);
        expect(after.worktreePath).toEqual(before.worktreePath);
        expect(yield* directory.getBinding(source)).toEqual(native);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadShellById(source)).organization?.owner
            ?.threadId,
        ).toBe(owner);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadShellById(owner)).organization?.workers.map(
            (w) => w.threadId,
          ),
        ).toEqual([source]);
        const shell = yield* snapshots.getShellSnapshot();
        expect(shell.threads.find((t) => t.id === source)?.organization?.owner?.threadId).toBe(
          owner,
        );
        expect((yield* service.list(owner)).map((worker) => worker.threadId)).toEqual([source]);
      }),
  );
  it.effect(
    "transfers and releases ownership atomically while preserving running and queued work and held reports",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const sql = yield* SqlClient.SqlClient;
        const { owner, source, worker, input } = yield* seed("organization-transfer");
        yield* service.spawn(owner, input);
        yield* session(worker, "running", "organization-active");
        const queued = yield* service.send(owner, {
          threadId: worker,
          clientRequestId: "queued",
          prompt: "Already authorized follow-up",
        });
        yield* service.control(owner, { threadId: worker, notifications: false });
        const report = yield* service.report(worker, {
          clientRequestId: "held",
          outcome: "blocked",
          summary: "Signing decision required",
        });
        const before =
          (yield* sql`SELECT json_extract(plan_json, '$.modelSelection') AS model, json_extract(plan_json, '$.runtimeMode') AS mode, read_seq, read_offset FROM custom_workers WHERE thread_id = ${worker}`)[0];
        const moved = yield* service.changeOwnership({
          clientRequestId: "transfer",
          threadId: worker,
          ownerThreadId: source,
          expectedOwnerThreadId: owner,
          expectedRevision: 0,
        });
        expect(yield* service.list(owner)).toHaveLength(0);
        expect(
          (yield* service
            .send(owner, { threadId: worker, clientRequestId: "stale", prompt: "Unauthorized" })
            .pipe(Effect.flip)).message,
        ).toContain("not a worker owned");
        expect(
          (yield* sql`SELECT target_id FROM custom_worker_jobs WHERE id = ${report.requestId}`)[0],
        ).toEqual({ target_id: source });
        yield* service.changeOwnership({
          clientRequestId: "release",
          threadId: worker,
          ownerThreadId: null,
          expectedOwnerThreadId: source,
          expectedRevision: moved.revision,
        });
        expect(yield* service.list(source)).toHaveLength(0);
        expect(
          (yield* service
            .report(worker, {
              clientRequestId: "late",
              outcome: "done",
              summary: "No longer owned",
            })
            .pipe(Effect.flip)).message,
        ).toContain("no master");
        expect(
          (yield* sql`SELECT state, target_id FROM custom_worker_jobs WHERE id = ${queued.requestId}`)[0],
        ).toEqual({ state: "queued", target_id: worker });
        expect(
          (yield* sql`SELECT json_extract(plan_json, '$.modelSelection') AS model, json_extract(plan_json, '$.runtimeMode') AS mode, read_seq, read_offset FROM custom_workers WHERE thread_id = ${worker}`)[0],
        ).toEqual(before);
        yield* service.changeOwnership({
          clientRequestId: "reassign",
          threadId: worker,
          ownerThreadId: owner,
          expectedOwnerThreadId: null,
          expectedRevision: moved.revision + 1,
        });
        expect(
          (yield* sql`SELECT target_id FROM custom_worker_jobs WHERE id = ${report.requestId}`)[0],
        ).toEqual({ target_id: owner });
      }),
  );
  it.effect(
    "allows only one racing assignment and rejects stale ABA editors and ancestor cycles",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const { owner, source, worker, input } = yield* seed("organization-race");
        yield* service.spawn(owner, input);
        const contenders = yield* Effect.all(
          [
            service
              .changeOwnership({
                clientRequestId: "a",
                threadId: worker,
                ownerThreadId: source,
                expectedOwnerThreadId: owner,
                expectedRevision: 0,
              })
              .pipe(Effect.exit),
            service
              .changeOwnership({
                clientRequestId: "b",
                threadId: worker,
                ownerThreadId: null,
                expectedOwnerThreadId: owner,
                expectedRevision: 0,
              })
              .pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        );
        expect(contenders.filter(Exit.isSuccess)).toHaveLength(1);
        const state = yield* service.readOwnership(worker);
        yield* service.changeOwnership({
          clientRequestId: "back",
          threadId: worker,
          ownerThreadId: owner,
          expectedOwnerThreadId: state.ownerThreadId,
          expectedRevision: state.revision,
        });
        expect(
          (yield* service
            .changeOwnership({
              clientRequestId: "stale",
              threadId: worker,
              ownerThreadId: source,
              expectedOwnerThreadId: owner,
              expectedRevision: 0,
            })
            .pipe(Effect.flip)).message,
        ).toContain("changed");
        const child = ThreadId.make("organization-child");
        yield* service.spawn(worker, {
          threadId: child,
          title: "Child",
          modelSelection: input.modelSelection,
          prompt: "Child work",
        });
        const current = yield* service.readOwnership(worker);
        expect(
          (yield* service
            .changeOwnership({
              clientRequestId: "cycle",
              threadId: worker,
              ownerThreadId: child,
              expectedOwnerThreadId: owner,
              expectedRevision: current.revision,
            })
            .pipe(Effect.flip)).message,
        ).toContain("ancestors");
        yield* service.changeOwnership({
          clientRequestId: "with-child",
          threadId: worker,
          ownerThreadId: source,
          expectedOwnerThreadId: owner,
          expectedRevision: current.revision,
        });
        expect((yield* service.list(worker)).map((row) => row.threadId)).toEqual([child]);
      }),
  );
  it.effect("renews a nested master without detaching its successor from the parent group", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const snapshots = yield* ProjectionSnapshotQuery;
      const { owner, source, worker, input } = yield* seed("organization-renewal");
      yield* service.spawn(owner, input);
      const child = ThreadId.make("organization-renewal-child");
      yield* service.spawn(worker, {
        threadId: child,
        title: "Child",
        modelSelection: input.modelSelection,
        prompt: "Keep working",
      });
      const successor = ThreadId.make("organization-renewal-successor");
      expect(
        (yield* service.handoff(worker, {
          threadId: successor,
          sourceThreadId: source,
          title: "Successor",
          modelSelection: input.modelSelection,
          prompt: "Continue this group",
        })).state,
      ).toBe("completed");
      expect((yield* service.readOwnership(successor)).ownerThreadId).toBe(owner);
      expect((yield* service.readOwnership(child)).ownerThreadId).toBe(successor);
      expect(
        Option.getOrThrow(yield* snapshots.getThreadShellById(successor)).organization,
      ).toMatchObject({ owner: { threadId: owner }, workers: [{ threadId: child }] });
      const restarted = yield* Workers.WorkerControls.pipe(Effect.provide(Workers.layer));
      expect((yield* restarted.readOwnership(child)).ownerThreadId).toBe(successor);
    }),
  );
  it.effect(
    "exposes direct worker input in the shell without copying its message into the master conversation",
    () =>
      Effect.gen(function* () {
        const service = yield* Workers.WorkerControls;
        const snapshots = yield* ProjectionSnapshotQuery;
        const { owner, worker, input } = yield* seed("organization-direct-input");
        yield* service.spawn(owner, input);
        yield* session(worker, "running", "initial");
        yield* session(worker, "ready", "initial-finished");
        yield* service.drain();
        const before = Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages;
        yield* directInput(worker, "user-assignment", "Check this additional detail");
        yield* session(worker, "running", "direct-assignment");
        yield* service.drain();
        expect(
          Option.getOrThrow(yield* snapshots.getThreadShellById(worker)).organization
            ?.directInputAt,
        ).toBe(timestamp);
        expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(owner)).messages).toEqual(
          before,
        );
        yield* service.send(owner, {
          threadId: worker,
          clientRequestId: "next-managed-work",
          prompt: "Then finish the original task",
        });
        expect(
          Option.getOrThrow(yield* snapshots.getThreadShellById(worker)).organization
            ?.directInputAt,
        ).toBeNull();
      }),
  );
  it.effect("rejects permission expansion and agent adoption without direct user provenance", () =>
    Effect.gen(function* () {
      const service = yield* Workers.WorkerControls;
      const engine = yield* OrchestrationEngineService;
      const { owner, source } = yield* seed("organization-permissions");
      const input = {
        clientRequestId: "adopt",
        threadId: source,
        ownerThreadId: owner,
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      };
      expect(
        (yield* service
          .changeOwnership(input, { threadId: owner, userRequest: "Adopt this session" })
          .pipe(Effect.flip)).message,
      ).toContain("direct user");
      yield* directInput(owner, "organization-user", "Adopt this session");
      yield* service.changeOwnership(input, { threadId: owner, userRequest: "Adopt this session" });
      const limited = ThreadId.make("organization-limited");
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("organization-limited"),
        threadId: limited,
        projectId: ProjectId.make("organization-permissions"),
        title: "Limited master",
        modelSelection: selections[0]!,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        historyImport: true,
        createdAt: timestamp,
      });
      expect(
        (yield* service
          .changeOwnership({
            clientRequestId: "limited",
            threadId: source,
            ownerThreadId: limited,
            expectedOwnerThreadId: owner,
            expectedRevision: 1,
          })
          .pipe(Effect.flip)).message,
      ).toContain("broader permissions");
      expect((yield* service.readOwnership(source)).ownerThreadId).toBe(owner);
    }),
  );
});

it.effect(
  "retains remote hierarchy offline and synchronizes transfer/release through the authority proxy",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, alphaWorkers, betaWorkers, betaSnapshots } = yield* linkedPair;
      const a = yield* seed("organization-alpha").pipe(Effect.provide(alpha));
      const b = yield* seed("organization-beta").pipe(Effect.provide(beta));
      yield* alphaWorkers.spawn(a.owner, { ...b.input, environment: "beta" });
      offline.add("env-beta");
      const transferInput = {
        clientRequestId: "remote-transfer",
        threadId: b.worker,
        ownerThreadId: a.source,
        expectedOwnerThreadId: a.owner,
        expectedRevision: 0,
      };
      expect((yield* alphaWorkers.changeOwnership(transferInput).pipe(Effect.flip)).code).toBe(
        "pending",
      );
      expect((yield* alphaWorkers.readOwnership(b.worker)).ownerThreadId).toBe(a.owner);
      offline.delete("env-beta");
      yield* alphaWorkers.changeOwnership(transferInput);
      yield* alphaWorkers.drain();
      expect(
        Option.getOrThrow(yield* betaSnapshots.getThreadShellById(b.worker)).organization?.owner,
      ).toEqual({ environmentId: "env-alpha", threadId: a.source });
      yield* alphaWorkers.changeOwnership({
        clientRequestId: "remote-release",
        threadId: b.worker,
        ownerThreadId: null,
        expectedOwnerThreadId: a.source,
        expectedRevision: 1,
      });
      expect(
        Option.getOrThrow(yield* betaSnapshots.getThreadShellById(b.worker)).organization?.owner,
      ).toBeNull();
      expect(
        (yield* betaWorkers
          .report(b.worker, { clientRequestId: "late", outcome: "done", summary: "No owner" })
          .pipe(Effect.flip)).message,
      ).toContain("no master");
      yield* alphaWorkers.changeOwnership({
        clientRequestId: "remote-reassign",
        threadId: b.worker,
        ownerThreadId: a.owner,
        expectedOwnerThreadId: null,
        expectedRevision: 2,
      });
      expect(
        Option.getOrThrow(yield* betaSnapshots.getThreadShellById(b.worker)).organization?.owner
          ?.threadId,
      ).toBe(a.owner);
    }).pipe(Effect.scoped),
);

it.effect(
  "cross-computer ownership assigns, transfers, releases and reassigns without moving native execution",
  () =>
    Effect.gen(function* () {
      const {
        alpha,
        beta,
        gamma,
        alphaWorkers: aw,
        betaWorkers: bw,
        gammaWorkers: cw,
        betaSnapshots,
        gammaSnapshots,
        messages,
      } = yield* linkedPair;
      const a = yield* seed("cross-a").pipe(Effect.provide(alpha));
      const b = yield* seed("cross-b").pipe(Effect.provide(beta));
      const c = yield* seed("cross-c").pipe(Effect.provide(gamma));
      const before = Option.getOrThrow(yield* betaSnapshots.getThreadDetailById(b.source));
      const native = yield* ProviderSessionDirectory.pipe(
        Effect.flatMap((d) => d.getBinding(b.source)),
        Effect.provide(beta),
      );
      const assigned = yield* bw.changeOwnership({
        clientRequestId: "assign-a",
        threadId: b.source,
        ownerThreadId: a.owner,
        ownerEnvironmentId: "env-alpha",
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      });
      expect(assigned.ownerEnvironmentId).toBe("env-alpha");
      expect((yield* aw.list(a.owner)).map((w) => w.threadId)).toEqual([b.source]);
      yield* aw.control(a.owner, { threadId: b.source, notifications: false });
      yield* bw.report(b.source, {
        clientRequestId: "queued-report",
        outcome: "blocked",
        summary: "Exactly one ownership decision",
      });
      const moved = yield* aw.changeOwnership({
        clientRequestId: "transfer-c",
        threadId: b.source,
        ownerThreadId: c.owner,
        ownerEnvironmentId: "env-gamma",
        expectedOwnerThreadId: a.owner,
        expectedOwnerEnvironmentId: "env-alpha",
        expectedRevision: assigned.revision,
      });
      yield* cw.control(c.owner, { threadId: b.source, notifications: true });
      yield* aw.drain();
      yield* bw.drain();
      yield* cw.drain();
      expect(
        (yield* messages(gammaSnapshots, c.owner)).filter((t) =>
          t.includes("Exactly one ownership decision"),
        ),
      ).toHaveLength(1);
      expect(
        (yield* aw
          .send(a.owner, { threadId: b.source, clientRequestId: "stale", prompt: "must be denied" })
          .pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      const released = yield* cw.changeOwnership({
        clientRequestId: "release",
        threadId: b.source,
        ownerThreadId: null,
        expectedOwnerThreadId: c.owner,
        expectedOwnerEnvironmentId: "env-gamma",
        expectedRevision: moved.revision,
      });
      expect((yield* bw.readOwnership(b.source)).ownerThreadId).toBeNull();
      yield* bw.changeOwnership({
        clientRequestId: "assign-again",
        threadId: b.source,
        ownerThreadId: a.owner,
        ownerEnvironmentId: "env-alpha",
        expectedOwnerThreadId: null,
        expectedRevision: released.revision,
      });
      const after = Option.getOrThrow(yield* betaSnapshots.getThreadDetailById(b.source));
      expect(after.messages).toEqual(before.messages);
      expect(after.modelSelection).toEqual(before.modelSelection);
      expect(after.worktreePath).toEqual(before.worktreePath);
      expect(
        yield* ProviderSessionDirectory.pipe(
          Effect.flatMap((d) => d.getBinding(b.source)),
          Effect.provide(beta),
        ),
      ).toEqual(native);
    }).pipe(Effect.scoped),
);

it.effect(
  "cross-computer unavailable participant retains the relationship and recovers on service restart",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, alphaWorkers: aw, betaWorkers: bw } = yield* linkedPair;
      const a = yield* seed("offline-a").pipe(Effect.provide(alpha));
      const b = yield* seed("offline-b").pipe(Effect.provide(beta));
      const input = {
        clientRequestId: "offline-assignment",
        threadId: b.source,
        ownerThreadId: a.owner,
        ownerEnvironmentId: "env-alpha",
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      };
      offline.add("env-alpha");
      expect((yield* bw.changeOwnership(input).pipe(Effect.flip)).code).toBe("pending");
      expect((yield* bw.readOwnership(b.source)).ownerThreadId).toBeNull();
      offline.delete("env-alpha");
      const restarted = yield* Workers.WorkerControls.pipe(
        Effect.provide(Workers.layer),
        Effect.provide(beta),
      );
      peerHandlers.set("env-beta", (from, request) => restarted.receive(from, request));
      yield* restarted.drain();
      const committed = yield* restarted.changeOwnership(input);
      expect(committed.ownerThreadId).toBe(a.owner);
      expect((yield* aw.list(a.owner)).map((w) => w.threadId)).toEqual([b.source]);
      expect((yield* restarted.readOwnership(b.source)).revision).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect("cross-computer ancestry rejects cycles and concurrent opposing transfers", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaWorkers: aw, betaWorkers: bw } = yield* linkedPair;
    const a = yield* seed("cycle-a").pipe(Effect.provide(alpha));
    const b = yield* seed("cycle-b").pipe(Effect.provide(beta));
    const toB = {
      clientRequestId: "a-to-b",
      threadId: a.source,
      ownerThreadId: b.source,
      ownerEnvironmentId: "env-beta",
      expectedOwnerThreadId: null,
      expectedRevision: 0,
    };
    const toA = {
      clientRequestId: "b-to-a",
      threadId: b.source,
      ownerThreadId: a.source,
      ownerEnvironmentId: "env-alpha",
      expectedOwnerThreadId: null,
      expectedRevision: 0,
    };
    yield* Effect.all(
      [aw.changeOwnership(toB).pipe(Effect.exit), bw.changeOwnership(toA).pipe(Effect.exit)],
      { concurrency: "unbounded" },
    );
    yield* aw.drain();
    yield* bw.drain();
    const ar = yield* aw.readOwnership(a.source);
    const br = yield* bw.readOwnership(b.source);
    expect(ar.ownerThreadId === b.source && br.ownerThreadId === a.source).toBe(false);
    // Ensure one direction exists, then exercise a non-racing cycle attempt.
    if (!ar.ownerThreadId && !br.ownerThreadId)
      yield* aw.changeOwnership({ ...toB, clientRequestId: "one-direction" });
    const attempt =
      ar.ownerThreadId || !br.ownerThreadId
        ? bw.changeOwnership({ ...toA, clientRequestId: "cycle" })
        : aw.changeOwnership({ ...toB, clientRequestId: "cycle" });
    expect((yield* attempt.pipe(Effect.flip)).message).toContain("ancestors");
  }).pipe(Effect.scoped),
);

it.effect("nested renewal retains a remote parent and children across retry", () =>
  Effect.gen(function* () {
    const {
      alpha,
      beta,
      alphaWorkers: aw,
      betaWorkers: bw,
      betaSnapshots,
      messages,
    } = yield* linkedPair;
    const a = yield* seed("nested-a").pipe(Effect.provide(alpha));
    const b = yield* seed("nested-b").pipe(Effect.provide(beta));
    yield* aw.spawn(a.owner, { ...b.input, environment: "beta" });
    const child = ThreadId.make("nested-child");
    yield* bw.spawn(b.worker, { ...b.input, threadId: child });
    const successor = ThreadId.make("nested-successor");
    const input = {
      ...b.input,
      threadId: successor,
      sourceThreadId: undefined,
      projectId: ProjectId.make("nested-b"),
      title: "Nested successor",
      prompt: "Continue supervising",
    };
    offline.add("env-alpha");
    yield* bw.handoff(b.worker, input);
    yield* bw.drain();
    expect((yield* bw.handoffStatus(b.worker, { threadId: successor })).state).toBe("error");
    expect((yield* bw.readOwnership(child)).ownerThreadId).toBe(b.worker);
    offline.delete("env-alpha");
    lostReplies.add("env-alpha:organizationRenew");
    yield* bw.handoff(b.worker, input);
    yield* bw.drain();
    expect((yield* bw.handoffStatus(b.worker, { threadId: successor })).state).toBe("error");
    const restarted = yield* Workers.WorkerControls.pipe(
      Effect.provide(Workers.layer),
      Effect.provide(beta),
    );
    peerHandlers.set("env-beta", (from, request) => restarted.receive(from, request));
    yield* restarted.handoff(b.worker, input);
    yield* restarted.drain();
    expect((yield* bw.handoffStatus(b.worker, { threadId: successor })).state).toBe("completed");
    expect((yield* bw.readOwnership(successor)).ownerThreadId).toBe(a.owner);
    expect((yield* bw.readOwnership(successor)).ownerEnvironmentId).toBe("env-alpha");
    expect((yield* bw.readOwnership(child)).ownerThreadId).toBe(successor);
    yield* bw.handoff(b.worker, input);
    yield* bw.drain();
    yield* aw.drain();
    expect((yield* aw.list(a.owner)).filter((w) => w.threadId === successor)).toHaveLength(1);
    expect(
      (yield* messages(betaSnapshots, successor)).filter((text) =>
        text.includes("[T3 orchestrator handoff]"),
      ),
    ).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "committed cross-computer transfer recovers a lost finalize response and delivers a queued report once",
  () =>
    Effect.gen(function* () {
      const {
        alpha,
        beta,
        gamma,
        alphaWorkers: aw,
        betaWorkers: bw,
        gammaWorkers: cw,
        gammaSnapshots,
        messages,
      } = yield* linkedPair;
      const a = yield* seed("lost-a").pipe(Effect.provide(alpha));
      const b = yield* seed("lost-b").pipe(Effect.provide(beta));
      const c = yield* seed("lost-c").pipe(Effect.provide(gamma));
      yield* bw.changeOwnership({
        clientRequestId: "lost-assign",
        threadId: b.source,
        ownerThreadId: a.owner,
        ownerEnvironmentId: "env-alpha",
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      });
      const input = {
        clientRequestId: "lost-transfer",
        threadId: b.source,
        ownerThreadId: c.owner,
        ownerEnvironmentId: "env-gamma",
        expectedOwnerThreadId: a.owner,
        expectedOwnerEnvironmentId: "env-alpha",
        expectedRevision: 1,
      };
      lostReplies.add("env-gamma:organizationFinish");
      expect((yield* bw.changeOwnership(input).pipe(Effect.flip)).code).toBe("pending");
      expect(
        (yield* aw
          .send(a.owner, {
            threadId: b.source,
            clientRequestId: "stale-during-recovery",
            prompt: "Denied",
          })
          .pipe(Effect.flip)).message,
      ).toContain("not a worker owned");
      yield* bw.report(b.source, {
        clientRequestId: "pending-commit-report",
        outcome: "blocked",
        summary: "Recover once",
      });
      const restarted = yield* Workers.WorkerControls.pipe(
        Effect.provide(Workers.layer),
        Effect.provide(beta),
      );
      peerHandlers.set("env-beta", (from, request) => restarted.receive(from, request));
      yield* restarted.drain();
      expect((yield* restarted.changeOwnership(input)).revision).toBe(2);
      lostReplies.add("env-gamma:deliver");
      yield* restarted.report(b.source, {
        clientRequestId: "lost-report-response",
        outcome: "blocked",
        summary: "Delivery accepted before response loss",
      });
      yield* restarted.drain();
      yield* cw.drain();
      yield* restarted.drain();
      const texts = yield* messages(gammaSnapshots, c.owner);
      expect(texts.filter((text) => text.includes("Recover once"))).toHaveLength(1);
      expect(
        texts.filter((text) => text.includes("Delivery accepted before response loss")),
      ).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "scoped agent adoption uses the same remote ownership service and denies a stale owner",
  () =>
    Effect.gen(function* () {
      const {
        alpha,
        beta,
        gamma,
        alphaWorkers: aw,
        betaWorkers: bw,
        gammaWorkers: cw,
      } = yield* linkedPair;
      const a = yield* seed("agent-a").pipe(Effect.provide(alpha));
      const b = yield* seed("agent-b").pipe(Effect.provide(beta));
      const c = yield* seed("agent-c").pipe(Effect.provide(gamma));
      const instruction = "Assign that existing remote session to me";
      yield* directInput(a.owner, "agent-adopt", instruction).pipe(Effect.provide(alpha));
      expect((yield* aw.readOwnership(b.source, "env-beta")).ownerThreadId).toBeNull();
      const assigned = yield* aw.changeOwnership(
        {
          clientRequestId: "remote-agent-adopt",
          threadId: b.source,
          threadEnvironmentId: "env-beta",
          ownerThreadId: a.owner,
          ownerEnvironmentId: "env-alpha",
          expectedOwnerThreadId: null,
          expectedRevision: 0,
        },
        { threadId: a.owner, userRequest: instruction },
      );
      yield* bw.changeOwnership({
        clientRequestId: "remote-agent-transfer",
        threadId: b.source,
        ownerThreadId: c.owner,
        ownerEnvironmentId: "env-gamma",
        expectedOwnerThreadId: a.owner,
        expectedOwnerEnvironmentId: "env-alpha",
        expectedRevision: assigned.revision,
      });
      expect(
        (yield* aw
          .changeOwnership(
            {
              clientRequestId: "stale-agent-adopt",
              threadId: b.source,
              threadEnvironmentId: "env-beta",
              ownerThreadId: a.owner,
              ownerEnvironmentId: "env-alpha",
              expectedOwnerThreadId: c.owner,
              expectedOwnerEnvironmentId: "env-gamma",
              expectedRevision: assigned.revision + 1,
            },
            { threadId: a.owner, userRequest: instruction },
          )
          .pipe(Effect.flip)).message,
      ).toContain("current master");
      expect((yield* cw.list(c.owner)).map((worker) => worker.threadId)).toEqual([b.source]);
    }).pipe(Effect.scoped),
);

it.effect(
  "renews a transferred nested master with a child whose authority is on a third computer",
  () =>
    Effect.gen(function* () {
      const {
        alpha,
        beta,
        gamma,
        alphaWorkers: aw,
        betaWorkers: bw,
        gammaWorkers: cw,
      } = yield* linkedPair;
      const a = yield* seed("renew-a").pipe(Effect.provide(alpha));
      const b = yield* seed("renew-b").pipe(Effect.provide(beta));
      const c = yield* seed("renew-c").pipe(Effect.provide(gamma));
      yield* bw.changeOwnership({
        clientRequestId: "parent",
        threadId: b.source,
        ownerThreadId: a.owner,
        ownerEnvironmentId: "env-alpha",
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      });
      yield* cw.changeOwnership({
        clientRequestId: "child",
        threadId: c.source,
        ownerThreadId: b.source,
        ownerEnvironmentId: "env-beta",
        expectedOwnerThreadId: null,
        expectedRevision: 0,
      });
      const successor = ThreadId.make("third-host-renewal");
      const input = {
        threadId: successor,
        projectId: ProjectId.make("renew-b"),
        title: "Successor with remote family",
        modelSelection: b.input.modelSelection,
        prompt: "Continue this group",
      };
      yield* bw.handoff(b.source, input);
      yield* bw.drain();
      yield* aw.drain();
      yield* cw.drain();
      expect((yield* bw.handoffStatus(b.source, { threadId: successor })).state).toBe("completed");
      expect((yield* bw.readOwnership(successor)).ownerThreadId).toBe(a.owner);
      expect((yield* cw.readOwnership(c.source)).ownerThreadId).toBe(successor);
      expect(
        (yield* aw.list(a.owner)).filter((worker) => worker.threadId === successor),
      ).toHaveLength(1);
      expect((yield* bw.list(successor)).map((worker) => worker.threadId)).toEqual([c.source]);
    }).pipe(Effect.scoped),
);

for (const automatic of [false, true])
  it.effect(
    `reconciles a real remote pre-start refusal by intent and retains uncertain transport starts (${automatic ? "model-selected" : "exact"})`,
    () =>
      Effect.gen(function* () {
        const { alpha, beta, gamma, alphaWorkers, betaSnapshots } = yield* linkedPair;
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const allocationLayer = AllocationAssignments.layer.pipe(
          Layer.provideMerge(Allocation.layer),
          Layer.provideMerge(AllocationStore.layer),
          Layer.provide(allocationRegistry),
          Layer.provide(
            Layer.succeed(UsageMeasurements, {
              read: () =>
                Effect.succeed({
                  observedAt: "1970-01-01T00:00:00.000Z",
                  monitoredInstanceIds: [],
                  retentionDays: 14,
                  persistenceError: null,
                  accounts: [],
                  turns: [],
                  totalMatchingTurns: 0,
                  profiles: [],
                  limitations: [],
                }),
            }),
          ),
        );
        const allocations = [];
        for (const [id, context] of [
          ["env-alpha", alpha],
          ["env-beta", beta],
          ["env-gamma", gamma],
        ] as const) {
          yield* (yield* Settings.ServerSettingsService.pipe(
            Effect.provide(context),
          )).updateSettings({ allocationCoordinatorEnvironmentId: "env-alpha" });
          const services = yield* Layer.build(allocationLayer).pipe(
            Effect.provide(context),
            Scope.provide(scope),
          );
          const allocation = yield* Allocation.ProviderAllocation.pipe(Effect.provide(services));
          const store = yield* AllocationStore.AllocationStore.pipe(Effect.provide(services));
          const assignments = yield* AllocationAssignments.AllocationAssignments.pipe(
            Effect.provide(services),
          );
          yield* store.savePolicy({
            expectedVersion: 0,
            policy: {
              ...defaultAllocationPolicy,
              mode: "automatic",
              coordinatorEnvironmentId: "env-alpha",
            },
          });
          const workerHandler = peerHandlers.get(id)!;
          peerHandlers.set(id, (from, request) =>
            typeof request === "object" &&
            request !== null &&
            "_tag" in request &&
            typeof request._tag === "string" &&
            request._tag.startsWith("allocation")
              ? allocation
                  .receive(from, request)
                  .pipe(Effect.mapError((e) => new Workers.WorkerError({ message: e.message })))
              : workerHandler(from, request),
          );
          allocations.push({ allocation, store, assignments });
        }
        const { owner } = yield* seed("allocate-remote-owner", 1).pipe(Effect.provide(alpha));
        yield* seed("allocate-remote-project", 1).pipe(Effect.provide(beta));
        const { allocation, store, assignments } = allocations[0]!;
        const input = {
          kind: "worker" as const,
          projectId: ProjectId.make("missing-project"),
          title: "allocated remote",
          prompt: "task",
          request: {
            assignmentId: "remote-refused",
            environmentId: "env-beta",
            threadId: ThreadId.make("remote-refused"),
            ...(automatic
              ? {
                  selection: "automatic" as const,
                  allowedDrivers: [ProviderDriverKind.make("codex")],
                  assessment: {
                    difficulty: 8,
                    stakes: 8,
                    difficultyReason: "Interacting state machines",
                    stakesReason: "Consequential startup",
                  },
                }
              : {
                  driver: ProviderDriverKind.make("codex"),
                  model: selections[1]!.model,
                  options: selections[1]!.options,
                }),
          },
        };
        expect(Exit.isFailure(yield* Effect.exit(assignments.start(input, owner)))).toBe(true);
        expect((yield* store.reservations)[0]?.state).toBe("starting");
        const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(beta));
        expect(
          yield* sql`SELECT assignment_id, thread_id FROM provider_allocation_start_rejections`,
        ).toEqual([{ assignment_id: "remote-refused", thread_id: "remote-refused" }]);
        expect(
          yield* sql`SELECT 1 FROM custom_workers WHERE thread_id = 'remote-refused'`,
        ).toHaveLength(0);
        expect(Option.isNone(yield* betaSnapshots.getThreadShellById(input.request.threadId))).toBe(
          true,
        );
        expect(
          yield* allocations[1]!.allocation.receive("env-alpha", {
            _tag: "allocationProbe",
            threadId: input.request.threadId,
            assignmentId: input.request.assignmentId,
            since: "1970-01-01T00:00:00.000Z",
            startIntent: "wrong-intent",
          }),
        ).toEqual({ state: "unknown" });
        yield* allocation.execute({ _tag: "snapshot" });
        expect((yield* store.reservations)[0]?.state).toBe("released");
        expect(Exit.isFailure(yield* Effect.exit(assignments.start(input, owner)))).toBe(true);
        // The target refuses replay even if the caller tries to repair the project in place.
        const corrected = {
          threadId: input.request.threadId,
          projectId: ProjectId.make("allocate-remote-project"),
          title: input.title,
          prompt: input.prompt,
          modelSelection: selections[1]!,
          environment: "beta",
          allocation: {
            assignmentId: "remote-refused",
            startIntent: (yield* store.reservations)[0]!.startIntent!,
          },
        };
        expect(Exit.isFailure(yield* Effect.exit(alphaWorkers.spawn(owner, corrected)))).toBe(true);
        const restartedTarget = yield* Workers.WorkerControls.pipe(
          Effect.provide(Workers.layer),
          Effect.provide(beta),
        );
        expect(
          (yield* restartedTarget
            .receive("env-alpha", {
              _tag: "spawn",
              owner: { threadId: owner, runtimeMode: "full-access", interactionMode: "default" },
              input: corrected,
            })
            .pipe(Effect.asVoid, Effect.flip)).code,
        ).toBe("allocation_start_rejected");
        const accepted = {
          ...input,
          projectId: ProjectId.make("allocate-remote-project"),
          request: {
            ...input.request,
            assignmentId: "remote-uncertain",
            threadId: ThreadId.make("remote-uncertain"),
          },
        };
        lostReplies.add("env-beta:spawn");
        expect(Exit.isFailure(yield* Effect.exit(assignments.start(accepted, owner)))).toBe(true);
        expect(
          yield* sql`SELECT 1 FROM provider_allocation_start_rejections WHERE assignment_id = 'remote-uncertain'`,
        ).toHaveLength(0);
        offline.add("env-beta");
        yield* allocation.execute({ _tag: "snapshot" });
        expect(
          (yield* store.reservations).find((r) => r.assignmentId === "remote-uncertain")?.state,
        ).toBe("starting");
        offline.delete("env-beta");
        yield* allocation.execute({ _tag: "snapshot" });
        expect(
          (yield* store.reservations).find((r) => r.assignmentId === "remote-uncertain")?.state,
        ).toBe("starting");
        expect(
          Option.getOrThrow(yield* betaSnapshots.getThreadShellById(accepted.request.threadId))
            .modelSelection,
        ).toEqual(selections[1]);
      }).pipe(Effect.scoped),
  );
