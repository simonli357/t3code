import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefPrefixForThread } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { GitVcsDriver, type ExecuteGitInput } from "../vcs/GitVcsDriver.ts";
import { ThreadDeletionReactorLive } from "./Layers/ThreadDeletionReactor.ts";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "./Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "./Services/ThreadDeletionReactor.ts";
import {
  type PurgeGraph,
  SettledThreadPurge,
  layer,
  selectThreadsToPurge,
} from "./SettledThreadPurge.ts";

describe("selectThreadsToPurge", () => {
  it("keeps every thread a kept thread still depends on, repeating until stable", () => {
    const graph: PurgeGraph = {
      candidates: [
        { threadId: "owner", blocked: null },
        { threadId: "worker", blocked: "pinned" },
        { threadId: "successor", blocked: null },
        { threadId: "planner", blocked: null },
        { threadId: "fork", blocked: null },
        { threadId: "queued", blocked: null },
        { threadId: "settled-worker", blocked: null },
        { threadId: "remote-owner", blocked: null },
        { threadId: "failed-spawn-owner", blocked: null },
        { threadId: "plan-a", blocked: null },
        { threadId: "plan-b", blocked: null },
        { threadId: "pending-work", blocked: null },
        { threadId: "reporter", blocked: null },
      ],
      liveThreadIds: new Set([
        "owner",
        "worker",
        "successor",
        "planner",
        "implementer",
        "fork",
        "fork-source",
        "queued",
        "settled-worker",
        "live-owner",
        "remote-owner",
        "failed-spawn-owner",
        "plan-a",
        "plan-b",
        "pending-work",
        "reporter",
        "live-sender",
      ]),
      workers: [
        { threadId: "worker", ownerId: "owner", remote: false },
        { threadId: "settled-worker", ownerId: "live-owner", remote: false },
        { threadId: "peer-worker", ownerId: "remote-owner", remote: true },
        { threadId: "never-created", ownerId: "failed-spawn-owner", remote: false },
      ],
      activeJobs: [
        { id: "job-1", workerId: "live-sender", targetId: "queued", state: "queued" },
        {
          id: "job-2",
          workerId: "settled-worker",
          targetId: "settled-worker",
          state: "interrupted",
        },
        { id: "job-3", workerId: "pending-work", targetId: "pending-work", state: "queued" },
        { id: "job-4", workerId: "reporter", targetId: "live-owner", state: "queued" },
        { id: "job-5", workerId: "plan-a", targetId: "plan-b", state: "interrupted" },
      ],
      handoffs: [{ threadId: "successor", ownerId: "owner" }],
      planLinks: [
        { threadId: "planner", linkedThreadId: "implementer" },
        { threadId: "plan-a", linkedThreadId: "plan-b" },
      ],
      sessionKeys: [
        { threadId: "fork", key: "claudeAgent:s-1" },
        { threadId: "fork-source", key: "claudeAgent:s-1" },
      ],
    };

    const { purge, skipped } = selectThreadsToPurge(graph);

    expect([...purge].toSorted()).toEqual([
      "failed-spawn-owner",
      "plan-a",
      "plan-b",
      "settled-worker",
    ]);
    expect(Object.fromEntries(skipped)).toEqual({
      worker: "pinned",
      queued: "worker job job-1 from live-sender is queued",
      "pending-work": "worker job job-3 is queued",
      reporter: "worker job job-4 for live-owner is queued",
      owner: "owns worker worker, which is kept",
      successor: "took over from owner, which is kept",
      planner: "shares a proposed plan with implementer, which is kept",
      fork: "shares its provider session with fork-source, which is kept",
      "remote-owner": "owns worker peer-worker, which is kept",
    });
  });
});

const SESSION = "0248b7d6-1ead-447d-894b-5edbafe089df";
const OTHER_SESSION = "3eb759e7-b92c-43aa-9344-c277e5ca72aa";
const PROJECT = ProjectId.make("project-purge");
const PURGED = ThreadId.make("thread-purged");
const OWNER = ThreadId.make("thread-owner");
const WORKER = ThreadId.make("thread-worker");
const OLD = "2026-01-01T00:00:00.000Z";

/** A server's orchestration core on `baseDir`; building it again is a restart. */
function makeServer(input: {
  readonly baseDir: string;
  readonly claudeHome: string;
  readonly gitCalls: Array<ExecuteGitInput>;
}) {
  const providers = Layer.mock(ProviderService)({
    listSessions: () => Effect.succeed([]),
    stopSession: () => Effect.void,
  });
  const deletionReactor = Layer.effectDiscard(
    Effect.flatMap(Effect.service(ThreadDeletionReactor), (reactor) => reactor.start()),
  ).pipe(
    Layer.provideMerge(ThreadDeletionReactorLive),
    Layer.provide(providers),
    Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
  );
  const git = Layer.mock(GitVcsDriver)({
    execute: (call) =>
      Effect.sync(() => {
        input.gitCalls.push(call);
        const prefix = checkpointRefPrefixForThread(PURGED);
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout:
            call.args[0] === "for-each-ref" && call.args[2] === prefix
              ? `${prefix}turn/0\n${prefix}turn/1\n`
              : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  return layer.pipe(
    Layer.provideMerge(deletionReactor),
    Layer.provide(providers),
    Layer.provide(Layer.mock(ProviderRuntimeIngestionService)({ drain: Effect.void })),
    Layer.provide(git),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [ProviderInstanceId.make("claude_eol")]: {
            driver: "claudeAgent",
            config: { homePath: input.claudeHome },
          },
        },
      }),
    ),
    Layer.provideMerge(
      OrchestrationLayerLive.pipe(
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(makeSqlitePersistenceLive(`${input.baseDir}/state.sqlite`)),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(input.baseDir, input.baseDir)),
  );
}

const seed = Effect.fn(function* (workspace: string) {
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
  yield* dispatch({
    type: "project.create",
    commandId: CommandId.make("project-create"),
    projectId: PROJECT,
    title: "Purge",
    workspaceRoot: workspace,
    createdAt: OLD,
  });
  for (const threadId of [PURGED, OWNER, WORKER]) {
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${threadId}`),
      threadId,
      projectId: PROJECT,
      title: threadId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude_eol"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: OLD,
    });
  }
  yield* sql`UPDATE projection_threads SET settled_override = 'settled', settled_at = ${OLD}
    WHERE thread_id IN (${PURGED}, ${OWNER})`;
  yield* sql`INSERT INTO provider_session_runtime
    (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json, provider_instance_id)
    VALUES (${PURGED}, 'claudeAgent', 'claudeAgent', 'stopped', ${OLD},
      ${`{"threadId":"${PURGED}","resume":"${SESSION}"}`}, 'claude_eol')`;
  yield* sql`INSERT INTO projection_thread_activities
    (activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence)
    VALUES ('activity-1', ${PURGED}, 'info', 'tool', 'ran', '{}', ${OLD}, 1)`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('message-1', ${PURGED}, 'user', 'hi', 0, ${OLD}, ${OLD})`;
  yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
    VALUES (${PURGED}, 'turn-1', 'completed', ${OLD}, '[]')`;
  yield* sql`INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at)
    VALUES (${PURGED}, 0, 1, 'diff', ${OLD})`;
  yield* sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json, state)
    VALUES (${WORKER}, ${OWNER}, NULL, '{}', 'ready')`;
  yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state)
    VALUES ('done-1', ${PURGED}, ${OWNER}, 'done', 'report', ${OLD}, 'completed')`;
});

const rowsOf = (threadId: string) =>
  Effect.flatMap(
    Effect.service(SqlClient.SqlClient),
    (sql) => sql<{ n: number }>`SELECT
      (SELECT count(*) FROM projection_threads WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM projection_turns WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM provider_session_runtime WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM projection_thread_sessions WHERE thread_id = ${threadId}) +
      (SELECT count(*) FROM orchestration_command_receipts WHERE aggregate_id = ${threadId}) +
      (SELECT count(*) FROM custom_worker_jobs WHERE worker_id = ${threadId} OR target_id = ${threadId})
      AS n`,
  ).pipe(Effect.map((rows) => rows[0]!.n));

it.layer(NodeServices.layer)("SettledThreadPurge", (it) => {
  it.effect("removes a settled thread's rows and exact transcripts, and survives a restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-01T00:00:00.000Z"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-purge-state-" });
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-purge-workspace-" });
      const claudeHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-purge-claude-" });
      const project = path.join(claudeHome, "projects", "-workspace");
      yield* fs.makeDirectory(path.join(project, SESSION, "subagents"), { recursive: true });
      yield* fs.makeDirectory(path.join(project, "memory"), { recursive: true });
      yield* fs.writeFileString(path.join(project, `${SESSION}.jsonl`), "0123456789");
      yield* fs.writeFileString(path.join(project, SESSION, "subagents", "agent.jsonl"), "abc");
      yield* fs.writeFileString(path.join(project, `${OTHER_SESSION}.jsonl`), "kept");
      yield* fs.writeFileString(path.join(project, "memory", "MEMORY.md"), "kept");
      const gitCalls: Array<ExecuteGitInput> = [];
      const server = makeServer({ baseDir, claudeHome, gitCalls });

      const lastSequence = yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const sql = yield* SqlClient.SqlClient;
        const purge = yield* SettledThreadPurge;
        yield* seed(workspace);

        const preview = yield* purge.purge({ settledForDays: 30 });
        expect(preview.dryRun).toBe(true);
        expect(preview.purged.map((thread) => thread.threadId)).toEqual([PURGED]);
        expect(preview.purged[0]?.transcriptPaths.toSorted()).toEqual([
          path.join(project, SESSION),
          path.join(project, `${SESSION}.jsonl`),
        ]);
        expect(preview.skipped).toEqual([
          { threadId: OWNER, title: OWNER, reason: `owns worker ${WORKER}, which is kept` },
        ]);
        expect(preview.rowCounts.projection_thread_activities).toBe(1);
        expect(yield* rowsOf(PURGED)).toBeGreaterThan(5);
        expect(yield* fs.exists(path.join(project, `${SESSION}.jsonl`))).toBe(true);

        const report = yield* purge.purge({ settledForDays: 30, dryRun: false });
        expect(report.failed).toEqual([]);
        expect(report.purged.map((thread) => thread.threadId)).toEqual([PURGED]);
        expect(report.bytesRemoved).toBe(13);
        expect(report.purged[0]?.checkpointRefs).toBe(2);
        const prefix = checkpointRefPrefixForThread(PURGED);
        expect(gitCalls.at(-1)?.stdin).toBe(`delete ${prefix}turn/0\ndelete ${prefix}turn/1\n`);
        expect(yield* rowsOf(PURGED)).toBe(0);
        expect(
          yield* sql<{ event_type: string }>`SELECT event_type FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${PURGED}`,
        ).toEqual([{ event_type: "thread.deleted" }]);
        expect((yield* fs.readDirectory(project)).toSorted()).toEqual([
          `${OTHER_SESSION}.jsonl`,
          "memory",
        ]);
        expect(yield* fs.exists(path.join(project, "memory", "MEMORY.md"))).toBe(true);
        // The running engine no longer knows the thread, exactly as after a restart.
        const rejected = yield* Effect.flip(
          engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-again"),
            threadId: PURGED,
          }),
        );
        expect(rejected.message).toMatch(/does not exist/);
        return yield* engine.latestSequence;
      }).pipe(Effect.provide(server));

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const readModel = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
        expect(readModel.threads.map((thread) => thread.id).toSorted()).toEqual([OWNER, WORKER]);
        expect(readModel.snapshotSequence).toBe(lastSequence);
        const next = yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("rename-owner"),
          threadId: OWNER,
          title: "renamed",
        });
        expect(next.sequence).toBeGreaterThan(lastSequence);
      }).pipe(Effect.provide(server));
    }),
  );
});
