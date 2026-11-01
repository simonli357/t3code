import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  BaseSessionCreateInput,
  CommandId,
  MessageId,
  OrchestrationV2Command,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectStore from "./ProjectStore.ts";

const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);

type Send = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
const encode = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2Command));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2Command));
// Read the old receipt format only; all new execution goes through V2 commands.
const LegacySubmission = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  threadId: ThreadId,
  initializeBase: Schema.optional(Schema.Boolean),
  sourceProposedPlan: Schema.optional(Schema.Unknown),
  message: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(Schema.Unknown),
    context: Schema.optional(Schema.Unknown),
  }),
});
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(LegacySubmission));
const encodeCreation = Schema.encodeSync(Schema.fromJsonString(BaseSessionCreateInput));
interface Receipt {
  input_json: string;
  thread_id: string;
  command_json: string | null;
  state: string;
  error: string | null;
}

/** Records the destination before dispatch. Every uncertain retry uses the same fork and send IDs. */
export const makeBaseSessions = Effect.fn("BaseSessions.make")(function* (
  orchestrator: Orchestrator.OrchestratorV2Shape,
  ensureTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error> = () => Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const lock = yield* Semaphore.make(1);
  const reject = (command: OrchestrationV2ServerCommand, cause: unknown) =>
    new Orchestrator.OrchestratorDispatchError({
      commandId: command.commandId,
      commandType: command.type,
      cause,
    });
  const readReceipt = Effect.fn("BaseSessions.readReceipt")(function* (input: Send) {
    const saved =
      (yield* sql<Receipt>`SELECT * FROM base_session_submissions WHERE request_id = ${input.commandId}`)[0];
    if (!saved || saved.input_json === encode(input)) return saved;
    const legacy = decodeLegacy(saved.input_json);
    if (Option.isNone(legacy)) return saved;
    const previous = legacy.value;
    if (
      stableStringify({
        threadId: previous.threadId,
        initializeBase: previous.initializeBase,
        messageId: previous.message.messageId,
        text: previous.message.text,
        attachments: previous.message.attachments,
        context: previous.message.context,
        sourcePlanRef: previous.sourceProposedPlan,
      }) !==
      stableStringify({
        threadId: input.threadId,
        initializeBase: input.initializeBase,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments,
        context: input.context,
        sourcePlanRef: input.sourcePlanRef,
      })
    )
      return yield* reject(
        input,
        "This Base submission ID belongs to another message. Retry the saved request.",
      );
    const destination = ThreadId.make(saved.thread_id);
    const prepared = saved.command_json ? decodeLegacy(saved.command_json) : Option.none();
    if (saved.state === "failed")
      return yield* reject(
        input,
        saved.error ??
          `The previous Base task failed in ${destination}. Inspect it before discarding the request.`,
      );
    if (Option.isNone(prepared))
      return yield* reject(
        input,
        `Native cloning has an uncertain outcome. Inspect retained destination ${destination} before discarding the saved request; no second fork was created.`,
      );
    const messageId = prepared.value.message.messageId;
    let state = saved.state;
    if (state !== "started") {
      yield* ensureTranscript(destination);
      const records = yield* orchestrator.getThreadRecords(destination, ["messages"], {
        messageIds: [messageId],
      });
      const message = records.messages.find((message) => message.id === messageId);
      if (message) {
        const runs = message.runId
          ? (yield* orchestrator.getThreadRecords(destination, ["runs"], {
              runIds: [message.runId],
            })).runs
          : [];
        if (runs.some((run) => run.status === "completed")) state = "started";
        else
          return yield* reject(
            input,
            `The previous task already exists in session ${destination}, but its provider acceptance is unconfirmed. Inspect that session before discarding the saved request; it was not sent again.`,
          );
      }
    }
    const target = state === "started" ? null : yield* orchestrator.getThreadShell(destination);
    if (state !== "started" && !target)
      return yield* reject(
        input,
        `The retained destination ${destination} is unavailable. Nothing was sent.`,
      );
    const command: Send = {
      ...input,
      threadId: destination,
      messageId,
      commandId: CommandId.make(`base-send:${input.commandId}`),
      initializeBase: undefined,
      modelSelection: target?.modelSelection ?? input.modelSelection,
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: undefined,
    };
    const converted = { ...saved, input_json: encode(input), command_json: encode(command), state };
    yield* sql`UPDATE base_session_submissions SET input_json = ${converted.input_json}, command_json = ${converted.command_json}, state = ${state} WHERE request_id = ${input.commandId}`;
    return converted;
  });
  const prepare = Effect.fn("BaseSessions.prepare")(function* (input: Send) {
    const inputJson = encode(input);
    const saved = yield* readReceipt(input);
    if (saved && saved.input_json !== inputJson)
      return yield* reject(
        input,
        "This Base submission ID belongs to another message. Retry the saved request.",
      );
    if (saved?.state === "failed")
      return yield* reject(
        input,
        saved.error ??
          "The saved Base submission failed. Inspect its destination before discarding it.",
      );
    if (saved?.command_json) {
      const command = decode(saved.command_json);
      if (command.type !== "message.dispatch")
        return yield* reject(input, "The saved Base submission is not a V2 message.");
      return { command, tracked: true, started: saved.state === "started" };
    }
    const records = yield* orchestrator.getThreadRecords(input.threadId, []);
    if (!saved && !records?.thread.isBase) {
      if (input.initializeBase)
        return yield* reject(input, "Only a designated Base can be initialized.");
      return { command: input, tracked: false, started: false };
    }
    const source = yield* orchestrator.getThreadShell(input.threadId);
    if (!source) return yield* reject(input, "The original Base is unavailable. Nothing was sent.");
    if (
      source.activeRunId !== null ||
      ["preparing", "queued", "starting", "running", "waiting"].includes(source.status) ||
      source.pendingRuntimeRequest ||
      source.pendingBackgroundTasks?.length
    )
      return yield* reject(
        input,
        "The Base is busy. Wait for its work to finish before sending a task or refreshing it.",
      );
    if (
      input.guestMessageId ||
      input.idleCompaction ||
      input.delegatedCompletion ||
      input.notification ||
      input.restartContinuationOfRunId ||
      input.manualContinuationOfRunId ||
      input.usageLimitContinuationOfRunId
    )
      return yield* reject(
        input,
        "This operation cannot mutate a prepared Base. Refresh it explicitly or send a new task.",
      );
    const destination = saved?.thread_id
      ? ThreadId.make(saved.thread_id)
      : input.initializeBase
        ? input.threadId
        : ThreadId.make(yield* crypto.randomUUIDv4());
    if (!saved)
      yield* sql`INSERT INTO base_session_submissions (request_id,input_json,source_id,thread_id) VALUES (${input.commandId},${inputJson},${input.threadId},${destination})`;
    if (!input.initializeBase) {
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`base-fork:${input.commandId}`),
        sourceThreadId: input.threadId,
        targetThreadId: destination,
        sourcePoint: { type: "latest_stable" },
        nativeOnly: true,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
    }
    const target = input.initializeBase ? source : yield* orchestrator.getThreadShell(destination);
    if (!target)
      return yield* reject(input, "The prepared fork is unavailable. Retry the saved request.");
    const command: Send = {
      ...input,
      threadId: destination,
      commandId: CommandId.make(`base-send:${input.commandId}`),
      initializeBase: undefined,
      modelSelection: target.modelSelection,
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: undefined,
    };
    yield* sql`UPDATE base_session_submissions SET command_json = ${encode(command)}, state = 'prepared' WHERE request_id = ${input.commandId}`;
    return { command, tracked: true, started: false };
  }, lock.withPermit);
  const dispatch = Effect.fn("BaseSessions.dispatch")(
    function* (input: OrchestrationV2ServerCommand) {
      if (input.type !== "message.dispatch") return yield* orchestrator.dispatch(input);
      const { command, tracked, started } = yield* prepare(input);
      if (started)
        return {
          sequence: yield* orchestrator.getThreadEventSequence(command.threadId),
          storedEvents: [],
          threadId: command.threadId,
        };
      const result = yield* orchestrator.dispatch(command);
      if (!tracked) return result;
      // A run becomes running before the provider accepts its input. The start effect
      // settles after that boundary (including any synchronous provider failure).
      const starts = (yield* outbox.listByCommandId(command.commandId)).filter(
        (effect) => effect.request.type === "provider-turn.start",
      );
      if (starts.length === 0)
        return yield* reject(
          input,
          `Provider acceptance is not yet confirmed for ${command.threadId}. Retry the saved request.`,
        );
      for (const start of starts) {
        yield* outbox.awaitSettled(start.id).pipe(
          Effect.timeoutOrElse({
            duration: "45 seconds",
            orElse: () =>
              Effect.fail(
                reject(
                  input,
                  `Provider acceptance is still pending for ${command.threadId}. Retry the saved request.`,
                ),
              ),
          }),
        );
        const settled = yield* outbox.get(start.id);
        if (Option.isNone(settled))
          return yield* reject(
            input,
            `The provider receipt is unavailable. Inspect session ${command.threadId} before discarding the request.`,
          );
        if (start.request.type !== "provider-turn.start") continue;
        const runId = start.request.runId;
        const records = yield* orchestrator.getThreadRecords(command.threadId, ["runs"], {
          runIds: [runId],
        });
        const run = records.runs.find((run) => run.id === runId);
        if (
          settled.value.status !== "succeeded" ||
          !run ||
          ["failed", "cancelled"].includes(run.status)
        ) {
          const error =
            settled.value.lastError ??
            `The provider did not accept the Base submission. Inspect session ${command.threadId} before discarding the request.`;
          yield* sql`UPDATE base_session_submissions SET state = 'failed', error = ${error} WHERE request_id = ${input.commandId}`;
          return yield* reject(input, error);
        }
      }
      yield* sql`UPDATE base_session_submissions SET state = 'started' WHERE request_id = ${input.commandId}`;
      return { ...result, threadId: command.threadId };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) => (isOrchestratorError(cause) ? cause : reject(input, cause))),
      ),
  );
  // Admission follows the saved send identity and fixed destination profile on retry.
  // Confirmed requests are read-only recovery even if the account was disabled later.
  const policyCommand = Effect.fn("BaseSessions.policyCommand")(
    function* (input: Send) {
      const saved = yield* readReceipt(input);
      if (!saved) return input;
      if (saved.input_json !== encode(input))
        return yield* reject(
          input,
          "This Base submission ID belongs to another message. Retry the saved request.",
        );
      if (saved.state === "started") return null;
      if (!saved.command_json) return input;
      const command = decode(saved.command_json);
      return command.type === "message.dispatch" ? command : input;
    },
    (effect, input) =>
      effect.pipe(
        lock.withPermit,
        Effect.mapError((cause) => (isOrchestratorError(cause) ? cause : reject(input, cause))),
      ),
  );
  const create = Effect.fn("BaseSessions.create")(function* (input: BaseSessionCreateInput) {
    const id = (step: string) => CommandId.make(`base-create:${input.clientRequestId}:${step}`);
    const creationCommand = {
      type: "thread.create" as const,
      commandId: id("create"),
      threadId: input.threadId,
      projectId: input.projectId,
      title: `${input.modelSelection.instanceId} Base`,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt: DateTime.makeUnsafe(input.createdAt),
      createdBy: "user" as const,
      creationSource: "web" as const,
    };
    const prompt = yield* lock.withPermit(
      Effect.gen(function* () {
        const prior = (yield* sql<{
          input_json: string;
          prompt: string;
        }>`SELECT * FROM base_session_creations WHERE request_id = ${input.clientRequestId}`)[0];
        if (prior) {
          if (prior.input_json !== encodeCreation(input))
            return yield* reject(
              creationCommand,
              "This Base creation ID belongs to another request.",
            );
          return prior.prompt;
        }
        if (Option.isNone(projects))
          return yield* reject(creationCommand, "Project service unavailable.");
        const project = yield* projects.value.get(input.projectId);
        if (Option.isNone(project)) return yield* reject(creationCommand, "Project unavailable.");
        const prompt = project.value.basePrompt ?? "Understand project";
        yield* sql`INSERT INTO base_session_creations (request_id,input_json,prompt) VALUES (${input.clientRequestId},${encodeCreation(input)},${prompt})`;
        return prompt;
      }),
    );
    yield* orchestrator.dispatch(creationCommand);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: id("designate"),
      threadId: input.threadId,
      isBase: true,
    });
    return yield* dispatch({
      type: "message.dispatch",
      commandId: id("initialize"),
      threadId: input.threadId,
      messageId: MessageId.make(`base-initialize:${input.clientRequestId}`),
      text: prompt,
      attachments: [],
      initializeBase: true,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });
  return { dispatch, create, policyCommand };
});
