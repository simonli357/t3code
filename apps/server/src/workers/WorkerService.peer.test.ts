import { assert, it } from "@effect/vitest";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ProviderAllocation } from "../allocation/ProviderAllocation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { master, model, project, seed, setLatestRun } from "./integration.testkit.ts";
import { makeComputer, newNetwork, on } from "./peerWorld.testkit.ts";
import * as WorkerService from "./WorkerService.ts";

const idA = "environment-a" as EnvironmentId;
const idB = "environment-b" as EnvironmentId;
const worker = ThreadId.make("thread:remote-worker");

const spawnInput = {
  threadId: worker,
  title: "Remote worker",
  modelSelection: model,
  prompt: "Build it on the other computer.",
  projectId: project,
};

const makePair = Effect.fn("makePair")(function* () {
  const network = newNetwork();
  const a = yield* makeComputer(idA, idB, network);
  const b = yield* makeComputer(idB, idA, network);
  yield* on(a, seed(master, a.root));
  yield* on(b, seed(ThreadId.make("thread:b-local"), b.root));
  return { network, a, b };
});

const messagesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).messages.map(
      (message) => message.text,
    );
  });

it.effect("runs a worker on a linked computer and carries its reports back", () =>
  Effect.gen(function* () {
    const { network, a, b } = yield* makePair();
    const workersA = yield* on(a, WorkerService.WorkerService);
    const workersB = yield* on(b, WorkerService.WorkerService);

    const spawned = yield* on(a, workersA.spawnRemote(master, idB, spawnInput));
    assert.equal(spawned.environment, `Peer ${idB}`);
    assert.equal(spawned.ownerThreadId, master);
    const there = yield* on(b, messagesOf(worker));
    assert.deepEqual(there, ["Build it on the other computer."]);
    const ownerOnB = yield* on(
      b,
      SqlClient.SqlClient.pipe(
        Effect.flatMap(
          (sql) =>
            sql<{
              owner_id: string;
            }>`SELECT owner_id FROM custom_workers WHERE thread_id = ${worker}`,
        ),
      ),
    );
    assert.equal(ownerOnB[0]?.owner_id, `peer:${idA}:${master}`);

    const listed = yield* on(a, workersA.list(master));
    assert.deepEqual(
      listed.map((entry) => [entry.threadId, entry.environment]),
      [[worker, `Peer ${idB}`]],
    );

    yield* on(b, setLatestRun(worker, "running"));
    const sent = yield* on(
      a,
      workersA.send(master, {
        threadId: worker,
        clientRequestId: "second",
        prompt: "Also run the tests.",
      }),
    );
    assert.equal(sent.threadId, worker);
    const read = yield* on(a, workersA.read(master, { threadId: worker }));
    assert.equal(read.worker.environment, `Peer ${idB}`);
    const controlled = yield* on(
      a,
      workersA.control(master, { threadId: worker, notifications: true }),
    );
    assert.equal(controlled.environment, `Peer ${idB}`);

    // While the master's computer is away the report waits on the worker's computer.
    network.outages.add("deliver");
    yield* on(
      b,
      workersB.report(worker, {
        clientRequestId: "done-1",
        outcome: "done",
        summary: "Built it remotely.",
      }),
    );
    yield* on(b, workersB.drain());
    assert.isFalse(
      (yield* on(a, messagesOf(master))).some((text) => text.includes("Built it remotely.")),
    );
    yield* on(b, workersB.drain());
    yield* on(a, workersA.drain());
    assert.isTrue(
      (yield* on(a, messagesOf(master))).some((text) => text.includes("Built it remotely.")),
    );
  }).pipe(Effect.scoped),
);

it.effect("sends later reports to the successor after a handoff", () =>
  Effect.gen(function* () {
    const { a, b } = yield* makePair();
    const workersA = yield* on(a, WorkerService.WorkerService);
    const workersB = yield* on(b, WorkerService.WorkerService);
    const successor = ThreadId.make("thread:successor");
    yield* on(a, workersA.spawnRemote(master, idB, spawnInput));

    const handoff = yield* on(
      a,
      workersA.handoff(master, {
        threadId: successor,
        title: "Successor",
        modelSelection: model,
        prompt: "Carry on.",
      }),
    );
    assert.deepEqual(handoff.transferredWorkerIds, [worker]);

    yield* on(a, workersA.drain());
    // A finished report waits for a working master, so let the successor's startup turn end.
    yield* on(a, setLatestRun(successor, "completed"));
    yield* on(
      b,
      workersB.report(worker, {
        clientRequestId: "done-after-handoff",
        outcome: "done",
        summary: "Finished after the handoff.",
      }),
    );
    yield* on(b, workersB.drain());
    yield* on(a, workersA.drain());
    const atSuccessor = yield* on(a, messagesOf(successor));
    assert.isTrue(atSuccessor.some((text) => text.includes("Finished after the handoff.")));
    const atMaster = yield* on(a, messagesOf(master));
    assert.isFalse(atMaster.some((text) => text.includes("Finished after the handoff.")));
    const listed = yield* on(a, workersA.list(successor));
    assert.deepEqual(
      listed.map((entry) => [entry.threadId, entry.ownerThreadId, entry.state !== "unreachable"]),
      [[worker, successor, true]],
    );
  }).pipe(Effect.scoped),
);

it.effect("ranks linked computers in placement advice and marks an unreachable one offline", () =>
  Effect.gen(function* () {
    const { network, a } = yield* makePair();
    const allocation = yield* on(a, ProviderAllocation);

    const reachable = yield* on(a, allocation.place({}));
    assert.deepEqual(
      reachable.placement.hosts
        .map((host) => [host.environmentId, host.state !== "offline"])
        .toSorted(),
      [
        [idA, true],
        [idB, true],
      ],
    );

    network.outages.add("allocationInventory");
    const away = yield* on(a, allocation.place({}));
    const offline = away.placement.hosts.find((host) => host.environmentId === idB);
    assert.equal(offline?.state, "offline");
    assert.notEqual(away.placement.recommendedEnvironmentId, idB);
  }).pipe(Effect.scoped),
);
