import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationRequest,
  type AllocationStart,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  layerWorld,
  layerPlacementProbe,
  seed,
  project,
  setLatestRun,
  master,
} from "../workers/integration.testkit.ts";
import { layerPeers, newNetwork } from "../workers/peerWorld.testkit.ts";
import { provider } from "../workers/WorkerService.testkit.ts";
import * as Workers from "../workers/WorkerService.ts";
import * as Allocation from "./ProviderAllocation.ts";
import * as Assignments from "./AllocationAssignments.ts";
import * as Store from "./AllocationStore.ts";

const a = EnvironmentId.make("coordinator-a");
const b = EnvironmentId.make("execution-b");
const at = "2026-11-01T08:00:00.000Z";
const accounts = [
  {
    ...provider("codex", "gpt-5.4"),
    checkedAt: at,
    auth: { status: "authenticated", email: "shared@example.test" },
    usageLimits: {
      checkedAt: at,
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          resetsAt: "2026-11-05T08:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    },
  },
];

const pair = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(at));
  const network = newNetwork();
  const one = yield* Layer.build(
    layerWorld(accounts, { environmentId: a, peers: layerPeers(a, b, network) }),
  );
  const two = yield* Layer.build(
    layerWorld(accounts, { environmentId: b, peers: layerPeers(b, a, network) }),
  );
  const ca = Context.get(one, Allocation.ProviderAllocation);
  const cb = Context.get(two, Allocation.ProviderAllocation);
  yield* Effect.provideContext(seed(), one);
  yield* Effect.provideContext(seed(), two);
  yield* ca.execute({ _tag: "connect", coordinatorEnvironmentId: a });
  yield* cb.execute({ _tag: "connect", coordinatorEnvironmentId: a });
  return { one, two, ca, cb, network };
});

const request = (id: string, environmentId: string = b): AllocationRequest => ({
  assignmentId: `assignment:${id}`,
  threadId: ThreadId.make(id),
  environmentId,
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-5.4",
  options: [],
});

it.effect(
  "routes both allocation modes and policy to one authority, with durable retry and drain checks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ca, cb, one, two, network } = yield* pair;
        const input = request("remote");
        const policy = (yield* cb.execute({ _tag: "caps" })).policy!;
        assert.equal(policy.coordinatorEnvironmentId, a);
        const updated = yield* cb.execute({
          _tag: "policy",
          input: {
            expectedVersion: policy.version,
            policy: { ...policy, maxReadingAgeMinutes: 25 },
          },
        });
        assert.equal(
          (yield* ca.execute({ _tag: "caps" })).policy?.version,
          updated.policy?.version,
        );
        assert.equal(
          (yield* cb.execute({ _tag: "connections" })).connections?.coordinatorEnvironmentId,
          a,
        );
        const first = (yield* cb.execute({ _tag: "allocate", request: input })).result!;
        assert.isDefined(first.reservation);
        assert.equal(first.decision.request.environmentId, b);
        const repeat = (yield* cb.execute({ _tag: "allocate", request: input })).result!;
        assert.equal(repeat.reservation?.assignmentId, first.reservation?.assignmentId);
        const rebuilt = yield* Layer.build(
          Allocation.layer.pipe(
            Layer.provide(layerPlacementProbe),
            Layer.provideMerge(Store.layer),
            Layer.fresh,
            Layer.provide(Layer.succeedContext(one)),
          ),
        );
        assert.equal(
          (yield* Context.get(rebuilt, Allocation.ProviderAllocation).execute({ _tag: "snapshot" }))
            .snapshot?.reservations[0]?.assignmentId,
          input.assignmentId,
        );
        assert.equal(
          (yield* cb.execute({ _tag: "allocate", request: input })).result?.reservation
            ?.assignmentId,
          input.assignmentId,
        );
        const rows = yield* Effect.provideContext(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM provider_allocation_reservations`;
          }),
          two,
        );
        assert.equal(rows[0]?.n, 0);
        assert.equal((yield* ca.execute({ _tag: "snapshot" })).snapshot?.reservations.length, 1);
        const denied = yield* cb
          .execute({ _tag: "connect", coordinatorEnvironmentId: b })
          .pipe(Effect.flip);
        assert.equal(denied.code, "conflict");
        // A repeated selection is harmless even with active reservations.
        yield* cb.execute({ _tag: "connect", coordinatorEnvironmentId: a });
        yield* cb.execute({
          _tag: "lifecycle",
          input: {
            assignmentId: input.assignmentId,
            environmentId: b,
            threadId: input.threadId,
            action: "release",
          },
        });
        const selection = yield* cb.execute({
          _tag: "modelAllocate",
          request: {
            selection: "automatic",
            allowedDrivers: [ProviderDriverKind.make("codex")],
            assignmentId: "model-preview",
            environmentId: b,
            threadId: input.threadId,
            assessment: {
              difficulty: 1,
              stakes: 1,
              difficultyReason: "Small edit",
              stakesReason: "Reversible",
            },
            override: {
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
              options: [],
              reason: "Fixture model",
            },
          },
        });
        assert.isDefined(selection.selection?.allocation?.reservation);
        yield* cb.execute({
          _tag: "lifecycle",
          input: {
            assignmentId: "model-preview",
            environmentId: b,
            threadId: input.threadId,
            action: "release",
          },
        });
        network.outages.add("allocate");
        const unavailable = yield* cb
          .execute({ _tag: "allocate", request: request("offline") })
          .pipe(Effect.flip);
        assert.equal(unavailable.code, "unavailable");
        network.outages.add("allocationInventory");
        const missingInventory = yield* cb
          .execute({ _tag: "allocate", request: request("inventory-offline") })
          .pipe(Effect.flip);
        assert.equal(missingInventory.code, "unavailable");
        const original = network.handlers.get(b)!;
        network.handlers.set(b, (from, topic, body) =>
          original(from, topic, body).pipe(
            Effect.map((result) =>
              topic === "allocationInventory"
                ? { ...(result as object), environmentId: "wrong-computer" }
                : result,
            ),
          ),
        );
        const mismatch = yield* cb
          .execute({ _tag: "allocate", request: request("wrong-host") })
          .pipe(Effect.flip);
        assert.match(mismatch.detail, /different environment/);
        network.handlers.set(b, original);
        // A stale coordinator chain is rejected at the receiver rather than routed in a loop.
        yield* Context.get(one, ServerSettingsService).updateSettings({
          allocationCoordinatorEnvironmentId: b,
        });
        const cyclic = yield* cb
          .execute({ _tag: "allocate", request: request("cycle") })
          .pipe(Effect.flip);
        assert.equal(cyclic.code, "unavailable");
        yield* Context.get(one, ServerSettingsService).updateSettings({
          allocationCoordinatorEnvironmentId: a,
        });
        yield* cb.execute({ _tag: "connect", coordinatorEnvironmentId: b });
        assert.equal((yield* cb.execute({ _tag: "caps" })).policy?.coordinatorEnvironmentId, b);
      }),
    ),
);

it.effect(
  "reconciles startup and completion from the execution computer and keeps uncertain capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ca, cb, two, network } = yield* pair;
        const input = request("worker-remote");
        yield* cb.execute({ _tag: "allocate", request: input });
        yield* cb.execute({
          _tag: "lifecycle",
          input: {
            assignmentId: input.assignmentId,
            environmentId: b,
            threadId: input.threadId,
            action: "start",
          },
        });
        network.outages.add("allocationProbe");
        assert.equal(
          (yield* ca.execute({ _tag: "snapshot" })).snapshot?.reservations[0]?.state,
          "starting",
        );
        yield* Effect.provideContext(
          Effect.gen(function* () {
            const workers = yield* Workers.WorkerService;
            yield* workers.spawn(master, {
              threadId: input.threadId,
              projectId: project,
              title: "Remote",
              prompt: "Work",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            });
            yield* setLatestRun(input.threadId, "running");
          }),
          two,
        );
        // Pending worker jobs are an authoritative hold until their own receipt finishes.
        assert.notEqual(
          (yield* ca.execute({ _tag: "snapshot" })).snapshot?.reservations[0]?.state,
          "released",
        );
        yield* Effect.provideContext(
          Effect.gen(function* () {
            yield* setLatestRun(input.threadId, "completed");
            yield* (yield* Workers.WorkerService).drain();
          }),
          two,
        );
        assert.equal(
          (yield* ca.execute({ _tag: "snapshot" })).snapshot?.reservations[0]?.state,
          "released",
        );
      }),
    ),
);

it.effect(
  "retries an allocated session using its local creation receipt when its reservation is remote",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { ca, two } = yield* pair;
        const assignments = Context.get(two, Assignments.AllocationAssignments);
        const input: AllocationStart = {
          kind: "session",
          projectId: project,
          title: "Remote session",
          prompt: "Start",
          request: request("session-remote"),
        };
        const started = yield* assignments.start(input);
        const retried = yield* assignments.start(input);
        assert.equal(retried.threadId, started.threadId);
        assert.equal((yield* ca.execute({ _tag: "snapshot" })).snapshot?.reservations.length, 1);
        const replaced = yield* assignments
          .start({ ...input, request: { ...input.request, assignmentId: "unrelated" } })
          .pipe(Effect.flip);
        assert.equal(replaced.code, "invalid");
      }),
    ),
);
