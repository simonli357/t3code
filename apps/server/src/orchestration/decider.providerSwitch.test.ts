import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
const threadId = ThreadId.make("switch-thread");
const at = "2026-01-01T00:00:00Z";
const command = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("switch"),
  threadId,
  message: {
    messageId: MessageId.make("next"),
    role: "user" as const,
    text: "next",
    attachments: [],
  },
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: at,
};
const projectId = ProjectId.make("project");
const readModelWithThread = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(at), {
    sequence: 1,
    eventId: EventId.make("event-project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: at,
    commandId: CommandId.make("command-project-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-project-created"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("event-thread-created"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: at,
    commandId: CommandId.make("command-thread-created"),
    causationEventId: null,
    correlationId: CommandId.make("command-thread-created"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Bootstrap thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
      updatedAt: at,
    },
  });
});

const state = (running: boolean) =>
  readModelWithThread.pipe(
    Effect.map((model) => ({
      ...model,
      threads: model.threads.map((thread) => ({
        ...thread,
        session: {
          threadId,
          status: running ? ("running" as const) : ("ready" as const),
          providerName: "codex" as const,
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access" as const,
          activeTurnId: running ? TurnId.make("active") : null,
          lastError: null,
          updatedAt: at,
        },
      })),
    })),
  );
it.layer(NodeServices.layer)("provider switch admission", (it) => {
  it.effect("rejects switching during active work before persisting a new message", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: yield* state(true),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
  it.effect("accepts a switch after the turn finishes", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({ command, readModel: yield* state(false) });
      expect(
        Array.isArray(result) &&
          result.some((event) => event.type === "thread.turn-start-requested"),
      ).toBe(true);
    }),
  );
});
