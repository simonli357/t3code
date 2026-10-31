import { expect, it } from "@effect/vitest";
import { MessageId, SessionHistoryReadError, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionMessages from "./SessionMessages.ts";

const threadId = ThreadId.make("thread:history");
const layer = SessionMessages.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

type Row = {
  id: string;
  role: "user" | "assistant";
  at: number;
  text: string;
  runId?: string;
  streaming?: boolean;
};

const seed = (rows: ReadonlyArray<Row>, runs: Record<string, string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const iso = (at: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 0, at)));
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', 'History', 'codex', 'full-access', 'default', ${iso(0)}, ${iso(0)}, '{}')`;
    for (const [runId, status] of Object.entries(runs))
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${runId}, ${threadId}, ${Number(runId.slice(-1))}, 'codex', ${status}, ${iso(0)}, '{}')`;
    for (const row of rows)
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${row.id}, ${threadId}, ${row.runId ?? null}, ${row.role}, ${row.streaming ? 1 : 0},
          ${iso(row.at)}, ${iso(row.at)}, ${JSON.stringify({ text: row.text })})`;
  });

const conversation: ReadonlyArray<Row> = [
  { id: "u1", role: "user", at: 1, text: "first prompt" },
  { id: "a1-step", role: "assistant", at: 2, text: "working", runId: "run-1" },
  { id: "a1", role: "assistant", at: 3, text: "answer one", runId: "run-1" },
  { id: "u2", role: "user", at: 4, text: "second prompt" },
  { id: "a2-step", role: "assistant", at: 5, text: "still working", runId: "run-2" },
];

it.effect("shows prompts and final answers, and the intermediate steps on request", () =>
  Effect.gen(function* () {
    yield* seed(conversation, { "run-1": "completed", "run-2": "running" });
    const messages = yield* SessionMessages.SessionMessages;
    const final = yield* messages.readRecent(threadId, {});
    expect(final.messages.map((m) => [m.messageId, m.kind])).toEqual([
      ["u1", "prompt"],
      ["a1", "final"],
      ["u2", "prompt"],
    ]);
    const all = yield* messages.readRecent(threadId, { view: "all", messageLimit: 4 });
    expect(all.messages.map((m) => [m.messageId, m.kind])).toEqual([
      ["a1-step", "intermediate"],
      ["a1", "final"],
      ["u2", "prompt"],
      ["a2-step", "intermediate"],
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("pages older messages, and reads one message in slices of its text", () =>
  Effect.gen(function* () {
    yield* seed(conversation, { "run-1": "completed", "run-2": "running" });
    const messages = yield* SessionMessages.SessionMessages;
    const first = yield* messages.readRecent(threadId, { messageLimit: 2 });
    expect(first.messages.map((m) => m.messageId)).toEqual(["a1", "u2"]);
    expect(first.page).toEqual({ hasMore: true, beforeMessageId: MessageId.make("a1") });
    const older = yield* messages.readRecent(threadId, {
      messageLimit: 2,
      beforeMessageId: first.page.beforeMessageId!,
    });
    expect(older.messages.map((m) => m.messageId)).toEqual(["u1"]);
    expect(older.page.hasMore).toBe(false);
    const slice = yield* messages.readRecent(threadId, {
      messageId: MessageId.make("a1"),
      offset: 7,
    });
    expect(slice.messages[0]).toMatchObject({ text: "one", offset: 7, totalChars: 10 });
  }).pipe(Effect.provide(layer)),
);

it.effect("cuts the oldest kept message to the size budget and offers the rest", () =>
  Effect.gen(function* () {
    yield* seed([{ id: "u1", role: "user", at: 1, text: "x".repeat(3000) }], {});
    const messages = yield* SessionMessages.SessionMessages;
    const page = yield* messages.readRecent(threadId, { maxChars: 1024 });
    const [message] = page.messages;
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(1024);
    expect(message!.text.length).toBeLessThan(3000);
    expect(message!.nextOffset).toBe(message!.text.length);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a missing session, a bad cursor and conflicting paging", () =>
  Effect.gen(function* () {
    yield* seed(conversation, { "run-1": "completed", "run-2": "running" });
    const messages = yield* SessionMessages.SessionMessages;
    const message = (input: Parameters<typeof messages.readRecent>[1], id = threadId) =>
      messages.readRecent(id, input).pipe(
        Effect.result,
        Effect.map((result) => (Result.isFailure(result) ? result.failure.message : "ok")),
      );
    expect(yield* message({}, ThreadId.make("thread:missing"))).toBe("Session not found.");
    expect(yield* message({ beforeMessageId: MessageId.make("elsewhere") })).toBe(
      "The older-page cursor does not belong to this session.",
    );
    expect(yield* message({ offset: 1 })).toContain("message ID with an offset");
    expect(yield* message({ messageId: MessageId.make("nope") })).toBe(
      "Message not found in the selected history view.",
    );
    expect(yield* message({ messageId: MessageId.make("u1"), offset: 99 })).toBe(
      "Message offset exceeds text length.",
    );
    expect(SessionHistoryReadError).toBeDefined();
  }).pipe(Effect.provide(layer)),
);
