import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  defaultModelRoutingPolicy,
  allocationPreferenceKey,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  ProjectId,
  ProviderDriverKind,
  type AllocationInventory,
  OrchestrationThreadShell,
  type OrchestrationProjectShell,
  type AllocationStart,
  type AllocationResponse,
  type ComputerCapacity,
  type OrchestrationCommand,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./AllocationStore.ts";
import * as Allocation from "./ProviderAllocation.ts";
import * as Assignments from "./AllocationAssignments.ts";
import * as Computers from "../computers/Computers.ts";
import { PeerLinks, PeerRejected, PeerUnavailable } from "../orchestration/PeerLinks.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import * as Settings from "../serverSettings.ts";
import * as Workers from "../orchestration/WorkerControls.ts";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { codexRateLimitsToLimits } from "../provider/Layers/codexUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";

const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const expectHistoricalWarning = (response: AllocationResponse, present: boolean) => {
  expect(response.result?.decision.selectedInstanceId).toBe("chosen");
  expect(
    response.result?.decision.reasons.some((reason) => reason.includes("Provider rejected")),
  ).toBe(present);
};
const at = "1970-01-01T00:00:00.000Z";
/** Peer reads a managed worker start makes for its recommendation before allocating. */
const ADVICE_READS = 2;
const report: UsageMeasurementsReport = {
  observedAt: at,
  monitoredInstanceIds: [],
  retentionDays: 14,
  persistenceError: null,
  accounts: [],
  turns: [],
  totalMatchingTurns: 0,
  profiles: [],
  limitations: [],
};
const decodeProvider = Schema.decodeUnknownEffect(ServerProvider);
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "chosen",
  driver: "codex",
  displayName: "chosen",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "account@example.test" },
  checkedAt: at,
  models: [
    {
      slug: "astra",
      name: "Astra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
          {
            id: "serviceTier",
            label: "Tier",
            type: "select",
            options: [{ id: "priority", label: "Priority" }],
          },
        ],
      },
    },
  ],
  usageLimits: {
    checkedAt: at,
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 0,
        resetsAt: "1970-01-07T00:00:00.000Z",
        windowDurationMins: 10080,
      },
      {
        id: "short",
        kind: "session",
        label: "Short",
        usedPercent: 0,
        resetsAt: "1970-01-01T04:00:00.000Z",
        windowDurationMins: 300,
      },
    ],
  },
});

it.effect(
  "legacy rejection stays with the historical account across family and same-driver switches",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const sql = yield* SqlClient.SqlClient;
      const oldAt = "1969-12-31T23:00:00.000Z";
      const errorAt = "1969-12-31T23:30:00.000Z";
      f.state.threads = [shell()];
      const old = {
        ...provider,
        instanceId: ProviderInstanceId.make("old-account"),
        auth: { ...provider.auth, email: "old@example.test" },
      };
      f.state.providers = [provider, { ...old, driver: ProviderDriverKind.make("claudeAgent") }];
      const session = (id: string, version: number, when: string, instance: string) =>
        sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES (${id},'thread','worker',${version},'thread.session-set',${when},'provider',${encodeUnknown({ session: { providerInstanceId: instance, activeTurnId: id === "old-binding" ? "old-turn" : "new-turn" } })},'{}')`;
      yield* session("old-binding", 1, oldAt, "old-account");
      yield* session("switched", 2, errorAt, "chosen");
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
      VALUES ('old-quota','worker','old-turn','info','runtime.warning','',${encodeUnknown({ detail: { status: "rejected", rateLimitType: "short", resetsAt: 3600 } })},${errorAt})`;
      const snapshot = () => allocation.execute({ _tag: "snapshot" });
      let accounts = (yield* snapshot()).snapshot!.inventories[0]!.accounts;
      expect(accounts.find((a) => a.instanceId === "chosen")?.available).toBe(true);
      expect(accounts.find((a) => a.instanceId === "old-account")?.available).toBe(false);
      f.state.providers = [provider, old];
      accounts = (yield* snapshot()).snapshot!.inventories[0]!.accounts;
      expect(accounts.find((a) => a.instanceId === "chosen")?.available).toBe(true);
      expect(accounts.find((a) => a.instanceId === "old-account")?.available).toBe(false);
      // Imported legacy history can retain Claude as driver but relabel its ID to
      // Codex. The account is ambiguous within Claude, never a Codex rejection.
      f.state.providers = [provider, { ...old, driver: ProviderDriverKind.make("claudeAgent") }];
      yield* sql`UPDATE orchestration_events SET payload_json=${encodeUnknown({ session: { providerName: "claudeAgent", providerInstanceId: "chosen", activeTurnId: "old-turn" } })} WHERE event_id='old-binding'`;
      accounts = (yield* snapshot()).snapshot!.inventories[0]!.accounts;
      expect(accounts.find((a) => a.instanceId === "chosen")?.available).toBe(true);
      expect(accounts.find((a) => a.instanceId === "old-account")?.available).toBe(false);
      // Explicit stamped identity outranks even a conflicting session timeline.
      f.state.providers = [provider];
      yield* sql`UPDATE projection_thread_activities SET kind='account.quota-state',payload_json=${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "short", status: "rejected" }] })}`;
      expect(
        (yield* snapshot()).snapshot!.inventories[0]!.accounts.find(
          (a) => a.instanceId === "chosen",
        )?.available,
      ).toBe(false);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "paired legacy Claude errors retain scope and recover without waiting for unrelated weekly reset",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const sql = yield* SqlClient.SqlClient;
      f.state.threads = [shell("error")];
      const errorAt = "1969-12-31T22:30:00.000Z";
      const message = "Claude usage limit reached. Send the message again once the limit resets.";
      f.state.threads = [
        {
          ...shell("error"),
          session: { ...shell("error").session!, lastError: message, updatedAt: errorAt },
        },
      ];
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
      VALUES ('warning','worker','turn','info','runtime.warning','',${encodeUnknown({ detail: { status: "rejected", rateLimitType: "short", resetsAt: -3600 } })},${errorAt}),
             ('error','worker','turn','error','runtime.error','',${encodeUnknown({ message })},${errorAt})`;
      const preview = () => allocation.execute({ _tag: "preview", request: startInput.request });
      expectHistoricalWarning(yield* preview(), false);
      // Current rejection remains visible even alongside fresh zero numeric usage.
      yield* sql`UPDATE projection_thread_activities SET payload_json=${encodeUnknown({ detail: { status: "rejected", rateLimitType: "short", resetsAt: 3600 } })} WHERE activity_id='warning'`;
      expectHistoricalWarning(yield* preview(), true);
      // A healthy same-login alias on another host cannot override that rejection.
      const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
      f.state.peers = [
        {
          ...own,
          environmentId: "remote",
          coordinatorEnvironmentId: "local",
          accounts: own.accounts.map((a) => ({
            ...a,
            environmentId: "remote",
            instanceId: ProviderInstanceId.make("remote-alias"),
            available: true,
            unavailableReason: null,
            limitedUntil: null,
          })),
        },
      ];
      expect(
        (yield* allocation.execute({
          _tag: "preview",
          request: { ...startInput.request, environmentId: "remote" },
        })).result?.decision.selectedInstanceId,
      ).toBe("remote-alias");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "old auth errors and unknown Codex errors are not cleared by fresh numeric availability",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const errorAt = "1969-12-31T23:30:00.000Z";
      f.state.providers = [
        {
          ...provider,
          usageLimits: {
            checkedAt: at,
            shortWindowAbsent: true,
            shortWindowAbsentCheckedAt: at,
            windows: provider.usageLimits!.windows.filter((w) => w.kind === "weekly"),
          },
        },
      ];
      const failed = {
        ...shell("error"),
        session: {
          ...shell("error").session!,
          lastError: "Authentication failed",
          updatedAt: errorAt,
        },
      };
      f.state.threads = [failed];
      const preview = () => allocation.execute({ _tag: "preview", request: startInput.request });
      expectHistoricalWarning(yield* preview(), true);
      f.state.threads = [
        { ...failed, session: { ...failed.session, lastError: "Codex usage limit reached." } },
      ];
      expectHistoricalWarning(yield* preview(), true);
      // Confirmed absent short window does not invent a rejection on that window.
      f.state.threads = [shell("ready")];
      expectHistoricalWarning(yield* preview(), false);
    }).pipe(Effect.provide(f.layer));
  },
);
const GIB = 2 ** 30;
const capacityAt = (sampledAt: number): ComputerCapacity => ({
  sampledAt,
  os: "linux",
  resources: {
    sampledAt,
    cpuUtilization: 0.25,
    cpuCount: 16,
    availableMemoryBytes: 10 * GIB,
    totalMemoryBytes: 16 * GIB,
  },
  disks: [
    {
      path: "/",
      label: "root",
      totalBytes: 900 * GIB,
      availableBytes: 120 * GIB,
      freeBytes: 120 * GIB,
    },
  ],
  workDisk: "/",
  jobs: { active: 3, running: 1 },
  notices: [],
});
const startInput = {
  kind: "worker",
  projectId: ProjectId.make("project"),
  title: "task",
  prompt: "PRIVATE TASK CONTENT",
  assessment: {
    difficulty: 3,
    difficultyReason: "Routine change",
    stakes: 4,
    stakesReason: "Reversible",
  },
  overrides: { computer: "The project checkout is on this computer." },
  request: {
    assignmentId: "assignment",
    environmentId: "local",
    threadId: ThreadId.make("worker"),
    driver: ProviderDriverKind.make("codex"),
    model: "astra",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  },
} satisfies AllocationStart;
// Automatic requests carry their own assessment.
const { assessment: _assessment, ...automaticStartInput } = startInput;

function fixture(
  options: {
    remote?: boolean;
    localId?: string;
    label?: string;
    fail?: boolean;
    peerCall?: PeerLinks["Service"]["call"];
  } = {},
) {
  const peerCalls: unknown[] = [];
  const calls: Array<typeof Workers.RemoteSpawnInput.Type> = [];
  const dispatched: OrchestrationCommand[] = [];
  const state: {
    threads: OrchestrationThreadShell[];
    peers: AllocationInventory[];
    providers: ServerProvider[];
    projects: OrchestrationProjectShell[];
    capacity: ComputerCapacity;
    workPaths: Array<string | undefined>;
  } = {
    threads: [],
    peers: [],
    providers: [provider],
    projects: [],
    capacity: capacityAt(Date.parse(at)),
    workPaths: [],
  };
  const db = NodeSqliteClient.layer({ filename: ":memory:" });
  const deps = Layer.mergeAll(
    db,
    Settings.layerTest({
      allocationCoordinatorEnvironmentId: options.remote ? "remote" : (options.localId ?? "local"),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => state.providers) }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: state.projects,
          threads: state.threads,
          updatedAt: at,
        }),
      getThreadShellById: (id) =>
        Effect.succeed(Option.fromNullishOr(state.threads.find((t) => t.id === id))),
    }),
    Layer.succeed(UsageMeasurements, { read: () => Effect.succeed(report) }),
    Layer.mock(Computers.Computers)({
      capacity: (input) =>
        Effect.sync(() => {
          state.workPaths.push(input?.workPath);
          return state.capacity;
        }),
    }),
    Layer.succeed(PeerLinks, {
      list: Effect.sync(() =>
        state.peers.map((i) => ({ environmentId: i.environmentId, label: i.environmentId })),
      ),
      localEnvironment: Effect.succeed({
        environmentId: options.localId ?? "local",
        label: options.label ?? "Local",
      }),
      resolve: (id) =>
        Effect.succeed(
          Option.some({
            environmentId: id,
            label: id,
            url: "https://peer.invalid",
            token: "test-token",
          }),
        ),
      call: (id, input) => {
        peerCalls.push(input);
        if (options.peerCall) return options.peerCall(id, input);
        const peer = state.peers.find((i) => i.environmentId === id);
        return peer
          ? Effect.succeed(peer)
          : Effect.fail(new PeerUnavailable({ environmentId: id, message: "offline" }));
      },
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 };
        }),
    }),
    Layer.mock(Workers.WorkerControls)({
      spawn: (owner, input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            threadId: input.threadId,
            ownerThreadId: owner,
            sourceThreadId: null,
            title: input.title,
            modelSelection: input.modelSelection,
            state: options.fail ? "error" : "queued",
            error: options.fail ? "startup failed" : null,
            notifications: true,
            latestRequest: null,
            pendingReports: 0,
            deliveryError: null,
          };
        }),
    }),
  );
  const layer = Assignments.layer.pipe(
    Layer.provideMerge(Allocation.layer),
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(deps),
  );
  const setup = Effect.gen(function* () {
    yield* runMigrations();
    const store = yield* Store.AllocationStore;
    yield* store.savePolicy({
      expectedVersion: 0,
      policy: {
        ...defaultAllocationPolicy,
        coordinatorEnvironmentId: options.localId ?? "local",
        mode: "automatic",
      },
    });
    return {
      store,
      allocation: yield* Allocation.ProviderAllocation,
      assignments: yield* Assignments.AllocationAssignments,
    };
  });
  return { layer, calls, dispatched, setup, state, peerCalls };
}

for (const observation of ["hung", "offline"] as const) {
  it.effect(
    `explicit managed start does not spend its authority deadline on an unrelated ${observation} observer`,
    () =>
      Effect.gen(function* () {
        const attempted = yield* Deferred.make<void>();
        let execution: AllocationInventory;
        let interrupted = 0;
        const f = fixture({
          peerCall: (id) =>
            id === "hung"
              ? Deferred.succeed(attempted, undefined).pipe(
                  Effect.andThen(
                    observation === "hung"
                      ? Effect.never
                      : Effect.fail(new PeerUnavailable({ environmentId: id, message: "offline" })),
                  ),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      interrupted++;
                    }),
                  ),
                )
              : Effect.succeed(execution),
        });
        yield* Effect.gen(function* () {
          const { allocation, assignments, store } = yield* f.setup;
          const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
          execution = {
            ...own,
            environmentId: "execution",
            accounts: own.accounts.map((a) => ({ ...a, environmentId: "execution" })),
          };
          f.state.peers = [{ ...execution, environmentId: "hung", accounts: [] }, execution];
          const input = {
            ...startInput,
            request: {
              ...startInput.request,
              environmentId: "execution",
              explicitInstanceId: provider.instanceId,
            },
          };
          // PeerLinks bounds the real caller-to-coordinator RPC at 15 seconds; computer advice
          // gives up on this mock's unbounded peer after its own 20 seconds.
          const started = yield* assignments
            .start(input, ThreadId.make("master"))
            .pipe(Effect.timeout("35 seconds"), Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("20 seconds");
          const result = yield* Fiber.join(started);
          expect(result.state).toBe("submitted");
          expect(result.allocation!.decision.reasons.join(" ")).toMatch(
            /unknown|unavailable|incomplete/i,
          );
          expect(f.calls).toHaveLength(1);
          expect(f.calls[0]?.environment).toBe("execution");
          expect(f.calls[0]?.threadId).toBe(input.request.threadId);
          expect(f.calls[0]?.modelSelection).toEqual({
            instanceId: provider.instanceId,
            model: input.request.model,
            options: input.request.options,
          });
          expect(
            (yield* store.reservations).map((r) => [
              r.assignmentId,
              r.request.environmentId,
              r.request.threadId,
              r.instanceId,
              r.state,
            ]),
          ).toEqual([
            [
              input.request.assignmentId,
              "execution",
              input.request.threadId,
              provider.instanceId,
              "starting",
            ],
          ]);
          expect(interrupted > 0).toBe(observation === "hung");
        }).pipe(Effect.provide(f.layer));
      }),
  );
}

it.effect(
  "a forwarded start reaches its required executor within the real coordinator peer deadline",
  () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      let execution: AllocationInventory;
      const coordinator = fixture({
        localId: "remote",
        peerCall: (id, input) => {
          if (id === "hung")
            return Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.never));
          if (
            typeof input === "object" &&
            input !== null &&
            "_tag" in input &&
            input._tag === "allocationProbe"
          )
            return Effect.succeed({ state: "pending" });
          return Effect.succeed(execution);
        },
      });
      yield* Effect.gen(function* () {
        const authority = yield* coordinator.setup;
        const own = (yield* authority.allocation.execute({ _tag: "snapshot" })).snapshot!
          .inventories[0]!;
        execution = {
          ...own,
          environmentId: "execution",
          accounts: own.accounts.map((a) => ({ ...a, environmentId: "execution" })),
        };
        coordinator.state.peers = [
          { ...execution, environmentId: "hung", accounts: [] },
          execution,
        ];
        const caller = fixture({
          remote: true,
          peerCall: (id, request, timeoutMs = 15_000) => {
            expect(id).toBe("remote");
            return authority.allocation.receive("local", request).pipe(
              Effect.timeout(timeoutMs),
              Effect.mapError(
                () =>
                  new PeerUnavailable({ environmentId: id, message: "coordinator request failed" }),
              ),
            );
          },
        });
        yield* Effect.gen(function* () {
          const client = yield* caller.setup;
          const input = {
            ...startInput,
            request: {
              ...startInput.request,
              environmentId: "execution",
              explicitInstanceId: provider.instanceId,
            },
          };
          const started = yield* client.assignments
            .start(input, ThreadId.make("master"))
            .pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          // Computer advice gives an unanswered computer one peer deadline, then lists it offline.
          yield* TestClock.adjust("15 seconds");
          expect((yield* Fiber.join(started)).state).toBe("submitted");
          expect(yield* client.store.reservations).toEqual([]);
          expect(yield* authority.store.reservations).toHaveLength(1);
          expect(caller.calls[0]?.environment).toBe("execution");
          expect(caller.calls[0]?.modelSelection).toEqual({
            instanceId: provider.instanceId,
            model: input.request.model,
            options: input.request.options,
          });
          const retry = yield* client.assignments.start(input, ThreadId.make("master"));
          expect(retry.state).toBe("submitted");
          expect(yield* authority.store.reservations).toHaveLength(1);
          expect((yield* authority.store.reservations)[0]?.request).toEqual(input.request);
          // The remote spawn transport may retry; WorkerControls owns native
          // idempotency. Both attempts must carry the identical durable intent.
          expect(caller.calls).toHaveLength(2);
          expect(caller.calls[1]).toEqual(caller.calls[0]);
        }).pipe(Effect.provide(Layer.fresh(caller.layer)));
      }).pipe(Effect.provide(coordinator.layer));
    }),
);

for (const failure of ["HTTP 401: authentication failed", "transport disconnected"] as const) {
  it.effect(`required execution ${failure} preserves the reservation and same-ID retry`, () => {
    let execution: AllocationInventory;
    let reads = 0;
    let recovered = false;
    const f = fixture({
      peerCall: (id, input) => {
        if (
          typeof input === "object" &&
          input !== null &&
          "_tag" in input &&
          input._tag === "allocationProbe"
        )
          return Effect.succeed({ state: "pending" });
        // Computer advice and its model preview read the execution host first.
        return ++reads >= 2 + ADVICE_READS && !recovered
          ? Effect.fail(new PeerUnavailable({ environmentId: id, message: failure }))
          : Effect.succeed(execution);
      },
    });
    return Effect.gen(function* () {
      const { allocation, assignments, store } = yield* f.setup;
      const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
      execution = {
        ...own,
        environmentId: "execution",
        accounts: own.accounts.map((a) => ({ ...a, environmentId: "execution" })),
      };
      f.state.peers = [execution];
      const input = {
        ...startInput,
        request: {
          ...startInput.request,
          environmentId: "execution",
          explicitInstanceId: provider.instanceId,
        },
      };
      const error = yield* Effect.flip(assignments.start(input, ThreadId.make("master")));
      expect(error.code).toBe("unavailable");
      expect(error.detail).toContain(failure);
      expect(f.calls).toHaveLength(0);
      const held = (yield* store.reservations)[0]!;
      expect(held.state).toBe("reserved");
      expect(held.assignmentId).toBe(input.request.assignmentId);
      expect(held.request).toEqual(input.request);
      expect(held.instanceId).toBe(provider.instanceId);
      recovered = true;
      expect((yield* assignments.start(input, ThreadId.make("master"))).state).toBe("submitted");
      expect(yield* store.reservations).toHaveLength(1);
      expect((yield* store.reservations)[0]?.request).toEqual(held.request);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.modelSelection).toEqual({
        instanceId: held.instanceId,
        model: held.request.model,
        options: held.request.options,
      });
    }).pipe(Effect.provide(f.layer));
  });
}

it.effect(
  "a hung execution host stays required and leaves its exact reserved identity uncertain",
  () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      let execution: AllocationInventory;
      let reads = 0;
      const f = fixture({
        peerCall: () =>
          ++reads <= 1 + ADVICE_READS
            ? Effect.succeed(execution)
            : Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const { allocation, assignments, store } = yield* f.setup;
        const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
        execution = {
          ...own,
          environmentId: "execution",
          accounts: own.accounts.map((a) => ({ ...a, environmentId: "execution" })),
        };
        f.state.peers = [execution];
        const input = {
          ...startInput,
          request: {
            ...startInput.request,
            environmentId: "execution",
            explicitInstanceId: provider.instanceId,
          },
        };
        const started = yield* assignments
          .start(input, ThreadId.make("master"))
          .pipe(Effect.timeout("15 seconds"), Effect.exit, Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("15 seconds");
        expect(Exit.isFailure(yield* Fiber.join(started))).toBe(true);
        expect(f.calls).toHaveLength(0);
        const reservations = yield* store.reservations;
        expect(reservations).toHaveLength(1);
        expect(reservations[0]?.state).toBe("reserved");
        expect(reservations[0]?.request).toEqual(input.request);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "unreachable unrelated starting reservations remain counted against a shared account",
  () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const f = fixture({
        peerCall: () => Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const { allocation, assignments, store } = yield* f.setup;
        const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
        const baseline = (yield* allocation.execute({
          _tag: "preview",
          request: startInput.request,
        })).result!.decision;
        const other = {
          ...own,
          environmentId: "hung",
          accounts: own.accounts.map((a) => ({ ...a, environmentId: "hung" })),
        };
        const priorRequest = {
          ...startInput.request,
          assignmentId: "prior",
          threadId: ThreadId.make("prior-worker"),
          environmentId: "hung",
        };
        yield* store.allocate({
          at,
          request: priorRequest,
          inventories: [other],
          authorityAvailable: true,
          reserve: true,
        });
        yield* store.lifecycle(
          {
            assignmentId: "prior",
            environmentId: "hung",
            threadId: priorRequest.threadId,
            action: "start",
            startIntent: "prior-intent",
          },
          at,
        );
        f.state.peers = [other];
        const started = yield* assignments
          .start(startInput, ThreadId.make("master"))
          .pipe(Effect.timeout("35 seconds"), Effect.forkChild);
        yield* Deferred.await(attempted);
        yield* TestClock.adjust("20 seconds");
        const result = yield* Fiber.join(started);
        expect(result.state).toBe("submitted");
        const chosen = (decision: typeof baseline) =>
          decision.candidates.find(
            (c) => c.environmentId === "local" && c.instanceId === provider.instanceId,
          )!;
        expect(chosen(result.allocation!.decision).windows[0]!.forecastPoints).toBeGreaterThan(
          chosen(baseline).windows[0]!.forecastPoints,
        );
        expect((yield* store.reservations).find((r) => r.assignmentId === "prior")?.state).toBe(
          "starting",
        );
        expect(
          f.peerCalls.some(
            (call) =>
              typeof call === "object" &&
              call !== null &&
              "_tag" in call &&
              call._tag === "allocationProbe",
          ),
        ).toBe(false);
        expect(result.allocation!.decision.reasons.join(" ")).not.toContain(
          "coordinator unavailable",
        );
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("model allocation and lifecycle start do not repeat an unrelated peer timeout", () =>
  Effect.gen(function* () {
    const attempted = yield* Deferred.make<void>();
    let interrupted = 0;
    const f = fixture({
      peerCall: () =>
        Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted++;
            }),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      f.state.peers = [
        {
          environmentId: "hung",
          coordinatorEnvironmentId: null,
          observedAt: at,
          complete: false,
          notices: [],
          accounts: [],
          demand: [],
        },
      ];
      const started = yield* assignments
        .start(
          {
            ...automaticStartInput,
            request: {
              selection: "automatic",
              assignmentId: "model-hung",
              threadId: startInput.request.threadId,
              environmentId: "local",
              explicitInstanceId: provider.instanceId,
              allowedDrivers: [provider.driver],
              assessment: {
                difficulty: 8,
                stakes: 8,
                difficultyReason: "Interactions",
                stakesReason: "Consequential",
              },
              override: {
                driver: provider.driver,
                model: "astra",
                options: startInput.request.options,
                reason: "Exact requested profile",
              },
            },
          },
          ThreadId.make("master"),
        )
        .pipe(Effect.timeout("35 seconds"), Effect.forkChild);
      yield* Deferred.await(attempted);
      yield* TestClock.adjust("20 seconds");
      const result = yield* Fiber.join(started);
      expect(result.state).toBe("submitted");
      expect(result.selection?.allocation?.decision.request.model).toBe("astra");
      expect(result.selection?.reasons.join(" ")).toContain("unknown or stale");
      expect(f.calls).toHaveLength(1);
      expect(yield* store.reservations).toHaveLength(1);
      expect(interrupted).toBe(f.peerCalls.length);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("model startup remains available when unrelated observations are incomplete", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation, assignments } = yield* f.setup;
    f.state.peers = [
      {
        environmentId: "unrelated",
        coordinatorEnvironmentId: null,
        observedAt: at,
        complete: false,
        notices: ["Offline"],
        accounts: [],
        demand: [],
      },
    ];
    const snapshot = (yield* allocation.execute({ _tag: "modelSnapshot" })).modelSnapshot!;
    expect(snapshot.inventories.some((i) => !i.complete)).toBe(true);
    expect(snapshot.authorityAvailable).toBe(true);
    const result = yield* assignments.start(
      {
        ...automaticStartInput,
        request: {
          selection: "automatic",
          assignmentId: startInput.request.assignmentId,
          threadId: startInput.request.threadId,
          environmentId: "local",
          allowedDrivers: [provider.driver],
          assessment: {
            difficulty: 8,
            stakes: 8,
            difficultyReason: "Interactions",
            stakesReason: "Consequential",
          },
          override: {
            driver: provider.driver,
            model: "astra",
            options: startInput.request.options,
            reason: "Exact profile",
          },
        },
      },
      ThreadId.make("master"),
    );
    expect(result.state).toBe("submitted");
    expect(result.selection?.reasons.join(" ")).toContain("unknown or stale");
    expect(f.calls).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("account reselection measures the retained profile after a policy edit", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation, store } = yield* f.setup;
    const models = defaultModelRoutingPolicy.codex.allowedModels.map((slug) => ({
      ...provider.models[0]!,
      slug,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select" as const,
            options: ["medium", "high", "max", "xhigh"].map((id) => ({ id, label: id })),
          },
        ],
      },
    }));
    f.state.providers = [
      { ...provider, models },
      { ...provider, models, instanceId: ProviderInstanceId.make("other") },
    ];
    const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
    f.state.peers = [{ ...own, environmentId: "peer", accounts: [] }];
    const request = {
      selection: "automatic" as const,
      assignmentId: "retained-measurement",
      threadId: ThreadId.make("retained-measurement"),
      environmentId: "local",
      allowedDrivers: [provider.driver],
      explicitInstanceId: provider.instanceId,
      assessment: {
        difficulty: 8,
        stakes: 8,
        difficultyReason: "Interactions",
        stakesReason: "Consequential",
      },
    };
    const initial = (yield* allocation.execute({ _tag: "modelAllocate", request })).selection!;
    expect(initial.allocation?.decision.request.model).toBe("gpt-6-astra");
    yield* store.saveModelPolicy({
      expectedVersion: 0,
      inventories: [own],
      policy: {
        ...defaultModelRoutingPolicy,
        codex: {
          ...defaultModelRoutingPolicy.codex,
          cells: defaultModelRoutingPolicy.codex.cells.map((row) =>
            row.map(() => ({ model: "gpt-6.1-sol", effort: "medium" })),
          ),
        },
      },
    });
    f.peerCalls.length = 0;
    const retried = (yield* allocation.execute({
      _tag: "modelAllocate",
      request: {
        ...request,
        explicitInstanceId: ProviderInstanceId.make("other"),
      },
    })).selection!;
    expect(retried.allocation?.reservation?.instanceId).toBe("other");
    expect(retried.allocation?.decision.request.model).toBe("gpt-6-astra");
    expect(f.peerCalls).toContainEqual({
      _tag: "allocationInventory",
      request: {
        ...retried.allocation!.decision.request,
      },
    });
    expect(f.peerCalls.some((call) => JSON.stringify(call).includes("gpt-6.1-sol"))).toBe(false);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "automatic managed creation uses the selected account and preserves all requested options",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      const result = yield* assignments.start(startInput, ThreadId.make("master"));
      expect(result.state).toBe("submitted");
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.modelSelection).toEqual({
        instanceId: "chosen",
        model: "astra",
        options: startInput.request.options,
      });
      expect(f.calls[0]?.environment).toBeUndefined();
      expect((yield* store.reservations)[0]?.state).toBe("starting");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        replay_json: string;
      }>`SELECT replay_json FROM provider_allocation_decisions`;
      expect(rows[0]?.replay_json).not.toContain("PRIVATE TASK CONTENT");
      expect(rows[0]?.replay_json).not.toContain("account@example.test");
      expect((yield* store.history)[0]?.candidates[0]?.windows).toEqual([]);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("quota warnings do not prevent exact managed startup or alter its durable intent", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    const input: AllocationStart = {
      ...automaticStartInput,
      request: {
        selection: "automatic",
        assignmentId: startInput.request.assignmentId,
        environmentId: startInput.request.environmentId,
        threadId: startInput.request.threadId,
        allowedDrivers: [startInput.request.driver],
        policyVersion: 0,
        assessment: {
          difficulty: 8,
          stakes: 8,
          difficultyReason: "Interacting state",
          stakesReason: "Consequential",
        },
        override: {
          driver: startInput.request.driver,
          model: startInput.request.model,
          options: startInput.request.options,
          reason: "Exact priority profile",
        },
      },
    };
    f.state.providers = [
      {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          windows: provider.usageLimits!.windows.map((w) => ({ ...w, usedPercent: 100 })),
        },
      },
    ];
    expect((yield* assignments.start(input, ThreadId.make("master"))).state).toBe("submitted");
    expect(f.calls).toHaveLength(1);
    expect(yield* store.reservations).toHaveLength(1);
    yield* TestClock.adjust("7 days");
    const recoveredAt = "1970-01-08T00:00:00.000Z";
    f.state.providers = [
      {
        ...provider,
        checkedAt: recoveredAt,
        usageLimits: {
          ...provider.usageLimits!,
          checkedAt: recoveredAt,
          windows: provider.usageLimits!.windows.map((w) => ({
            ...w,
            resetsAt: w.kind === "weekly" ? "1970-01-14T00:00:00.000Z" : "1970-01-08T04:00:00.000Z",
          })),
        },
      },
    ];
    const recovered = yield* assignments.start(input, ThreadId.make("master"));
    expect(recovered.state).toBe("submitted");
    expect(recovered.threadId).toBe(startInput.request.threadId);
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: "chosen",
      model: "astra",
      options: startInput.request.options,
    });
    const intent = (yield* store.reservations)[0]?.startIntent;
    expect(intent).toBeTruthy();
    yield* assignments.start(input, ThreadId.make("master"));
    expect((yield* store.reservations)[0]?.startIntent).toBe(intent);
    expect(yield* store.reservations).toHaveLength(1);
    expect(
      f.calls.every(
        (call) =>
          call.threadId === startInput.request.threadId && call.allocation?.startIntent === intent,
      ),
    ).toBe(true);
    const changed = yield* assignments
      .start({ ...input, prompt: "Changed intent" }, ThreadId.make("master"))
      .pipe(Effect.flip);
    expect(changed.code).toBe("conflict");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "complete weekly-only reads admit an exact assignment, while partial, stale and five-hour evidence stays conservative",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const weekly = { usedPercent: 5, windowDurationMins: 10080, resetsAt: 6 * 24 * 3600 };
      const complete = codexRateLimitsToLimits({
        checkedAt: at,
        completeRead: true,
        snapshot: { primary: weekly, secondary: null },
      });
      f.state.providers = [{ ...provider, usageLimits: complete }];
      const admitted = yield* allocation.execute({ _tag: "allocate", request: startInput.request });
      expect(admitted.result?.decision).toMatchObject({
        outcome: "selected",
        request: startInput.request,
      });
      expect(admitted.result?.reservation).not.toBeNull();
      const preview = () => allocation.execute({ _tag: "preview", request: startInput.request });
      f.state.providers = [
        {
          ...provider,
          usageLimits: codexRateLimitsToLimits({
            checkedAt: at,
            completeRead: true,
            snapshot: { primary: weekly },
          }),
        },
      ];
      expect((yield* preview()).result?.decision).toMatchObject({
        outcome: "selected",
        waitUntil: null,
      });
      f.state.providers = [
        {
          ...provider,
          usageLimits: codexRateLimitsToLimits({
            checkedAt: at,
            completeRead: true,
            snapshot: {
              primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 4 * 3600 },
              secondary: weekly,
            },
          }),
        },
      ];
      expect((yield* preview()).result?.decision.selectedInstanceId).toBe("chosen");
      yield* TestClock.adjust("1 hour");
      f.state.providers = [
        {
          ...provider,
          usageLimits: applyUsageLimitsUpdate({
            previous: complete,
            checkedAt: "1970-01-01T01:00:00.000Z",
            update: { windows: complete.windows.map((w) => ({ ...w, usedPercent: 6 })) },
          })!,
        },
      ];
      const stale = (yield* preview()).result!.decision;
      expect(stale.waitUntil).toBeNull();
      expect(stale.candidates[0]?.warnings?.join(" ")).toContain("missing or stale");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "lists named coordinator choices locally even when the configured authority is disconnected",
  () => {
    const f = fixture({ remote: true });
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const result = yield* allocation.execute({ _tag: "connections" });
      expect(result.connections).toEqual({
        coordinatorEnvironmentId: "remote",
        environments: [{ environmentId: "local", label: "Local" }],
      });
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "human automatic creation dispatches a durable new-thread command with unchanged model/options",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments } = yield* f.setup;
      expect((yield* assignments.start({ ...startInput, kind: "session" })).state).toBe(
        "submitted",
      );
      expect(f.dispatched[0]).toMatchObject({ type: "thread.create", projectId: "project" });
      expect(f.dispatched[1]).toMatchObject({
        type: "thread.turn.start",
        commandId: "allocation:assignment",
        modelSelection: {
          instanceId: "chosen",
          model: "astra",
          options: startInput.request.options,
        },
      });
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "legacy observation does not suppress an explicit start and native-session replacement stays invalid",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      const policy = yield* store.policy;
      yield* store.savePolicy({
        expectedVersion: policy.version,
        policy: { ...policy, mode: "observation" },
      });
      expect((yield* assignments.start(startInput, ThreadId.make("master"))).state).toBe(
        "submitted",
      );
      expect(f.calls).toHaveLength(1);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            assignments.start(
              {
                ...startInput,
                request: { ...startInput.request, nativeInstanceId: provider.instanceId },
              },
              ThreadId.make("master"),
            ),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "startup failure is released only after its durable execution receipt confirms failure",
  () => {
    const f = fixture({ fail: true });
    return Effect.gen(function* () {
      const { assignments, store, allocation } = yield* f.setup;
      expect(
        Exit.isFailure(yield* Effect.exit(assignments.start(startInput, ThreadId.make("master")))),
      ).toBe(true);
      expect((yield* store.reservations)[0]?.state).toBe("starting");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state) VALUES ('failed', 'worker', 'worker', 'work', '', ${at}, 'error')`;
      yield* allocation.execute({ _tag: "snapshot" });
      expect((yield* store.reservations)[0]?.state).toBe("released");
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "coordinator disconnection returns a safe failure without local fallback or startup",
  () => {
    const f = fixture({ remote: true });
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      expect(
        Exit.isFailure(yield* Effect.exit(assignments.start(startInput, ThreadId.make("master")))),
      ).toBe(true);
      expect(yield* store.reservations).toEqual([]);
      expect(f.calls).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

const decodeShell = Schema.decodeUnknownSync(OrchestrationThreadShell);
const shell = (sessionStatus: "running" | "error" | "ready" = "running") =>
  decodeShell({
    id: "worker",
    projectId: "project",
    title: "worker",
    modelSelection: { instanceId: "chosen", model: "astra", options: startInput.request.options },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    session: {
      threadId: "worker",
      status: sessionStatus,
      providerName: "codex",
      providerInstanceId: "chosen",
      activeTurnId: null,
      lastError: sessionStatus === "error" ? "startup rejected" : null,
      updatedAt: at,
    },
  });

it.effect(
  "recovers running, cancelled and uncertain starts after reconstruction without releasing live work",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments, store, allocation } = yield* f.setup;
      yield* assignments.start(startInput, ThreadId.make("master"));
      const release = {
        _tag: "lifecycle" as const,
        input: {
          assignmentId: "assignment",
          threadId: startInput.request.threadId,
          environmentId: "local",
          action: "release" as const,
        },
      };
      expect(Exit.isFailure(yield* Effect.exit(allocation.execute(release)))).toBe(true);
      f.state.threads = [shell()];
      // Reconstruct the service against the same durable state.
      yield* Effect.gen(function* () {
        yield* (yield* Allocation.ProviderAllocation).execute({ _tag: "snapshot" });
      }).pipe(Effect.provide(Allocation.layer));
      expect((yield* store.reservations)[0]?.state).toBe("consumed");
      expect(Exit.isFailure(yield* Effect.exit(allocation.execute(release)))).toBe(true);
      f.state.threads = [shell("ready")];
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO custom_worker_jobs (id, worker_id, target_id, kind, prompt, created_at, state) VALUES ('spawn:worker', 'worker', 'worker', 'work', '', ${at}, 'cancelled')`;
      yield* allocation.execute({ _tag: "snapshot" });
      expect((yield* store.reservations)[0]?.state).toBe("released");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "expires unused leases during inspection and recovers rejected human startup receipts",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { store, allocation } = yield* f.setup;
      yield* allocation.execute({ _tag: "allocate", request: startInput.request });
      yield* TestClock.adjust("6 minutes");
      yield* allocation.execute({ _tag: "snapshot" });
      expect((yield* store.reservations)[0]?.state).toBe("expired");
      // The used lease cannot be revived by a duplicate start.
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            allocation.execute({
              _tag: "lifecycle",
              input: {
                assignmentId: "assignment",
                environmentId: "local",
                threadId: startInput.request.threadId,
                action: "start",
                startIntent: "intent",
              },
            }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "linked host coordinator mismatch warns without preventing exact remote execution",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation, assignments } = yield* f.setup;
      const local = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
      const remote: AllocationInventory = {
        ...local,
        environmentId: "remote",
        coordinatorEnvironmentId: "different",
        accounts: local.accounts.map((a) => ({ ...a, environmentId: "remote" })),
      };
      f.state.peers = [remote];
      expect(
        (yield* allocation.execute({
          _tag: "preview",
          request: startInput.request,
        })).result?.decision.reasons.join(" "),
      ).toContain("coordinator");
      const result = yield* assignments.start(
        { ...startInput, request: { ...startInput.request, environmentId: "remote" } },
        ThreadId.make("master"),
      );
      expect(result.state).toBe("submitted");
      expect(f.calls[0]?.environment).toBe("remote");
      expect(f.calls[0]?.modelSelection.options).toEqual(startInput.request.options);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("duplicate starts retain the original intent and cannot change the task or model", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    yield* assignments.start(startInput, ThreadId.make("master"));
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          assignments.start({ ...startInput, prompt: "changed" }, ThreadId.make("master")),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          assignments.start(
            { ...startInput, request: { ...startInput.request, model: "other" } },
            ThreadId.make("master"),
          ),
        ),
      ),
    ).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(yield* store.reservations).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("honors persisted paused-Claude rejections and recovers only the allowed window", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    f.state.providers = [{ ...provider, driver: ProviderDriverKind.make("claudeAgent") }];
    f.state.threads = [shell()];
    const sql = yield* SqlClient.SqlClient;
    const write = (id: string, kind: string, payload: unknown) =>
      sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at) VALUES (${id}, 'worker', 'info', ${kind}, '', ${encodeUnknown(payload)}, ${at})`;
    const preview = () =>
      allocation.execute({
        _tag: "preview",
        request: {
          ...startInput.request,
          driver: ProviderDriverKind.make("claudeAgent"),
          explicitInstanceId: provider.instanceId,
        },
      });
    yield* write("legacy", "runtime.warning", {
      message: "Claude usage limit reached",
      detail: { status: "rejected", rateLimitType: "short", resetsAt: 3600 },
    });
    expectHistoricalWarning(yield* preview(), true);
    for (const windowId of ["short", "weekly"])
      yield* write(`reject-${windowId}`, "account.quota-state", {
        quotaStates: [{ windowId, status: "rejected" }],
      });
    yield* write("allow-short", "account.quota-state", {
      quotaStates: [{ windowId: "short", status: "allowed" }],
    });
    expectHistoricalWarning(yield* preview(), true);
    yield* write("allow-week", "account.quota-state", {
      quotaStates: [{ windowId: "weekly", status: "allowed" }],
    });
    expectHistoricalWarning(yield* preview(), false);
    yield* write("rejected-again", "account.quota-state", {
      quotaStates: [{ windowId: "short", status: "rejected" }],
    });
    expectHistoricalWarning(yield* preview(), true);
  }).pipe(Effect.provide(f.layer));
});

it.effect("recovers real-shaped historical Codex errors only after fresh confirmed cycles", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const failed = shell("error");
    const errorAt = "1969-12-30T00:00:00.000Z";
    f.state.threads = [
      {
        ...failed,
        session: {
          ...failed.session!,
          lastError: "Codex usage limit reached.",
          updatedAt: errorAt,
        },
      },
    ];
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at) VALUES ('codex-error', 'worker', 'error', 'runtime.error', '', '{"message":"Codex usage limit reached."}', ${errorAt})`;
    const preview = () => allocation.execute({ _tag: "preview", request: startInput.request });
    expectHistoricalWarning(yield* preview(), false);
    // Missing reset evidence cannot turn a same-cycle low percentage into recovery.
    f.state.providers = [
      {
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          windows: provider.usageLimits!.windows.map((w) =>
            w.id === "weekly" ? { ...w, resetsAt: "1970-01-02T00:00:00.000Z" } : w,
          ),
        },
      },
    ];
    expectHistoricalWarning(yield* preview(), true);
    // New structured receipts support recovery as soon as that rejected window resets.
    yield* sql`UPDATE projection_thread_activities SET payload_json = ${encodeUnknown({ message: "Codex usage limit reached.", quotaStates: [{ windowId: "short", status: "rejected", resetsAt: "1969-12-31T23:00:00.000Z" }] })}`;
    expectHistoricalWarning(yield* preview(), false);
    f.state.providers = [
      {
        ...provider,
        usageLimits: { ...provider.usageLimits!, checkedAt: "1969-12-31T22:00:00.000Z" },
      },
    ];
    expectHistoricalWarning(yield* preview(), true);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "a stopped Claude session recovers through a fresh scoped probe, including mapping learned after rejection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const sql = yield* SqlClient.SqlClient;
      const oldReset = "1970-01-01T00:30:00.000Z";
      const now = "1970-01-01T01:00:00.000Z";
      const read = (named: boolean, checkedAt = now) =>
        claudeUsageResponseToLimits({
          checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 0, resets_at: "1970-01-01T05:00:00.000Z" },
              seven_day: { utilization: 0, resets_at: "1970-01-08T00:30:00.000Z" },
              ...({
                model_scoped: named
                  ? [
                      {
                        display_name: "Fable",
                        utilization: 0,
                        resets_at: "1970-01-08T00:30:00.000Z",
                      },
                    ]
                  : [],
              } as object),
            },
          },
        }).limits;
      f.state.threads = [
        { ...shell("ready"), session: { ...shell("ready").session!, status: "stopped" } },
      ];
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at) VALUES ('scoped-reject', 'worker', 'info', 'account.quota-state', '', ${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "seven_day_overage_included", status: "rejected", resetsAt: oldReset }] })}, ${at})`;
      yield* TestClock.adjust("1 hour");
      const preview = () =>
        allocation.execute({
          _tag: "preview",
          request: {
            ...startInput.request,
            driver: ProviderDriverKind.make("claudeAgent"),
            explicitInstanceId: provider.instanceId,
          },
        });
      const setLimits = (usageLimits: typeof provider.usageLimits) => {
        f.state.providers = [
          { ...provider, driver: ProviderDriverKind.make("claudeAgent"), usageLimits },
        ];
      };
      setLimits(read(false));
      expectHistoricalWarning(yield* preview(), true);
      setLimits(read(true, at));
      expectHistoricalWarning(yield* preview(), true);
      setLimits(read(true));
      expectHistoricalWarning(yield* preview(), false);
      // An independently rejected weekly window must not be cleared by the scoped reset.
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at) VALUES ('other-reject', 'worker', 'info', 'account.quota-state', '', ${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "seven_day", status: "rejected", resetsAt: "1970-01-08T00:30:00.000Z" }] })}, ${at})`;
      expectHistoricalWarning(yield* preview(), true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("peer inventory reads indexed quota evidence without scanning ordinary history", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const sql = yield* SqlClient.SqlClient;
    f.state.threads = [
      shell(),
      ...Array.from({ length: 266 }, (_, i) => ({ ...shell(), id: ThreadId.make(`history-${i}`) })),
    ];
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      SELECT 'ordinary-' || i, 'worker', 'info', 'tool.completed', '', '{}', ${at} FROM n`;
    const write = (id: string, thread: string, kind: string, payload: unknown, createdAt = at) =>
      sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${id}, ${thread}, 'info', ${kind}, '', ${encodeUnknown(payload)}, ${createdAt})`;
    yield* write(
      "old-reject",
      "worker",
      "account.quota-state",
      {
        quotaStates: [{ windowId: "short", status: "rejected" }],
      },
      "1969-12-31T23:00:00.000Z",
    );
    yield* write("legacy", "worker", "runtime.warning", {
      detail: { status: "rejected", rateLimitType: "short" },
    });
    yield* write("error", "worker", "runtime.error", { message: "Usage limit reached" });
    yield* write("allow", "worker", "account.quota-state", {
      quotaStates: [{ windowId: "short", status: "allowed" }],
    });
    yield* write("ordinary-warning", "worker", "runtime.warning", { message: "Retrying" });
    yield* write("other-thread", "outside-inventory", "account.quota-state", {
      quotaStates: [{ windowId: "short", status: "rejected" }],
    });
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* allocation
      .receive("peer", { _tag: "allocationInventory" })
      .pipe(Effect.withTracer(tracer));
    const query = spans
      .map((s) => s.attributes.get("db.query.text"))
      .find(
        (q): q is string =>
          typeof q === "string" &&
          q.startsWith("SELECT payload_json, created_at, kind, rowid AS ordinal"),
      );
    expect(query).toBeDefined();
    const ids = f.state.threads.map((t) => t.id);
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!}`, ids);
    expect(
      plan.some((row) =>
        row.detail.includes("USING INDEX idx_projection_thread_activities_quota_evidence"),
      ),
    ).toBe(true);
    const rows = yield* sql.unsafe<{ kind: string; payload_json: string; ordinal: number }>(
      query!,
      ids,
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "account.quota-state",
      "runtime.error",
      "runtime.warning",
      "account.quota-state",
    ]);
    expect(rows.slice(0, 3).map((row) => row.ordinal)).toEqual([20004, 20003, 20002]);
    const payload = yield* Schema.decodeEffect(
      Schema.fromJsonString(
        Schema.Struct({ quotaStates: Schema.Array(Schema.Struct({ status: Schema.String })) }),
      ),
    )(rows[0]!.payload_json);
    expect(payload.quotaStates[0]?.status).toBe("allowed");
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "fresh complete Claude probe and later acceptance recover historical exhausted windows without deleting errors",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const sql = yield* SqlClient.SqlClient;
      f.state.threads = [
        { ...shell("ready"), session: { ...shell("ready").session!, status: "stopped" } },
      ];
      const weeklyReset = 604800;
      const warning = {
        message: "Claude usage limit reached.",
        detail: {
          status: "rejected",
          rateLimitType: "seven_day",
          resetsAt: weeklyReset,
          isUsingOverage: false,
          unifiedWindows: { seven_day: { utilization: 1, resetsAt: weeklyReset } },
        },
      };
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES ('weekly','worker','old-turn','info','runtime.warning','',${encodeUnknown(warning)},${at})`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES ('weekly-error','worker','old-turn','info','runtime.error','',${encodeUnknown({ message: "Claude usage limit reached. Send the message again once the limit resets." })},${at})`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES ('accepted','worker','new-turn','info','account.quota-state','',${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "five_hour", status: "allowed" }] })},'1970-01-01T00:01:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES ('short','worker','new-turn','info','account.quota-state','',${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "five_hour", status: "rejected", resetsAt: "1970-01-01T00:30:00.000Z" }] })},'1970-01-01T00:02:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at) VALUES ('native-retry','worker','retry-turn','assistant',${"You've hit your session limit \u00b7 resets 12:30am (UTC)"},0,'1970-01-01T00:03:00.000Z','1970-01-01T00:03:00.000Z')`;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,assistant_message_id,state,checkpoint_files_json,requested_at,started_at,completed_at) VALUES ('worker','retry-turn','native-retry','error','[]','1970-01-01T00:02:59.000Z','1970-01-01T00:02:59.000Z','1970-01-01T00:03:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES ('retry-error','worker','retry-turn','info','runtime.error','',${encodeUnknown({ message: "Claude usage limit reached. Send the message again once the limit resets." })},'1970-01-01T00:03:00.000Z')`;
      yield* TestClock.adjust("6 hours");
      const setLimits = (checkedAt = "1970-01-01T06:00:00.000Z") => {
        f.state.providers = [
          {
            ...provider,
            driver: ProviderDriverKind.make("claudeAgent"),
            usageLimits: claudeUsageResponseToLimits({
              checkedAt,
              response: {
                rate_limits_available: true,
                rate_limits: {
                  five_hour: { utilization: 0, resets_at: null },
                  seven_day: { utilization: 60, resets_at: "1970-01-08T00:00:00.000Z" },
                },
              },
            }).limits,
          },
        ];
      };
      const preview = () =>
        allocation.execute({
          _tag: "preview",
          request: {
            ...startInput.request,
            driver: ProviderDriverKind.make("claudeAgent"),
            explicitInstanceId: provider.instanceId,
          },
        });
      setLimits(at);
      expectHistoricalWarning(yield* preview(), true);
      setLimits();
      expectHistoricalWarning(yield* preview(), false);
      const rows =
        yield* sql`SELECT activity_id FROM projection_thread_activities WHERE thread_id='worker'`;
      expect(rows).toHaveLength(5);
      yield* sql`UPDATE projection_turns SET state='completed' WHERE turn_id='retry-turn'`;
      expectHistoricalWarning(yield* preview(), true);
      yield* sql`UPDATE projection_turns SET state='error' WHERE turn_id='retry-turn'`;
      expectHistoricalWarning(yield* preview(), false);
      // New authoritative rejection remains a warning even with the same fresh low probe.
      yield* sql`INSERT INTO projection_thread_activities (activity_id,thread_id,tone,kind,summary,payload_json,created_at) VALUES ('again','worker','info','account.quota-state','',${encodeUnknown({ providerInstanceId: "chosen", quotaStates: [{ windowId: "seven_day", status: "rejected", resetsAt: "1970-01-08T00:00:00.000Z" }] })},'1970-01-01T01:00:00.000Z')`;
      expectHistoricalWarning(yield* preview(), true);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "explicit managed startup retains warnings for missing quota, identity and historical rejection",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      f.state.providers = [
        { ...provider, auth: { status: "authenticated" }, usageLimits: undefined },
      ];
      f.state.threads = [
        {
          ...shell("error"),
          id: ThreadId.make("old"),
          session: { ...shell("error").session!, lastError: "Codex usage limit reached." },
        },
      ];
      const result = yield* assignments.start(
        {
          ...startInput,
          request: { ...startInput.request, explicitInstanceId: provider.instanceId },
        },
        ThreadId.make("master"),
      );
      expect(result.state).toBe("submitted");
      expect(result.allocation?.decision.reasons.join(" ")).toContain("unknown");
      expect(result.allocation?.decision.reasons.join(" ")).toContain("Provider rejected");
      expect(result.allocation?.decision.candidates[0]?.eligible).toBe(true);
      expect(f.calls[0]?.modelSelection).toEqual({
        instanceId: provider.instanceId,
        model: "astra",
        options: startInput.request.options,
      });
      expect((yield* store.reservations)[0]?.accountKey).toBeNull();
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a zero preference weight never vetoes an explicit managed launch", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store, allocation } = yield* f.setup;
    const snapshot = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!;
    const chosen = snapshot.inventories
      .flatMap((host) => host.accounts)
      .find((account) => account.instanceId === "chosen")!;
    const policy = yield* store.policy;
    yield* store.savePolicy({
      expectedVersion: policy.version,
      policy: { ...policy, accountWeights: [{ key: allocationPreferenceKey(chosen), weight: 0 }] },
    });
    const request = {
      ...startInput,
      request: { ...startInput.request, explicitInstanceId: ProviderInstanceId.make("chosen") },
    };
    expect((yield* assignments.start(request, ThreadId.make("master"))).state).toBe("submitted");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: "chosen",
      model: "astra",
      options: startInput.request.options,
    });
  }).pipe(Effect.provide(f.layer));
});

const linkedInventory = (
  id: string,
  extra: Partial<AllocationInventory> = {},
): AllocationInventory => ({
  environmentId: id,
  environmentLabel: id,
  observedAt: at,
  accounts: [],
  demand: [],
  complete: true,
  notices: [],
  ...extra,
});
const checkout = (
  id: string,
  title: string,
  repositoryKey: string | null,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/repos/${title}`,
  repositoryIdentity: repositoryKey
    ? {
        canonicalKey: repositoryKey,
        locator: { source: "project-config", projectKey: repositoryKey },
      }
    : null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: at,
  updatedAt: at,
});
const placementOf = (response: AllocationResponse) => response.placement!;

it.effect(
  "placement reads every connected computer; ordinary allocation never measures one",
  () => {
    const down = new PeerUnavailable({ environmentId: "down", message: "offline" });
    const readings: Record<string, AllocationInventory> = {
      // Plenty of memory and CPU, and measured just now.
      roomy: linkedInventory("roomy", {
        computer: {
          ...capacityAt(0),
          resources: {
            ...capacityAt(0).resources,
            availableMemoryBytes: 15 * GIB,
            cpuUtilization: 0.05,
          },
        },
      }),
      // A server that predates capacity readings reports none: unknown, never zero.
      older: linkedInventory("older"),
      // Stamped eleven minutes after its reading was taken.
      stale: linkedInventory("stale", {
        observedAt: "1970-01-01T00:11:00.000Z",
        computer: capacityAt(0),
      }),
    };
    const f = fixture({
      peerCall: (id) => (id === "down" ? Effect.fail(down) : Effect.succeed(readings[id])),
    });
    f.state.peers = ["roomy", "older", "stale", "down"].map((id) => linkedInventory(id));
    return Effect.gen(function* () {
      const { allocation, store } = yield* f.setup;
      const placement = placementOf(
        yield* allocation.execute({
          _tag: "placement",
          request: { needs: { memoryBytes: 4 * GIB } },
        }),
      );
      expect(placement.hosts.map((host) => [host.label, host.state, host.fit])).toEqual([
        ["roomy", "fresh", "fits"],
        ["Local", "fresh", "fits"],
        ["stale", "stale", "fits"],
        ["older", "unknown", "unknown"],
        ["down", "offline", "unknown"],
      ]);
      expect(placement.recommendedEnvironmentId).toBe("roomy");
      expect(placement.hosts.find((host) => host.label === "Local")?.computer?.workDisk).toBe("/");
      // Every linked computer is asked for its capacity; it is measured once per computer.
      expect(
        f.peerCalls.filter((call) => (call as { placement?: unknown }).placement),
      ).toHaveLength(4);
      expect(f.state.workPaths).toHaveLength(1);
      // Advice reserves nothing.
      expect(yield* store.reservations).toHaveLength(0);

      // The ordinary preview asks no one for capacity and measures nothing.
      f.peerCalls.length = 0;
      f.state.workPaths.length = 0;
      yield* allocation.execute({ _tag: "preview", request: startInput.request });
      expect(f.peerCalls.every((call) => !("placement" in (call as object)))).toBe(true);
      expect(f.state.workPaths).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "placement finds the project's checkouts by repository and measures the disk that holds new work",
  () => {
    const f = fixture();
    f.state.peers = [linkedInventory("remote", { projects: [] })];
    f.state.projects = [
      checkout("local-project", "scratch", "repo:example"),
      checkout("other-project", "unrelated", "repo:other"),
      checkout("no-identity", "loose", null),
    ];
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const placement = placementOf(
        yield* allocation.execute({
          _tag: "placement",
          request: { projectId: ProjectId.make("local-project") },
        }),
      );
      // The receiving computer turns its own project ID into the repository every computer can match.
      expect(placement.request.repositoryKey).toBe("repo:example");
      const local = placement.hosts.find((host) => host.label === "Local")!;
      expect(local.projects).toEqual([{ id: "local-project", title: "scratch" }]);
      expect(local.reasons).toContain("Checkout: scratch (local-project).");
      expect(placement.hosts.map((host) => host.label)).toEqual(["Local", "remote"]);
      expect(f.peerCalls).toEqual([
        { _tag: "allocationInventory", placement: { repositoryKey: "repo:example" } },
      ]);
      // With no agent work root configured, new work would be written beside the checkout.
      expect(f.state.workPaths).toEqual(["/repos/scratch"]);
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        agentWorkRoot: "/agent/jobs",
      });
      yield* allocation.execute({
        _tag: "placement",
        request: { projectId: ProjectId.make("local-project") },
      });
      expect(f.state.workPaths).toEqual(["/repos/scratch", "/agent/jobs"]);

      const loose = placementOf(
        yield* allocation.execute({
          _tag: "placement",
          request: { projectId: ProjectId.make("no-identity") },
        }),
      );
      expect(loose.request.repositoryKey).toBeUndefined();
      expect(loose.reasons.join(" ")).toContain("The project has no repository identity");
      const missing = yield* allocation
        .execute({ _tag: "placement", request: { projectId: ProjectId.make("nowhere") } })
        .pipe(Effect.flip);
      expect(missing).toMatchObject({
        code: "invalid",
        detail: "Project nowhere was not found on this computer.",
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "placement stays on this server when an older coordinator refuses it, repository resolved",
  () => {
    const f = fixture({
      remote: true,
      peerCall: (id, input) =>
        (input as { _tag?: string })._tag === "allocation"
          ? Effect.fail(new PeerRejected({ message: `${id}: Invalid allocation peer request.` }))
          : Effect.succeed(linkedInventory(id, { computer: capacityAt(0) })),
    });
    f.state.peers = [linkedInventory("remote")];
    f.state.projects = [checkout("local-project", "scratch", "repo:example")];
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const placement = placementOf(
        yield* allocation.execute({
          _tag: "placement",
          request: { projectId: ProjectId.make("local-project") },
        }),
      );
      expect(placement.hosts.map((host) => host.environmentId).toSorted()).toEqual([
        "local",
        "remote",
      ]);
      expect(placement.hosts.every((host) => host.state !== "offline")).toBe(true);
      expect(f.peerCalls).toEqual([
        { _tag: "allocationInventory", placement: { repositoryKey: "repo:example" } },
      ]);
      expect(f.state.workPaths).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("two servers exchange capacity and checkouts over the peer wire", () =>
  Effect.gen(function* () {
    const peer = fixture({ localId: "remote", label: "Remote" });
    peer.state.capacity = {
      ...capacityAt(0),
      resources: {
        ...capacityAt(0).resources,
        availableMemoryBytes: 15 * GIB,
        cpuUtilization: 0.02,
      },
    };
    peer.state.projects = [checkout("remote-project", "scratch-remote", "repo:example")];
    const peerContext = yield* Layer.build(peer.layer);
    yield* peer.setup.pipe(Effect.provide(peerContext));
    const peerAllocation = Context.get(peerContext, Allocation.ProviderAllocation);
    // Both directions are serialized, as the HTTP peer route does.
    const wire = <A>(value: A): A => JSON.parse(JSON.stringify(value));
    const f = fixture({
      peerCall: (_id, input) =>
        peerAllocation.receive("local", wire(input)).pipe(
          Effect.map(wire),
          Effect.mapError(
            (e) => new PeerUnavailable({ environmentId: "remote", message: e.message }),
          ),
        ),
    });
    f.state.peers = [linkedInventory("remote")];
    f.state.projects = [checkout("local-project", "scratch", "repo:example")];
    f.state.capacity = capacityAt(0);
    const placement = placementOf(
      yield* Effect.gen(function* () {
        const { allocation } = yield* f.setup;
        return yield* allocation.execute({
          _tag: "placement",
          request: { projectId: ProjectId.make("local-project") },
        });
      }).pipe(Effect.provide(f.layer)),
    );
    expect(placement.hosts.map((host) => [host.label, host.state, host.projects])).toEqual([
      ["Remote", "fresh", [{ id: "remote-project", title: "scratch-remote" }]],
      ["Local", "fresh", [{ id: "local-project", title: "scratch" }]],
    ]);
    expect(placement.recommendedEnvironmentId).toBe("remote");
  }).pipe(Effect.scoped),
);

it.effect("placement advice never gates or changes a managed start", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, allocation, store } = yield* f.setup;
    const placement = placementOf(
      yield* allocation.execute({
        _tag: "placement",
        request: { needs: { memoryBytes: 1024 * GIB, cpuThreads: 64, diskBytes: 1024 * GIB } },
      }),
    );
    // Nothing fits, and that is only advice.
    expect(placement.hosts.map((host) => host.fit)).toEqual(["short"]);
    expect(placement.recommendedEnvironmentId).toBe("local");
    const request = {
      ...startInput,
      request: { ...startInput.request, explicitInstanceId: ProviderInstanceId.make("chosen") },
    };
    expect((yield* assignments.start(request, ThreadId.make("master"))).state).toBe("submitted");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: "chosen",
      model: "astra",
      options: startInput.request.options,
    });
    expect(yield* store.reservations).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("placement lists an unreachable computer with its error and ranks the rest", () => {
  const f = fixture({
    remote: true,
    peerCall: (id) =>
      Effect.fail(new PeerUnavailable({ environmentId: id, message: `${id}: unreachable` })),
  });
  f.state.peers = [linkedInventory("remote")];
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const placement = placementOf(yield* allocation.execute({ _tag: "placement", request: {} }));
    const remote = placement.hosts.find((host) => host.environmentId === "remote");
    expect(remote?.state).toBe("offline");
    expect(remote?.warnings.join(" ")).toContain("remote: unreachable");
    expect(placement.recommendedEnvironmentId).toBe("local");
  }).pipe(Effect.provide(f.layer));
});
const tableModels = defaultModelRoutingPolicy.codex.allowedModels.map((slug) => ({
  ...provider.models[0]!,
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select" as const,
        options: ["medium", "high", "max", "xhigh"].map((id) => ({ id, label: id })),
      },
    ],
  },
}));
// Difficulty 3 / stakes 4 maps to gpt-6.1-sol / high in the default Codex table.
const tableStart = {
  ...startInput,
  overrides: {},
  request: {
    ...startInput.request,
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
} satisfies AllocationStart;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const storedRecommendations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    thread_id: string;
    record_json: string;
  }>`SELECT thread_id, record_json FROM worker_recommendations`).map((row) => ({
    threadId: row.thread_id,
    ...(decodeJson(row.record_json) as {
      recommendation: { model: { overrideReason?: string } };
      computers: Array<{ environmentId: string; state: string; warnings: string[] }>;
    }),
  }));
});

it.effect("every managed start needs the master's assessment", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments } = yield* f.setup;
    const { assessment: _missing, ...unscored } = startInput;
    const error = yield* Effect.flip(assignments.start(unscored, ThreadId.make("master")));
    expect(error.detail).toContain("assessment: { difficulty");
    const spawnError = yield* Effect.flip(
      assignments.spawn(ThreadId.make("master"), {
        threadId: ThreadId.make("fork"),
        sourceThreadId: ThreadId.make("source"),
        title: "fork",
        prompt: "task",
        modelSelection: { instanceId: provider.instanceId, model: "astra" },
      }),
    );
    expect(spawnError.message).toContain("assessment: { difficulty");
    expect(f.calls).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("an exact choice records the table recommendation and the master's reason", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    f.state.providers = [{ ...provider, models: tableModels }];
    const error = yield* Effect.flip(assignments.start(tableStart, ThreadId.make("master")));
    expect(error.detail).toContain(
      "overrides.model (recommended gpt-6.1-sol / high, chosen gpt-6-astra / xhigh)",
    );
    expect(yield* store.reservations).toHaveLength(0);
    const result = yield* assignments.start(
      { ...tableStart, overrides: { model: "user specified Astra xhigh" } },
      ThreadId.make("master"),
    );
    expect(result.state).toBe("submitted");
    expect(result.recommendation?.model).toEqual({
      recommended: "gpt-6.1-sol / high",
      chosen: "gpt-6-astra / xhigh",
      overrideReason: "user specified Astra xhigh",
    });
    expect(result.recommendation?.account).toEqual({ recommended: "chosen", chosen: "chosen" });
    expect(result.recommendation?.computer).toEqual({ recommended: "local", chosen: "local" });
    expect(f.calls[0]?.modelSelection.model).toBe("gpt-6-astra");
    const [stored] = yield* storedRecommendations;
    expect(stored?.recommendation.model.overrideReason).toBe("user specified Astra xhigh");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a model-only pin takes its effort from the table", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments } = yield* f.setup;
    f.state.providers = [{ ...provider, models: tableModels }];
    const result = yield* assignments.start(
      {
        ...automaticStartInput,
        overrides: { model: "user specified Astra" },
        request: {
          selection: "automatic",
          assignmentId: "pinned-model",
          threadId: startInput.request.threadId,
          environmentId: "local",
          allowedDrivers: [provider.driver],
          explicitInstanceId: provider.instanceId,
          assessment: startInput.assessment,
          override: { driver: provider.driver, model: "gpt-6-astra", reason: "User named Astra" },
        },
      },
      ThreadId.make("master"),
    );
    expect(result.state).toBe("submitted");
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: provider.instanceId,
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(result.recommendation?.model.chosen).toBe("gpt-6-astra / high");
  }).pipe(Effect.provide(f.layer));
});

it.effect("a fork records its recommendation with the continuity reason", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments } = yield* f.setup;
    f.state.providers = [{ ...provider, models: tableModels }];
    const result = yield* assignments.spawn(ThreadId.make("master"), {
      threadId: ThreadId.make("fork"),
      sourceThreadId: ThreadId.make("source"),
      title: "fork",
      prompt: "task",
      modelSelection: {
        instanceId: provider.instanceId,
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      assessment: startInput.assessment,
    });
    expect(result.recommendation?.model).toEqual({
      recommended: "gpt-6.1-sol / high",
      chosen: "gpt-6-astra / xhigh",
      overrideReason: "Fork keeps the source session's account and model for native continuity.",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).not.toHaveProperty("assessment");
    expect((yield* storedRecommendations).map((r) => r.threadId)).toEqual(["fork"]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("computer advice lists a failing peer with its error and ranks the rest", () => {
  const f = fixture({
    peerCall: (id) =>
      id === "broken"
        ? Effect.fail(
            new PeerUnavailable({
              environmentId: id,
              message: "broken: Invalid allocation peer request.",
            }),
          )
        : Effect.succeed(f.state.peers.find((p) => p.environmentId === id)!),
  });
  return Effect.gen(function* () {
    const { allocation, assignments } = yield* f.setup;
    const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
    f.state.peers = [
      { ...own, environmentId: "broken", accounts: [] },
      { ...own, environmentId: "idle", accounts: [], demand: [] },
    ];
    const result = yield* assignments.start(startInput, ThreadId.make("master"));
    expect(result.state).toBe("submitted");
    const [stored] = yield* storedRecommendations;
    const broken = stored!.computers.find((h) => h.environmentId === "broken")!;
    expect(broken.state).toBe("offline");
    expect(broken.warnings.join(" ")).toContain("Invalid allocation peer request");
    expect(stored!.computers.find((h) => h.environmentId === "local")?.state).toBe("fresh");
    // The idle peer has no matching account, so this computer still ranks first.
    expect(result.recommendation?.computer.recommended).toBe("local");
  }).pipe(Effect.provide(f.layer));
});

it.effect("an identical retry reuses the recorded recommendation without duplicates", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    const first = yield* assignments.start(startInput, ThreadId.make("master"));
    yield* TestClock.adjust("1 minute");
    const reads = f.peerCalls.length;
    const retry = yield* assignments.start(startInput, ThreadId.make("master"));
    expect(retry.state).toBe("submitted");
    expect(retry.recommendation).toEqual(first.recommendation);
    expect(f.peerCalls.length).toBe(reads);
    expect(yield* store.reservations).toHaveLength(1);
    expect(yield* storedRecommendations).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("usage recovery prefers another same-family account and observes live headroom", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const selection = { instanceId: provider.instanceId, model: "astra", options: [] };
    const spare = {
      ...provider,
      instanceId: ProviderInstanceId.make("spare"),
      auth: { ...provider.auth, email: "spare@example.test" },
    };
    f.state.providers = [provider, spare];
    expect(yield* allocation.replacement(ThreadId.make("worker"), selection)).toEqual({
      ...selection,
      instanceId: spare.instanceId,
    });
    f.state.providers = [
      provider,
      {
        ...spare,
        usageLimits: {
          ...spare.usageLimits!,
          windows: spare.usageLimits!.windows.map((w) => ({ ...w, usedPercent: 100 })),
        },
      },
    ];
    expect(yield* allocation.replacement(ThreadId.make("worker"), selection)).toBeNull();
    f.state.providers = [provider, { ...spare, auth: provider.auth }];
    expect(yield* allocation.replacement(ThreadId.make("worker"), selection)).toBeNull();
    f.state.providers = [provider, { ...spare, usageLimits: undefined }];
    expect(yield* allocation.replacement(ThreadId.make("worker"), selection)).toBeNull();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("usage recovery falls back to the other family's configured profile", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const profile = defaultModelRoutingPolicy.claudeAgent.cells[5]![5]!;
    const other = yield* decodeProvider({
      ...provider,
      instanceId: "claude-spare",
      driver: "claudeAgent",
      auth: { ...provider.auth, email: "other@example.test" },
      models: [
        {
          slug: profile.model,
          name: profile.model,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [{ id: profile.effort, label: profile.effort }],
              },
            ],
          },
        },
      ],
    });
    const same = {
      ...provider,
      instanceId: ProviderInstanceId.make("same-family"),
      auth: { ...provider.auth, email: "same@example.test" },
    };
    f.state.providers = [provider, other, same];
    expect(
      (yield* allocation.replacement(ThreadId.make("worker"), {
        instanceId: provider.instanceId,
        model: "astra",
        options: [],
      }))?.instanceId,
    ).toBe(same.instanceId);
    f.state.providers = [provider, other];
    expect(
      yield* allocation.replacement(ThreadId.make("worker"), {
        instanceId: provider.instanceId,
        model: "astra",
        options: [],
      }),
    ).toEqual({
      instanceId: other.instanceId,
      model: profile.model,
      options: [{ id: "effort", value: profile.effort }],
    });
    yield* TestClock.adjust("11 minutes");
    expect(
      yield* allocation.replacement(ThreadId.make("worker"), {
        instanceId: provider.instanceId,
        model: "astra",
        options: [],
      }),
    ).toBeNull();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("computer advice observes each computer's live session cap", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    f.state.threads = Array.from({ length: 3 }, (_, index) => ({
      ...shell(),
      id: ThreadId.make(`running-${index}`),
    }));
    const first = yield* allocation.place({});
    const local = first.inventories[0]!;
    f.state.peers = [
      {
        ...local,
        environmentId: "peer",
        environmentLabel: "peer",
        demand: [],
        computer: {
          ...local.computer!,
          resources: { ...local.computer!.resources, availableMemoryBytes: 2 * GIB },
        },
      },
    ];
    expect((yield* allocation.place({})).placement.recommendedEnvironmentId).toBe("local");
    yield* (yield* Settings.ServerSettingsService).updateSettings({ maxActiveAgentSessions: 3 });
    const limited = (yield* allocation.place({})).placement;
    expect(limited.recommendedEnvironmentId).toBe("peer");
    expect(
      limited.hosts.find((host) => host.environmentId === "local")?.warnings.join(" "),
    ).toContain("3/3");
    yield* (yield* Settings.ServerSettingsService).updateSettings({ maxActiveAgentSessions: 4 });
    expect((yield* allocation.place({})).placement.recommendedEnvironmentId).toBe("local");
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});
