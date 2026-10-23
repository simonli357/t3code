import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Null environment means the server supplying this shell. */
export const ManagedSessionRef = Schema.Struct({
  environmentId: Schema.NullOr(Schema.String),
  threadId: ThreadId,
});
export type ManagedSessionRef = typeof ManagedSessionRef.Type;

/** Derived from custom_workers; roles are never stored separately. */
export const SessionOrganization = Schema.Struct({
  authorityEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.NullOr(ManagedSessionRef),
  workers: Schema.Array(ManagedSessionRef),
  revision: NonNegativeInt,
  assignmentState: Schema.NullOr(Schema.String),
  reportOutcome: Schema.NullOr(Schema.Literals(["done", "blocked"])),
  directInputAt: Schema.NullOr(Schema.String),
});
export type SessionOrganization = typeof SessionOrganization.Type;

export const SessionOwnershipInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  ownerThreadId: Schema.NullOr(ThreadId),
  expectedOwnerThreadId: Schema.NullOr(ThreadId),
  expectedRevision: NonNegativeInt,
});
export type SessionOwnershipInput = typeof SessionOwnershipInput.Type;
export const SessionOwnershipReadInput = Schema.Struct({ threadId: ThreadId });
export const SessionOwnershipResult = Schema.Struct({
  threadId: ThreadId,
  ownerThreadId: Schema.NullOr(ThreadId),
  previousOwnerThreadId: Schema.NullOr(ThreadId),
  revision: NonNegativeInt,
});
export type SessionOwnershipResult = typeof SessionOwnershipResult.Type;
export class SessionOwnershipError extends Schema.TaggedError<SessionOwnershipError>()(
  "SessionOwnershipError",
  { message: Schema.String },
) {}
