import { ModelSelection, RuntimeMode, ProviderInteractionMode } from "./orchestration.ts";
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
