import {
  type CommandId,
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import { WorkerService, layer as workerServiceLayer } from "./WorkerService.ts";

/** A stand-in for the V2 orchestrator: threads and runs the worker service reads and writes through its seams. */
export const projectId = ProjectId.make("project:workers");
export const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
export const claude = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
} satisfies ModelSelection;

interface FakeThread {
  id: ThreadId;
  title: string;
  projectId: ProjectId;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: "default" | "plan";
  archivedAt: DateTime.Utc | null;
  stopRequested: boolean;
  lastError: string | null;
  runs: Array<OrchestrationV2Run>;
  requests: Array<{ id: string; kind: string; status: string }>;
}

const live = ["preparing", "queued", "starting", "running", "waiting"];

export class World {
  readonly threads = new Map<string, FakeThread>();
  readonly sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  readonly dispatched: Array<OrchestrationV2ServerCommand> = [];
  readonly launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  readonly stored: Array<OrchestrationV2StoredEvent> = [];
  readonly claimed = new Map<
    CommandId,
    { run: OrchestrationV2Run; delivery: "started" | "queued" | "steered" }
  >();
  sequence = 100;
  runCount = 0;
  windowMinutes = 15;
  disabledInstances: Array<string> = [];
  pubsub = Effect.runSync(PubSub.unbounded<OrchestrationV2StoredEvent["event"]>());

  addThread(id: ThreadId, partial: Partial<Omit<FakeThread, "id">> = {}) {
    this.threads.set(id, {
      id,
      title: id,
      projectId,
      modelSelection: codex,
      runtimeMode: "full-access",
      interactionMode: "default",
      archivedAt: null,
      stopRequested: false,
      lastError: null,
      runs: [],
      requests: [],
      ...partial,
    });
  }

  thread(id: string) {
    const found = this.threads.get(id);
    if (!found) throw new Error(`no fake thread ${id}`);
    return found;
  }

  activeRun(id: string) {
    return this.thread(id).runs.find((run) => live.includes(run.status) && run.status !== "queued");
  }

  /** Ends a run, as the provider finishing; the next queued run starts. */
  finishRun(
    threadId: string,
    runId: string,
    status: OrchestrationV2Run["status"],
    at: DateTime.Utc,
  ) {
    const thread = this.thread(threadId);
    thread.runs = thread.runs.map((run) =>
      run.id === runId ? { ...run, status, completedAt: at } : run,
    );
    if (status === "failed") thread.lastError = "provider failed";
    const next = thread.runs.find((run) => run.status === "queued");
    if (next && !this.activeRun(threadId))
      thread.runs = thread.runs.map((run) =>
        run.id === next.id ? { ...run, status: "running", startedAt: at } : run,
      );
  }

  addMessage(
    threadId: string,
    input: {
      id: string;
      role: "user" | "assistant";
      text: string;
      createdBy?: "user" | "agent" | "system";
      eventId?: string;
      streaming?: boolean;
    },
  ) {
    this.emit(
      threadId,
      "message.updated",
      {
        id: input.id,
        threadId,
        role: input.role,
        text: input.text,
        createdBy: input.createdBy ?? "agent",
        streaming: input.streaming ?? false,
      },
      input.eventId,
    );
  }

  emit(threadId: string, type: string, payload: unknown, eventId?: string) {
    this.sequence += 1;
    const event = {
      id: eventId ?? `event:${this.sequence}`,
      type,
      threadId,
      payload,
    } as unknown as OrchestrationV2StoredEvent["event"];
    this.stored.push({ sequence: this.sequence, event } as unknown as OrchestrationV2StoredEvent);
    Effect.runSync(PubSub.publish(this.pubsub, event));
  }

  shell(thread: FakeThread) {
    const active = this.activeRun(thread.id);
    const pending = thread.requests.find((request) => request.status === "pending");
    const latest = thread.runs.at(-1);
    return {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      providerInstanceId: thread.modelSelection.instanceId,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      archivedAt: thread.archivedAt,
      deletedAt: null,
      snoozedUntil: null,
      activeRunId: active?.id ?? null,
      latestRunId: latest?.id ?? null,
      latestRunStopRequested: thread.stopRequested,
      pendingRuntimeRequest: pending ? { id: pending.id, kind: pending.kind } : null,
      lastError: thread.lastError,
      latestVisibleMessage: null,
    };
  }
}

const makeThreads = (world: World) => {
  const fail = (message: string) => Effect.die(message);
  const send = (input: ThreadManagementService.ThreadManagementSendInput) =>
    Effect.gen(function* () {
      const replay = world.claimed.get(input.commandId);
      if (replay) return { ...replay, message: {}, projection: {}, turnItem: null, dispatch: {} };
      const thread = world.threads.get(input.threadId);
      if (!thread) return yield* fail(`no thread ${input.threadId}`);
      if (thread.archivedAt) return yield* fail("archived");
      world.sent.push(input);
      const at = yield* DateTime.now;
      const active = world.activeRun(thread.id);
      let outcome: { run: OrchestrationV2Run; delivery: "started" | "queued" | "steered" };
      if (input.mode === "auto" && active) {
        outcome = { run: active, delivery: "steered" };
      } else {
        const queued = active !== undefined || thread.runs.some((run) => run.status === "queued");
        world.runCount += 1;
        const run = {
          id: `run:${world.runCount}`,
          threadId: thread.id,
          ordinal: world.runCount,
          userMessageId: input.messageId,
          status: queued ? "queued" : "running",
          requestedAt: at,
          startedAt: queued ? null : at,
          completedAt: null,
        } as unknown as OrchestrationV2Run;
        thread.runs.push(run);
        outcome = { run, delivery: queued ? "queued" : "started" };
      }
      world.claimed.set(input.commandId, outcome);
      return { ...outcome, message: {}, projection: {}, turnItem: null, dispatch: {} };
    });

  return Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (id: ThreadId) =>
      Effect.succeed(world.threads.has(id) ? (world.shell(world.thread(id)) as never) : null),
    getThreadRecords: ((id: ThreadId, fields: ReadonlyArray<string>) => {
      const thread = world.threads.get(id);
      if (!thread) return fail(`no thread ${id}`);
      return Effect.succeed({
        thread: { id },
        runs: thread.runs,
        runtimeRequests: thread.requests,
        fields,
      } as never);
    }) as never,
    sendToThread: send as never,
    dispatch: ((command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        world.dispatched.push(command);
        if (command.type === "thread.fork") {
          const source = world.thread(command.sourceThreadId);
          world.addThread(command.targetThreadId, {
            title: command.title ?? source.title,
            modelSelection: source.modelSelection,
            runtimeMode: source.runtimeMode,
            interactionMode: source.interactionMode,
          });
        } else if (command.type === "thread.model-selection.set") {
          world.thread(command.threadId).modelSelection = command.modelSelection;
        } else if (command.type === "queued-run.cancel") {
          const thread = world.thread(command.threadId);
          thread.runs = thread.runs.map((run) =>
            run.id === command.runId ? { ...run, status: "cancelled" } : run,
          );
        }
        return { sequence: world.sequence } as never;
      })) as never,
    streamDomainEvents: Stream.fromPubSub(world.pubsub),
    getThreadEventSequence: ((id: ThreadId) =>
      Effect.sync(() =>
        world.stored.reduce(
          (latest, stored) => (stored.event.threadId === id ? stored.sequence : latest),
          0,
        ),
      )) as never,
    streamStoredEventsFrom: ((input?: {
      afterSequence?: number;
      threadId?: string;
      eventType?: string;
    }) =>
      Stream.fromIterable(
        world.stored.filter(
          (stored) =>
            stored.sequence > (input?.afterSequence ?? 0) &&
            (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
            (input?.eventType === undefined || stored.event.type === input.eventType),
        ),
      )) as never,
  });
};

const makeLauncher = (world: World) =>
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: ((input: ThreadLaunchService.ThreadLaunchInput) =>
      Effect.sync(() => {
        world.launched.push(input);
        world.addThread(input.threadId!, {
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
        });
        return { threadId: input.threadId } as never;
      })) as never,
  });

/** Everything the worker service needs, over the fake world and the caller's real SQLite database. */
export const layerFor = (world: World) =>
  workerServiceLayer.pipe(
    Layer.provide(makeThreads(world)),
    Layer.provide(makeLauncher(world)),
    Layer.provide(
      ProviderRegistryMock.layer([
        provider("codex", "gpt-5.4"),
        provider("claude", "sonnet"),
      ] as never),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.sync(
          () =>
            ({
              workerCommunicationWindowMinutes: world.windowMinutes,
              workerDisabledInstanceIds: world.disabledInstances,
            }) as never,
        ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (() => Effect.succeedSome({ id: projectId } as never)) as never,
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:local")),
      }),
    ),
  );

export function provider(instanceId: string, model: string) {
  return {
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

export { WorkerService };
