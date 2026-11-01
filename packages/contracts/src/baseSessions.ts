import { CommandId, MessageId, PlanId } from "./baseSchemas.ts";
import { ChatAttachment, UploadChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BaseSessionConfigurationInput = Schema.Struct({ projectId: ProjectId });
export const BaseSessionConfiguration = Schema.Struct({
  configuredPrompt: Schema.NullOr(Schema.String),
  candidates: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, instanceId: ProviderInstanceId }),
  ),
  warning: Schema.NullOr(Schema.String),
});
export type BaseSessionConfiguration = typeof BaseSessionConfiguration.Type;

export const BaseSessionCreateInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  clientRequestId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type BaseSessionCreateInput = typeof BaseSessionCreateInput.Type;

export class BaseSessionError extends Schema.TaggedError<BaseSessionError>()("BaseSessionError", {
  message: Schema.String,
}) {}

/** Persisted by clients before submitting a Base task, including uncertain sends. */
export const BaseSessionSendInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  initializeBase: Schema.optionalKey(Schema.Boolean),
  titleSeed: Schema.optionalKey(Schema.String),
  dispatchMode: Schema.optionalKey(Schema.Literals(["auto", "queue", "steer", "restart", "start"])),
  sourceProposedPlan: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, planId: PlanId })),
  creationSource: Schema.optionalKey(
    Schema.Literals(["web", "mobile", "mcp", "provider", "server"]),
  ),
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([ChatAttachment, UploadChatAttachment])),
    context: Schema.optionalKey(OrchestrationMessageContext),
  }),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
