import { BeforeNativeFork } from "../provider/NativeFork.ts";
import * as Deferred from "effect/Deferred";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BaseSessions from "./BaseSessions.ts";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { EventId, type ClientThreadTurnStartCommand } from "@t3tools/contracts";

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
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-fork-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const nativeClone = <A>(run: () => Effect.Effect<A, ProviderAdapterRequestError>) =>
  Effect.gen(function* () {
    yield* (yield* BeforeNativeFork).pipe(
      Effect.mapError(
        (detail) =>
          new ProviderAdapterRequestError({ provider: "codex", method: "thread/fork", detail }),
      ),
    );
    return yield* run();
  });

const createdAt = "2026-10-24T12:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex_antoine"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const seed = Effect.fn(function* (
  name: string,
  driver: "codex" | "claudeAgent" | "cursor" = "codex",
) {
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const projectId = ProjectId.make(`project-${name}`);
  const threadId = ThreadId.make(`base-${name}`);
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`project-${name}`),
    projectId,
    title: "Bases",
    workspaceRoot: `${process.cwd()}/${name}`,
    defaultModelSelection: null,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`thread-${name}`),
    threadId,
    projectId,
    title: "ad_base",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: "main",
    worktreePath: null,
    historyImport: true,
    createdAt,
  });
  yield* engine.dispatch({
    type: "thread.history.import",
    commandId: CommandId.make(`history-${name}`),
    threadId,
    messages: [
      {
        messageId: MessageId.make(`history-user-${name}`),
        role: "user",
        text: "Remember cobalt",
        createdAt,
      },
      {
        messageId: MessageId.make(`history-assistant-${name}`),
        role: "assistant",
        text: "Remembered",
        createdAt,
      },
    ],
  });
  yield* directory.upsert({
    threadId,
    provider: ProviderDriverKind.make(driver),
    providerInstanceId: modelSelection.instanceId,
    runtimeMode: "approval-required",
    status: "stopped",
    resumeCursor: { threadId: "native-original" },
    runtimePayload: { cwd: process.cwd() },
  });
  yield* engine.dispatch({
    type: "thread.meta.update",
    commandId: CommandId.make(`designate-${name}`),
    threadId,
    isBase: true,
  });
  const input: typeof ClientThreadTurnStartCommand.Type = {
    type: "thread.turn.start",
    commandId: CommandId.make(`send-${name}`),
    threadId,
    message: {
      messageId: MessageId.make(`message-${name}`),
      role: "user",
      text: "Use cobalt to solve this",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    createdAt,
  };
  return { engine, directory, projectId, threadId, input };
});
// Model only the provider boundary: consume committed requests and publish the
// same durable session/activity receipt that the real reactor publishes.
const react = Effect.fn(function* (fail = false) {
  const engine = yield* OrchestrationEngineService;
  const events = yield* engine.subscribeDomainEvents;
  const calls: string[] = [];
  const fiber = yield* events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.type !== "thread.turn-start-requested") return;
        calls.push(event.aggregateId);
        const id = event.payload.threadId;
        if (fail) {
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`failed-${id}`),
            threadId: id,
            createdAt,
            activity: {
              id: EventId.make(`failure-${id}`),
              kind: "provider.turn.start.failed",
              tone: "error",
              summary: "Startup rejected",
              payload: { requestId: event.payload.messageId, detail: "Startup rejected" },
              turnId: null,
              createdAt,
            },
          });
        } else
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`running-${id}`),
            threadId: id,
            createdAt,
            session: {
              threadId: id,
              status: "running",
              providerName: "codex",
              providerInstanceId: modelSelection.instanceId,
              runtimeMode: "approval-required",
              activeTurnId: TurnId.make(`turn-${id}`),
              lastError: null,
              updatedAt: createdAt,
            },
          });
        if (!fail)
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`accepted-${event.payload.messageId}`),
            threadId: id,
            createdAt,
            activity: {
              id: EventId.make(`accepted-${event.payload.messageId}`),
              kind: "provider.turn.start.accepted",
              tone: "info",
              summary: "Message accepted by provider",
              payload: { requestId: event.payload.messageId },
              turnId: TurnId.make(`turn-${id}`),
              createdAt,
            },
          });
      }),
    ),
    Effect.tapCause((cause) => Effect.logError(cause)),
    Effect.forkChild,
  );
  return { calls, fiber };
});

it.layer(testLayer)("protected Base submissions", (it) => {
  it.effect(
    "forks once under concurrent retry, preserves source and settings, and survives a removed designation",
    () =>
      Effect.gen(function* () {
        const { engine, directory, threadId, input: plainInput, projectId } = yield* seed("retry");
        const input = {
          ...plainInput,
          message: {
            ...plainInput.message,
            attachments: [
              {
                type: "image" as const,
                id: "local-image",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 4,
                dataUrl: "data:image/png;base64,AQIDBA==",
              },
            ],
          },
        };
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        const binding = yield* directory.getBinding(threadId);
        let clones = 0;
        const provider = Layer.mock(ProviderService)({
          forkConversation: () =>
            nativeClone(() =>
              Effect.sync(() => {
                clones++;
                return { threadId: "native-independent" };
              }),
            ),
        });
        const reactor = yield* react();
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const [a, b] = yield* Effect.all([service.submit(input), service.submit(input)], {
            concurrency: 2,
          });
          expect(a.threadId).toBe(b.threadId);
          expect(a.threadId).not.toBe(threadId);
          const fork = Option.getOrThrow(yield* snapshots.getThreadDetailById(a.threadId!));
          expect(fork.isBase).not.toBe(true);
          expect(fork.projectId).toBe(projectId);
          expect(fork.modelSelection).toEqual(modelSelection);
          expect(fork.runtimeMode).toBe("approval-required");
          expect(fork.interactionMode).toBe("plan");
          const task = fork.messages.find((message) => message.text === input.message.text)!;
          expect(task.attachments).toHaveLength(1);
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: task.attachments![0]!.id,
          });
          expect(path).not.toBeNull();
          expect(Array.from(yield* fs.readFile(path!))).toEqual([1, 2, 3, 4]);
          expect(fork.messages.map((m) => m.text).sort()).toEqual(
            ["Remember cobalt", "Remembered", input.message.text].sort(),
          );
          expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
          expect(yield* directory.getBinding(threadId)).toEqual(binding);
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("remove-base"),
            threadId,
            isBase: false,
          });
          expect((yield* service.submit(input)).threadId).toBe(a.threadId);
          const restarted = yield* BaseSessions.BaseSessions.pipe(
            Effect.provide(BaseSessions.layer.pipe(Layer.provide(provider))),
          );
          expect((yield* restarted.submit(input)).threadId).toBe(a.threadId);
          const conflict = yield* Effect.result(
            service.submit({ ...input, message: { ...input.message, text: "Different task" } }),
          );
          expect(conflict._tag).toBe("Failure");
          expect(clones).toBe(1);
          expect(reactor.calls).toHaveLength(1);
        }).pipe(Effect.provide(BaseSessions.layer.pipe(Layer.provide(provider))));
        yield* Fiber.interrupt(reactor.fiber);
      }),
  );
  it.effect("rejects native clone failure without sending or modifying the Base", () =>
    Effect.gen(function* () {
      const { threadId, input, directory } = yield* seed("clone-error");
      const snapshots = yield* ProjectionSnapshotQuery;
      const before = yield* snapshots.getThreadDetailById(threadId);
      const binding = yield* directory.getBinding(threadId);
      let clones = 0;
      yield* Effect.gen(function* () {
        const service = yield* BaseSessions.BaseSessions;
        expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
        expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
      }).pipe(
        Effect.provide(
          BaseSessions.layer.pipe(
            Layer.provide(
              Layer.mock(ProviderService)({
                forkConversation: () =>
                  nativeClone(() => {
                    clones++;
                    return Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: ProviderDriverKind.make("codex"),
                        method: "thread/fork",
                        detail: "Native clone failed",
                      }),
                    );
                  }),
              }),
            ),
          ),
        ),
      );
      expect(clones).toBe(1);
      expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
      expect(yield* directory.getBinding(threadId)).toEqual(binding);
    }),
  );
  it.effect("retains one destination after startup rejection and does not retry the task", () =>
    Effect.gen(function* () {
      const { threadId, input } = yield* seed("startup-error");
      const snapshots = yield* ProjectionSnapshotQuery;
      const before = yield* snapshots.getThreadDetailById(threadId);
      const reactor = yield* react(true);
      let clones = 0;
      yield* Effect.gen(function* () {
        const service = yield* BaseSessions.BaseSessions;
        expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
        expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
      }).pipe(
        Effect.provide(
          BaseSessions.layer.pipe(
            Layer.provide(
              Layer.mock(ProviderService)({
                forkConversation: () =>
                  nativeClone(() =>
                    Effect.sync(() => {
                      clones++;
                      return { threadId: "native-rejected" };
                    }),
                  ),
              }),
            ),
          ),
        ),
      );
      expect(clones).toBe(1);
      expect(reactor.calls).toHaveLength(1);
      expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
      yield* Fiber.interrupt(reactor.fiber);
    }),
  );
  it.effect(
    "persists project prompts without sending and protects direct engine entry points",
    () =>
      Effect.gen(function* () {
        const { engine, projectId, threadId, input } = yield* seed("prompt");
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        expect(
          Option.getOrThrow(yield* snapshots.getProjectShellById(projectId)).basePrompt ??
            "Understand project",
        ).toBe("Understand project");
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("custom-prompt"),
          projectId,
          basePrompt: "Learn conventions and tests",
        });
        expect(Option.getOrThrow(yield* snapshots.getProjectShellById(projectId)).basePrompt).toBe(
          "Learn conventions and tests",
        );
        expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
        expect(
          (yield* Effect.result(
            engine.dispatch({ ...input, message: { ...input.message, attachments: [] } }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            engine.dispatch({
              type: "thread.message.user.append",
              commandId: CommandId.make("bypass"),
              threadId,
              message: { ...input.message, attachments: [] },
              createdAt,
            }),
          ))._tag,
        ).toBe("Failure");
        const reactor = yield* react();
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const result = yield* service.submit({
            ...input,
            initializeBase: true,
            message: { ...input.message, text: "Learn conventions and tests" },
          });
          expect(result.threadId).toBe(threadId);
        }).pipe(
          Effect.provide(
            BaseSessions.layer.pipe(
              Layer.provide(
                Layer.mock(ProviderService)({
                  forkConversation: () => Effect.die("Initialization must not clone"),
                }),
              ),
            ),
          ),
        );
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("reset-prompt"),
          projectId,
          basePrompt: "Understand project",
        });
        expect(Option.getOrThrow(yield* snapshots.getProjectShellById(projectId)).basePrompt).toBe(
          "Understand project",
        );
        expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId)).isBase).toBe(true);
        yield* Fiber.interrupt(reactor.fiber);
      }),
  );
  it.effect(
    "creates and initializes once using the saved project prompt, including retry after the prompt changes",
    () =>
      Effect.gen(function* () {
        const { engine, projectId, threadId } = yield* seed("create");
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        yield* engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.make("creation-prompt"),
          projectId,
          basePrompt: "Understand the custom conventions",
        });
        const reactor = yield* react();
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const input = {
            clientRequestId: "new-base",
            threadId: ThreadId.make("created-base"),
            projectId,
            createdAt,
            modelSelection,
            runtimeMode: "approval-required" as const,
            interactionMode: "plan" as const,
          };
          expect((yield* service.create(input)).threadId).toBe(input.threadId);
          yield* engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.make("creation-prompt-later"),
            projectId,
            basePrompt: "A later saved prompt",
          });
          expect((yield* service.create(input)).threadId).toBe(input.threadId);
          const created = Option.getOrThrow(yield* snapshots.getThreadDetailById(input.threadId));
          expect(created.isBase).toBe(true);
          expect(created.messages.map((m) => m.text)).toEqual([
            "Understand the custom conventions",
          ]);
          expect(
            (yield* Effect.result(
              service.create({ ...input, threadId: ThreadId.make("conflicting-create") }),
            ))._tag,
          ).toBe("Failure");
        }).pipe(
          Effect.provide(
            BaseSessions.layer.pipe(
              Layer.provide(
                Layer.mock(ProviderService)({
                  forkConversation: () => Effect.die("New base initialization must not clone"),
                }),
              ),
            ),
          ),
        );
        expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
        expect(reactor.calls).toHaveLength(1);
        yield* Fiber.interrupt(reactor.fiber);
      }),
  );
  it.effect(
    "truthfully rejects an unsupported native provider without creating a replacement",
    () =>
      Effect.gen(function* () {
        const { threadId, input } = yield* seed("unsupported", "cursor");
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const result = yield* Effect.result(service.submit(input));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.message).toMatch(/support/i);
        }).pipe(
          Effect.provide(
            BaseSessions.layer.pipe(
              Layer.provide(
                Layer.mock(ProviderService)({
                  forkConversation: () => Effect.die("Unsupported native clone must not run"),
                }),
              ),
            ),
          ),
        );
        expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
      }),
  );
  it.effect(
    "offers configured exact IDs within the project/account, preserves prompts and refuses ambiguous names",
    () =>
      Effect.gen(function* () {
        const { engine, projectId, threadId } = yield* seed("workflow");
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        const fs = yield* FileSystem.FileSystem;
        const root = `${process.cwd()}/workflow`;
        const config = {
          accounts: { AD: { instanceId: "codex_antoine", base: "ad_base" } },
          skillHomes: [],
          projects: {
            configured: { baseProject: root, basePrompt: "Keep my exact custom prompt" },
          },
        };
        const mockFiles = {
          ...fs,
          exists: () => Effect.succeed(true),
          realPath: (path: string) => Effect.succeed(path),
          readFileString: () => Effect.succeed(JSON.stringify(config)),
        };
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const configuration = yield* service.configuration(projectId);
          expect(configuration.configuredPrompt).toBe("Keep my exact custom prompt");
          expect(configuration.candidates.map((c) => c.threadId)).toEqual([threadId]);
          expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
          expect(
            Option.getOrThrow(yield* snapshots.getProjectShellById(projectId)).basePrompt,
          ).toBeNull();
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("duplicate-name"),
            threadId: ThreadId.make("duplicate-name"),
            projectId,
            title: "ad_base",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt,
          });
          const ambiguous = yield* service.configuration(projectId);
          expect(ambiguous.candidates).toEqual([]);
          expect(ambiguous.warning).toMatch(/Ambiguous/);
          expect(ambiguous.configuredPrompt).toBe("Keep my exact custom prompt");
        }).pipe(
          Effect.provide(BaseSessions.layer.pipe(Layer.provide(Layer.mock(ProviderService)({})))),
          Effect.provideService(FileSystem.FileSystem, mockFiles),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
      }),
  );
});

it.layer(testLayer)("Base submission receipt boundaries", (it) => {
  it.effect(
    "waits beyond early turn.started and retains a later failed send without resending",
    () =>
      Effect.gen(function* () {
        const { engine, threadId, input, directory } = yield* seed(
          "delayed-rejection",
          "claudeAgent",
        );
        const snapshots = yield* ProjectionSnapshotQuery;
        const before = yield* snapshots.getThreadDetailById(threadId);
        const binding = yield* directory.getBinding(threadId);
        const checkedEarlyStart = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        let starts = 0;
        const events = yield* engine.subscribeDomainEvents;
        const reactor = yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "thread.turn-start-requested") return;
              starts++;
              yield* engine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.make("delayed-running"),
                threadId: event.payload.threadId,
                createdAt,
                session: {
                  threadId: event.payload.threadId,
                  status: "running",
                  providerName: "claudeAgent",
                  providerInstanceId: modelSelection.instanceId,
                  runtimeMode: "approval-required",
                  activeTurnId: TurnId.make("early-native"),
                  lastError: null,
                  updatedAt: createdAt,
                },
              });
              yield* Deferred.await(checkedEarlyStart);
              expect(yield* Deferred.isDone(completed)).toBe(false);
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make("delayed-rejection"),
                threadId: event.payload.threadId,
                createdAt,
                activity: {
                  id: EventId.make("delayed-rejection"),
                  kind: "provider.turn.start.failed",
                  tone: "error",
                  summary: "Image rejected after early start",
                  payload: {
                    requestId: event.payload.messageId,
                    detail: "Unsupported Claude image attachment type 'image/svg+xml'.",
                  },
                  turnId: null,
                  createdAt,
                },
              });
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.gen(function* () {
          const service = yield* BaseSessions.BaseSessions;
          const result = yield* Effect.result(service.submit(input)).pipe(
            Effect.tap(() => Deferred.succeed(completed, undefined)),
          );
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
          expect(starts).toBe(1);
          expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
          expect(yield* directory.getBinding(threadId)).toEqual(binding);
        }).pipe(
          Effect.provide(
            BaseSessions.layer.pipe(
              Layer.provide(
                Layer.mock(ProviderService)({
                  forkConversation: () =>
                    nativeClone(() => Effect.succeed({ threadId: "delayed-native" })),
                }),
              ),
            ),
          ),
          Effect.provideService(ProjectionSnapshotQuery, {
            ...snapshots,
            getThreadDetailById: (id) =>
              snapshots
                .getThreadDetailById(id)
                .pipe(
                  Effect.tap((thread) =>
                    id !== threadId &&
                    Option.isSome(thread) &&
                    thread.value.session?.status === "running"
                      ? Deferred.succeed(checkedEarlyStart, undefined)
                      : Effect.void,
                  ),
                ),
          }),
        );
        yield* Fiber.interrupt(reactor);
      }),
  );

  it.effect(
    "validates persisted initialization attachments and preserves non-Base bootstrap reuse",
    () =>
      Effect.gen(function* () {
        const { engine, threadId, input } = yield* seed("persisted-attachments");
        const snapshots = yield* ProjectionSnapshotQuery;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("remove-for-bootstrap"),
          threadId,
          isBase: false,
        });
        const messageId = MessageId.make("bootstrap-image");
        yield* engine.dispatch({
          type: "thread.message.user.append",
          commandId: CommandId.make("bootstrap-image"),
          threadId,
          createdAt,
          message: {
            messageId,
            text: "Understand project",
            attachments: [
              {
                type: "image",
                id: "retained-image",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 4,
              },
            ],
          },
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("base-for-validation"),
          threadId,
          isBase: true,
        });
        const before = yield* snapshots.getThreadDetailById(threadId);
        const initialize = {
          ...input,
          initializeBase: true as const,
          message: {
            messageId,
            role: "user" as const,
            text: "Understand project",
            attachments: [],
          },
        };
        expect((yield* Effect.result(engine.dispatch(initialize)))._tag).toBe("Failure");
        expect(yield* snapshots.getThreadDetailById(threadId)).toEqual(before);
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("non-base-bootstrap"),
          threadId,
          isBase: false,
        });
        expect(
          (yield* Effect.result(
            engine.dispatch({
              ...initialize,
              commandId: CommandId.make("normal-bootstrap"),
              initializeBase: undefined,
            }),
          ))._tag,
        ).toBe("Success");
        const effective = Option.getOrThrow(
          yield* snapshots.getTurnStartMessage({ threadId, messageId }),
        );
        expect(effective.message.attachments).toHaveLength(1);
      }),
  );

  it.effect("retries a proven pre-clone rejection once the base is idle", () =>
    Effect.gen(function* () {
      const { engine, threadId, input, directory } = yield* seed("receipt-busy");
      const setStatus = (status: "starting" | "stopped") =>
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`receipt-${status}`),
          threadId,
          createdAt,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: modelSelection.instanceId,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        });
      yield* setStatus("starting");
      let clones = 0;
      const provider = Layer.mock(ProviderService)({
        forkConversation: () =>
          nativeClone(() =>
            Effect.sync(() => {
              clones++;
              return { threadId: "receipt-native-destination" };
            }),
          ),
      });
      const reactor = yield* react();
      yield* Effect.gen(function* () {
        const service = yield* BaseSessions.BaseSessions;
        const first = yield* Effect.result(service.submit(input));
        expect(first._tag).toBe("Failure");
        if (first._tag === "Failure")
          expect(first.failure.message).toContain("Wait for the current turn");
        expect(clones).toBe(0);
        yield* setStatus("stopped");
        const retry = yield* Effect.result(service.submit(input));
        const sql = yield* SqlClient.SqlClient;
        const receipts =
          yield* sql`SELECT state, thread_id FROM base_session_submissions WHERE request_id = ${input.commandId}`;
        const binding = yield* directory.getBinding(ThreadId.make(String(receipts[0]!.thread_id)));
        expect(clones).toBe(1);
        expect(binding._tag).toBe("Some");
        expect(reactor.calls).toHaveLength(1);
        expect(receipts[0]?.state).toBe("started");
        expect(retry._tag).toBe("Success");
      }).pipe(Effect.provide(BaseSessions.layer.pipe(Layer.provide(provider))));
      yield* Fiber.interrupt(reactor.fiber);
    }),
  );
  it.effect("does not initialize a base using a different persisted message", () =>
    Effect.gen(function* () {
      const { engine, threadId, input } = yield* seed("receipt-existing-message");
      const snapshots = yield* ProjectionSnapshotQuery;
      const messageId = MessageId.make("history-user-receipt-existing-message");
      const result = yield* Effect.result(
        engine.dispatch({
          ...input,
          initializeBase: true,
          message: { messageId, role: "user", text: "Understand project", attachments: [] },
        }),
      );
      const actual = Option.getOrThrow(
        yield* snapshots.getTurnStartMessage({ threadId, messageId }),
      );
      expect(actual.message.text).toBe("Remember cobalt");
      expect(result._tag).toBe("Failure");
    }),
  );
  it.effect("does not acknowledge a startup with a captured failure after early turn.started", () =>
    Effect.gen(function* () {
      const { engine, input } = yield* seed("receipt-early-start", "claudeAgent");
      const snapshots = yield* ProjectionSnapshotQuery;
      const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
        Effect.gen(function* () {
          const receipt = yield* engine.dispatch(command);
          if (command.type === "thread.turn.start") {
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("early-running"),
              threadId: command.threadId,
              createdAt,
              session: {
                threadId: command.threadId,
                status: "running",
                providerName: "claudeAgent",
                providerInstanceId: modelSelection.instanceId,
                runtimeMode: "approval-required",
                activeTurnId: TurnId.make("early-native-turn"),
                lastError: null,
                updatedAt: createdAt,
              },
            });
            yield* engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("early-error"),
              threadId: command.threadId,
              createdAt,
              session: {
                threadId: command.threadId,
                status: "error",
                providerName: "claudeAgent",
                providerInstanceId: modelSelection.instanceId,
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: "Unsupported Claude image attachment type 'image/svg+xml'.",
                updatedAt: createdAt,
              },
            });
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make("early-failure"),
              threadId: command.threadId,
              createdAt,
              activity: {
                id: EventId.make("early-failure"),
                kind: "provider.turn.start.failed",
                tone: "error",
                summary: "Provider turn start failed",
                payload: {
                  requestId: command.message.messageId,
                  detail: "Unsupported Claude image attachment type 'image/svg+xml'.",
                },
                turnId: null,
                createdAt,
              },
            });
          }
          return receipt;
        });
      yield* Effect.gen(function* () {
        const service = yield* BaseSessions.BaseSessions;
        const result = yield* Effect.result(service.submit(input));
        const sql = yield* SqlClient.SqlClient;
        const saved =
          yield* sql`SELECT state, thread_id FROM base_session_submissions WHERE request_id = ${input.commandId}`;
        const destination = Option.getOrThrow(
          yield* snapshots.getThreadDetailById(ThreadId.make(String(saved[0]!.thread_id))),
        );
        expect(saved[0]?.state).toBe("failed");
        expect(destination.session?.status).toBe("error");
        expect((yield* Effect.result(service.submit(input)))._tag).toBe("Failure");
        expect(result._tag).toBe("Failure");
      }).pipe(
        Effect.provide(
          BaseSessions.layer.pipe(
            Layer.provide(
              Layer.mock(ProviderService)({
                forkConversation: () =>
                  nativeClone(() => Effect.succeed({ threadId: "native-independent-early" })),
              }),
            ),
          ),
        ),
        Effect.provideService(OrchestrationEngineService, { ...engine, dispatch }),
      );
    }),
  );
});
