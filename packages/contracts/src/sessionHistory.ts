import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, NonNegativeInt, TurnId } from "./baseSchemas.ts";

export const SESSION_HISTORY_DEFAULT_MESSAGES = 3;
export const SESSION_HISTORY_MAX_MESSAGES = 15;
export const SESSION_HISTORY_DEFAULT_CHARS = 16_000;
export const SESSION_HISTORY_MAX_CHARS = 64_000;
export const SESSION_HISTORY_MIN_CHARS = 1_024;

export const SessionHistoryMessageLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: SESSION_HISTORY_MAX_MESSAGES }),
);
export const SessionHistoryCharLimit = Schema.Int.check(
  Schema.isBetween({ minimum: SESSION_HISTORY_MIN_CHARS, maximum: SESSION_HISTORY_MAX_CHARS }),
);
export const SessionHistoryReadInput = Schema.Struct({
  messageLimit: Schema.optional(SessionHistoryMessageLimit),
  maxChars: Schema.optional(SessionHistoryCharLimit),
  view: Schema.optional(Schema.Literals(["final", "all"])),
  beforeMessageId: Schema.optional(MessageId),
  messageId: Schema.optional(MessageId),
  offset: Schema.optional(NonNegativeInt),
});
export type SessionHistoryReadInput = typeof SessionHistoryReadInput.Type;

export const SessionHistoryMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  kind: Schema.Literals(["prompt", "final", "inferred-final", "intermediate"]),
  turnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  streaming: Schema.Boolean,
  text: Schema.String,
  totalChars: NonNegativeInt,
  offset: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export const SessionHistoryReadResult = Schema.Struct({
  messages: Schema.Array(SessionHistoryMessage),
  view: Schema.Literals(["final", "all"]),
  messageLimit: SessionHistoryMessageLimit,
  page: Schema.Struct({ beforeMessageId: Schema.NullOr(MessageId), hasMore: Schema.Boolean }),
});
export type SessionHistoryReadResult = typeof SessionHistoryReadResult.Type;

export class SessionHistoryReadError extends Schema.TaggedError<SessionHistoryReadError>()(
  "SessionHistoryReadError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}
