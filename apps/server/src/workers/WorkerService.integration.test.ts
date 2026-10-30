import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { provider } from "./WorkerService.testkit.ts";
import * as WorkerService from "./WorkerService.ts";
import { WorkerError } from "./workerSchemas.ts";

/**
 * The worker service over the real V2 orchestrator and thread management on SQLite. Runs never reach
 * a provider here: the test plays the provider by writing run state through the event sink.
 */
const project = ProjectId.make("project:worker-integration");
const model = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const master = ThreadId.make("thread:master");

const layerPlatform = NodeServices.layer;
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-worker-integration-" });
const layerCheckpoints = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
);
const driver = ProviderDriverKind.make("codex");
const instance = {
  instanceId: model.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: model.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("the test plays the provider"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const layerInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
  listInstances: Effect.succeed([instance]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const layerShared = Layer.mergeAll(
  ServerSettings.layerTest(),
  ProviderRegistryMock.layer([provider("codex", "gpt-5.4"), provider("claude", "sonnet")] as never),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedSome({ id: project } as never),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:local")),
  }),
);

const layerRuntime = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
).pipe(
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("unused title link"),
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(layerShared),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpoints),
  Layer.provide(layerConfig),
  Layer.provide(layerInstances),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(layerPlatform),
);

// A fresh worker is launched as a bare thread; workspace preparation belongs to the real launcher.
const layerLauncher = Layer.effect(
  ThreadLaunchService.ThreadLaunchService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return ThreadLaunchService.ThreadLaunchService.of({
      launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
        orchestrator
          .dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: input.threadId!,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: process.cwd(),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(Effect.as({ threadId: input.threadId } as never), Effect.orDie),
    } as never);
  }),
);

const layerWorkers = WorkerService.layer.pipe(
  Layer.provideMerge(layerLauncher),
  Layer.provideMerge(layerRuntime),
);

const seed = Effect.fn("seed")(function* (masterId: ThreadId = master) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  if ((yield* orchestrator.getThreadShell(masterId)) !== null) return;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const at = DateTime.formatIso(yield* DateTime.now);
  const existing = yield* projects.get(project).pipe(Effect.orElseSucceed(() => null));
  if (!existing)
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make("seed:worker-integration-project"),
      aggregateKind: "project",
      aggregateId: project,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: project,
        title: "Workers",
        workspaceRoot: process.cwd(),
        defaultModelSelection: model,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    } as never);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${masterId}`),
    threadId: masterId,
    projectId: project,
    title: masterId,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: process.cwd(),
    createdBy: "user",
    creationSource: "web",
  });
});

/** Plays the provider: moves the newest run of a thread to a state, as the effect worker would. */
const setLatestRun = Effect.fn("setLatestRun")(function* (
  threadId: ThreadId,
  status: "running" | "completed" | "failed",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const run =
    status === "running"
      ? projection.runs.findLast((candidate) => candidate.status !== "running")!
      : (projection.runs.find((candidate) => candidate.status === "running") ??
        projection.runs.at(-1)!);
  const at = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`provider:${run.id}:${status}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: at,
        payload: {
          ...run,
          status,
          startedAt: run.startedAt ?? at,
          completedAt: status === "running" ? null : at,
          ...(status === "completed"
            ? { checkpointId: CheckpointId.make(`checkpoint:${run.id}`) }
            : {}),
        },
      },
    ],
  });
  return run;
});

const spawnInput = (threadId: ThreadId, prompt: string) => ({
  threadId,
  title: "Worker",
  modelSelection: model,
  prompt,
  projectId: project,
});

it.layer(layerWorkers)("workers over the real orchestrator", (it) => {
  it.effect("spawns a fresh worker, delivers one assignment and its done report", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = ThreadId.make("thread:worker-fresh");

      const spawned = yield* workers.spawn(master, spawnInput(worker, "Do the thing"));
      const retried = yield* workers.spawn(master, spawnInput(worker, "Do the thing"));
      assert.equal(retried.threadId, spawned.threadId);

      const created = yield* orchestrator.getThreadProjection(worker);
      assert.lengthOf(created.runs, 1);
      assert.equal(created.messages.filter((message) => message.role === "user").length, 1);

      yield* setLatestRun(worker, "running");
      const refused = yield* workers
        .report(worker, {
          clientRequestId: "report-blocked",
          outcome: "blocked",
          summary: "Stuck on the build.",
        })
        .pipe(Effect.flip);
      assert.include((refused as WorkerError).message, "communication window");

      yield* workers.report(worker, {
        clientRequestId: "report-done",
        outcome: "done",
        summary: "Finished the thing.",
      });
      yield* setLatestRun(worker, "completed");
      yield* workers.drain();

      const delivered = yield* orchestrator.getThreadProjection(master);
      const reports = delivered.messages.filter((message) =>
        message.text.includes("[T3 worker report"),
      );
      assert.lengthOf(reports, 1);
      assert.include(reports[0]!.text, "Finished the thing.");
      yield* workers.drain();
      const again = yield* orchestrator.getThreadProjection(master);
      assert.lengthOf(
        again.messages.filter((message) => message.text.includes("[T3 worker report")),
        1,
      );
    }),
  );

  it.effect("keeps a queued assignment and its report across a service restart", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const worker = ThreadId.make("thread:worker-restart");

      yield* workers.spawn(master, spawnInput(worker, "First"));
      yield* setLatestRun(worker, "running");
      const second = yield* workers.send(master, {
        threadId: worker,
        clientRequestId: "req-restart-1",
        prompt: "Second",
      });
      const retry = yield* workers.send(master, {
        threadId: worker,
        clientRequestId: "req-restart-1",
        prompt: "Second",
      });
      assert.equal(retry.requestId, second.requestId);
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM custom_worker_jobs WHERE worker_id = ${worker}`)[0]!.count,
        2,
      );

      // A restart rebuilds the service from the database alone: a fresh instance sees the same jobs.
      const context = yield* Effect.context<
        | SqlClient.SqlClient
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | ProviderRegistry
        | ServerSettings.ServerSettingsService
        | ProjectService.ProjectService
        | ServerEnvironment.ServerEnvironmentIdentity
      >();
      const restarted = yield* Layer.build(
        Layer.fresh(WorkerService.layer).pipe(Layer.provide(Layer.succeedContext(context))),
      ).pipe(Effect.map((built) => Context.get(built, WorkerService.WorkerService)));
      yield* setLatestRun(worker, "completed");
      yield* restarted.drain();
      const read = yield* restarted.read(master, { threadId: worker });
      assert.equal(read.worker.threadId, worker);
      const projection = yield* orchestrator.getThreadProjection(worker);
      assert.isAtLeast(projection.runs.length, 1);
    }),
  );

  it.effect("forks a worker from an idle base and accepts a blocker once the window is over", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const base = ThreadId.make("thread:base");
      const forked = ThreadId.make("thread:worker-forked");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:base"),
        threadId: base,
        projectId: project,
        title: "Base",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        createdBy: "user",
        creationSource: "web",
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("base:first"),
        threadId: base,
        messageId: MessageId.make("message:base-first"),
        text: "Set things up.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* setLatestRun(base, "running");
      yield* setLatestRun(base, "completed");

      const spawned = yield* workers.spawn(master, {
        ...spawnInput(forked, "Continue from the base."),
        sourceThreadId: base,
      });
      assert.equal(spawned.sourceThreadId, base);
      const projection = yield* orchestrator.getThreadProjection(forked);
      assert.lengthOf(projection.runs, 1);

      yield* setLatestRun(forked, "running");
      yield* workers.drain();
      yield* TestClock.adjust(Duration.minutes(16));
      yield* workers.report(forked, {
        clientRequestId: "blocked-1",
        outcome: "blocked",
        needs: "master",
        summary: "Needs the signing key.",
      });
      yield* workers.drain();
      const delivered = yield* orchestrator.getThreadProjection(master);
      assert.isTrue(
        delivered.messages.some((message) => message.text.includes("Needs the signing key.")),
      );
    }),
  );

  it.effect("hands workers to a successor and reclaims one on the user's instruction", () =>
    Effect.gen(function* () {
      const boss = ThreadId.make("thread:boss");
      yield* seed(boss);
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const successor = ThreadId.make("thread:successor");
      const owned = ThreadId.make("thread:worker-owned");
      yield* workers.spawn(boss, spawnInput(owned, "Hold this."));

      const handoff = yield* workers.handoff(boss, {
        threadId: successor,
        title: "Successor",
        modelSelection: model,
        prompt: "Carry on with the plan.",
      });
      assert.deepEqual(handoff.transferredWorkerIds, [owned]);
      assert.deepEqual(
        (yield* workers.list(successor)).map((entry) => entry.threadId),
        [owned],
      );
      assert.lengthOf(yield* workers.list(boss), 0);
      assert.equal((yield* workers.readOwnership(owned)).ownerThreadId, successor);

      const typed = yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("user:take-back"),
        threadId: boss,
        messageId: MessageId.make("message:take-back"),
        text: "Please take back the held worker.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.isDefined(typed);
      const reclaimed = yield* workers.reclaim(boss, {
        clientRequestId: "reclaim-real",
        workerThreadIds: [owned],
        userRequest: "take back the held worker",
      });
      assert.deepEqual(reclaimed.workerThreadIds, [owned]);
      assert.equal((yield* workers.readOwnership(owned)).ownerThreadId, boss);
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM custom_worker_reclaims`;
      assert.equal(rows[0]!.count, 1);
    }),
  );

  it.effect("serves a worker carried over from the custom fork", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const imported = ThreadId.make("thread:imported");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:imported"),
        threadId: imported,
        projectId: project,
        title: "Imported worker",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        createdBy: "agent",
        creationSource: "mcp",
      });
      const baseline =
        yield* (yield* ThreadManagementService.ThreadManagementService).getThreadEventSequence(
          imported,
        );
      const plan = JSON.stringify({
        threadId: imported,
        projectId: project,
        title: "Imported worker",
        modelSelection: model,
        prompt: "Original task",
        runtimeMode: "full-access",
        interactionMode: "default",
        authorityRevision: 3,
      });
      yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, baseline, read_seq, notify)
        VALUES (${imported}, ${master}, ${plan}, 'ready', ${baseline}, ${baseline}, 1)`;
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, turn_id, reported, dispatched_at)
        VALUES (${`spawn:${imported}`}, ${imported}, ${imported}, 'work', 'Original task', '2026-10-01T00:00:00.000Z', 'completed', 'turn-v1', 1, '2026-10-01T00:00:00.000Z')`;

      const listed = yield* workers.list(master);
      assert.isTrue(listed.some((entry) => entry.threadId === imported));
      const sent = yield* workers.send(master, {
        threadId: imported,
        clientRequestId: "imported-1",
        prompt: "Continue with the next step.",
      });
      assert.equal(sent.threadId, imported);
      const read = yield* workers.read(master, { threadId: imported });
      assert.isTrue(read.items.some((item) => item.text.includes("Continue with the next step.")));
      assert.equal((yield* workers.readOwnership(imported)).ownerThreadId, master);
    }),
  );
});
