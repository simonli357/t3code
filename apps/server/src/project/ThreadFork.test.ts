import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { WORKER_REVIEW_DONE, presentWorkerMessage } from "@t3tools/shared/workerMessages";
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
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { forkThread } from "./ThreadFork.ts";

const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const testLayer = Layer.mergeAll(
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
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-fork-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("conversation fork", (it) => {
  for (const [instance, driver] of [
    ["codex", "codex"],
    ["codex_antoine", "codex"],
    ["claudeAgent", "claudeAgent"],
    ["claude_eol", "claudeAgent"],
  ] as const) {
    it.effect(
      `forks ${instance} history with independent native identity and preserves settings`,
      () =>
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const snapshots = yield* ProjectionSnapshotQuery;
          const directory = yield* ProviderSessionDirectory;
          const projectId = ProjectId.make(`project-${instance}`);
          const sourceId = ThreadId.make(`source-${instance}`);
          const threadId = ThreadId.make(`fork-${instance}`);
          const worktreePath = instance.includes("_") ? `/tmp/worktree-${instance}` : null;
          const runtimeMode = instance.includes("_") ? "approval-required" : "full-access";
          const interactionMode = instance.includes("_") ? "plan" : "default";
          const modelSelection = {
            instanceId: ProviderInstanceId.make(instance),
            model: "test-model",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          };
          const createdAt = "2026-09-28T10:00:00.000Z";
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`project-${instance}`),
            projectId,
            title: "Fork tests",
            workspaceRoot: `/tmp/fork-test-${instance}`,
            defaultModelSelection: null,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`source-${instance}`),
            projectId,
            threadId: sourceId,
            title: "Source",
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: "main",
            worktreePath,
            historyImport: true,
            createdAt,
          });
          yield* engine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(`history-${instance}`),
            threadId: sourceId,
            messages: [
              {
                messageId: MessageId.make(`question-${instance}`),
                role: "user",
                text: "Remember cobalt",
                createdAt,
              },
              {
                messageId: MessageId.make(`answer-${instance}`),
                role: "assistant",
                text: "Remembered",
                createdAt,
              },
            ],
          });
          const originalCursor =
            driver === "codex" ? { threadId: "native-original" } : { resume: "native-original" };
          const forkCursor =
            driver === "codex" ? { threadId: "native-fork" } : { resume: "native-fork" };
          yield* directory.upsert({
            threadId: sourceId,
            provider: ProviderDriverKind.make(driver),
            providerInstanceId: modelSelection.instanceId,
            runtimeMode,
            status: "stopped",
            resumeCursor: originalCursor,
            runtimePayload: { cwd: `/removed/fork-test-${instance}` },
          });
          const before = Option.getOrThrow(yield* snapshots.getThreadDetailById(sourceId));
          let nativeCalls = 0;
          const providerLayer = Layer.mock(ProviderService)({
            forkConversation: (id, options) =>
              Effect.sync(() => {
                expect(id).toBe(sourceId);
                expect(options).toEqual({ cwd: worktreePath ?? `/tmp/fork-test-${instance}` });
                nativeCalls++;
                return forkCursor;
              }),
          });
          const result = yield* forkThread({ sourceThreadId: sourceId, threadId }).pipe(
            Effect.provide(providerLayer),
          );
          expect(result.threadId).toBe(threadId);
          const fork = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
          expect(fork.title).toBe("Source (fork)");
          expect(fork.modelSelection).toEqual(modelSelection);
          expect(fork.runtimeMode).toBe(runtimeMode);
          expect(fork.interactionMode).toBe(interactionMode);
          expect(fork.worktreePath).toBe(worktreePath);
          expect(fork.branch).toBe("main");
          expect(fork.settledOverride).toBe("active");
          expect(fork.messages.map((m) => m.text)).toEqual(before.messages.map((m) => m.text));
          expect(fork.messages[0]?.id).not.toBe(before.messages[0]?.id);
          expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
            providerInstanceId: instance,
            resumeCursor: forkCursor,
          });
          expect(Option.getOrThrow(yield* directory.getBinding(sourceId)).resumeCursor).toEqual(
            originalCursor,
          );
          expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(sourceId))).toEqual(before);
          yield* forkThread({ sourceThreadId: sourceId, threadId }).pipe(
            Effect.provide(providerLayer),
          );
          expect(nativeCalls).toBe(1);
          // Resume an interrupted publish from its persisted cursor/history, as
          // after a process crash between native fork and the thread.create event.
          const pendingId = ThreadId.make(`pending-${instance}`);
          const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
          yield* directory.upsert({ ...binding, threadId: pendingId });
          yield* forkThread({ sourceThreadId: sourceId, threadId: pendingId }).pipe(
            Effect.provide(providerLayer),
          );
          expect(nativeCalls).toBe(1);
          expect(
            Option.getOrThrow(yield* snapshots.getThreadDetailById(pendingId)).messages,
          ).toHaveLength(2);
          const blockedId = ThreadId.make(`blocked-${instance}`);
          const busy = {
            ...before,
            messages: before.messages.map((m) => ({ ...m, streaming: true })),
          };
          const busyResult = yield* Effect.result(
            forkThread({ sourceThreadId: sourceId, threadId: blockedId }).pipe(
              Effect.provide(providerLayer),
              Effect.provideService(ProjectionSnapshotQuery, {
                ...snapshots,
                getThreadDetailById: (id) =>
                  id === sourceId
                    ? Effect.succeed(Option.some(busy))
                    : snapshots.getThreadDetailById(id),
              }),
            ),
          );
          expect(busyResult._tag).toBe("Failure");
          expect(nativeCalls).toBe(1);
          expect(Option.isNone(yield* directory.getBinding(blockedId))).toBe(true);
          const failedId = ThreadId.make(`failed-${instance}`);
          const failed = yield* Effect.result(
            forkThread({ sourceThreadId: sourceId, threadId: failedId }).pipe(
              Effect.provide(
                Layer.mock(ProviderService)({
                  forkConversation: () =>
                    Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: ProviderDriverKind.make(driver),
                        method: "thread/fork",
                        detail: "Native fork failed",
                      }),
                    ),
                }),
              ),
            ),
          );
          expect(failed._tag).toBe("Failure");
          expect(Option.isNone(yield* snapshots.getThreadDetailById(failedId))).toBe(true);
          expect(Option.isNone(yield* directory.getBinding(failedId))).toBe(true);
          const rejected = yield* Effect.result(
            forkThread({ sourceThreadId: sourceId, threadId: sourceId }).pipe(
              Effect.provide(providerLayer),
            ),
          );
          expect(rejected._tag).toBe("Failure");
          const historicalId = ThreadId.make(`historical-${instance}`);
          const finished = {
            ...before,
            latestTurn: {
              turnId: TurnId.make("finished-turn"),
              state: "completed" as const,
              requestedAt: createdAt,
              startedAt: createdAt,
              completedAt: createdAt,
              assistantMessageId: null,
            },
            messages: before.messages.map((m) => ({
              ...m,
              streaming: true,
              turnId: TurnId.make("old-turn"),
            })),
          };
          const withSource = (source: typeof finished) => ({
            ...snapshots,
            getThreadDetailById: (id: ThreadId) =>
              id === sourceId
                ? Effect.succeed(Option.some(source))
                : snapshots.getThreadDetailById(id),
          });
          yield* forkThread({ sourceThreadId: sourceId, threadId: historicalId }).pipe(
            Effect.provide(providerLayer),
            Effect.provideService(ProjectionSnapshotQuery, withSource(finished)),
          );
          expect(nativeCalls).toBe(2);
          expect(
            Option.getOrThrow(yield* snapshots.getThreadDetailById(historicalId)).messages,
          ).toHaveLength(2);
          const runningSource = {
            ...finished,
            latestTurn: { ...finished.latestTurn, state: "running" as const, completedAt: null },
          };
          const runningResult = yield* Effect.result(
            forkThread({
              sourceThreadId: sourceId,
              threadId: ThreadId.make(`running-${instance}`),
            }).pipe(
              Effect.provide(providerLayer),
              Effect.provideService(ProjectionSnapshotQuery, {
                ...snapshots,
                getThreadDetailById: (id) =>
                  id === sourceId
                    ? Effect.succeed(Option.some(runningSource))
                    : snapshots.getThreadDetailById(id),
              }),
            ),
          );
          expect(runningResult._tag).toBe("Failure");
          expect(nativeCalls).toBe(2);
        }),
    );
  }

  it.effect("keeps delivered reports recognisable in the fork, and the user's words theirs", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory;
      const projectId = ProjectId.make("project-delivered");
      const sourceId = ThreadId.make("source-delivered");
      const threadId = ThreadId.make("fork-delivered");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "test-model",
        options: [{ id: "effort", value: "max" }],
      };
      const createdAt = "2026-09-28T10:00:00.000Z";
      const at = (second: number) => `2026-09-28T10:00:0${second}.000Z`;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project-delivered"),
        projectId,
        title: "Fork tests",
        workspaceRoot: "/tmp/fork-test-delivered",
        defaultModelSelection: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("source-delivered"),
        projectId,
        threadId: sourceId,
        title: "Source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        historyImport: true,
        createdAt,
      });
      const report = `[T3 worker report — w — 13:05]\nWorker: ${sourceId}\nOutcome: done\nAll finished.\n\n${WORKER_REVIEW_DONE}`;
      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make("history-delivered"),
        threadId: sourceId,
        messages: [
          { messageId: MessageId.make("typed"), role: "user", text: report, createdAt: at(0) },
          {
            messageId: MessageId.make("worker-job:report:w:1"),
            role: "user",
            text: report,
            createdAt: at(1),
          },
          {
            messageId: MessageId.make("worker-job:work:w:2"),
            role: "user",
            text: "An assignment",
            createdAt: at(2),
          },
          {
            messageId: MessageId.make("answer"),
            role: "assistant",
            text: "Noted",
            createdAt: at(3),
          },
        ],
      });
      yield* directory.upsert({
        threadId: sourceId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: modelSelection.instanceId,
        runtimeMode: "full-access",
        status: "stopped",
        resumeCursor: { resume: "native-original" },
        runtimePayload: { cwd: "/tmp/fork-test-delivered" },
      });
      yield* forkThread({ sourceThreadId: sourceId, threadId }).pipe(
        Effect.provide(
          Layer.mock(ProviderService)({
            forkConversation: () => Effect.succeed({ resume: "native-fork" }),
          }),
        ),
      );
      const fork = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId)).messages;
      expect(fork.map((m) => m.id.replace(threadId, "<fork>"))).toEqual([
        "fork:<fork>:0",
        "worker-job:report:fork:<fork>:1",
        "fork:<fork>:2",
        "fork:<fork>:3",
      ]);
      expect(presentWorkerMessage(fork[0]!)).toBeNull();
      expect(presentWorkerMessage(fork[1]!)?.entries[0]?.text).toBe("All finished.");
    }),
  );
});
