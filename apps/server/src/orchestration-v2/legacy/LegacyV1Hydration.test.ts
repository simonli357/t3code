import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);
const sinkLayer = EventSink.layer.pipe(Layer.provide(stores));
const dependencies = Layer.mergeAll(stores, sinkLayer);
const layerTest = Layer.mergeAll(
  dependencies,
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(dependencies)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

// Timestamps and event ordering from the retained myacer trial; contents are synthetic.
const threadId = ThreadId.make("160385b0-8a1e-4d51-8ce6-afc49017eeac");
const createdAt = "2026-10-23T18:47:14.861Z";
const historicalAt = "2026-10-23T21:09:52.575Z";
const sourceAt = "2026-10-31T17:56:58.787Z";
const editedAt = "2026-11-01T09:18:43.898Z";

it.effect.each(["none", "before", "read-write", "batch", "retry"] as const)(
  "hydrates historical events without regressing activity or overwriting %s concurrent edits, including replay and restart",
  (interleave) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p-hydration','Synthetic','/tmp/hydration','[]',${createdAt},${sourceAt})`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
      VALUES (${threadId},'p-hydration','Imported','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default',${createdAt},${sourceAt})`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,resume_cursor_json)
      VALUES (${threadId},'codex','codex','codex','full-access','idle',${sourceAt},'{"threadId":"historical-native"}')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('historical-message',${threadId},'user','Synthetic history',0,${historicalAt},${historicalAt})`;
      for (let i = 0; i < 201; i++)
        yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,created_at,sequence)
      VALUES (${`history-${i}`},${threadId},'info','tool.completed','Synthetic','{}',${historicalAt},${i})`;
      for (let i = 0; i < 4; i++)
        yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,completed_at,checkpoint_turn_count,checkpoint_ref,checkpoint_status,checkpoint_files_json)
      VALUES (${threadId},${`old-turn-${i}`},'completed',${historicalAt},${historicalAt},${i + 1},${`refs/t3/checkpoints/${i}`},'ready','[]')`;
      yield* importer.reconcileShells;
      const initial = yield* store.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(initial.thread.updatedAt), sourceAt);
      const originalBinding = initial.providerThreads[0]!;
      const newBindingId = ProviderThreadId.make("new-active-binding");
      const edit = Effect.gen(function* () {
        const now = DateTime.makeUnsafe(editedAt);
        const current = (yield* store.getThreadProjection(threadId)).providerThreads.find(
          (thread) => thread.id === originalBinding.id,
        )!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("live-old-binding"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalBinding,
                status: "active",
                firstRunOrdinal: current.firstRunOrdinal ?? 5,
                lastRunOrdinal: 8,
                updatedAt: now,
                nativeThreadRef: {
                  driver: originalBinding.driver,
                  nativeId: "current-native-head",
                  strength: "strong",
                },
              },
            },
            {
              id: EventId.make("live-new-binding"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...originalBinding,
                id: newBindingId,
                firstRunOrdinal: 9,
                lastRunOrdinal: 9,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("live-thread-edit"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: {
                ...initial.thread,
                title: "Concurrent user title",
                modelSelection: { ...initial.thread.modelSelection, model: "gpt-5.5" },
                activeProviderThreadId: newBindingId,
                updatedAt: now,
                pinnedAt: now,
                pinOrderKey: "a",
                runtimeMode: "approval-required",
                interactionMode: "plan",
              },
            },
          ],
        });
      });
      if (interleave === "before") yield* edit;
      if (interleave === "read-write" || interleave === "batch") {
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let writes = 0;
        const importing = yield* Effect.gen(function* () {
          yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(threadId);
        }).pipe(
          Effect.provide(LegacyV1ThreadImporter.layer),
          Effect.provideService(EventSink.EventSinkV2, {
            ...sink,
            write: (input) =>
              Effect.gen(function* () {
                if (++writes === (interleave === "read-write" ? 1 : 2)) {
                  yield* Deferred.succeed(paused, undefined);
                  yield* Deferred.await(release);
                }
                return yield* sink.write(input);
              }),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(paused);
        yield* edit;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(importing);
      } else if (interleave === "retry") {
        let writes = 0;
        const interrupted = yield* Effect.gen(function* () {
          yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(threadId);
        }).pipe(
          Effect.provide(LegacyV1ThreadImporter.layer),
          Effect.provideService(EventSink.EventSinkV2, {
            ...sink,
            write: (input) => (++writes === 2 ? Effect.interrupt : sink.write(input)),
          }),
          Effect.exit,
        );
        assert.equal(interrupted._tag, "Failure");
        yield* edit;
        assert.isTrue((yield* maintenance.rebuild).valid);
        yield* Effect.gen(function* () {
          yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(threadId);
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
      } else yield* importer.ensureTranscript(threadId);
      const hydrated = yield* store.getThreadProjection(threadId);
      const expectedTime = interleave === "none" ? sourceAt : editedAt;
      assert.equal(DateTime.formatIso(hydrated.thread.updatedAt), expectedTime);
      assert.equal(DateTime.formatIso(hydrated.updatedAt), expectedTime);
      assert.equal(
        hydrated.thread.activeProviderThreadId,
        interleave === "none" ? originalBinding.id : newBindingId,
      );
      const originalAfter = hydrated.providerThreads.find(
        (thread) => thread.id === originalBinding.id,
      )!;
      assert.equal(originalAfter.firstRunOrdinal, 1);
      assert.equal(originalAfter.lastRunOrdinal, interleave === "none" ? 4 : 8);
      if (interleave !== "none") {
        assert.equal(hydrated.thread.title, "Concurrent user title");
        assert.equal(hydrated.thread.modelSelection.model, "gpt-5.5");
        assert.equal(hydrated.thread.runtimeMode, "approval-required");
        assert.equal(hydrated.thread.interactionMode, "plan");
        assert.equal(hydrated.thread.pinOrderKey, "a");
        assert.equal(originalAfter.status, "active");
        assert.equal(originalAfter.nativeThreadRef?.nativeId, "current-native-head");
        assert.equal(DateTime.formatIso(originalAfter.updatedAt), editedAt);
      }
      assert.isTrue(hydrated.runs.every((run) => run.providerThreadId === originalBinding.id));
      assert.lengthOf(hydrated.runs, 4);
      assert.isTrue(hydrated.runs.every((run) => run.modelSelection.model === "gpt-5.4"));
      assert.lengthOf(hydrated.messages, 1);
      const rows = yield* sql<{
        updated_at: string;
        payload_at: string;
      }>`SELECT updated_at,json_extract(payload_json,'$.updatedAt') payload_at FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
      assert.equal(rows[0]?.updated_at, expectedTime);
      assert.equal(rows[0]?.payload_at, expectedTime);
      let replay: OrchestrationV2ThreadProjection | undefined;
      const recorded = yield* events.read({ threadId }).pipe(Stream.runCollect);
      for (const stored of recorded) {
        if (!replay) {
          assert.equal(stored.event.type, "thread.created");
          if (stored.event.type === "thread.created")
            replay = ProjectionStore.emptyProjection(stored.event);
        } else replay = ProjectionStore.applyToProjection(replay, stored.event);
      }
      assert.deepEqual(replay?.thread, hydrated.thread);
      assert.deepEqual(replay?.providerThreads, hydrated.providerThreads);
      assert.equal(DateTime.formatIso(replay!.updatedAt), expectedTime);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* store.getThreadProjection(threadId)).thread, hydrated.thread);
      const sequence = yield* sink.latestSequence();
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(threadId);
      }).pipe(Effect.provide(LegacyV1ThreadImporter.layer));
      assert.equal(yield* sink.latestSequence(), sequence);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
);
