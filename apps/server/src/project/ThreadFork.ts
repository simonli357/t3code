import {
  AgentSessionForkError,
  type AgentSessionForkInput,
  CommandId,
  MessageId,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

const ForkHistory = Schema.Struct({
  sourceThreadId: ThreadId,
  projectId: OrchestrationThread.fields.projectId,
  title: Schema.String,
  modelSelection: OrchestrationThread.fields.modelSelection,
  runtimeMode: OrchestrationThread.fields.runtimeMode,
  interactionMode: OrchestrationThread.fields.interactionMode,
  branch: OrchestrationThread.fields.branch,
  worktreePath: OrchestrationThread.fields.worktreePath,
  messages: OrchestrationThread.fields.messages,
});
const readPendingFork = Schema.decodeUnknownOption(Schema.Struct({ forkHistory: ForkHistory }));
const encodeMessages = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationThread.fields.messages),
);
const isForkError = Schema.is(AgentSessionForkError);
const forkLock = Semaphore.makeUnsafe(1);

function isBusy(thread: OrchestrationThread) {
  return (
    thread.session?.activeTurnId != null ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.messages.some((message) => message.streaming)
  );
}

/** Native history is copied first; T3's normal events publish the independent thread. */
export const forkThread = Effect.fn("forkThread")(
  function* (input: AgentSessionForkInput) {
    const snapshots = yield* ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const provider = yield* ProviderService;
    const engine = yield* OrchestrationEngineService;
    if (input.threadId === input.sourceThreadId) {
      return yield* new AgentSessionForkError({ message: "The fork must have a new thread id." });
    }
    const sourceOption = yield* snapshots.getThreadDetailById(input.sourceThreadId);
    if (Option.isNone(sourceOption) || sourceOption.value.deletedAt !== null) {
      return yield* new AgentSessionForkError({
        message: "The source conversation no longer exists.",
      });
    }
    const source = sourceOption.value;
    const destination = yield* snapshots.getThreadDetailById(input.threadId);
    const binding = yield* directory.getBinding(input.threadId);
    const pending = Option.isSome(binding)
      ? readPendingFork(binding.value.runtimePayload)
      : Option.none();
    if (Option.isSome(destination)) {
      if (
        Option.isNone(pending) ||
        pending.value.forkHistory.sourceThreadId !== input.sourceThreadId
      ) {
        return yield* new AgentSessionForkError({
          message: "That destination thread already exists.",
        });
      }
      if (destination.value.messages.length > 0) {
        yield* engine.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make(`fork:${input.threadId}:unsettle`),
          threadId: input.threadId,
          reason: "user",
        });
        return { threadId: input.threadId };
      }
    }
    let history: typeof ForkHistory.Type;
    if (Option.isSome(pending)) {
      if (pending.value.forkHistory.sourceThreadId !== input.sourceThreadId) {
        return yield* new AgentSessionForkError({
          message: "That destination belongs to another fork.",
        });
      }
      history = pending.value.forkHistory;
    } else {
      if (Option.isSome(binding))
        return yield* new AgentSessionForkError({
          message: "That destination already has a session.",
        });
      if (isBusy(source))
        return yield* new AgentSessionForkError({
          message: "Wait for the current turn to finish before forking.",
        });
      if (
        !source.messages.some((message) => message.role === "user" || message.role === "assistant")
      ) {
        return yield* new AgentSessionForkError({
          message: "Send a message before forking this conversation.",
        });
      }
      const sourceBinding = yield* directory.getBinding(input.sourceThreadId);
      if (Option.isNone(sourceBinding) || !sourceBinding.value.providerInstanceId) {
        return yield* new AgentSessionForkError({
          message: "This conversation has no resumable provider session.",
        });
      }
      const native = sourceBinding.value;
      if (native.provider !== "codex" && native.provider !== "claudeAgent") {
        return yield* new AgentSessionForkError({
          message: "Conversation forks are supported for Codex and Claude.",
        });
      }
      history = {
        sourceThreadId: input.sourceThreadId,
        projectId: source.projectId,
        title: `${source.title} (fork)`,
        modelSelection: { ...source.modelSelection, instanceId: native.providerInstanceId! },
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch: source.branch,
        worktreePath: source.worktreePath,
        messages: source.messages,
      };
      const resumeCursor = yield* provider.forkConversation(input.sourceThreadId);
      const current = yield* snapshots.getThreadDetailById(input.sourceThreadId);
      if (
        Option.isNone(current) ||
        isBusy(current.value) ||
        encodeMessages(current.value.messages) !== encodeMessages(source.messages)
      ) {
        return yield* new AgentSessionForkError({
          message:
            "The source conversation changed while forking. Wait for it to finish and try again.",
        });
      }
      const project = yield* snapshots.getProjectShellById(source.projectId);
      if (Option.isNone(project))
        return yield* new AgentSessionForkError({ message: "The project no longer exists." });
      // Persist the native cursor and visible history together before publishing.
      // Retries after a disconnect/crash reuse the native fork, never the original.
      yield* directory.upsert(
        {
          threadId: input.threadId,
          provider: native.provider,
          providerInstanceId: native.providerInstanceId!,
          runtimeMode: source.runtimeMode,
          status: "stopped",
          resumeCursor,
          runtimePayload: {
            cwd: source.worktreePath ?? project.value.workspaceRoot,
            forkHistory: history,
          },
        },
        { onConflict: "ignore" },
      );
    }
    if (Option.isNone(destination)) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`fork:${input.threadId}:create`),
        threadId: input.threadId,
        projectId: history.projectId,
        title: history.title,
        modelSelection: history.modelSelection,
        runtimeMode: history.runtimeMode,
        interactionMode: history.interactionMode,
        branch: history.branch,
        worktreePath: history.worktreePath,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        historyImport: true,
      });
    }
    yield* engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make(`fork:${input.threadId}:history`),
      threadId: input.threadId,
      messages: history.messages.flatMap((message, index) =>
        message.role === "user" || message.role === "assistant"
          ? [
              {
                messageId: MessageId.make(`fork:${input.threadId}:${index}`),
                role: message.role,
                text: message.text,
                createdAt: message.createdAt,
                ...(message.attachments ? { attachments: message.attachments } : {}),
              },
            ]
          : [],
      ),
    });
    yield* engine.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make(`fork:${input.threadId}:unsettle`),
      threadId: input.threadId,
      reason: "user",
    });
    return { threadId: input.threadId };
  },
  forkLock.withPermit,
  Effect.mapError((cause) =>
    isForkError(cause)
      ? cause
      : new AgentSessionForkError({
          message: cause instanceof Error ? cause.message : "Could not fork this conversation.",
        }),
  ),
);
