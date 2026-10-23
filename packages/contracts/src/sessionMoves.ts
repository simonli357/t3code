import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const SessionMoveInput = Schema.Struct({
  requestId: CommandId,
  threadId: ThreadId,
  environment: TrimmedNonEmptyString,
  projectId: ProjectId,
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type SessionMoveInput = typeof SessionMoveInput.Type;

export const SessionMoveStatusInput = Schema.Struct({
  requestId: Schema.optional(CommandId),
  threadId: Schema.optional(ThreadId),
  cancel: Schema.optional(Schema.Boolean),
});
export type SessionMoveStatusInput = typeof SessionMoveStatusInput.Type;

export const SessionMoveState = Schema.Literals([
  "queued",
  "copying",
  "prepared",
  "committing",
  "complete",
  "cancelling",
  "cancelled",
  "error",
]);
export const SessionMoveResult = Schema.Struct({
  requestId: CommandId,
  threadId: ThreadId,
  targetThreadId: ThreadId,
  sourceEnvironmentId: EnvironmentId,
  targetEnvironmentId: EnvironmentId,
  projectId: ProjectId,
  state: SessionMoveState,
  error: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type SessionMoveResult = typeof SessionMoveResult.Type;

export class SessionMoveError extends Schema.TaggedError<SessionMoveError>()("SessionMoveError", {
  message: Schema.String,
}) {}
