import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerWorld, master, model, project, seed, setLatestRun } from "./integration.testkit.ts";
import * as WorkerService from "./WorkerService.ts";
import { WorkerError } from "./workerSchemas.ts";

const spawnInput = (threadId: ThreadId, prompt: string) => ({
  threadId,
  title: "Worker",
  modelSelection: model,
  prompt,
  projectId: project,
});

it.layer(layerWorld())("workers over the real orchestrator", (it) => {
  it.effect("spawns a fresh worker, delivers one assignment and its done report", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = ThreadId.make("thread:worker-fresh");

      const spawned = yield* workers.spawn(master, spawnInput(worker, "Do the thing"));
      const retried = yield* workers.spawn(master, spawnInput(worker, "Do the thing"));
      assert.equal(retried.threadId, spawned.threadId);

      const created = yield* orchestrator.getThreadProjection(worker);
      assert.lengthOf(created.runs, 1);
      assert.equal(created.messages.filter((message) => message.role === "user").length, 1);

      yield* setLatestRun(worker, "running");
      const refused = yield* workers
        .report(worker, {
          clientRequestId: "report-blocked",
          outcome: "blocked",
          summary: "Stuck on the build.",
        })
        .pipe(Effect.flip);
      assert.include((refused as WorkerError).message, "communication window");

      yield* workers.report(worker, {
        clientRequestId: "report-done",
        outcome: "done",
        summary: "Finished the thing.",
      });
      yield* setLatestRun(worker, "completed");
      yield* workers.drain();

      const delivered = yield* orchestrator.getThreadProjection(master);
      const reports = delivered.messages.filter((message) =>
        message.text.includes("[T3 worker report"),
      );
      assert.lengthOf(reports, 1);
      assert.include(reports[0]!.text, "Finished the thing.");
      yield* workers.drain();
      const again = yield* orchestrator.getThreadProjection(master);
      assert.lengthOf(
        again.messages.filter((message) => message.text.includes("[T3 worker report")),
        1,
      );
    }),
  );

  it.effect("adds working time and a renewal warning to a done report", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const worker = ThreadId.make("thread:worker-hours");
      yield* settings.updateSettings({ workerRenewal: { workerHours: 1 } });
      yield* workers.spawn(master, spawnInput(worker, "Long task"));
      yield* setLatestRun(worker, "running");
      yield* TestClock.adjust(Duration.minutes(90));
      yield* workers.report(worker, {
        clientRequestId: "report-hours",
        outcome: "done",
        summary: "Done after a long while.",
      });
      const sql = yield* SqlClient.SqlClient;
      const text = (yield* sql<{
        prompt: string;
      }>`SELECT prompt FROM custom_worker_jobs WHERE id = ${`report:${worker}:report-hours`}`)[0]!
        .prompt;
      assert.match(text, /Worker working time: \d+\.\d h over 1 turn, 0 compactions\./);
      assert.include(text, "Over the 1.5 h renewal threshold");
      yield* settings.updateSettings({ workerRenewal: { workerHours: 3.5 } });
    }),
  );

  it.effect("renews one hard-limit master with its child and queued report", () =>
    Effect.gen(function* () {
      const boss = ThreadId.make("thread:renewal-master");
      const child = ThreadId.make("thread:renewal-child");
      yield* seed(boss);
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      yield* settings.updateSettings({
        workerRenewal: { masterHardHours: 1, toolWaitSeconds: 0 },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("renewal-master:work"),
        threadId: boss,
        messageId: MessageId.make("renewal-master:work"),
        text: "Long master task",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* setLatestRun(boss, "running");
      yield* TestClock.adjust(Duration.minutes(90));
      yield* setLatestRun(boss, "completed");
      yield* workers.spawn(boss, spawnInput(child, "Held task"));
      yield* setLatestRun(child, "running");
      yield* setLatestRun(child, "completed");

      yield* workers.drain();
      const checkpointId = `renewal:${boss}:checkpoint`;
      const checkpoint = (yield* orchestrator.getThreadProjection(boss)).runs.find(
        (run) => run.userMessageId === checkpointId,
      );
      assert.isDefined(checkpoint);
      yield* sql`INSERT INTO custom_worker_jobs
        (id, worker_id, target_id, kind, prompt, created_at, state)
        VALUES ('report:queued-before-renewal', ${child}, ${boss}, 'done',
          '[T3 worker report] queued before renewal', ${DateTime.formatIso(yield* DateTime.now)}, 'queued')`;
      yield* setLatestRun(boss, "running");
      const repliedAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("renewal-checkpoint:assistant"),
            type: "message.updated",
            threadId: boss,
            runId: checkpoint!.id,
            occurredAt: repliedAt,
            payload: {
              id: MessageId.make("renewal-checkpoint:assistant"),
              threadId: boss,
              runId: checkpoint!.id,
              nodeId: checkpoint!.rootNodeId,
              role: "assistant",
              text: "The task is half done. Finish the remaining verifier.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: repliedAt,
              updatedAt: repliedAt,
            },
          },
        ],
      });
      yield* setLatestRun(boss, "completed");
      yield* workers.drain();

      const handoffs = yield* sql<{
        thread_id: string;
        state: string;
        transferred_json: string;
      }>`SELECT thread_id, state, transferred_json FROM custom_orchestrator_handoffs
        WHERE owner_id = ${boss}`;
      assert.lengthOf(handoffs, 1);
      assert.equal(handoffs[0]!.state, "completed");
      const successor = ThreadId.make(handoffs[0]!.thread_id);
      assert.deepEqual(JSON.parse(handoffs[0]!.transferred_json), [child]);
      assert.equal((yield* workers.readOwnership(child)).ownerThreadId, successor);
      const queued = yield* sql<{
        target_id: string;
      }>`SELECT target_id FROM custom_worker_jobs WHERE id = 'report:queued-before-renewal'`;
      assert.equal(queued[0]!.target_id, successor);
      const renewal = yield* sql<{
        successor_id: string;
        state: string;
      }>`SELECT successor_id, state FROM custom_session_renewals WHERE thread_id = ${boss}`;
      assert.equal(renewal[0]?.successor_id, successor);
      assert.equal(renewal[0]?.state, "completed");
      const authority = yield* sql<{
        active: number;
        successor_id: string;
      }>`SELECT active, successor_id FROM custom_orchestrator_authority WHERE thread_id = ${boss}`;
      assert.equal(authority[0]?.active, 0);
      assert.equal(authority[0]?.successor_id, successor);

      yield* workers.drain();
      assert.lengthOf(
        yield* sql`SELECT 1 FROM custom_orchestrator_handoffs WHERE owner_id = ${boss}`,
        1,
      );
    }),
  );

  it.effect("keeps a queued assignment and its report across a service restart", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const worker = ThreadId.make("thread:worker-restart");

      yield* workers.spawn(master, spawnInput(worker, "First"));
      yield* setLatestRun(worker, "running");
      const second = yield* workers.send(master, {
        threadId: worker,
        clientRequestId: "req-restart-1",
        prompt: "Second",
      });
      const retry = yield* workers.send(master, {
        threadId: worker,
        clientRequestId: "req-restart-1",
        prompt: "Second",
      });
      assert.equal(retry.requestId, second.requestId);
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM custom_worker_jobs WHERE worker_id = ${worker}`)[0]!.count,
        2,
      );

      // A restart rebuilds the service from the database alone: a fresh instance sees the same jobs.
      const context = yield* Effect.context<
        | SqlClient.SqlClient
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | ProviderRegistry
        | ServerSettings.ServerSettingsService
        | ProjectService.ProjectService
        | ServerEnvironment.ServerEnvironmentIdentity
      >();
      const restarted = yield* Layer.build(
        Layer.fresh(WorkerService.layer).pipe(Layer.provide(Layer.succeedContext(context))),
      ).pipe(Effect.map((built) => Context.get(built, WorkerService.WorkerService)));
      yield* setLatestRun(worker, "completed");
      yield* restarted.drain();
      const read = yield* restarted.read(master, { threadId: worker });
      assert.equal(read.worker.threadId, worker);
      const projection = yield* orchestrator.getThreadProjection(worker);
      assert.isAtLeast(projection.runs.length, 1);
    }),
  );

  it.effect("forks a worker from an idle base and accepts a blocker once the window is over", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const base = ThreadId.make("thread:base");
      const forked = ThreadId.make("thread:worker-forked");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:base"),
        threadId: base,
        projectId: project,
        title: "Base",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        createdBy: "user",
        creationSource: "web",
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("base:first"),
        threadId: base,
        messageId: MessageId.make("message:base-first"),
        text: "Set things up.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* setLatestRun(base, "running");
      yield* setLatestRun(base, "completed");

      const spawned = yield* workers.spawn(master, {
        ...spawnInput(forked, "Continue from the base."),
        sourceThreadId: base,
      });
      assert.equal(spawned.sourceThreadId, base);
      const projection = yield* orchestrator.getThreadProjection(forked);
      assert.lengthOf(projection.runs, 1);

      yield* setLatestRun(forked, "running");
      yield* workers.drain();
      yield* TestClock.adjust(Duration.minutes(16));
      yield* workers.report(forked, {
        clientRequestId: "blocked-1",
        outcome: "blocked",
        needs: "master",
        summary: "Needs the signing key.",
      });
      yield* workers.drain();
      const delivered = yield* orchestrator.getThreadProjection(master);
      assert.isTrue(
        delivered.messages.some((message) => message.text.includes("Needs the signing key.")),
      );
    }),
  );

  it.effect("hands workers to a successor and reclaims one on the user's instruction", () =>
    Effect.gen(function* () {
      const boss = ThreadId.make("thread:boss");
      yield* seed(boss);
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const successor = ThreadId.make("thread:successor");
      const owned = ThreadId.make("thread:worker-owned");
      yield* workers.spawn(boss, spawnInput(owned, "Hold this."));

      const handoff = yield* workers.handoff(boss, {
        threadId: successor,
        title: "Successor",
        modelSelection: model,
        prompt: "Carry on with the plan.",
      });
      assert.deepEqual(handoff.transferredWorkerIds, [owned]);
      assert.deepEqual(
        (yield* workers.list(successor)).map((entry) => entry.threadId),
        [owned],
      );
      assert.lengthOf(yield* workers.list(boss), 0);
      assert.equal((yield* workers.readOwnership(owned)).ownerThreadId, successor);

      const typed = yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("user:take-back"),
        threadId: boss,
        messageId: MessageId.make("message:take-back"),
        text: "Please take back the held worker.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.isDefined(typed);
      const reclaimed = yield* workers.reclaim(boss, {
        clientRequestId: "reclaim-real",
        workerThreadIds: [owned],
        userRequest: "take back the held worker",
      });
      assert.deepEqual(reclaimed.workerThreadIds, [owned]);
      assert.equal((yield* workers.readOwnership(owned)).ownerThreadId, boss);
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM custom_worker_reclaims`;
      assert.equal(rows[0]!.count, 1);
    }),
  );

  it.effect("serves a worker carried over from the custom fork", () =>
    Effect.gen(function* () {
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const imported = ThreadId.make("thread:imported");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:imported"),
        threadId: imported,
        projectId: project,
        title: "Imported worker",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        createdBy: "agent",
        creationSource: "mcp",
      });
      const baseline =
        yield* (yield* ThreadManagementService.ThreadManagementService).getThreadEventSequence(
          imported,
        );
      const plan = JSON.stringify({
        threadId: imported,
        projectId: project,
        title: "Imported worker",
        modelSelection: model,
        prompt: "Original task",
        runtimeMode: "full-access",
        interactionMode: "default",
        authorityRevision: 3,
      });
      yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, baseline, read_seq, notify)
        VALUES (${imported}, ${master}, ${plan}, 'ready', ${baseline}, ${baseline}, 1)`;
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, turn_id, reported, dispatched_at)
        VALUES (${`spawn:${imported}`}, ${imported}, ${imported}, 'work', 'Original task', '2026-10-01T00:00:00.000Z', 'completed', 'turn-v1', 1, '2026-10-01T00:00:00.000Z')`;

      const listed = yield* workers.list(master);
      assert.isTrue(listed.some((entry) => entry.threadId === imported));
      const sent = yield* workers.send(master, {
        threadId: imported,
        clientRequestId: "imported-1",
        prompt: "Continue with the next step.",
      });
      assert.equal(sent.threadId, imported);
      const read = yield* workers.read(master, { threadId: imported });
      assert.isTrue(read.items.some((item) => item.text.includes("Continue with the next step.")));
      assert.equal((yield* workers.readOwnership(imported)).ownerThreadId, master);
    }),
  );
});
