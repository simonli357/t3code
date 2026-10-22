import { expect, it } from "@effect/vitest";
import { MessageId, ThreadId, SessionHistoryReadResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as History from "./ContextHandoff.ts";

const testLayer = History.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: () => Effect.die("Recent history must not hydrate a whole thread."),
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const stamp = (n: number) => DateTime.formatIso(DateTime.makeUnsafe(n));
const encodeHistory = Schema.encodeSync(Schema.fromJsonString(SessionHistoryReadResult));
const seed = Effect.fn(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
    VALUES (${id}, 'p', ${id}, '{}', 'full-access', ${stamp(0)}, ${stamp(0)})`;
  return ThreadId.make(id);
});
const message = Effect.fn(function* (
  threadId: ThreadId,
  id: string,
  role: string,
  text: string,
  order: number,
  turnId: string | null = null,
  streaming = false,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${id}, ${threadId}, ${turnId}, ${role}, ${text}, ${streaming ? 1 : 0}, ${stamp(order)}, ${stamp(order)})`;
});
const turn = Effect.fn(function* (
  threadId: ThreadId,
  id: string,
  final: string | null,
  state = "completed",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
    VALUES (${threadId}, ${id}, ${final}, ${state}, ${stamp(0)}, ${state === "completed" ? stamp(1) : null}, '[]')`;
});

it.layer(testLayer)("bounded session history", (it) => {
  it.effect(
    "returns user prompts and completed turn finals, excluding progress, reasoning and tools",
    () =>
      Effect.gen(function* () {
        const history = yield* History.ThreadHistory;
        const id = yield* seed("mixed");
        yield* message(id, "mixed-user1", "user", "task", 1);
        yield* message(id, "mixed-progress", "assistant", "working", 2, "done");
        yield* message(id, "mixed-reasoning", "reasoning", "private", 3, "done");
        yield* message(id, "mixed-tool", "tool", "tool output", 4, "done");
        yield* message(id, "mixed-final", "assistant", "result", 5, "done");
        yield* turn(id, "done", "mixed-final");
        yield* message(id, "mixed-user2", "user", "next task", 6);
        yield* message(id, "mixed-running", "assistant", "more progress", 7, "running");
        yield* message(id, "mixed-stream", "assistant", "partial", 8, "running", true);
        yield* turn(id, "running", "mixed-stream", "running");
        const result = yield* history.readRecent(id, {});
        expect(result.messages.map((m) => m.text)).toEqual(["task", "result", "next task"]);
        expect(result.messages.map((m) => m.kind)).toEqual(["prompt", "final", "prompt"]);
        const all = yield* history.readRecent(id, { view: "all", messageLimit: 15 });
        expect(all.messages.map((m) => m.text)).toEqual([
          "task",
          "working",
          "result",
          "next task",
          "more progress",
          "partial",
        ]);
      }),
  );
  it.effect("selects exactly the last 1, 3, 5 or 15 eligible messages", () =>
    Effect.gen(function* () {
      const history = yield* History.ThreadHistory;
      const id = yield* seed("counts");
      const expected = [];
      for (let i = 0; i < 10; i++) {
        yield* message(id, `count-user-${i}`, "user", `prompt ${i}`, i * 3);
        yield* message(
          id,
          `count-progress-${i}`,
          "assistant",
          `progress ${i}`,
          i * 3 + 1,
          `count-turn-${i}`,
        );
        yield* message(
          id,
          `count-final-${i}`,
          "assistant",
          `final ${i}`,
          i * 3 + 2,
          `count-turn-${i}`,
        );
        yield* turn(id, `count-turn-${i}`, `count-final-${i}`);
        expected.push(`prompt ${i}`, `final ${i}`);
      }
      for (const messageLimit of [1, 3, 5, 15]) {
        const result = yield* history.readRecent(id, { messageLimit });
        expect(result.messages.map((m) => m.text)).toEqual(expected.slice(-messageLimit));
        expect(result.page.hasMore).toBe(true);
      }
    }),
  );
  it.effect("prefers a completed turn's final pointer and supports old missing pointers", () =>
    Effect.gen(function* () {
      const history = yield* History.ThreadHistory;
      const id = yield* seed("pointers");
      yield* message(id, "pointer-progress", "assistant", "first", 1, "p1");
      yield* message(id, "pointer-final", "assistant", "proven final", 2, "p1");
      yield* message(id, "pointer-extra", "assistant", "late commentary", 3, "p1");
      yield* turn(id, "p1", "pointer-final");
      yield* message(id, "pointer-old1", "assistant", "old progress", 4, "p2");
      yield* message(id, "pointer-old2", "assistant", "old final", 5, "p2");
      yield* turn(id, "p2", "missing-provider-diff-placeholder");
      expect((yield* history.readRecent(id, {})).messages.map((m) => m.text)).toEqual([
        "proven final",
        "old final",
      ]);
    }),
  );
  it.effect("infers the final imported reply per prompt with tied timestamps", () =>
    Effect.gen(function* () {
      const history = yield* History.ThreadHistory;
      const id = yield* seed("imported");
      for (let i = 0; i < 2; i++) {
        yield* message(id, `import-user-${i}`, "user", `prompt ${i}`, 1);
        yield* message(id, `import-update-${i}`, "assistant", "progress", 1);
        yield* message(id, `import-final-${i}`, "assistant", `answer ${i}`, 1);
      }
      const result = yield* history.readRecent(id, { messageLimit: 5 });
      expect(result.messages.map((m) => m.text)).toEqual([
        "prompt 0",
        "answer 0",
        "prompt 1",
        "answer 1",
      ]);
      expect(
        result.messages
          .filter((m) => m.role === "assistant")
          .every((m) => m.kind === "inferred-final"),
      ).toBe(true);
    }),
  );
  it.effect(
    "pages backwards without duplicates and rejects another session's cursor or message ID",
    () =>
      Effect.gen(function* () {
        const history = yield* History.ThreadHistory;
        const id = yield* seed("paging");
        const other = yield* seed("paging-other");
        for (let i = 0; i < 8; i++) yield* message(id, `page-${i}`, "user", String(i), 1);
        let beforeMessageId: MessageId | undefined;
        const seen = [];
        for (let page = 0; page < 3; page++) {
          const result = yield* history.readRecent(id, { messageLimit: 3, beforeMessageId });
          seen.unshift(...result.messages.map((m) => m.text));
          if (!result.page.hasMore) break;
          beforeMessageId = result.page.beforeMessageId ?? undefined;
        }
        expect(seen).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
        expect(
          (yield* history
            .readRecent(other, { beforeMessageId: beforeMessageId! })
            .pipe(Effect.flip)).message,
        ).toContain("cursor");
        expect(
          (yield* history
            .readRecent(other, { messageId: MessageId.make("page-0") })
            .pipe(Effect.flip)).message,
        ).toContain("Message not found");
      }),
  );
  it.effect(
    "caps complete JSON including metadata and escaped Unicode, with lossless targeted continuation",
    () =>
      Effect.gen(function* () {
        const history = yield* History.ThreadHistory;
        const id = yield* seed("unicode");
        const text = '😀\\"\n'.repeat(1500);
        yield* message(id, "unicode-user", "user", text, 1);
        let offset = 0;
        let reconstructed = "";
        for (let page = 0; page < 30; page++) {
          const result = yield* history.readRecent(id, {
            messageId: MessageId.make("unicode-user"),
            maxChars: 2048,
            offset,
          });
          expect(encodeHistory(result).length).toBeLessThanOrEqual(2048);
          const current = result.messages[0]!;
          reconstructed += current.text;
          if (current.nextOffset === null) break;
          expect(current.nextOffset).toBeGreaterThan(offset);
          offset = current.nextOffset;
        }
        expect(reconstructed).toBe(text);
      }),
  );
  it.effect(
    "caps tiny-message metadata too and rejects requests above the 15-message ceiling",
    () =>
      Effect.gen(function* () {
        const history = yield* History.ThreadHistory;
        const id = yield* seed("limits");
        for (let i = 0; i < 100; i++) yield* message(id, `tiny-${i}`, "user", "x", i);
        const result = yield* history.readRecent(id, { messageLimit: 15, maxChars: 1024 });
        expect(result.messages.length).toBeLessThanOrEqual(15);
        expect(encodeHistory(result).length).toBeLessThanOrEqual(1024);
        expect(result.page.hasMore).toBe(true);
        for (const input of [
          { messageLimit: 16 },
          { messageLimit: 0 },
          { maxChars: 64001 },
          { maxChars: 1 },
        ])
          expect((yield* history.readRecent(id, input).pipe(Effect.flip)).message).toContain(
            "Invalid",
          );
      }),
  );
});
