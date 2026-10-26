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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { buildGlobalInstructionContext } from "../provider/GlobalInstructions.ts";
import { forkThread } from "../project/ThreadFork.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as Workspaces from "./SessionWorkspaces.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as BaseSessions from "../project/BaseSessions.ts";
import { forkCodexThread } from "../provider/Layers/CodexSessionRuntime.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";

const dependencies = Layer.mergeAll(Git.layer, ProcessRunner.layer, Settings.layerTest()).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "session-jobs-" })),
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  OrchestrationLayerLive,
  Workspaces.layer,
  ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
).pipe(
  Layer.provideMerge(Workspaces.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(dependencies),
  Layer.provideMerge(WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer))),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const settings = yield* Settings.ServerSettingsService;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-test-" });
  const primary = path.join(root, "primary");
  const jobs = path.join(root, "jobs");
  yield* fs.makeDirectory(primary);
  yield* fs.makeDirectory(jobs);
  const run = (args: string[], cwd = primary) => git.execute({ operation: "test", cwd, args });
  yield* run(["init", "--initial-branch=main"]);
  yield* run(["config", "user.name", "Workspace test"]);
  yield* run(["config", "user.email", "workspace@example.invalid"]);
  yield* fs.writeFileString(path.join(primary, "source.txt"), "original\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  yield* settings.updateSettings({ agentWorkRoot: jobs, workspaceLifecycleCommand: null });
  return { fs, path, primary, jobs, root, run, settings };
});

it.layer(testLayer)("session workspace binding", (it) => {
  for (const mode of ["disabled", "legacy", "bound"] as const) {
    it.effect(`composes Base fork/send and same-request retry with ${mode} workspaces`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory;
        const workspaces = yield* Workspaces.SessionWorkspaces;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make(`base-project-${mode}`);
        const sourceId = ThreadId.make(`base-source-${mode}`);
        const createdAt = "2026-10-24T00:00:00.000Z";
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex-test-account"),
          model: "exact-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        };
        if (mode === "disabled") yield* f.settings.updateSettings({ agentWorkRoot: "" });
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`project-${mode}`),
          projectId,
          title: "Base project",
          workspaceRoot: f.primary,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${mode}`),
          threadId: sourceId,
          projectId,
          title: "Base",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: "main",
          worktreePath: null,
          createdAt,
          ...(mode === "legacy" ? { historyImport: true } : {}),
        });
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(`history-${mode}`),
          threadId: sourceId,
          messages: [
            {
              messageId: MessageId.make(`old-${mode}`),
              role: "user",
              text: "Remember the source",
              createdAt,
            },
          ],
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`base-${mode}`),
          threadId: sourceId,
          isBase: true,
        });
        const parentJob = yield* workspaces.get(sourceId);
        const sourceCwd = parentJob?.workspaceDirectory ?? f.primary;
        yield* directory.upsert({
          threadId: sourceId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "approval-required",
          status: "stopped",
          resumeCursor: { threadId: "native-source" },
          runtimePayload: { cwd: mode === "legacy" ? f.path.join(f.root, "removed") : sourceCwd },
        });
        const before = yield* snapshots.getThreadDetailById(sourceId);
        const nativeBefore = yield* directory.getBinding(sourceId);
        const input = {
          type: "thread.turn.start" as const,
          commandId: CommandId.make(`submit-${mode}`),
          threadId: sourceId,
          modelSelection,
          runtimeMode: "approval-required" as const,
          interactionMode: "plan" as const,
          createdAt: "2026-10-24T01:00:00.000Z",
          message: {
            messageId: MessageId.make(`task-${mode}`),
            role: "user" as const,
            text: "Use the remembered source",
            attachments: [],
          },
        };
        let clones = 0;
        let deliveries = 0;
        const events = yield* engine.subscribeDomainEvents;
        const reactor = yield* events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "thread.turn-start-requested") return;
              deliveries++;
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`accepted-${mode}`),
                threadId: event.payload.threadId,
                createdAt,
                activity: {
                  id: EventId.make(`accepted-${mode}`),
                  kind: "provider.turn.start.accepted",
                  tone: "info",
                  summary: "Accepted",
                  payload: { requestId: event.payload.messageId },
                  turnId: null,
                  createdAt,
                },
              });
            }),
          ),
          Effect.forkChild,
        );
        const provider = Layer.mock(ProviderService)({
          forkConversation: (source, options) =>
            Effect.gen(function* () {
              expect(source).toBe(sourceId);
              expect(options?.cwd).toBe(sourceCwd);
              const rows = yield* sql<{
                state: string;
                thread_id: string;
              }>`SELECT state, thread_id FROM base_session_submissions WHERE request_id = ${input.commandId}`;
              expect(rows[0]!.state).toBe("preparing");
              const child = yield* workspaces.get(rows[0]!.thread_id);
              expect(options?.destinationThreadId).toBe(
                mode === "disabled" ? undefined : rows[0]!.thread_id,
              );
              expect(Boolean(child)).toBe(mode !== "disabled");
              const client: Parameters<typeof forkCodexThread>[0] = {
                raw: {
                  request: (method, params) =>
                    Effect.gen(function* () {
                      // The real native boundary must persist uncertainty after all job preflight.
                      expect(
                        (yield* sql<{
                          state: string;
                        }>`SELECT state FROM base_session_submissions WHERE request_id = ${input.commandId}`)[0]!
                          .state,
                      ).toBe("cloning");
                      expect(method).toBe("thread/fork");
                      expect(params).toEqual({
                        threadId: "native-source",
                        ...(child ? { cwd: child.workspaceDirectory } : {}),
                      });
                      clones++;
                      return { thread: { id: "native-child" } };
                    }).pipe(Effect.orDie),
                },
              };
              return yield* forkCodexThread(client, "native-source", child?.workspaceDirectory);
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread/fork",
                    detail: String(cause),
                  }),
              ),
            ),
        });
        yield* Effect.gen(function* () {
          const bases = yield* BaseSessions.BaseSessions;
          const submit = () => bases.submit(input);
          if (mode === "bound") {
            yield* f.fs.writeFileString(f.path.join(sourceCwd, "source.txt"), "dirty source");
            expect((yield* submit().pipe(Effect.flip)).message).toContain("uncommitted");
            expect(clones).toBe(0);
            expect(
              (yield* sql<{
                state: string;
              }>`SELECT state FROM base_session_submissions WHERE request_id = ${input.commandId}`)[0]!
                .state,
            ).toBe("preparing");
            yield* f.fs.writeFileString(f.path.join(sourceCwd, "source.txt"), "original\n");
          }
          const [a, b] = yield* Effect.all([submit(), submit()], { concurrency: 2 });
          expect(b.threadId).toBe(a.threadId);
          const restarted = yield* BaseSessions.BaseSessions.pipe(
            Effect.provide(BaseSessions.layer.pipe(Layer.provide(provider))),
          );
          expect((yield* restarted.submit(input)).threadId).toBe(a.threadId);
          const child = Option.getOrThrow(yield* snapshots.getThreadDetailById(a.threadId!));
          const childJob = yield* workspaces.get(a.threadId!);
          expect(child).toMatchObject({
            projectId,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "plan",
          });
          expect(child.isBase).not.toBe(true);
          expect(child.messages.map((m) => m.text).sort()).toEqual(
            ["Remember the source", input.message.text].sort(),
          );
          expect(child.worktreePath).toBe(childJob?.workspaceDirectory ?? null);
          expect(Option.getOrThrow(yield* directory.getBinding(a.threadId!))).toMatchObject({
            resumeCursor: { threadId: "native-child" },
            runtimePayload: { cwd: childJob?.workspaceDirectory ?? f.primary },
          });
          expect(clones).toBe(1);
          expect(deliveries).toBe(1);
          expect(yield* snapshots.getThreadDetailById(sourceId)).toEqual(before);
          expect(yield* directory.getBinding(sourceId)).toEqual(nativeBefore);
          expect(yield* workspaces.get(sourceId)).toEqual(parentJob);
          expect(yield* f.fs.readFileString(f.path.join(sourceCwd, "source.txt"))).toBe(
            "original\n",
          );
          expect((yield* f.fs.readDirectory(f.jobs)).length).toBe(
            mode === "disabled" ? 0 : mode === "legacy" ? 1 : 2,
          );
        }).pipe(Effect.provide(BaseSessions.layer.pipe(Layer.provide(provider))));
        yield* Fiber.interrupt(reactor);
      }),
    );
  }

  it.effect("disabled defaults and legacy sessions keep their existing paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      yield* f.settings.updateSettings({ agentWorkRoot: "" });
      expect(
        yield* service.prepare({ threadId: ThreadId.make("disabled"), sourceDirectory: f.primary }),
      ).toBeNull();
      yield* f.settings.updateSettings({ agentWorkRoot: f.jobs });
      expect(yield* service.verify("legacy-with-native-history")).toBeNull();
      expect(yield* f.fs.readDirectory(f.jobs)).toEqual([]);
    }),
  );

  it.effect("parallel retries and a service restart reuse one real checkout", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      const input = { threadId: ThreadId.make("idempotent"), sourceDirectory: f.primary };
      const jobs = yield* Effect.all([service.prepare(input), service.prepare(input)], {
        concurrency: 2,
      });
      const job = jobs[0]!;
      expect(jobs[1]).toEqual(job);
      expect(yield* f.fs.readFileString(f.path.join(job.workspaceDirectory, "source.txt"))).toBe(
        "original\n",
      );
      yield* f.fs.writeFileString(
        f.path.join(job.workspaceDirectory, "source.txt"),
        "session change\n",
      );
      yield* f.settings.updateSettings({ agentWorkRoot: f.path.join(f.root, "changed-root") });
      const resumed = yield* Effect.gen(function* () {
        return yield* (yield* Workspaces.SessionWorkspaces).prepare(input);
      }).pipe(Effect.provide(Workspaces.layer));
      expect(resumed).toEqual(job);
      expect(yield* f.fs.readFileString(f.path.join(f.primary, "source.txt"))).toBe("original\n");
      expect(
        (yield* f.run(["worktree", "list", "--porcelain"])).stdout.match(/worktree /g),
      ).toHaveLength(2);
      const other = yield* fixture();
      expect(
        (yield* service.prepare({ ...input, sourceDirectory: other.primary }).pipe(Effect.flip))
          .message,
      ).toContain("different source");
      expect((yield* service.get(input.threadId))!.root).toBe(job.root);
    }),
  );

  it.effect(
    "failed registration retains the identity and blocks launch until the identical registration succeeds",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const service = yield* Workspaces.SessionWorkspaces;
        const adapter = f.path.join(f.root, "lifecycle.mjs");
        yield* f.fs.writeFileString(
          adapter,
          "process.stderr.write('registration unavailable'); process.exit(3);",
        );
        yield* f.settings.updateSettings({
          workspaceLifecycleCommand: { executable: process.execPath, args: [adapter] },
        });
        const input = { threadId: ThreadId.make("register-retry"), sourceDirectory: f.primary };
        const error = yield* service.prepare(input).pipe(Effect.flip);
        expect(error.message).toContain("registration unavailable");
        const reserved = (yield* service.get(input.threadId))!;
        expect((yield* service.verify(input.threadId).pipe(Effect.flip)).message).toContain(
          "incomplete",
        );
        yield* f.fs.writeFileString(
          adapter,
          `import fs from 'node:fs'; let text=''; for await(const data of process.stdin) text+=data;
      const job=JSON.parse(text); const record=job.root+'/registered.json';
      if(fs.existsSync(record) && fs.readFileSync(record,'utf8')!==text) process.exit(4);
      fs.writeFileSync(record,text); console.log(JSON.stringify({version:1,jobId:job.jobId,registered:true}));`,
        );
        const ready = (yield* service.prepare(input))!;
        expect(ready).toEqual(reserved);
        yield* f.fs.writeFileString(
          f.path.join(ready.workspaceDirectory, "source.txt"),
          "dirty tracked file",
        );
        yield* f.fs.writeFileString(
          f.path.join(ready.workspaceDirectory, "unfinished.txt"),
          "untracked work",
        );
        yield* service.completeSetup(input.threadId);
        const successor = "registered-successor";
        yield* service.inherit(input.threadId, successor);
        const restarted = yield* Workspaces.SessionWorkspaces.pipe(
          Effect.provide(Workspaces.layer),
        );
        yield* restarted.inherit(input.threadId, successor);
        expect(yield* restarted.verify(successor)).toEqual(ready);
        expect(yield* restarted.needsSetup(successor)).toBe(false);
        expect(
          yield* f.fs.readFileString(f.path.join(ready.workspaceDirectory, "source.txt")),
        ).toBe("dirty tracked file");
        expect(
          yield* f.fs.readFileString(f.path.join(ready.workspaceDirectory, "unfinished.txt")),
        ).toBe("untracked work");

        yield* service.verify(input.threadId);
        const request = decodeUnknown(
          yield* f.fs.readFileString(f.path.join(ready.root, "registered.json")),
        );
        expect(request).toEqual({
          action: "register",
          version: 1,
          jobId: ready.jobId,
          threadId: input.threadId,
          root: ready.root,
          sourceDirectory: f.primary,
          workspaceDirectory: ready.workspaceDirectory,
          tmpDirectory: ready.tmpDirectory,
          buildDirectory: ready.buildDirectory,
          cacheDirectory: ready.cacheDirectory,
          downloadsDirectory: ready.downloadsDirectory,
          outputsDirectory: ready.outputsDirectory,
          evidenceDirectory: ready.evidenceDirectory,
        });
        expect(
          (yield* f.run(["worktree", "list", "--porcelain"])).stdout.match(/worktree /g),
        ).toHaveLength(2);
      }),
  );

  it.effect("forks get distinct jobs and preserve the parent's exact committed source", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      const parent = (yield* service.prepare({
        threadId: ThreadId.make("parent"),
        sourceDirectory: f.primary,
      }))!;
      const child = (yield* service.prepare({
        threadId: ThreadId.make("child"),
        sourceDirectory: parent.workspaceDirectory,
        fork: true,
      }))!;
      expect(child.jobId).not.toBe(parent.jobId);
      expect(child.sourceDirectory).toBe(parent.sourceDirectory);
      expect(child.revision).toBe(parent.revision);
      yield* f.fs.writeFileString(
        f.path.join(parent.workspaceDirectory, "source.txt"),
        "uncommitted\n",
      );
      expect(
        (yield* service
          .prepare({
            threadId: ThreadId.make("dirty-fork"),
            sourceDirectory: parent.workspaceDirectory,
            fork: true,
          })
          .pipe(Effect.flip)).message,
      ).toContain("uncommitted changes");
      expect(yield* f.fs.readFileString(f.path.join(parent.workspaceDirectory, "source.txt"))).toBe(
        "uncommitted\n",
      );
    }),
  );

  it.effect("missing directories fail truthfully and do not create a replacement job", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      const job = (yield* service.prepare({
        threadId: ThreadId.make("missing"),
        sourceDirectory: f.primary,
      }))!;
      yield* f.fs.rename(job.tmpDirectory, job.tmpDirectory + "-retained");
      yield* service.verify("missing").pipe(Effect.flip);
      expect(yield* f.fs.exists(job.tmpDirectory)).toBe(false);
      expect((yield* service.get("missing"))!.root).toBe(job.root);
    }),
  );

  it.effect(
    "publishes a fork with its distinct job and native context without changing its source",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory;
        const service = yield* Workspaces.SessionWorkspaces;
        const projectId = ProjectId.make("fork-job-project");
        const sourceId = ThreadId.make("fork-job-source");
        const childId = ThreadId.make("fork-job-child");
        const createdAt = "2026-10-24T00:00:00.000Z";
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("fork-job-project"),
          projectId,
          title: "fork jobs",
          workspaceRoot: f.primary,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("fork-job-source"),
          threadId: sourceId,
          projectId,
          title: "source",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const sourceJob = (yield* service.get(sourceId))!;
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make("fork-job-history"),
          threadId: sourceId,
          messages: [
            {
              messageId: MessageId.make("fork-job-message"),
              role: "user",
              text: "Retain native context",
              createdAt,
            },
          ],
        });
        yield* directory.upsert({
          threadId: sourceId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          status: "stopped",
          resumeCursor: { threadId: "native-source" },
          runtimePayload: { cwd: sourceJob.workspaceDirectory },
        });
        const before = Option.getOrThrow(yield* snapshots.getThreadDetailById(sourceId));
        let calls = 0;
        const provider = Layer.mock(ProviderService)({
          forkConversation: (source, destination) =>
            Effect.sync(() => {
              expect(source).toBe(sourceId);
              expect(destination).toEqual({
                cwd: sourceJob.workspaceDirectory,
                destinationThreadId: childId,
              });
              calls++;
              return { threadId: "native-child" };
            }),
        });
        yield* forkThread({ sourceThreadId: sourceId, threadId: childId }).pipe(
          Effect.provide(provider),
        );
        yield* forkThread({ sourceThreadId: sourceId, threadId: childId }).pipe(
          Effect.provide(provider),
        );
        const childJob = (yield* service.get(childId))!;
        expect(calls).toBe(1);
        expect(childJob.jobId).not.toBe(sourceJob.jobId);
        expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(childId))).toMatchObject({
          worktreePath: childJob.workspaceDirectory,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        expect(Option.getOrThrow(yield* directory.getBinding(childId))).toMatchObject({
          resumeCursor: { threadId: "native-child" },
          runtimePayload: { cwd: childJob.workspaceDirectory },
        });
        expect(Option.getOrThrow(yield* snapshots.getThreadDetailById(sourceId))).toEqual(before);
        expect((yield* service.get(sourceId))!.workspaceDirectory).toBe(
          sourceJob.workspaceDirectory,
        );
      }),
  );

  it.effect("shared creation persists the actual cwd and leaves history imports unchanged", () =>
    Effect.gen(function* () {
      const route = "shared";
      const f = yield* fixture();
      const engine = yield* OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const service = yield* Workspaces.SessionWorkspaces;
      const projectId = ProjectId.make(`project-${route}`);
      const threadId = ThreadId.make(`thread-${route}`);
      const createdAt = "2026-10-24T00:00:00.000Z";
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`project-${route}`),
        projectId,
        title: route,
        workspaceRoot: f.primary,
        defaultModelSelection: null,
        createdAt,
      });
      const command = {
        type: "thread.create" as const,
        commandId: CommandId.make(`create-${route}`),
        threadId,
        projectId,
        title: route,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt,
      };
      yield* engine.dispatch(command);
      yield* engine.dispatch(command);
      const thread = Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
      const job = (yield* service.get(threadId))!;
      expect(thread.worktreePath).toBe(job.workspaceDirectory);
      expect(thread.runtimeMode).toBe("approval-required");
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cannot-rebind"),
          threadId,
          worktreePath: f.primary,
        })
        .pipe(Effect.flip);
      expect(
        (yield* f.run(["worktree", "list", "--porcelain"])).stdout.match(/worktree /g),
      ).toHaveLength(2);
      yield* engine.dispatch({
        ...command,
        commandId: CommandId.make("legacy-import"),
        threadId: ThreadId.make("legacy-import"),
        historyImport: true,
      });
      expect(
        Option.getOrThrow(yield* snapshots.getThreadShellById(ThreadId.make("legacy-import")))
          .worktreePath,
      ).toBeNull();
      expect(yield* service.get("legacy-import")).toBeNull();
    }),
  );

  it.effect("move registration keeps logical identity and destination-local paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      const threadId = ThreadId.make("move-job");
      const cwd = (yield* service.movePath(threadId, "request"))!;
      const head = (yield* f.run(["rev-parse", "HEAD"])).stdout.trim();
      yield* service.reserveMove({
        threadId,
        requestId: "request",
        sourceDirectory: f.primary,
        cwd,
        revision: head,
        branch: "moved",
      });
      yield* f.run(["worktree", "add", "--detach", cwd, head]);
      const job = (yield* service.registerMove({
        threadId,
        requestId: "request",
        sourceDirectory: f.primary,
        cwd,
        revision: head,
        branch: "moved",
      }))!;
      expect(job.workspaceDirectory).toBe(cwd);
      expect(yield* service.movePath(threadId, "return-request")).toBe(cwd);
      expect(yield* service.needsSetup(threadId)).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT * FROM session_workspaces WHERE thread_id = ${threadId} AND active = 1`,
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "runtime facts retain current global instructions and contain actual launch paths without credentials",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const job = (yield* (yield* Workspaces.SessionWorkspaces).prepare({
          threadId: ThreadId.make("facts"),
          sourceDirectory: f.primary,
        }))!;
        yield* f.settings.updateSettings({
          globalInstructions: { enabled: true, text: "latest user instruction" },
        });
        const context = buildGlobalInstructionContext(
          yield* f.settings.getSettings,
          job.workspaceDirectory,
          true,
          job,
        )!;
        expect(context.context.instructions).toContain("latest user instruction");
        expect(context.context.runtimeFacts).toContain(encode(job.tmpDirectory).slice(1, -1));
        const environment = Workspaces.workspaceEnvironment(job);
        expect(environment.TMPDIR).toBe(job.tmpDirectory);
        expect(environment.HOME).toBeUndefined();
        expect(environment.CODEX_HOME).toBeUndefined();
        expect(environment.CLAUDE_CONFIG_DIR).toBeUndefined();
      }),
  );
});
