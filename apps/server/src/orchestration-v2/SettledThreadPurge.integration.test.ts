// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as SqlClient from "effect/sql/SqlClient";

import { model, seed } from "../workers/integration.testkit.ts";
import { type Computer, makeComputer, newNetwork, on } from "../workers/peerWorld.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as SettledThreadPurge from "./SettledThreadPurge.ts";

const id = (name: string) => ThreadId.make(`thread:${name}`);
const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const write = (file: string, text = "transcript\n") => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text);
  return file;
};

type Driver = "codex" | "claudeAgent" | "deepseekHarness" | "pi";

/** What a thread of the fixture gets, and where its native files live. */
interface Seeded {
  readonly files: ReadonlyArray<string>;
}

const fixture = (world: Computer) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const old = DateTime.subtract(now, { days: 3 });
    const event = (name: string) => EventId.make(`seed:${name}`);

    const create = (name: string) => seed(id(name), world.root);
    const settle = (name: string, at: DateTime.Utc = old) =>
      orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle:${name}`),
        threadId: id(name),
        settledAt: at,
      });

    /** A user message, and the run it started in the given state. */
    const history = Effect.fn("history")(function* (
      name: string,
      status: "completed" | "running" = "completed",
      sourcePlan?: string,
    ) {
      const threadId = id(name);
      const runId = RunId.make(`run:${name}`);
      const messageId = MessageId.make(`message:${name}`);
      yield* sink.write({
        events: [
          {
            id: event(`message:${name}`),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: null,
              role: "user",
              text: `hello from ${name}`,
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: event(`run:${name}`),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: model.instanceId,
              modelSelection: model,
              providerThreadId: null,
              userMessageId: messageId,
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: now,
              startedAt: now,
              completedAt: status === "completed" ? now : null,
              checkpointId: null,
              contextHandoffId: null,
              ...(sourcePlan === undefined
                ? {}
                : {
                    sourcePlanRef: {
                      threadId: id(sourcePlan),
                      planId: `plan:${sourcePlan}` as never,
                    },
                  }),
            },
          },
        ],
      });
    });

    const bind = Effect.fn("bind")(function* (name: string, driver: Driver, nativeId: string) {
      const threadId = id(name);
      yield* sink.write({
        events: [
          {
            id: event(`provider-thread:${name}`),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: ProviderThreadId.make(`provider-thread:${name}`),
              driver: driver as never,
              providerInstanceId: (driver === "codex" ? model.instanceId : driver) as never,
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver: driver as never, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    });

    const transcripts = {
      codex: (native: string) => [
        write(
          NodePath.join(
            world.codexHome,
            `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${native}.jsonl`,
          ),
        ),
      ],
      claudeAgent: (native: string) => [
        write(NodePath.join(world.claudeHome, `projects/-work-project/${native}.jsonl`)),
        write(
          NodePath.join(world.claudeHome, `projects/-work-project/${native}/tool-results/a.txt`),
        ),
      ],
      deepseekHarness: (native: string) => [
        write(NodePath.join(world.dshHome, `sessions/bucket/${native}/transcript.jsonl`)),
        write(NodePath.join(world.dshHome, `sessions/bucket/${native}/artifacts/note.txt`)),
      ],
      pi: (native: string) => [native],
    } as const;
    const session = Effect.fn("session")(function* (name: string, driver: Driver, digit: string) {
      const native =
        driver === "pi"
          ? write(NodePath.join(world.piHome, `sessions/--work--/2026-01-01_${uuid(digit)}.jsonl`))
          : uuid(digit);
      yield* bind(name, driver, native);
      return { files: transcripts[driver](native) } satisfies Seeded;
    });

    const worker = (workerId: string, ownerId: string, state = "ready") =>
      sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, notify)
        VALUES (${id(workerId)}, ${id(ownerId)}, '{}', ${state}, 1)`;
    const job = (jobId: string, workerId: string, targetId: string, state: string) =>
      sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state)
        VALUES (${jobId}, ${id(workerId)}, ${id(targetId)}, 'task', 'p', ${DateTime.formatIso(now)}, ${state})`;

    // The threads that go.
    const seeded: Record<string, Seeded> = {};
    for (const [name, driver, digit] of [
      ["codex-old", "codex", "1"],
      ["claude-old", "claudeAgent", "2"],
      ["dsh-old", "deepseekHarness", "3"],
      ["pi-old", "pi", "4"],
    ] as const) {
      yield* create(name);
      yield* history(name);
      seeded[name] = yield* session(name, driver, digit);
      yield* settle(name);
    }
    // A sibling session in each home belongs to nobody and must stay.
    const siblings = [
      ...transcripts.codex(uuid("a")),
      ...transcripts.claudeAgent(uuid("b")),
      ...transcripts.deepseekHarness(uuid("c")),
      write(NodePath.join(world.piHome, `sessions/--work--/2026-01-01_${uuid("d")}.jsonl`)),
    ];

    for (const name of ["master-gone", "worker-gone", "deleted-earlier"]) {
      yield* create(name);
      yield* history(name);
    }
    yield* worker("worker-gone", "master-gone");
    yield* settle("master-gone");
    yield* settle("worker-gone");
    // Deleted before the purge: its tombstone exists.
    yield* settle("deleted-earlier");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:deleted-earlier"),
      threadId: id("deleted-earlier"),
    });
    // Checkpoints and a worktree for the first thread: one V2 ref with its scope, one V1 ref.
    const worktree = NodePath.join(world.root, "..", `${NodePath.basename(world.root)}-worktree`);
    NodeFS.mkdirSync(worktree, { recursive: true });
    const head = git(world.root, "rev-parse", "HEAD");
    const v2Ref = "refs/t3/orchestration-v2/checkpoints/scope/ordinal/1";
    const v1Ref = `refs/t3/checkpoints/${Base64Url.encode(id("codex-old"))}/turn/1`;
    git(world.root, "update-ref", v2Ref, head);
    git(world.root, "update-ref", v1Ref, head);
    git(world.root, "update-ref", "refs/t3/checkpoints/unrelated/turn/1", head);
    const scopeId = CheckpointScopeId.make("scope:codex-old");
    yield* sink.write({
      events: [
        {
          id: event("scope"),
          type: "checkpoint-scope.created",
          threadId: id("codex-old"),
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId: id("codex-old"),
            runId: RunId.make("run:codex-old"),
            nodeId: NodeId.make("node:codex-old"),
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: world.root,
            createdAt: now,
          },
        },
        {
          id: event("checkpoint"),
          type: "checkpoint.captured",
          threadId: id("codex-old"),
          occurredAt: now,
          payload: {
            id: CheckpointId.make("checkpoint:codex-old"),
            threadId: id("codex-old"),
            scopeId,
            runId: RunId.make("run:codex-old"),
            nodeId: NodeId.make("node:codex-old"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: null,
            ref: v2Ref as never,
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* sql`INSERT INTO session_workspaces (reservation_id, thread_id, binding_json, state, active)
      VALUES ('workspace:codex-old', ${id("codex-old")},
        ${JSON.stringify({ workspaceDirectory: worktree })}, 'ready', 1)`;

    // The threads that stay, each for one reason.
    const keepReasons: Record<string, string> = {};
    const keep = (name: string, reason: string) => {
      keepReasons[id(name)] = reason;
    };

    yield* create("pinned");
    yield* history("pinned");
    yield* settle("pinned");
    // Pinning unsettles and settling unpins, so only older or imported data is both.
    const pinnedThread = (yield* orchestrator.getThreadProjection(id("pinned"))).thread;
    yield* sink.write({
      events: [
        {
          id: event("pin:pinned"),
          type: "thread.pinned",
          threadId: id("pinned"),
          occurredAt: now,
          payload: { ...pinnedThread, pinnedAt: now },
        },
      ],
    });
    keep("pinned", "pinned");

    // Settled, then a run starts again: settling a running thread is refused.
    yield* create("live");
    yield* history("live");
    yield* settle("live");
    yield* sink.write({
      events: [
        {
          id: event("run:live:again"),
          type: "run.created",
          threadId: id("live"),
          runId: RunId.make("run:live:again"),
          occurredAt: now,
          payload: {
            id: RunId.make("run:live:again"),
            threadId: id("live"),
            ordinal: 2,
            providerInstanceId: model.instanceId,
            modelSelection: model,
            providerThreadId: null,
            userMessageId: MessageId.make("message:live"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    keep("live", "still active");

    yield* create("unsettled");
    yield* history("unsettled", "completed", "plan-source");
    yield* create("plan-source");
    yield* settle("plan-source");
    keep("plan-source", "shares a proposed plan with thread:unsettled");

    yield* create("master-kept");
    yield* create("worker-live");
    yield* worker("worker-live", "master-kept");
    yield* settle("master-kept");
    keep("master-kept", "owns worker thread:worker-live, which is kept");

    yield* create("job-sender");
    yield* job("job-1", "job-sender", "unsettled", "queued");
    yield* settle("job-sender");
    keep("job-sender", "worker job job-1 for thread:unsettled is queued");

    yield* create("handoff-owner");
    yield* sql`INSERT INTO custom_orchestrator_handoffs (thread_id, owner_id, plan_json)
      VALUES (${id("unsettled")}, ${id("handoff-owner")}, '{}')`;
    yield* settle("handoff-owner");
    keep("handoff-owner", "handed off to thread:unsettled, which is kept");

    yield* create("shared");
    const shared = yield* session("shared", "codex", "5");
    yield* settle("shared");
    yield* bind("unsettled", "codex", uuid("5"));
    keep("shared", "shares its provider session with thread:unsettled");

    yield* create("parked");
    yield* settle("parked");
    yield* sql`INSERT INTO custom_session_moves
      (id, thread_id, target_thread_id, direction, peer_environment_id, state, locked, input_json, created_at, updated_at)
      VALUES ('move:parked', ${id("parked")}, ${id("parked")}, 'out', 'environment-b', 'complete', 1, '{}', 'x', 'x')`;
    keep("parked", "session move");

    yield* create("remote-master");
    yield* worker("peer-worker", "remote-master", "remote");
    yield* settle("remote-master");
    keep("remote-master", "owns worker thread:peer-worker");

    // Settled today: not a candidate at all.
    yield* create("fresh");
    yield* settle("fresh", now);

    // The last event of the log belongs to a thread that goes: a late provider message.
    yield* sink.write({
      events: [
        {
          id: event("late:deleted-earlier"),
          type: "message.updated",
          threadId: id("deleted-earlier"),
          occurredAt: now,
          payload: {
            id: MessageId.make("message:late"),
            threadId: id("deleted-earlier"),
            runId: null,
            nodeId: null,
            role: "assistant",
            text: "late output",
            attachments: [],
            streaming: false,
            createdBy: "system",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });

    return {
      purged: [
        "codex-old",
        "claude-old",
        "dsh-old",
        "pi-old",
        "master-gone",
        "worker-gone",
        "deleted-earlier",
      ].map(id),
      keepReasons,
      seeded,
      siblings,
      shared,
      refs: { v2Ref, v1Ref },
      worktree,
    };
  });

const THREAD_TABLES = [
  ["orchestration_v2_projection_messages", "thread_id"],
  ["orchestration_v2_projection_runs", "thread_id"],
  ["orchestration_v2_projection_provider_threads", "thread_id"],
  ["orchestration_v2_projection_checkpoints", "thread_id"],
  ["orchestration_v2_projection_checkpoint_scopes", "thread_id"],
  ["orchestration_v2_turn_item_positions", "thread_id"],
  ["custom_workers", "thread_id"],
  ["session_workspaces", "thread_id"],
] as const;

/** Row counts of every table a thread owns rows in, plus its event types. */
const footprint = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const counts: Record<string, number> = {};
    for (const [table, column] of THREAD_TABLES) {
      const rows = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`,
        [threadId],
      );
      counts[table] = rows[0]!.n;
    }
    const events = yield* sql<{ event_type: string }>`
      SELECT event_type FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} ORDER BY sequence`;
    return { counts, events: events.map((row) => row.event_type) };
  });

const worldWithPurge = Effect.gen(function* () {
  const world = yield* makeComputer(
    EnvironmentId.make("environment-a"),
    EnvironmentId.make("environment-b"),
    newNetwork(),
  );
  // The server's effect daemon, which the purge waits on for the deletion's cleanup effects.
  yield* Effect.forkScoped(on(world, EffectWorker.runDaemonWithOptions()));
  return world;
});

it.effect("lists what goes and what stays, then purges exactly that, with one tombstone each", () =>
  Effect.gen(function* () {
    const world = yield* worldWithPurge;
    const seeded = yield* on(world, fixture(world));
    yield* on(
      world,
      Effect.gen(function* () {
        const purge = yield* SettledThreadPurge.SettledThreadPurge;
        const sql = yield* SqlClient.SqlClient;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const before = new Map<string, Awaited<ReturnType<never>> | unknown>();
        const everyone = [
          ...seeded.purged,
          ...Object.keys(seeded.keepReasons).map((key) => ThreadId.make(key)),
        ];
        for (const threadId of everyone) before.set(threadId, yield* footprint(threadId));
        const events = () =>
          sql<{ n: number }>`SELECT count(*) AS n FROM orchestration_events`.pipe(
            Effect.map((rows) => rows[0]!.n),
          );
        const eventsBefore = yield* events();

        // The dry run is the default and changes nothing.
        const dry = yield* purge.purge({ settledForDays: 1 });
        assert.isTrue(dry.dryRun);
        assert.deepEqual(
          dry.purged.map((entry) => entry.threadId).toSorted(),
          [...seeded.purged].toSorted(),
        );
        for (const [threadId, reason] of Object.entries(seeded.keepReasons)) {
          const skipped = dry.skipped.find((entry) => entry.threadId === threadId);
          assert.isDefined(skipped, `${threadId} is listed as kept`);
          assert.include(skipped!.reason, reason);
        }
        assert.strictEqual(dry.skipped.length, Object.keys(seeded.keepReasons).length);
        const codex = dry.purged.find((entry) => entry.threadId === id("codex-old"))!;
        assert.strictEqual(codex.checkpointRefs, 2);
        assert.strictEqual(codex.worktreePath, world.root);
        assert.strictEqual(yield* events(), eventsBefore);
        for (const files of Object.values(seeded.seeded))
          for (const file of files.files) assert.isTrue(NodeFS.existsSync(file));
        assert.strictEqual(git(world.root, "for-each-ref", "refs/t3/").split("\n").length, 3);

        const report = yield* purge.purge({ settledForDays: 1, dryRun: false });
        assert.isFalse(report.dryRun);
        assert.deepEqual(report.failed, []);
        assert.deepEqual(
          report.purged.map((entry) => entry.threadId).toSorted(),
          [...seeded.purged].toSorted(),
        );

        // Each purged thread keeps one thread.deleted event and no other rows.
        for (const threadId of seeded.purged) {
          const after = yield* footprint(threadId);
          assert.deepEqual(after.events, ["thread.deleted"], `${threadId} keeps one event`);
          assert.isTrue(
            Object.values(after.counts).every((count) => count === 0),
            `${threadId} owns no rows`,
          );
          const shell = yield* sql<{ deleted_at: string | null }>`
              SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
          assert.isNotNull(shell[0]!.deleted_at);
        }
        // The thread deleted earlier kept the tombstone it already had.
        assert.strictEqual(
          (yield* sql<{ n: number }>`SELECT count(*) AS n FROM orchestration_events
              WHERE stream_id = ${id("deleted-earlier")} AND event_type = 'thread.deleted'`)[0]!.n,
          1,
        );
        for (const threadId of Object.keys(seeded.keepReasons)) {
          assert.deepEqual(
            yield* footprint(ThreadId.make(threadId)),
            before.get(threadId),
            `${threadId} is untouched`,
          );
        }
        assert.isDefined(
          (yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${id("fresh")}`)[0],
        );

        // Exactly the purged threads' native files and checkpoint refs went; worktrees stay.
        for (const [name, files] of Object.entries(seeded.seeded)) {
          for (const file of files.files)
            assert.isFalse(NodeFS.existsSync(file), `${name}: ${file}`);
        }
        for (const file of [...seeded.siblings, ...seeded.shared.files])
          assert.isTrue(NodeFS.existsSync(file), file);
        assert.strictEqual(
          git(world.root, "for-each-ref", "--format=%(refname)", "refs/t3/"),
          "refs/t3/checkpoints/unrelated/turn/1",
        );
        assert.isTrue(NodeFS.existsSync(seeded.worktree));
        // Codex rollout, Claude transcript and its directory, the DeepSeek Harness directory, the Pi file.
        assert.strictEqual(report.transcriptPathsRemoved.length, 5);

        // Nothing needs a restart: the log and projections agree, and replaying them rebuilds the same.
        const verified = yield* maintenance.verify;
        assert.deepEqual(verified, { ...verified, valid: true });
        const snapshot = (threadId: string) =>
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`.pipe(
            Effect.map((rows) => rows[0]?.payload_json),
          );
        const shells = new Map<string, string | undefined>();
        for (const threadId of everyone) shells.set(threadId, yield* snapshot(threadId));
        const rebuilt = yield* maintenance.rebuild;
        assert.isTrue(rebuilt.valid);
        for (const threadId of everyone) {
          assert.strictEqual(
            yield* snapshot(threadId),
            shells.get(threadId),
            `${threadId} replays the same`,
          );
        }

        // A second run finds nothing left to purge.
        const again = yield* purge.purge({ settledForDays: 1 });
        assert.deepEqual(again.purged, []);
        assert.strictEqual(again.skipped.length, Object.keys(seeded.keepReasons).length);
      }),
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps the projection cursor on the log when the purged thread owned its end", () =>
  Effect.gen(function* () {
    const world = yield* worldWithPurge;
    yield* on(
      world,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const purge = yield* SettledThreadPurge.SettledThreadPurge;
        const threadId = id("last");
        yield* seed(threadId, world.root);
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle:last"),
          threadId,
          settledAt: DateTime.subtract(yield* DateTime.now, { days: 3 }),
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete:last"),
          threadId,
        });
        // Output that arrives after the thread was deleted is the newest event of the log.
        const at = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("seed:late:last"),
              type: "message.updated",
              threadId,
              occurredAt: at,
              payload: {
                id: MessageId.make("message:late:last"),
                threadId,
                runId: null,
                nodeId: null,
                role: "assistant",
                text: "late output",
                attachments: [],
                streaming: false,
                createdBy: "system",
                creationSource: "web",
                createdAt: at,
                updatedAt: at,
              },
            },
          ],
        });
        assert.isTrue((yield* maintenance.verify).valid);
        const report = yield* purge.purge({ settledForDays: 1, dryRun: false });
        assert.deepEqual(
          report.purged.map((entry) => entry.threadId),
          [threadId],
        );
        const verified = yield* maintenance.verify;
        assert.deepEqual(verified, { ...verified, valid: true });
        assert.strictEqual(verified.projectionSequence, verified.expectedSequence);
      }),
    );
  }).pipe(Effect.scoped),
);
