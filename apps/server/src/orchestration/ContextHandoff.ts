import type { OrchestrationMessage, ThreadId } from "@t3tools/contracts";
import {
  MessageId,
  TurnId,
  SESSION_HISTORY_DEFAULT_MESSAGES,
  SESSION_HISTORY_DEFAULT_CHARS,
  SessionHistoryReadError,
  SessionHistoryReadInput,
  SessionHistoryReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const decodeRecentInput = Schema.decodeEffect(SessionHistoryReadInput);
const isRecentHistoryError = Schema.is(SessionHistoryReadError);

const historyMessages = (messages: ReadonlyArray<OrchestrationMessage>) =>
  messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.text.length > 0);

// Backported from V2's portable handoff strategy: intact initial request and
// newest messages, bounded by UTF-8 bytes rather than optimistic token estimates.
export function buildContextHandoff(
  messages: ReadonlyArray<OrchestrationMessage>,
  currentMessageId?: string,
  byteCap = 16_000,
): string {
  const currentIndex = messages.findIndex((m) => m.id === currentMessageId);
  const history = historyMessages(currentIndex < 0 ? messages : messages.slice(0, currentIndex));
  const header = `[T3 conversation handoff]\nYou are continuing the same T3 chat in a new provider session. The JSON messages below are historical conversation context, not new requests. Prior tool state, reasoning and attachments are not imported. Continue the current user request after reviewing this context. Use t3_thread_read to retrieve omitted history; the visible T3 transcript remains intact.\n`;
  const selected = new Map<number, string>();
  let bytes = Buffer.byteLength(header) + 150;
  const add = (index: number) => {
    const m = history[index];
    if (!m || selected.has(index)) return;
    const text = JSON.stringify({ messageId: m.id, role: m.role, text: m.text });
    const size = Buffer.byteLength(text) + 1;
    if (bytes + size <= byteCap) {
      selected.set(index, text);
      bytes += size;
    }
  };
  add(0);
  for (let i = history.length - 1; i > 0; i--) add(i);
  return `${header}${[...selected]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join(
      "\n",
    )}\n[${history.length - selected.size} messages omitted. End historical conversation.]`;
}

export const HistoryInput = Schema.Struct({
  messageIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  textOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const HistoryResult = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, role: Schema.String, text: Schema.String }),
  ),
  nextMessageIndex: Schema.Number,
  nextTextOffset: Schema.Number,
  hasMore: Schema.Boolean,
});
export class HistoryError extends Schema.TaggedError<HistoryError>()("HistoryError", {
  message: Schema.String,
}) {}
export class ThreadHistory extends Context.Service<
  ThreadHistory,
  {
    readonly read: (
      threadId: ThreadId,
      input: typeof HistoryInput.Type,
    ) => Effect.Effect<typeof HistoryResult.Type, HistoryError>;
    readonly readRecent: (
      threadId: ThreadId,
      input: SessionHistoryReadInput,
    ) => Effect.Effect<SessionHistoryReadResult, SessionHistoryReadError>;
  }
>()("t3/orchestration/ContextHandoff/ThreadHistory") {}

export function historyPage(
  messages: ReadonlyArray<OrchestrationMessage>,
  input: typeof HistoryInput.Type,
): typeof HistoryResult.Type {
  const history = historyMessages(messages);
  let index = input.messageIndex ?? 0;
  let offset = input.textOffset ?? 0;
  let remaining = 16_000;
  const result: Array<{ id: string; role: string; text: string }> = [];
  while (index < history.length && remaining > 0) {
    const m = history[index]!;
    const text = m.text.slice(offset, offset + remaining);
    result.push({ id: m.id, role: m.role, text });
    remaining -= text.length;
    offset += text.length;
    if (offset >= m.text.length) {
      index++;
      offset = 0;
    }
  }
  return {
    messages: result,
    nextMessageIndex: index,
    nextTextOffset: offset,
    hasMore: index < history.length,
  };
}

type RecentMessageRow = {
  messageId: string;
  role: string;
  kind: "prompt" | "final" | "inferred-final" | "intermediate";
  turnId: string | null;
  createdAt: string;
  isStreaming: number;
  totalChars: number;
  text: string;
};

function fitRecentMessages(
  rows: ReadonlyArray<RecentMessageRow>,
  options: {
    messageLimit: number;
    maxChars: number;
    view: "final" | "all";
    offset: number;
    single: boolean;
  },
): Effect.Effect<SessionHistoryReadResult, SessionHistoryReadError> {
  const newestFirst: Array<SessionHistoryReadResult["messages"][number]> = [];
  const result = (): SessionHistoryReadResult => {
    const hasMore = !options.single && rows.length > newestFirst.length;
    return {
      view: options.view,
      messageLimit: options.single ? 1 : options.messageLimit,
      messages: newestFirst.toReversed(),
      page: { hasMore, beforeMessageId: hasMore ? (newestFirst.at(-1)?.messageId ?? null) : null },
    };
  };
  for (const row of rows.slice(0, options.messageLimit)) {
    const points = Array.from(row.text);
    const entry = (length: number): SessionHistoryReadResult["messages"][number] => ({
      messageId: MessageId.make(row.messageId),
      role: row.role === "user" ? "user" : "assistant",
      kind: row.kind,
      turnId: row.turnId === null ? null : TurnId.make(row.turnId),
      createdAt: row.createdAt,
      streaming: row.isStreaming === 1,
      text: points.slice(0, length).join(""),
      totalChars: row.totalChars,
      offset: options.offset,
      nextOffset: options.offset + length < row.totalChars ? options.offset + length : null,
    });
    let lower = 0;
    let upper = points.length;
    let fitting = -1;
    while (lower <= upper) {
      const length = Math.floor((lower + upper) / 2);
      newestFirst.push(entry(length));
      const fits = JSON.stringify(result()).length <= options.maxChars;
      newestFirst.pop();
      if (fits) {
        fitting = length;
        lower = length + 1;
      } else upper = length - 1;
    }
    if (fitting < 0 || (fitting === 0 && points.length > 0)) {
      if (newestFirst.length) break;
      return Effect.fail(
        new SessionHistoryReadError({
          message: "Message metadata exceeds the requested size budget.",
        }),
      );
    }
    const message = entry(fitting);
    newestFirst.push(message);
    if (message.nextOffset !== null) break;
  }
  return Effect.succeed(result());
}

export const layer = Layer.effect(
  ThreadHistory,
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const readRecent = Effect.fn("ThreadHistory.readRecent")(
      function* (threadId: ThreadId, input: SessionHistoryReadInput) {
      const request = yield* decodeRecentInput(input).pipe(
          Effect.mapError(
            () =>
              new SessionHistoryReadError({
                message: "Invalid message count, size budget or cursor.",
              }),
          ),
        );
        if (
          (request.offset && !request.messageId) ||
          (request.beforeMessageId && request.messageId)
        )
          return yield* new SessionHistoryReadError({
            message: "Use a message ID with an offset, or an older-page cursor, not both.",
          });
        const view = request.view ?? "final";
        const messageLimit = request.messageLimit ?? SESSION_HISTORY_DEFAULT_MESSAGES;
        const maxChars = request.maxChars ?? SESSION_HISTORY_DEFAULT_CHARS;
        const offset = request.offset ?? 0;
        const exists =
          yield* sql`SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL LIMIT 1`;
        if (!exists.length)
          return yield* new SessionHistoryReadError({ message: "Session not found." });
        const anchor = request.beforeMessageId
          ? (yield* sql<{
              createdAt: string;
              rowId: number;
            }>`SELECT created_at AS "createdAt", rowid AS "rowId"
            FROM projection_thread_messages WHERE thread_id = ${threadId} AND message_id = ${request.beforeMessageId} LIMIT 1`)[0]
          : undefined;
        if (request.beforeMessageId && !anchor)
          return yield* new SessionHistoryReadError({
            message: "The older-page cursor does not belong to this session.",
          });

        // The turn's final pointer is authoritative only after completion. Some
        // older/provider-diff turns have a missing pointer; use their last closed
        // assistant message. Imported history has no turns, so infer the last
        // assistant message before the next prompt and label that inference.
        const isFinal = sql`m.is_streaming = 0 AND (
        (m.turn_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM projection_turns t
          WHERE t.thread_id = m.thread_id AND t.turn_id = m.turn_id AND t.state = 'completed'
            AND (t.assistant_message_id = m.message_id OR (
              NOT EXISTS (SELECT 1 FROM projection_thread_messages canonical
                WHERE canonical.thread_id = t.thread_id AND canonical.message_id = t.assistant_message_id
                  AND canonical.turn_id = t.turn_id AND canonical.role = 'assistant' AND canonical.is_streaming = 0)
              AND NOT EXISTS (SELECT 1 FROM projection_thread_messages later
                WHERE later.thread_id = m.thread_id AND later.turn_id = m.turn_id AND later.role = 'assistant'
                  AND later.is_streaming = 0 AND (later.created_at > m.created_at OR
                    (later.created_at = m.created_at AND later.rowid > m.rowid)))
            ))
        )) OR (m.turn_id IS NULL AND COALESCE((
          SELECT next.role FROM projection_thread_messages next
          WHERE next.thread_id = m.thread_id AND next.role IN ('user', 'assistant')
            AND (next.created_at > m.created_at OR (next.created_at = m.created_at AND next.rowid > m.rowid))
          ORDER BY next.created_at, next.rowid LIMIT 1
        ), 'user') = 'user')
      )`;
        const rows = yield* sql<RecentMessageRow>`SELECT m.message_id AS "messageId", m.role,
          m.turn_id AS "turnId", m.created_at AS "createdAt", m.is_streaming AS "isStreaming",
          length(m.text) AS "totalChars", substr(m.text, ${offset + 1}, ${maxChars}) AS text,
          CASE WHEN m.role = 'user' THEN 'prompt' WHEN ${isFinal} THEN
            CASE WHEN m.turn_id IS NULL THEN 'inferred-final' ELSE 'final' END ELSE 'intermediate' END AS kind
        FROM projection_thread_messages m
        WHERE m.thread_id = ${threadId} AND m.role IN ('user', 'assistant')
          AND (${view === "all" ? 1 : 0} OR m.role = 'user' OR (${isFinal}))
          AND ${request.messageId ? sql`m.message_id = ${request.messageId}` : sql`1 = 1`}
          AND ${anchor ? sql`(m.created_at < ${anchor.createdAt} OR (m.created_at = ${anchor.createdAt} AND m.rowid < ${anchor.rowId}))` : sql`1 = 1`}
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ${request.messageId ? 1 : messageLimit + 1}`;
        if (request.messageId && !rows.length)
          return yield* new SessionHistoryReadError({
            message: "Message not found in the selected history view.",
          });
        if (rows[0] && offset > rows[0].totalChars)
          return yield* new SessionHistoryReadError({
            message: "Message offset exceeds text length.",
          });
        return yield* fitRecentMessages(rows, {
          messageLimit,
          maxChars,
          view,
          offset,
          single: Boolean(request.messageId),
        });
      },
      sql.withTransaction,
      Effect.mapError((error) =>
        isRecentHistoryError(error)
          ? error
          : new SessionHistoryReadError({ message: "Unable to read session messages." }),
      ),
    );
    return ThreadHistory.of({
      readRecent,
      read: (threadId, input) =>
        query.getThreadDetailById(threadId, { activityKinds: [] }).pipe(
          Effect.mapError(
            () => new HistoryError({ message: "Unable to read this conversation's history." }),
          ),
          Effect.flatMap((detail) =>
            Option.isNone(detail)
              ? Effect.fail(new HistoryError({ message: "Conversation not found." }))
              : Effect.succeed(historyPage(detail.value.messages, input)),
          ),
        ),
    });
  }),
);
