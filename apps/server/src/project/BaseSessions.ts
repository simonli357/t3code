import { readWorkflowBases } from "./WorkflowBases.ts";
import {
  BaseSessionCreateInput,
  type BaseSessionConfiguration,
  type ProjectId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import {
  AgentSessionForkError,
  CommandId,
  MessageId,
  ThreadId,
  ThreadTurnStartCommand,
  ClientThreadTurnStartCommand,
  type DispatchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { forkThread } from "./ThreadFork.ts";
import { BeforeNativeFork } from "../provider/NativeFork.ts";

type Start = typeof ThreadTurnStartCommand.Type;
type Input = typeof ClientThreadTurnStartCommand.Type;
type Receipt = {
  input_json: string;
  thread_id: string;
  command_json: string | null;
  state: string;
  error: string | null;
};
const lock = Semaphore.makeUnsafe(1);
const encodeCreation = Schema.encodeSync(Schema.fromJsonString(BaseSessionCreateInput));
const encodeInput = Schema.encodeSync(Schema.fromJsonString(ClientThreadTurnStartCommand));
const encode = Schema.encodeSync(Schema.fromJsonString(ThreadTurnStartCommand));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadTurnStartCommand));

export class BaseSessions extends Context.Service<
  BaseSessions,
  {
    readonly shouldRoute: (input: Input) => Effect.Effect<boolean, AgentSessionForkError>;
    readonly create: (
      input: BaseSessionCreateInput,
    ) => Effect.Effect<DispatchResult, AgentSessionForkError>;
    readonly configuration: (
      projectId: ProjectId,
    ) => Effect.Effect<BaseSessionConfiguration, AgentSessionForkError>;
    readonly submit: (command: Input) => Effect.Effect<DispatchResult, AgentSessionForkError>;
  }
>()("t3/project/BaseSessions") {}

const make = Effect.gen(function* () {
  const workflowContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof readWorkflowBases>>>();
  const services =
    yield* Effect.context<Effect.Services<ReturnType<typeof normalizeDispatchCommand>>>();
  const normalize = (input: Input) =>
    normalizeDispatchCommand(input).pipe(
      Effect.provide(services),
      Effect.flatMap((command) =>
        command.type === "thread.turn.start"
          ? Effect.succeed(command)
          : Effect.fail(new AgentSessionForkError({ message: "Expected a turn submission." })),
      ),
    );
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const directory = yield* ProviderSessionDirectory;
  const provider = yield* ProviderService;
  const prepare = Effect.fn(function* (input: Input) {
    const encoded = encodeInput(input);
    const rows =
      yield* sql<Receipt>`SELECT * FROM base_session_submissions WHERE request_id = ${input.commandId}`;
    const prior = rows[0];
    if (prior && prior.input_json !== encoded)
      return yield* new AgentSessionForkError({
        message: "This Base submission ID belongs to another message. Retry the original request.",
      });
    if (prior?.state === "failed")
      return yield* new AgentSessionForkError({
        message: prior.error ?? "Base submission failed.",
      });
    if (prior?.command_json)
      return {
        command: decode(prior.command_json),
        tracked: true,
        complete: prior.state === "started",
      };
    const source = yield* snapshots.getThreadDetailById(input.threadId);
    if (!prior && (Option.isNone(source) || !source.value.isBase))
      return { command: yield* normalize(input), tracked: false, complete: false };
    if (Option.isNone(source))
      return yield* new AgentSessionForkError({
        message: "The original Base is unavailable. Your task was not sent.",
      });
    if (input.bootstrap)
      return yield* new AgentSessionForkError({
        message:
          "A Base submission must preserve its project and native context; worktree bootstrap is not supported.",
      });
    const hash = NodeCrypto.createHash("sha256")
      .update(`base:${input.threadId}:${input.commandId}`)
      .digest("hex");
    const destination = input.initializeBase
      ? input.threadId
      : ThreadId.make(
          `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        );
    if (!prior)
      yield* sql`INSERT INTO base_session_submissions (request_id, input_json, source_id, thread_id) VALUES (${input.commandId}, ${encoded}, ${input.threadId}, ${destination})`;
    if (!input.initializeBase) {
      // A process may die after native cloning but before its cursor is durable.
      // Never blindly clone again across that uncertain boundary.
      if (prior?.state === "cloning" && Option.isNone(yield* directory.getBinding(destination)))
        return yield* new AgentSessionForkError({
          message: `Native cloning has an uncertain outcome. The Base is unchanged. Inspect retained destination ${destination} before retrying.`,
        });
      yield* forkThread({ sourceThreadId: input.threadId, threadId: destination }).pipe(
        Effect.provideService(
          BeforeNativeFork,
          sql`UPDATE base_session_submissions SET state = 'cloning' WHERE request_id = ${input.commandId}`.pipe(
            Effect.asVoid,
            Effect.mapError(
              () => "Could not persist the native clone receipt. Nothing was cloned.",
            ),
          ),
        ),
        Effect.provideService(ProjectionSnapshotQuery, snapshots),
        Effect.provideService(OrchestrationEngineService, engine),
        Effect.provideService(ProviderSessionDirectory, directory),
        Effect.provideService(ProviderService, provider),
      );
    }
    const target = Option.getOrThrow(yield* snapshots.getThreadDetailById(destination));
    const command: Start = yield* normalize({
      ...input,
      threadId: destination,
      commandId: CommandId.make(`base-send:${input.commandId}`),
      message: { ...input.message, messageId: MessageId.make(`base-send:${input.commandId}`) },
      modelSelection: target.modelSelection,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
    });
    yield* sql`UPDATE base_session_submissions SET command_json = ${encode(command)}, state = 'prepared' WHERE request_id = ${input.commandId}`;
    return { command, tracked: true, complete: false };
  }, lock.withPermit);

  const submit = Effect.fn(
    function* (input: Input) {
      const { command, complete, tracked } = yield* prepare(input);
      if (!tracked) return yield* engine.dispatch(command);
      if (complete) return { sequence: yield* engine.latestSequence, threadId: command.threadId };
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const events = yield* engine.subscribeDomainEvents;
          const result = yield* engine.dispatch(command);
          const check = Effect.gen(function* () {
            const thread = yield* snapshots.getThreadDetailById(command.threadId);
            if (Option.isNone(thread)) return false;
            const failure = thread.value.activities.find(
              (a) =>
                a.kind === "provider.turn.start.failed" &&
                typeof a.payload === "object" &&
                a.payload !== null &&
                "requestId" in a.payload &&
                a.payload.requestId === command.message.messageId,
            );
            if (failure) {
              const error =
                typeof failure.payload === "object" &&
                failure.payload !== null &&
                "detail" in failure.payload &&
                typeof failure.payload.detail === "string"
                  ? failure.payload.detail
                  : failure.summary;
              const message = `${error} Retained session: ${command.threadId}.${input.initializeBase ? " The initialization request is retained." : " Your Base is unchanged."}`;
              yield* sql`UPDATE base_session_submissions SET state = 'failed', error = ${message} WHERE request_id = ${input.commandId}`;
              return yield* new AgentSessionForkError({ message });
            }
            // Claude can emit turn.started before preparing/rejecting an image.
            // Only the reactor's post-send receipt confirms accepted delivery.
            return thread.value.activities.some(
              (a) =>
                a.kind === "provider.turn.start.accepted" &&
                typeof a.payload === "object" &&
                a.payload !== null &&
                "requestId" in a.payload &&
                a.payload.requestId === command.message.messageId,
            );
          });
          if (!(yield* check)) {
            const ready = yield* events.pipe(
              Stream.filter((event) => event.aggregateId === command.threadId),
              Stream.mapEffect(() => check),
              Stream.filter(Boolean),
              Stream.runHead,
              Effect.timeoutOrElse({
                duration: "45 seconds",
                orElse: () =>
                  Effect.fail(
                    new AgentSessionForkError({
                      message: `Startup is still unconfirmed for ${command.threadId}. Retry this same submission to check it; your draft is retained.`,
                    }),
                  ),
              }),
            );
            if (Option.isNone(ready))
              return yield* new AgentSessionForkError({
                message: `Startup was not confirmed for ${command.threadId}. Retry the saved request.`,
              });
          }
          yield* sql`UPDATE base_session_submissions SET state = 'started' WHERE request_id = ${input.commandId}`;
          return { ...result, threadId: command.threadId };
        }),
      );
    },
    Effect.mapError((cause) =>
      Schema.is(AgentSessionForkError)(cause)
        ? cause
        : new AgentSessionForkError({
            message: cause instanceof Error ? cause.message : "Base submission failed.",
          }),
    ),
  );
  const create = Effect.fn(
    function* (input: BaseSessionCreateInput) {
      const creation = yield* lock.withPermit(
        Effect.gen(function* () {
          const rows = yield* sql<{
            input_json: string;
            prompt: string;
          }>`SELECT * FROM base_session_creations WHERE request_id = ${input.clientRequestId}`;
          const saved = rows[0];
          if (saved) {
            if (saved.input_json !== encodeCreation(input))
              return yield* new AgentSessionForkError({
                message: "This Base creation ID belongs to a different request.",
              });
            return saved;
          }
          const project = yield* snapshots.getProjectShellById(input.projectId);
          if (Option.isNone(project))
            return yield* new AgentSessionForkError({ message: "Project unavailable." });
          const prompt = project.value.basePrompt ?? "Understand project";
          const input_json = encodeCreation(input);
          yield* sql`INSERT INTO base_session_creations (request_id, input_json, prompt) VALUES (${input.clientRequestId}, ${input_json}, ${prompt})`;
          return { input_json, prompt };
        }),
      );
      const project = yield* snapshots.getProjectShellById(input.projectId);
      if (Option.isNone(project))
        return yield* new AgentSessionForkError({ message: "Project unavailable." });
      const commandId = (step: string) =>
        CommandId.make(`base-create:${input.clientRequestId}:${step}`);
      yield* engine.dispatch({
        type: "thread.create",
        commandId: commandId("create"),
        threadId: input.threadId,
        projectId: input.projectId,
        title: `${input.modelSelection.instanceId} Base`,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      });
      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: commandId("designate"),
        threadId: input.threadId,
        isBase: true,
      });
      return yield* submit({
        type: "thread.turn.start",
        commandId: commandId("initialize"),
        threadId: input.threadId,
        initializeBase: true,
        message: {
          messageId: MessageId.make(`base-initialize:${input.clientRequestId}`),
          role: "user",
          text: creation.prompt,
          attachments: [],
        },
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      });
    },
    Effect.mapError((cause) =>
      Schema.is(AgentSessionForkError)(cause)
        ? cause
        : new AgentSessionForkError({
            message: cause instanceof Error ? cause.message : "Could not create Base.",
          }),
    ),
  );
  const shouldRoute = Effect.fn(
    function* (input: Input) {
      const prior =
        yield* sql`SELECT 1 FROM base_session_submissions WHERE request_id = ${input.commandId}`;
      if (prior.length) return true;
      const source = yield* snapshots.getThreadShellById(input.threadId);
      return Option.isSome(source) && source.value.isBase === true;
    },
    Effect.mapError(
      () =>
        new AgentSessionForkError({
          message: "Could not check Base submission state. Nothing was sent.",
        }),
    ),
  );
  return BaseSessions.of({
    shouldRoute,
    submit,
    create,
    configuration: (projectId) =>
      readWorkflowBases(projectId).pipe(Effect.provide(workflowContext)),
  });
});
export const layer = Layer.effect(BaseSessions, make);
