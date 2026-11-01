import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt, ThreadId, ProjectId } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ServerProvider } from "./server.ts";
import { Project } from "./project.ts";
import { SessionHistoryReadInput, SessionHistoryReadResult } from "./sessionHistory.ts";
import { SessionMoveInput, SessionMoveResult, SessionMoveStatusInput } from "./sessionMoves.ts";

export const SessionWorkflowListInput = Schema.Struct({
  location: Schema.optional(Schema.Literals(["active", "archive"])),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  titleContains: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const SessionWorkflowListResult = Schema.Struct({
  environmentId: EnvironmentId,
  threads: Schema.Array(Schema.toCodecJson(OrchestrationV2ThreadShell)),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const SessionWorkflowHistoryInput = Schema.Struct({
  threadId: ThreadId,
  ...SessionHistoryReadInput.fields,
});
export const SessionWorkflowHistoryResult = Schema.Struct({
  environmentId: EnvironmentId,
  history: SessionHistoryReadResult,
});
export const SessionWorkflowCatalogResult = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  providers: Schema.Array(ServerProvider),
});
export const SessionWorkflowProjectsResult = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
const target = { environmentId: EnvironmentId };
export const LinkedSessionQuery = Schema.Union([
  Schema.Struct({
    ...target,
    operation: Schema.Literal("list"),
    ...SessionWorkflowListInput.fields,
  }),
  Schema.Struct({
    ...target,
    operation: Schema.Literal("history"),
    ...SessionWorkflowHistoryInput.fields,
  }),
  Schema.Struct({ ...target, operation: Schema.Literal("catalog") }),
  Schema.Struct({
    ...target,
    operation: Schema.Literal("projects"),
    cursor: Schema.optional(NonNegativeInt),
    limit: SessionWorkflowListInput.fields.limit,
  }),
]);
export type LinkedSessionQuery = typeof LinkedSessionQuery.Type;
export const LinkedSessionQueryResult = Schema.Union([
  SessionWorkflowListResult,
  SessionWorkflowHistoryResult,
  SessionWorkflowCatalogResult,
  SessionWorkflowProjectsResult,
]);
export const LinkedSessionCommand = Schema.Union([
  Schema.Struct({
    ...target,
    operation: Schema.Literal("organize"),
    threadId: ThreadId,
    action: Schema.Literals(["settle", "unsettle", "pin", "unpin", "archive", "unarchive"]),
  }),
  Schema.Struct({ ...target, operation: Schema.Literal("move"), ...SessionMoveInput.fields }),
  Schema.Struct({
    ...target,
    operation: Schema.Literal("moveStatus"),
    ...SessionMoveStatusInput.fields,
  }),
]);
export type LinkedSessionCommand = typeof LinkedSessionCommand.Type;
export const LinkedSessionCommandResult = Schema.Union([
  Schema.Struct({ sequence: NonNegativeInt }),
  SessionMoveResult,
]);
export class LinkedSessionError extends Schema.TaggedError<LinkedSessionError>()(
  "LinkedSessionError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
