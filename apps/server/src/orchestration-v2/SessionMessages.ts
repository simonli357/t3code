import {
  MessageId,
  SESSION_HISTORY_DEFAULT_CHARS,
  SESSION_HISTORY_DEFAULT_MESSAGES,
  SessionHistoryReadError,
  SessionHistoryReadInput,
  type SessionHistoryReadResult,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeInput = Schema.decodeEffect(SessionHistoryReadInput);
const isReadError = Schema.is(SessionHistoryReadError);

/** Recent messages of one session within a character budget, for agents that read another session. */
export class SessionMessages extends Context.Service<
  SessionMessages,
  {
    readonly readRecent: (
      threadId: ThreadId,
      input: SessionHistoryReadInput,
    ) => Effect.Effect<SessionHistoryReadResult, SessionHistoryReadError>;
  }
>()("t3/orchestration-v2/SessionMessages") {}

type MessageRow = {
  messageId: string;
  role: string;
  kind: "prompt" | "final" | "inferred-final" | "intermediate";
  runId: string | null;
  createdAt: string;
  streaming: number;
  totalChars: number;
  text: string;
};

/**
 * Takes rows newest first and keeps as many whole messages as fit `maxChars` of JSON, cutting
 * the oldest kept one at a character boundary and offering the rest through `nextOffset`.
 */
function fitRecentMessages(
  rows: ReadonlyArray<MessageRow>,
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
      turnId: row.runId === null ? null : TurnId.make(row.runId),
      createdAt: row.createdAt,
      streaming: row.streaming === 1,
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
  SessionMessages,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readRecent = Effect.fn("SessionMessages.readRecent")(
      function* (threadId: ThreadId, input: SessionHistoryReadInput) {
        const request = yield* decodeInput(input).pipe(
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
        const exists = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId} AND deleted_at IS NULL LIMIT 1`;
        if (!exists.length)
          return yield* new SessionHistoryReadError({ message: "Session not found." });
        const anchor = request.beforeMessageId
          ? (yield* sql<{ createdAt: string; rowId: number }>`
              SELECT created_at AS "createdAt", rowid AS "rowId"
              FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND message_id = ${request.beforeMessageId} LIMIT 1`)[0]
          : undefined;
        if (request.beforeMessageId && !anchor)
          return yield* new SessionHistoryReadError({
            message: "The older-page cursor does not belong to this session.",
          });

        // A run's last closed assistant message is its final answer once the run completed.
        // Messages without a run (imported history) take the last assistant message before the
        // next prompt, and are labelled as inferred.
        const isFinal = sql`m.streaming = 0 AND m.role = 'assistant' AND (
          (m.run_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
              WHERE r.run_id = m.run_id AND r.status = 'completed')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages later
              WHERE later.run_id = m.run_id AND later.role = 'assistant' AND later.streaming = 0
                AND (later.created_at > m.created_at
                  OR (later.created_at = m.created_at AND later.rowid > m.rowid))))
          OR (m.run_id IS NULL AND COALESCE((
            SELECT next.role FROM orchestration_v2_projection_messages next
            WHERE next.thread_id = m.thread_id AND next.role IN ('user', 'assistant')
              AND (next.created_at > m.created_at
                OR (next.created_at = m.created_at AND next.rowid > m.rowid))
            ORDER BY next.created_at, next.rowid LIMIT 1
          ), 'user') = 'user')
        )`;
        const rows = yield* sql<MessageRow>`
          SELECT m.message_id AS "messageId", m.role, m.run_id AS "runId",
            m.created_at AS "createdAt", m.streaming AS "streaming",
            length(json_extract(m.payload_json, '$.text')) AS "totalChars",
            substr(json_extract(m.payload_json, '$.text'), ${offset + 1}, ${maxChars}) AS text,
            CASE WHEN m.role = 'user' THEN 'prompt' WHEN ${isFinal} THEN
              CASE WHEN m.run_id IS NULL THEN 'inferred-final' ELSE 'final' END
              ELSE 'intermediate' END AS kind
          FROM orchestration_v2_projection_messages m
          WHERE m.thread_id = ${threadId} AND m.role IN ('user', 'assistant')
            AND (${view === "all" ? 1 : 0} OR m.role = 'user' OR (${isFinal}))
            AND ${request.messageId ? sql`m.message_id = ${request.messageId}` : sql`1 = 1`}
            AND ${
              anchor
                ? sql`(m.created_at < ${anchor.createdAt}
                    OR (m.created_at = ${anchor.createdAt} AND m.rowid < ${anchor.rowId}))`
                : sql`1 = 1`
            }
          ORDER BY m.created_at DESC, m.rowid DESC
          LIMIT ${request.messageId ? 1 : messageLimit + 1}`;
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
        isReadError(error)
          ? error
          : new SessionHistoryReadError({ message: "Unable to read session messages." }),
      ),
    );
    return SessionMessages.of({ readRecent });
  }),
);
