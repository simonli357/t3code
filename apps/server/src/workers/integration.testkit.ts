import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AllocationAssignments from "../allocation/AllocationAssignments.ts";
import * as AllocationStore from "../allocation/AllocationStore.ts";
import * as ProviderAllocation from "../allocation/ProviderAllocation.ts";
import * as UsageCapEnforcement from "../allocation/UsageCapEnforcement.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerRequests from "../peer/PeerRequests.ts";
import * as ThreadMoveGuard from "../moves/ThreadMoveGuard.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { provider } from "./WorkerService.testkit.ts";
import * as WorkerService from "./WorkerService.ts";

/**
 * Workers and allocation over the real V2 orchestrator and thread management on SQLite. Runs never
 * reach a provider here: tests play the provider by writing run state through the event sink.
 */
export const project = ProjectId.make("project:worker-integration");
export const model = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
export const master = ThreadId.make("thread:master");

const layerPlatform = NodeServices.layer;
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-worker-integration-" });
export const layerCheckpoints = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
);
const driver = ProviderDriverKind.make("codex");
const instanceFor = (instanceId: string) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: `codex:${instanceId}` },
    displayName: instanceId,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: {
      instanceId: ProviderInstanceId.make(instanceId),
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("the test plays the provider"),
    } as ProviderAdapter.ProviderAdapterV2["Service"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;
const layerInstances = (providers: ReadonlyArray<unknown>) => {
  const instances = [
    ...new Set([
      model.instanceId as string,
      ...providers.map((candidate) => (candidate as { instanceId: string }).instanceId),
    ]),
  ].map(instanceFor);
  return Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
};

export const defaultProviders = [provider("codex", "gpt-5.4"), provider("claude", "sonnet")];

/** What differs between the computers of a test: its identity, checkout and provider home. */
export interface WorldOptions {
  readonly environmentId?: string;
  readonly label?: string;
  readonly workspaceRoot?: string;
  readonly codexHome?: string;
  readonly dshHome?: string;
  readonly claudeHome?: string;
  readonly piHome?: string;
  /** Peer services of this computer, for tests that link it to another. */
  readonly peers?: Layer.Layer<PeerLinks.PeerLinks | PeerRequests.PeerRequests>;
}

const layerShared = (providers: ReadonlyArray<unknown>, options: WorldOptions = {}) => {
  const environmentId = EnvironmentId.make(options.environmentId ?? "environment:local");
  return Layer.mergeAll(
    ServerSettings.layerTest({
      providerInstances: Object.fromEntries(
        providers.map((candidate) => {
          const instanceId = (candidate as { instanceId: string }).instanceId;
          const deepseek = instanceId === "deepseekHarness";
          const claude = instanceId === "claudeAgent";
          if (instanceId === "pi") {
            return [
              instanceId,
              {
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
                ...(options.piHome === undefined
                  ? {}
                  : { environment: [{ name: "PI_CODING_AGENT_DIR", value: options.piHome }] }),
              },
            ];
          }
          const home = deepseek ? options.dshHome : claude ? options.claudeHome : options.codexHome;
          return [
            instanceId,
            {
              driver: ProviderDriverKind.make(
                deepseek ? "deepseekHarness" : claude ? "claudeAgent" : "codex",
              ),
              enabled: true,
              ...(home === undefined ? {} : { config: { homePath: home } }),
            },
          ];
        }),
      ),
    }),
    ProviderRegistryMock.layer(providers as ReadonlyArray<ServerProvider>),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: project,
          workspaceRoot: options.workspaceRoot ?? process.cwd(),
        } as never),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({ label: options.label ?? "This computer" } as never),
    }),
  );
};

const layerRuntime = (providers: ReadonlyArray<unknown>, options: WorldOptions = {}) =>
  Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink, ProjectStore.layer).pipe(
    Layer.provide(UsageCapEnforcement.guardLayer),
    Layer.provide(ThreadMoveGuard.layer),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused title link"),
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(layerShared(providers, options)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(layerCheckpoints),
    Layer.provide(layerConfig),
    Layer.provide(layerInstances(providers)),
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
    const projects = yield* ProjectService.ProjectService;
    return ThreadLaunchService.ThreadLaunchService.of({
      launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
        projects.getById(input.projectId).pipe(
          Effect.orDie,
          Effect.flatMap((found) =>
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
                worktreePath: Option.isSome(found) ? found.value.workspaceRoot : process.cwd(),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              })
              .pipe(Effect.as({ threadId: input.threadId } as never), Effect.orDie),
          ),
        ),
    } as never);
  }),
);

const layerAllocation = ProviderAllocation.layer.pipe(Layer.provideMerge(AllocationStore.layer));

/** Everything the integration tests drive, over one in-memory database. */
export const layerWorld = (
  providers: ReadonlyArray<unknown> = defaultProviders,
  options: WorldOptions = {},
) => {
  const peers = options.peers ?? Layer.empty;
  const allocation = layerAllocation.pipe(Layer.provide(peers));
  const workers = WorkerService.layer.pipe(Layer.provide(allocation), Layer.provide(peers));
  const both = Layer.merge(allocation, workers);
  return Layer.mergeAll(
    workers,
    allocation,
    AllocationAssignments.layer.pipe(Layer.provide(both)),
    UsageCapEnforcement.layer.pipe(Layer.provide(both)),
  ).pipe(
    Layer.provideMerge(layerLauncher),
    Layer.provideMerge(layerRuntime(providers, options)),
    Layer.provideMerge(peers),
  );
};

export const seed = Effect.fn("seed")(function* (
  masterId: ThreadId = master,
  workspaceRoot: string = process.cwd(),
) {
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
        workspaceRoot,
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
    worktreePath: workspaceRoot,
    createdBy: "user",
    creationSource: "web",
  });
});

/** Plays the provider: moves the newest run of a thread to a state, as the effect worker would. */
export const setLatestRun = Effect.fn("setLatestRun")(function* (
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

/** Plays a provider failure: the newest run ends failed, carrying the failure the provider reported. */
export const failLatestRun = Effect.fn("failLatestRun")(function* (
  threadId: ThreadId,
  failure: { readonly class: "usage_limit" | "provider_error"; readonly message: string },
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const run =
    projection.runs.find((candidate) => candidate.status === "running") ?? projection.runs.at(-1)!;
  const at = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`provider:${run.id}:error`),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerInstanceId: run.providerInstanceId,
        occurredAt: at,
        payload: {
          id: TurnItemId.make(`provider:${run.id}:error`),
          type: "error",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Provider failure",
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          failure: {
            class: failure.class,
            message: failure.message,
            code: failure.class,
            retryable: null,
            ...(failure.class === "usage_limit"
              ? { resetAt: DateTime.formatIso(DateTime.add(at, { hours: 1 })) }
              : {}),
          },
        },
      },
      {
        id: EventId.make(`provider:${run.id}:failed`),
        type: "run.updated",
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerInstanceId: run.providerInstanceId,
        occurredAt: at,
        payload: { ...run, status: "failed", startedAt: run.startedAt ?? at, completedAt: at },
      },
    ],
  });
});
