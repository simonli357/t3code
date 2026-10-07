import type { OrchestrationMessage, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

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
export const layer = Layer.effect(
  ThreadHistory,
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    return ThreadHistory.of({
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
