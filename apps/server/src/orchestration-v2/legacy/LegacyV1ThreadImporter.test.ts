import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  EventId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionMaintenanceProvided,
);

const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;
      yield* sql`
        UPDATE projection_thread_messages SET created_at = '0000-not-a-date'
        WHERE message_id = 'thread:first:old'
      `;

      yield* importer.importPendingTranscripts;

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

// regression: #15920 one bad legacy message stopped the server from starting
it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query] = statement.compile();
          const readingTranscript = query.includes("FROM projection_thread_messages");
          const writingRetryMarker = query.includes("SET last_error =");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("LegacyV1ThreadImporter", (it) => {
  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      const validContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx_1"),
            kind: "skill",
            label: "$test",
            name: "test",
          },
        ],
      } satisfies OrchestrationMessageContext;
      yield* sql`
        UPDATE projection_thread_messages
        SET context_json = CASE message_id
          WHEN 'message:legacy:2' THEN '{broken-json'
          WHEN 'message:legacy:3' THEN '{"version":2,"records":[]}'
          ELSE ${JSON.stringify(validContext)}
        END
        WHERE thread_id = ${threadId}
      `;
      const sourceMessages = yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => [message.text, message.context]),
        [
          ["Follow-up question", undefined],
          ["Partial answer", validContext],
        ],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.isNull(projection.thread.lastVisitedAt);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      const expectedMessages = [
        ["First question", validContext],
        ["First answer", undefined],
        ["Follow-up question", undefined],
        ["Partial answer", validContext],
      ];
      assert.deepStrictEqual(
        projection.messages.map((message) => [message.text, message.context]),
        expectedMessages,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
        `,
        sourceMessages,
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );
});

it.effect(
  "preserves native continuity, plans, tool payloads and checkpoints without reviving work",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p-native','Native','/tmp/native','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
      for (const [driver, cursor, nativeId] of [
        ["codex", { threadId: "native-codex" }, "native-codex"],
        [
          "claudeAgent",
          {
            resume: "native-claude",
            resumeSessionAt: "head-claude",
            turnCount: 1,
            turnStartMessageIds: ["native-user-claude"],
          },
          "native-claude",
        ],
        ["deepseekHarness", { schemaVersion: 1, sessionId: "native-dsh" }, "native-dsh"],
        ["pi", { schemaVersion: 1, sessionId: "native-pi" }, "native-pi"],
        ["antigravity", { schemaVersion: 1, sessionId: "native-antigravity" }, "native-antigravity"],
        ["opencode", { schemaVersion: 1, sessionId: "native-opencode" }, "native-opencode"],
      ] as const) {
        const threadId = ThreadId.make(`native-${driver}`);
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
        VALUES (${threadId},'p-native','Native',${JSON.stringify({ instanceId: `${driver}_work`, model: "custom-model", options: [{ id: "reasoningEffort", value: "high" }] })},'approval-required','plan','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json)
        VALUES (${threadId},${driver},${`${driver}_work`},${driver},'approval-required','running','2026-01-01T00:00:00Z',${JSON.stringify(cursor)})`;
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id,thread_id,plan_markdown,created_at,updated_at)
        VALUES (${`plan-${driver}`},${threadId},'Complete retained plan','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,created_at,sequence)
        VALUES (${`activity-${driver}`},${threadId},'info','tool.completed','Retained output','{"toolCallId":"call-1","result":{"text":"entire output"}}','2026-01-01T00:00:00Z',1)`;
        yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,completed_at,checkpoint_turn_count,checkpoint_ref,checkpoint_status,checkpoint_files_json)
        VALUES (${threadId},'old-turn','completed','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',1,'refs/t3/checkpoints/retained','ready','[{"path":"file.ts","kind":"modified","additions":2,"deletions":1}]')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
          VALUES (${`message-${driver}`},${threadId},'user','Retained message',0,'2026-01-01T00:01:00Z','2026-01-01T00:01:00Z')`;
        if (driver === "opencode") {
          yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at)
            VALUES ('assistant:native-part:segment:1',${threadId},'old-turn','assistant','Retained native output',0,'2026-01-01T00:01:00Z','2026-01-01T00:01:00Z')`;
          yield* sql`UPDATE projection_thread_activities SET turn_id = 'old-turn' WHERE thread_id = ${threadId}`;
        }
        yield* sql`UPDATE projection_threads SET is_base = 'true' WHERE thread_id = ${threadId}`;
        if (driver === "claudeAgent")
          yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json, state) VALUES (${threadId}, 'native-codex', 'native-codex', '{}', 'ready')`;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(threadId);
        yield* importer.ensureTranscript(threadId);
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.providerThreads[0]?.nativeThreadRef?.nativeId, nativeId);
        assert.equal(projection.thread.activeProviderThreadId, projection.providerThreads[0]?.id);
        assert.equal(
          projection.providerThreads[0]?.providerSessionId,
          `migration:v1:session:${threadId}`,
        );
        assert.equal(projection.providerThreads[0]?.status, "not_loaded");
        assert.equal(projection.providerThreads[0]?.providerInstanceId, `${driver}_work`);
        if (driver === "antigravity")
          assert.isTrue(projection.providerThreads[0]?.nativeMetadata?.legacyV1NativeResumeRequired);
        assert.equal(projection.thread.isBase, true);
        if (driver === "claudeAgent")
          assert.deepStrictEqual(projection.thread.lineage, {
            parentThreadId: ThreadId.make("native-codex"),
            relationshipToParent: "fork",
            rootThreadId: ThreadId.make("native-codex"),
          });
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.isBase', json('false'))
          WHERE thread_id = ${threadId}`;
        yield* importer.reconcileShells;
        assert.equal((yield* projections.getThreadProjection(threadId)).thread.isBase, false);
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_remove(payload_json, '$.isBase') WHERE thread_id = ${threadId}`;
        yield* importer.reconcileShells;
        assert.equal((yield* projections.getThreadProjection(threadId)).thread.isBase, true);
        assert.equal(projection.thread.runtimeMode, "approval-required");
        assert.equal(projection.thread.interactionMode, "plan");
        assert.equal(
          projection.thread.modelSelection.options?.find(
            (option) => option.id === "reasoningEffort",
          )?.value,
          "high",
        );
        assert.lengthOf(projection.runs, 1);
        assert.lengthOf(projection.plans, 1);
        assert.equal(projection.checkpoints[0]?.ref, "refs/t3/checkpoints/retained");
        assert.equal(projection.checkpoints[0]?.files[0]?.additions, 2);
        if (driver === "claudeAgent")
          assert.deepStrictEqual(projection.providerTurns[0]?.legacyClaudeBoundary, {
            headMessageId: "head-claude",
          });
        if (driver === "opencode") {
          assert.deepStrictEqual(projection.providerTurns[0]?.legacyOpenCodeBoundary, {
            retainedTurnCount: 1,
            turnCount: 1,
            messagePartIds: ["native-part"],
            toolCallIds: ["call-1"],
          });
          assert.isUndefined(projection.checkpoints[0]?.legacyV1?.rollbackUnavailableReason);
        }
        if (driver === "pi" || driver === "deepseekHarness" || driver === "antigravity")
          assert.include(
            projection.checkpoints[0]?.legacyV1?.rollbackUnavailableReason ?? "",
            "no recoverable native rollback boundary",
          );

        const tool = projection.turnItems.find((item) => item.type === "dynamic_tool");
        assert.equal(tool?.type, "dynamic_tool");
        if (tool?.type === "dynamic_tool")
          assert.deepEqual(tool.output, {
            kind: "tool.completed",
            tone: "info",
            summary: "Retained output",
            turnId: driver === "opencode" ? "old-turn" : null,
            payload: { toolCallId: "call-1", result: { text: "entire output" } },
          });
        if (driver === "claudeAgent")
          assert.equal(
            projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
            "head-claude",
          );
      }
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect.each([3, 6])(
  "retries interrupted multi-batch history hydration at batch %s after projection replay without losing or duplicating timeline positions",
  (interruptAt) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* seedPendingTranscripts;
      const threadId = ThreadId.make("thread:first");
      for (let i = 0; i < 230; i++) {
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES (${`hydration-${i}`}, ${threadId}, 'info', 'tool.completed', 'retained', ${JSON.stringify({ index: i })}, '2026-01-01T02:00:00Z', ${i})`;
      }
      let writes = 0;
      const interrupted = yield* Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(threadId);
      }).pipe(
        Effect.provide(LegacyV1ThreadImporter.layer),
        Effect.provideService(EventSink.EventSinkV2, {
          ...sink,
          write: (input) => (++writes === interruptAt ? Effect.interrupt : sink.write(input)),
        }),
        Effect.exit,
      );
      assert.isTrue(Exit.hasInterrupts(interrupted));
      assert.isNull(
        (yield* sql<{
          transcript_imported_at: string | null;
        }>`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}`)[0]
          ?.transcript_imported_at,
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(threadId);
        const after = yield* sink.latestSequence();
        yield* importer.ensureTranscript(threadId);
        assert.equal(yield* sink.latestSequence(), after);
      }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
      const hydrated = yield* projections.getThreadProjection(threadId);
      assert.lengthOf(hydrated.messages, 2);
      assert.lengthOf(hydrated.turnItems, 232);
      assert.equal(new Set(hydrated.turnItems.map((item) => item.ordinal)).size, 232);
      assert.deepStrictEqual(
        hydrated.turnItems
          .filter((item) => item.type === "dynamic_tool")
          .map((item) => item.id)
          .sort(),
        Array.from({ length: 230 }, (_, i) => `migration:v1:activity:hydration-${i}`).sort(),
      );
      const positions =
        yield* sql`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId} ORDER BY ordinal`;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepStrictEqual(
        yield* sql`SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${threadId} ORDER BY ordinal`,
        positions,
      );
      assert.deepStrictEqual(
        (yield* projections.getThreadProjection(threadId)).turnItems,
        hydrated.turnItems,
      );
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect(
  "isolates imported Antigravity identities and retains invalid cursors as explicit unavailable bindings across replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p-agy','Native','/tmp/ag-workspace','[]','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
      for (const [name, cursor] of [
        ["work", { schemaVersion: 1, sessionId: "same-native-id" }],
        ["personal", { schemaVersion: 1, sessionId: "same-native-id" }],
        ["invalid", { schemaVersion: 2, sessionId: "same-native-id" }],
        ["missing", null],
      ] as const) {
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
        VALUES (${name},'p-agy','Native',${JSON.stringify({ instanceId: `antigravity-${name}`, model: "gemini-test-high", options: [{ id: "mode", value: "auto_edit" }] })},'auto-accept-edits','plan','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json)
        VALUES (${name},'antigravity',${`antigravity-${name}`},'antigravity','auto-accept-edits','idle','2026-01-01T00:00:00Z',${JSON.stringify(cursor)})`;
      }
      yield* importer.reconcileShells;
      const before = [];
      for (const name of ["work", "personal", "invalid", "missing"]) {
        const projection = yield* projections.getThreadProjection(ThreadId.make(name));
        const binding = projection.providerThreads[0]!;
        before.push(binding);
        assert.equal(binding.providerInstanceId, `antigravity-${name}`);
        assert.isTrue(binding.nativeMetadata?.legacyV1NativeResumeRequired);
        assert.equal(binding.nativeMetadata?.itemIdentityVersion, 2);
        assert.equal(projection.thread.runtimeMode, "auto-accept-edits");
        assert.equal(projection.thread.interactionMode, "plan");
        if (name === "invalid" || name === "missing") {
          assert.isNull(binding.nativeThreadRef);
          assert.include(
            String(binding.nativeMetadata?.legacyV1NativeResumeError),
            "missing or incompatible",
          );
        } else assert.equal(binding.nativeThreadRef?.nativeId, "same-native-id");
      }
      assert.notEqual(before[0]?.id, before[1]?.id);
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).reconcileShells;
      }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
      for (const binding of before)
        assert.deepEqual(
          (yield* projections.getThreadProjection(binding.appThreadId!)).providerThreads[0],
          binding,
        );
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
);
