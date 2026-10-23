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
  workers: Schema.Array(
    Schema.Struct({ ...ManagedSessionRef.fields, revision: Schema.optional(NonNegativeInt) }),
  ),
  revision: NonNegativeInt,
  assignmentState: Schema.NullOr(Schema.String),
  reportOutcome: Schema.NullOr(Schema.Literals(["done", "blocked"])),
  directInputAt: Schema.NullOr(Schema.String),
});
export type SessionOrganization = typeof SessionOrganization.Type;

export const SessionOwnershipInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  /** Execution or known authority environment; defaults to the receiving server. */
  threadEnvironmentId: Schema.optional(Schema.String),
  threadId: ThreadId,
  ownerThreadId: Schema.NullOr(ThreadId),
  ownerEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  expectedOwnerThreadId: Schema.NullOr(ThreadId),
  expectedOwnerEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  expectedRevision: NonNegativeInt,
});
export type SessionOwnershipInput = typeof SessionOwnershipInput.Type;
export const SessionOwnershipReadInput = Schema.Struct({
  threadId: ThreadId,
  threadEnvironmentId: Schema.optional(Schema.String),
});
export const SessionOwnershipResult = Schema.Struct({
  threadId: ThreadId,
  ownerThreadId: Schema.NullOr(ThreadId),
  ownerEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  previousOwnerThreadId: Schema.NullOr(ThreadId),
  previousOwnerEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  authorityEnvironmentId: Schema.optional(Schema.String),
  revision: NonNegativeInt,
});
export type SessionOwnershipResult = typeof SessionOwnershipResult.Type;
export class SessionOwnershipError extends Schema.TaggedError<SessionOwnershipError>()(
  "SessionOwnershipError",
  { message: Schema.String, code: Schema.optional(Schema.String) },
) {}
