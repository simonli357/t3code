import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import migration from "../persistence/Migrations/074_NativeConversationForks.ts";
import { retainNativeConversationFork } from "./NativeConversationFork.ts";

it.effect("reserves an uncertain clone durably and refuses retries or destination reuse", () =>
  Effect.gen(function* () {
    yield* migration;
    let clones = 0;
    const input = { commandId: CommandId.make("request"), targetThreadId: ThreadId.make("destination"), sourceFingerprint: "source-revision", clone: Effect.sync(() => { clones++; }).pipe(Effect.andThen(Effect.fail("native response lost"))) };
    assert.equal(yield* retainNativeConversationFork(input).pipe(Effect.flip), "native response lost");
    const retry = yield* retainNativeConversationFork(input).pipe(Effect.flip);
    assert.equal(retry._tag, "NativeConversationForkError");
    const conflict = yield* retainNativeConversationFork({ ...input, commandId: CommandId.make("another") }).pipe(Effect.flip);
    assert.equal(conflict._tag, "NativeConversationForkError");
    assert.equal(clones, 1);
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* sql`SELECT * FROM orchestration_v2_native_conversation_forks`).length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
