import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  World,
  WorkerService,
  claude,
  codex,
  layerFor,
  projectId,
} from "./WorkerService.testkit.ts";
import { WorkerError } from "./workerSchemas.ts";

const master = ThreadId.make("thread:master");
const worker = ThreadId.make("thread:worker");
const other = ThreadId.make("thread:other");

const harness = (setup?: (world: World) => void) => {
  const world = new World();
  world.addThread(master);
  setup?.(world);
  const layer = layerFor(world).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  return {
    world,
    run: <A, E>(effect: Effect.Effect<A, E, WorkerService | SqlClient.SqlClient>) =>
      effect.pipe(Effect.provide(layer)),
  };
};

const spawnInput = (threadId = worker, extra: object = {}) => ({
  threadId,
  title: "Worker",
  modelSelection: codex,
  prompt: "Do the thing",
  ...extra,
});

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const finish = (world: World, threadId: string, status: "completed" | "failed" | "interrupted") =>
  Effect.gen(function* () {
    const run = world.thread(threadId).runs.at(-1)!;
    world.finishRun(threadId, run.id, status, yield* DateTime.now);
  });
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error as unknown as WorkerError),
  );

describe("spawn and send", () => {
  it.effect("launches a fresh worker, starts its assignment once and survives a retry", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const first = yield* service.spawn(master, spawnInput());
        assert.equal(first.state, "submitted");
        assert.equal(first.latestRequest?.requestId, `spawn:${worker}`);
        assert.equal(world.launched.length, 1);
        assert.equal(world.launched[0]?.projectId, projectId);
        assert.equal(world.launched[0]?.createdBy, "agent");
        assert.equal(world.sent.length, 1);
        assert.equal(world.sent[0]?.messageId, `worker-job:spawn:${worker}`);
        assert.equal(world.sent[0]?.text, "Do the thing");
        assert.equal(world.sent[0]?.senderThreadId, master);

        // The same request again neither relaunches nor resends.
        yield* service.spawn(master, spawnInput());
        assert.equal(world.launched.length, 1);
        assert.equal(world.sent.length, 1);

        const different = yield* failureOf(
          service.spawn(master, spawnInput(worker, { title: "Other" })),
        );
        assert.match(different.message, /already reserved/);
        const listed = yield* service.list(master);
        assert.deepEqual(
          listed.map((entry) => entry.threadId),
          [worker],
        );
      }),
    );
  });

  it.effect("forks an idle base on the same account and refuses a busy or mismatched one", () => {
    const base = ThreadId.make("thread:base");
    const { world, run } = harness((setup) =>
      setup.addThread(base, { runtimeMode: "full-access" }),
    );
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const forked = yield* service.spawn(master, spawnInput(worker, { sourceThreadId: base }));
        assert.equal(forked.sourceThreadId, base);
        assert.equal(world.dispatched[0]?.type, "thread.fork");
        assert.equal(world.launched.length, 0);

        const mismatch = yield* failureOf(
          service.spawn(
            master,
            spawnInput(other, { sourceThreadId: base, modelSelection: claude }),
          ),
        );
        assert.match(mismatch.message, /same provider account/);

        world.thread(base).runs.push({
          id: "run:busy",
          status: "running",
        } as never);
        const busy = yield* failureOf(
          service.spawn(
            master,
            spawnInput(ThreadId.make("thread:third"), { sourceThreadId: base }),
          ),
        );
        assert.match(busy.message, /busy/);
      }),
    );
  });

  it.effect("refuses an account turned off for workers", () => {
    const { world, run } = harness();
    world.disabledInstances = ["codex"];
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const error = yield* failureOf(service.spawn(master, spawnInput()));
        assert.match(error.message, /Turned off for workers/);
        assert.equal(world.launched.length, 0);
      }),
    );
  });

  it.effect("steers a busy worker, queues behind a non-steerable run, and dedupes retries", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        const first = yield* service.send(master, {
          threadId: worker,
          clientRequestId: "again",
          prompt: "Also this",
        });
        assert.equal(first.requestId, `${worker}:again`);
        // The worker was running, so the message went in as a steer, not a second run.
        assert.equal(world.sent.at(-1)?.mode, "auto");
        assert.equal(world.thread(worker).runs.length, 1);
        const retry = yield* service.send(master, {
          threadId: worker,
          clientRequestId: "again",
          prompt: "Also this",
        });
        assert.equal(retry.requestId, first.requestId);
        assert.equal(world.sent.length, 2);
        const changed = yield* failureOf(
          service.send(master, { threadId: worker, clientRequestId: "again", prompt: "Different" }),
        );
        assert.match(changed.message, /different assignment/);
      }),
    );
  });

  it.effect("rejects a send after the worker's settings changed until they are adopted", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        world.thread(worker).modelSelection = claude;
        const rejected = yield* failureOf(
          service.send(master, { threadId: worker, clientRequestId: "x", prompt: "Go" }),
        );
        assert.match(rejected.message, /adoptCurrentSettings/);
        const adopted = yield* service.control(master, {
          threadId: worker,
          adoptCurrentSettings: true,
        });
        assert.equal(adopted.modelSelection.instanceId, claude.instanceId);
        const accepted = yield* service.send(master, {
          threadId: worker,
          clientRequestId: "x",
          prompt: "Go",
        });
        assert.equal(accepted.state, "submitted");
      }),
    );
  });
});

describe("wait and read", () => {
  it.effect("waits for the assignment's run to end, and times out while it runs", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        const waiting = yield* Effect.forkChild(
          service.wait(master, { threadId: worker, requestId: `spawn:${worker}`, timeoutMs: 1 }),
        );
        yield* TestClock.adjust(Duration.millis(2));
        const pending = yield* Fiber.join(waiting);
        assert.isTrue(pending.timedOut);
        assert.equal(pending.request.state, "submitted");
        yield* finish(world, worker, "completed");
        const done = yield* service.wait(master, {
          threadId: worker,
          requestId: `spawn:${worker}`,
        });
        assert.isFalse(done.timedOut);
        assert.equal(done.request.state, "completed");
        assert.isNotNull(done.request.turnId);
      }),
    );
  });

  it.effect("reads new replies from a saved cursor and ignores history imported from V1", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        world.addMessage(worker, {
          id: "m0",
          role: "assistant",
          text: "old",
          eventId: "migration:v1:message:m0",
        });
        world.addMessage(worker, { id: "m1", role: "assistant", text: "first reply" });
        world.addMessage(worker, {
          id: "m2",
          role: "assistant",
          text: "streaming",
          streaming: true,
        });
        world.addMessage(worker, { id: "m3", role: "assistant", text: "second reply" });
        const first = yield* service.read(master, { threadId: worker });
        assert.deepEqual(
          first.items.map((item) => item.text),
          ["first reply", "second reply"],
        );
        assert.isFalse(first.hasMore);
        // Reading again continues after the saved cursor.
        world.addMessage(worker, { id: "m4", role: "assistant", text: "third" });
        const next = yield* service.read(master, { threadId: worker });
        assert.deepEqual(
          next.items.map((item) => item.text),
          ["third"],
        );
        // An explicit cursor rereads.
        const reread = yield* service.read(master, { threadId: worker, afterSequence: 0 });
        assert.equal(reread.items.length, 3);
        const sql = yield* SqlClient.SqlClient;
        const saved = yield* sql<{
          read_seq: number;
        }>`SELECT read_seq FROM custom_workers WHERE thread_id = ${worker}`;
        assert.equal(saved[0]?.read_seq, reread.nextSequence);
      }),
    );
  });

  it.effect("pages long text with a text offset", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        world.addMessage(worker, { id: "long", role: "assistant", text: "x".repeat(20000) });
        const first = yield* service.read(master, { threadId: worker });
        assert.equal(first.items[0]?.text.length, 12000);
        assert.equal(first.nextTextOffset, 12000);
        assert.isTrue(first.hasMore);
        const rest = yield* service.read(master, {
          threadId: worker,
          afterSequence: first.items[0]!.sequence - 1,
          textOffset: first.nextTextOffset,
        });
        assert.equal(rest.items[0]?.text.length, 8000);
        assert.equal(rest.nextTextOffset, 0);
      }),
    );
  });
});

describe("reports and the communication window", () => {
  it.effect("lets done through the window, refuses blocked, and delivers each once", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        const blocked = yield* failureOf(
          service.report(worker, { clientRequestId: "b1", outcome: "blocked", summary: "Stuck." }),
        );
        assert.equal(blocked.code, "worker_communication_window");

        yield* finish(world, worker, "completed");
        const done = yield* service.report(worker, {
          clientRequestId: "d1",
          outcome: "done",
          summary: "All finished.",
          evidence: "/tmp/evidence.md",
        });
        assert.equal(done.requestId, `report:${worker}:d1`);
        yield* service.drain();
        const delivered = world.sent.filter((input) => input.threadId === master);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.mode, "queue");
        assert.equal(delivered[0]?.senderThreadId, worker);
        assert.match(
          delivered[0]?.text ?? "",
          /Outcome: done\nAll finished\.\nEvidence: \/tmp\/evidence\.md/,
        );

        // A retry with the same ID is idempotent; a changed body is not.
        yield* service.report(worker, {
          clientRequestId: "d1",
          outcome: "done",
          summary: "All finished.",
          evidence: "/tmp/evidence.md",
        });
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 1);
        const changed = yield* failureOf(
          service.report(worker, { clientRequestId: "d1", outcome: "done", summary: "Different." }),
        );
        assert.match(changed.message, /different assignment/);
      }),
    );
  });

  it.effect("accepts a blocker after the window and holds it until then", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* TestClock.adjust(Duration.minutes(16));
        const blocked = yield* service.report(worker, {
          clientRequestId: "b1",
          outcome: "blocked",
          needs: "user",
          summary: "Need a decision.",
        });
        assert.equal(blocked.state, "queued");
        yield* service.drain();
        const sent = world.sent.filter((input) => input.threadId === master);
        assert.equal(sent.length, 1);
        assert.match(sent[0]?.text ?? "", /Outcome: blocked, needs the user/);
        // A retry of an accepted report is never refused, even if a new window opened.
        yield* service.send(master, { threadId: worker, clientRequestId: "again", prompt: "More" });
        const retried = yield* service.report(worker, {
          clientRequestId: "b1",
          outcome: "blocked",
          needs: "user",
          summary: "Need a decision.",
        });
        assert.equal(retried.requestId, `report:${worker}:b1`);
      }),
    );
  });

  it.effect("starts a new window with each accepted assignment and not with a rejected one", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* TestClock.adjust(Duration.minutes(16));
        // Past the first window: a blocker may pass.
        yield* service.report(worker, {
          clientRequestId: "b1",
          outcome: "blocked",
          summary: "Stuck.",
        });
        // A new assignment reopens it.
        yield* service.send(master, { threadId: worker, clientRequestId: "n1", prompt: "Next" });
        const refused = yield* failureOf(
          service.report(worker, {
            clientRequestId: "b2",
            outcome: "blocked",
            summary: "Stuck again.",
          }),
        );
        assert.equal(refused.code, "worker_communication_window");
        yield* TestClock.adjust(Duration.minutes(16));
        yield* service.report(worker, {
          clientRequestId: "b2",
          outcome: "blocked",
          summary: "Stuck again.",
        });
        void world;
      }),
    );
  });

  it.effect("disables the window with zero minutes", () => {
    const { world, run } = harness();
    world.windowMinutes = 0;
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        const blocked = yield* service.report(worker, {
          clientRequestId: "b1",
          outcome: "blocked",
          summary: "Stuck.",
        });
        assert.equal(blocked.state, "queued");
      }),
    );
  });

  it.effect("refuses a report from a session that is not a worker", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const error = yield* failureOf(
          service.report(master, { clientRequestId: "r", outcome: "done", summary: "Done." }),
        );
        assert.match(error.message, /not a managed T3 worker/);
      }),
    );
  });

  it.effect("holds done reports while the master works, then sends one digest", () => {
    const second = ThreadId.make("thread:worker-2");
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* service.spawn(master, spawnInput(second));
        // The master is mid-turn.
        world.thread(master).runs.push({ id: "run:master", status: "running" } as never);
        for (const [id, summary] of [
          [worker, "One done."],
          [second, "Two done."],
        ] as const)
          yield* service.report(id, { clientRequestId: "d", outcome: "done", summary });
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 0);
        // The turn ends; the two reports arrive as one message.
        world.thread(master).runs = [];
        yield* service.drain();
        const delivered = world.sent.filter((input) => input.threadId === master);
        assert.equal(delivered.length, 1);
        assert.match(delivered[0]?.text ?? "", /^\[T3 worker reports — 2 finished\]/);
        assert.match(delivered[0]?.text ?? "", /One done\./);
        assert.match(delivered[0]?.text ?? "", /Two done\./);
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 1);
      }),
    );
  });

  it.effect("keeps a report queued for a stopped master", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        world.thread(master).stopRequested = true;
        yield* service.report(worker, { clientRequestId: "d", outcome: "done", summary: "Done." });
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 0);
        world.thread(master).stopRequested = false;
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 1);
      }),
    );
  });
});

describe("runtime notices", () => {
  it.effect("tells the master once when a run fails, after the window", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* finish(world, worker, "failed");
        yield* service.drain();
        // Inside the window the notice waits.
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 0);
        yield* TestClock.adjust(Duration.minutes(16));
        yield* service.drain();
        const sent = world.sent.filter((input) => input.threadId === master);
        assert.equal(sent.length, 1);
        assert.match(sent[0]?.text ?? "", /Runtime state: error\nError: provider failed/);
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 1);
        const state = yield* service.wait(master, {
          threadId: worker,
          requestId: `spawn:${worker}`,
        });
        assert.equal(state.request.state, "error");
      }),
    );
  });

  it.effect("drops a failure notice that an explicit done superseded", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* finish(world, worker, "failed");
        yield* service.drain();
        yield* service.report(worker, {
          clientRequestId: "d",
          outcome: "done",
          summary: "Recovered.",
        });
        yield* TestClock.adjust(Duration.minutes(16));
        yield* service.drain();
        const sent = world.sent.filter((input) => input.threadId === master);
        assert.equal(sent.length, 1);
        assert.match(sent[0]?.text ?? "", /Outcome: done/);
      }),
    );
  });

  it.effect("sends nothing while notifications are off, and the failure when they resume", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* service.control(master, { threadId: worker, notifications: false });
        yield* finish(world, worker, "failed");
        yield* TestClock.adjust(Duration.minutes(16));
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 0);
        const held = yield* service.report(worker, {
          clientRequestId: "d",
          outcome: "done",
          summary: "Done.",
        });
        assert.isTrue(held.held);
        yield* service.control(master, { threadId: worker, notifications: true });
        yield* service.drain();
        assert.isAtLeast(world.sent.filter((input) => input.threadId === master).length, 1);
      }),
    );
  });
});

describe("control", () => {
  it.effect("changes the profile and saves it for later assignments", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        yield* finish(world, worker, "completed");
        const changed = yield* service.control(master, {
          threadId: worker,
          modelSelection: claude,
        });
        assert.equal(changed.modelSelection.instanceId, claude.instanceId);
        assert.equal(
          world.dispatched.filter((command) => command.type === "thread.model-selection.set")
            .length,
          1,
        );
        const sent = yield* service.send(master, {
          threadId: worker,
          clientRequestId: "n",
          prompt: "Next",
        });
        assert.equal(sent.state, "submitted");
      }),
    );
  });

  it.effect("cancels a queued assignment but not a running one", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        // The provider cannot steer this one, so it waits behind the running turn.
        world.thread(worker).runs.push({
          id: "run:steady",
          status: "waiting",
          userMessageId: "m",
        } as never);
        const running = yield* failureOf(
          service.control(master, { threadId: worker, cancelRequestId: `spawn:${worker}` }),
        );
        assert.match(running.message, /Only queued assignments/);
        // Hold a queued run directly.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at)
          VALUES (${`${worker}:queued`}, ${worker}, ${worker}, 'work', 'later', ${yield* nowIso})`;
        const result = yield* service.control(master, {
          threadId: worker,
          cancelRequestId: `${worker}:queued`,
        });
        assert.equal(result.threadId, worker);
        const rows = yield* sql<{
          state: string;
        }>`SELECT state FROM custom_worker_jobs WHERE id = ${`${worker}:queued`}`;
        assert.equal(rows[0]?.state, "cancelled");
      }),
    );
  });

  it.effect("refuses a worker its master does not own", () => {
    const { run } = harness((world) => world.addThread(other));
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        const error = yield* failureOf(
          service.control(other, { threadId: worker, notifications: false }),
        );
        assert.match(error.message, /not a worker owned by this master/);
      }),
    );
  });
});

describe("orchestrator handoff and reclaim", () => {
  const successor = ThreadId.make("thread:successor");
  const second = ThreadId.make("thread:worker-2");
  const handoffInput = (extra: object = {}) => ({
    threadId: successor,
    title: "Successor",
    modelSelection: codex,
    prompt: "Carry on with the plan.",
    ...extra,
  });
  const twoWorkers = (service: typeof WorkerService.Service) =>
    Effect.gen(function* () {
      yield* service.spawn(master, spawnInput());
      yield* service.spawn(master, spawnInput(second));
    });

  it.effect(
    "transfers workers and queued reports to a fresh successor and retires the master",
    () => {
      const { world, run } = harness();
      return run(
        Effect.gen(function* () {
          const service = yield* WorkerService;
          yield* twoWorkers(service);
          yield* service.report(worker, {
            clientRequestId: "d",
            outcome: "done",
            summary: "One done.",
          });
          world.thread(master).stopRequested = true;
          yield* service.drain();
          world.thread(master).stopRequested = false;
          const result = yield* service.handoff(master, handoffInput());
          assert.equal(result.state, "completed");
          assert.deepEqual([...result.transferredWorkerIds].sort(), [worker, second].sort());
          assert.equal((yield* service.list(master)).length, 0);
          assert.equal((yield* service.list(successor)).length, 2);
          yield* service.drain();
          // The queued report and the startup message both went to the successor, not the master.
          const toSuccessor = world.sent.filter((input) => input.threadId === successor);
          assert.equal(toSuccessor.length, 2);
          assert.match(
            toSuccessor.map((input) => input.text).join("\n"),
            /\[T3 orchestrator handoff\]/,
          );
          assert.match(toSuccessor.map((input) => input.text).join("\n"), /One done\./);
          assert.equal(world.sent.filter((input) => input.threadId === master).length, 0);
          // Repeating the call with the same input is the same handoff.
          const again = yield* service.handoff(master, handoffInput());
          assert.equal(again.state, "completed");
          assert.equal(world.launched.filter((input) => input.threadId === successor).length, 1);
          const status = yield* service.handoffStatus(master, { threadId: successor });
          assert.equal(status.startupState, "completed");
          const different = yield* failureOf(
            service.handoff(master, handoffInput({ title: "Elsewhere" })),
          );
          assert.match(different.message, /different handoff settings/);
        }),
      );
    },
  );

  it.effect("warns a retired master once, on its first successful action", () => {
    const { run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* twoWorkers(service);
        yield* service.handoff(master, handoffInput());
        const first = yield* service.spawn(master, spawnInput(ThreadId.make("thread:new-1")));
        assert.match(first.warning ?? "", /previously handed off to thread:successor/);
        const next = yield* service.spawn(master, spawnInput(ThreadId.make("thread:new-2")));
        assert.isUndefined(next.warning);
        // The master still owns the new workers: retirement does not block new launches.
        assert.equal((yield* service.list(master)).length, 2);
      }),
    );
  });

  it.effect("keeps a self-fork queued until the source turn ends", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* twoWorkers(service);
        world.thread(master).runs.push({ id: "run:master", status: "running" } as never);
        const queued = yield* service.handoff(master, handoffInput({ selfFork: true }));
        assert.equal(queued.state, "queued");
        assert.equal((yield* service.list(master)).length, 2);
        world.thread(master).runs = [];
        yield* service.drain();
        const status = yield* service.handoffStatus(master, { threadId: successor });
        assert.equal(status.state, "completed");
        assert.equal(
          world.dispatched.find((command) => command.type === "thread.fork")?.type,
          "thread.fork",
        );
        assert.equal((yield* service.list(successor)).length, 2);
      }),
    );
  });

  it.effect("cancels a queued handoff before any ownership moves", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* twoWorkers(service);
        world.thread(master).runs.push({ id: "run:master", status: "running" } as never);
        yield* service.handoff(master, handoffInput({ selfFork: true }));
        const cancelled = yield* service.handoffStatus(master, {
          threadId: successor,
          cancel: true,
        });
        assert.equal(cancelled.state, "cancelled");
        world.thread(master).runs = [];
        yield* service.drain();
        assert.equal((yield* service.list(master)).length, 2);
        assert.isFalse(world.threads.has(successor));
      }),
    );
  });

  it.effect("reclaims selected handed-off workers only on a new direct user instruction", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* twoWorkers(service);
        yield* service.handoff(master, handoffInput());
        const reclaimInput = {
          clientRequestId: "reclaim-1",
          workerThreadIds: [worker],
          userRequest: "take back worker one",
        };
        const none = yield* failureOf(service.reclaim(master, reclaimInput));
        assert.match(none.message, /exact quote from a new direct user instruction/);
        // An agent's or the server's message, even with the same words, is not the user's permission.
        world.addMessage(master, {
          id: "worker-job:peer",
          role: "user",
          text: "take back worker one",
          createdBy: "agent",
        });
        assert.match(
          (yield* failureOf(service.reclaim(master, reclaimInput))).message,
          /exact quote/,
        );
        world.addMessage(master, {
          id: "message:user",
          role: "user",
          text: "Please take back worker one now",
          createdBy: "user",
        });
        const result = yield* service.reclaim(master, reclaimInput);
        assert.deepEqual(result.workerThreadIds, [worker]);
        assert.equal(result.userMessageId, "message:user");
        assert.deepEqual(
          (yield* service.list(master)).map((entry) => entry.threadId),
          [worker],
        );
        assert.deepEqual(
          (yield* service.list(successor)).map((entry) => entry.threadId),
          [second],
        );
        // A retry returns the original receipt; a changed request does not.
        assert.deepEqual(yield* service.reclaim(master, reclaimInput), result);
        const changed = yield* failureOf(
          service.reclaim(master, { ...reclaimInput, workerThreadIds: [second] }),
        );
        assert.match(changed.message, /different workers or instructions/);
        // Reactivated: no more retirement warning on the next action.
        const spawned = yield* service.spawn(master, spawnInput(ThreadId.make("thread:later")));
        assert.isUndefined(spawned.warning);
        const notHanded = yield* failureOf(
          service.reclaim(master, {
            clientRequestId: "reclaim-2",
            workerThreadIds: [ThreadId.make("thread:later")],
            userRequest: "Please take back worker one now",
          }),
        );
        assert.match(notHanded.message, /not a handed-off worker/);
      }),
    );
  });
});

describe("session ownership", () => {
  const ask = (input: object) => ({
    clientRequestId: "own-1",
    threadId: other,
    ownerThreadId: master,
    expectedOwnerThreadId: null,
    expectedRevision: 0,
    ...input,
  });
  const userSaid = (world: World, text: string) =>
    world.addMessage(master, {
      id: `message:${text.length}`,
      role: "user",
      text,
      createdBy: "user",
    });

  it.effect("adopts an independent session with a fenced, idempotent change", () => {
    const { world, run } = harness((setup) => setup.addThread(other));
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const read = yield* service.readOwnership(other);
        assert.equal(read.ownerThreadId, null);
        assert.equal(read.revision, 0);
        const denied = yield* service
          .changeOwnership(ask({}), { threadId: master, userRequest: "adopt thread:other" })
          .pipe(Effect.flip);
        assert.match(denied.message, /exact quote from the latest direct user instruction/);
        userSaid(world, "Please adopt thread:other as my worker");
        const changed = yield* service.changeOwnership(ask({}), {
          threadId: master,
          userRequest: "adopt thread:other",
        });
        assert.equal(changed.ownerThreadId, master);
        assert.equal(changed.revision, 1);
        assert.equal((yield* service.list(master)).length, 1);
        const again = yield* service.changeOwnership(ask({}), {
          threadId: master,
          userRequest: "adopt thread:other",
        });
        assert.deepEqual(again, changed);
        // A stale expectation is a conflict.
        const stale = yield* service
          .changeOwnership(ask({ clientRequestId: "own-2", ownerThreadId: null }), {
            threadId: master,
            userRequest: "adopt thread:other",
          })
          .pipe(Effect.flip);
        assert.equal(stale.code, "conflict");
        const released = yield* service.changeOwnership(
          ask({
            clientRequestId: "own-3",
            ownerThreadId: null,
            expectedOwnerThreadId: master,
            expectedRevision: 1,
          }),
          { threadId: master, userRequest: "adopt thread:other" },
        );
        assert.equal(released.ownerThreadId, null);
        assert.equal(released.revision, 2);
        assert.equal((yield* service.list(master)).length, 0);
      }),
    );
  });

  it.effect("never lets a session own itself or an ancestor", () => {
    const { world, run } = harness();
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        userSaid(world, "Make the master a worker of its worker");
        const error = yield* service
          .changeOwnership(
            ask({
              threadId: master,
              ownerThreadId: worker,
              expectedOwnerThreadId: null,
            }),
            { threadId: master, userRequest: "Make the master a worker" },
          )
          .pipe(Effect.flip);
        assert.match(error.message, /own itself or one of its ancestors|already owns workers/);
      }),
    );
  });

  it.effect("keeps a worker's ownership change out of reach of a non-owner", () => {
    const { world, run } = harness((setup) => setup.addThread(other));
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        yield* service.spawn(master, spawnInput());
        world.addMessage(other, {
          id: "message:other",
          role: "user",
          text: "release it",
          createdBy: "user",
        });
        const error = yield* service
          .changeOwnership(
            ask({
              threadId: worker,
              ownerThreadId: other,
              expectedOwnerThreadId: master,
            }),
            { threadId: other, userRequest: "release it" },
          )
          .pipe(Effect.flip);
        assert.match(error.message, /Only the worker or its current master/);
      }),
    );
  });
});

describe("workers imported from V1", () => {
  it.effect("lets a master read and message a worker carried over from the custom fork", () => {
    const imported = ThreadId.make("thread:imported");
    const { world, run } = harness((setup) =>
      setup.addThread(imported, { title: "Imported worker" }),
    );
    return run(
      Effect.gen(function* () {
        const service = yield* WorkerService;
        const sql = yield* SqlClient.SqlClient;
        // The shapes the custom fork stored: a plan with keys this build does not know, and V1 turn ids.
        const plan = JSON.stringify({
          threadId: imported,
          projectId,
          title: "Imported worker",
          modelSelection: codex,
          prompt: "Original task",
          runtimeMode: "full-access",
          interactionMode: "default",
          authorityRevision: 3,
          organizationHosts: ["environment:local"],
        });
        yield* sql`INSERT INTO custom_workers (thread_id, owner_id, plan_json, state, baseline, read_seq, notify)
          VALUES (${imported}, ${master}, ${plan}, 'ready', 5, 5, 1)`;
        yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state, turn_id, reported, dispatched_at)
          VALUES (${`spawn:${imported}`}, ${imported}, ${imported}, 'work', 'Original task', '2026-10-01T00:00:00.000Z', 'completed', 'turn-v1', 1, '2026-10-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO custom_orchestrator_authority (thread_id, revision) VALUES (${imported}, 3)`;

        const listed = yield* service.list(master);
        assert.equal(listed[0]?.threadId, imported);
        assert.equal(listed[0]?.state, "completed");
        assert.equal(listed[0]?.title, "Imported worker");
        assert.equal(listed[0]?.latestRequest?.turnId, "turn-v1");

        // Old transcript events, created while importing, are not news; a new reply is.
        world.addMessage(imported, {
          id: "old",
          role: "assistant",
          text: "history",
          eventId: "migration:v1:message:old",
        });
        world.addMessage(imported, { id: "new", role: "assistant", text: "fresh reply" });
        const read = yield* service.read(master, { threadId: imported });
        assert.deepEqual(
          read.items.map((item) => item.text),
          ["fresh reply"],
        );

        const sent = yield* service.send(master, {
          threadId: imported,
          clientRequestId: "first",
          prompt: "Continue",
        });
        assert.equal(sent.state, "submitted");
        assert.equal(world.sent.at(-1)?.threadId, imported);

        // Its report still reaches its master, and ownership data keeps its revision.
        yield* TestClock.adjust(Duration.minutes(16));
        yield* service.report(imported, {
          clientRequestId: "r",
          outcome: "done",
          summary: "Finished.",
        });
        yield* service.drain();
        assert.equal(world.sent.filter((input) => input.threadId === master).length, 1);
        const ownership = yield* service.readOwnership(imported);
        assert.equal(ownership.ownerThreadId, master);
        assert.equal(ownership.revision, 3);
        // The extra plan keys survive a profile adoption.
        yield* service.control(master, {
          threadId: imported,
          notifications: true,
          adoptCurrentSettings: true,
        });
        const stored = yield* sql<{
          plan_json: string;
        }>`SELECT plan_json FROM custom_workers WHERE thread_id = ${imported}`;
        assert.equal(JSON.parse(stored[0]!.plan_json).authorityRevision, 3);
      }),
    );
  });
});
