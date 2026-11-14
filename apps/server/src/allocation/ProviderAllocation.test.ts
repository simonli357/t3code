import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
  legacyAllocationPolicyFields,
  defaultModelLadder,
  defaultModelRoutingPolicy,
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
  type ModelRoutingRequest,
  type ComputerCapacity,
  type OrchestrationCommand,
  type UsageMeasurementsReport,
  type UsageTurnMeasurement,
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
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
/** What the HTTP peer route does to a request and to its answer. */
const wire = (value: unknown) => decodeJson(encodeUnknown(value));
/** Whether a snapshot shows the account closed by a provider rejection or an auth failure. */
const expectHistoricalWarning = (response: AllocationResponse, present: boolean) => {
  const account = response.snapshot?.inventories[0]?.accounts.find(
    (a) => a.instanceId === "chosen",
  );
  expect(account).toBeDefined();
  expect(account?.unavailableReason?.startsWith("Provider rejected") ?? false).toBe(present);
};
const at = "1970-01-01T00:00:00.000Z";
const hoursIn = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(hours * 3_600_000));
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
      const preview = () => allocation.execute({ _tag: "snapshot" });
      expectHistoricalWarning(yield* preview(), false);
      // Current rejection remains visible even alongside fresh zero numeric usage.
      yield* sql`UPDATE projection_thread_activities SET payload_json=${encodeUnknown({ detail: { status: "rejected", rateLimitType: "short", resetsAt: 3600 } })} WHERE activity_id='warning'`;
      expectHistoricalWarning(yield* preview(), true);
      // The same login under an alias on another computer is drained by that rejection too.
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
        })).result?.decision,
      ).toMatchObject({ outcome: "wait", selectedInstanceId: null });
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
      const preview = () => allocation.execute({ _tag: "snapshot" });
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
const automaticStartInput = startInput;
/** A second Codex login beside `provider`, a little more used. */
const spareProvider: ServerProvider = {
  ...provider,
  instanceId: ProviderInstanceId.make("spare"),
  displayName: "spare",
  auth: { ...provider.auth, email: "spare@example.test" },
  usageLimits: {
    ...provider.usageLimits!,
    windows: provider.usageLimits!.windows.map((w) =>
      w.id === "weekly" ? { ...w, usedPercent: 5 } : w,
    ),
  },
};

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
    refresh: (instanceId: string) => Effect.Effect<void>;
    turns: Array<UsageTurnMeasurement & { readonly priced: number | null }>;
  } = {
    turns: [],
    threads: [],
    peers: [],
    providers: [provider],
    projects: [],
    capacity: capacityAt(Date.parse(at)),
    workPaths: [],
    refresh: () => Effect.void,
  };
  const db = NodeSqliteClient.layer({ filename: ":memory:" });
  const deps = Layer.mergeAll(
    db,
    Settings.layerTest({
      allocationCoordinatorEnvironmentId: options.remote ? "remote" : (options.localId ?? "local"),
    }),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.sync(() => state.providers),
      refreshInstance: (instanceId) =>
        Effect.suspend(() => state.refresh(instanceId)).pipe(Effect.map(() => state.providers)),
    }),
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
    Layer.succeed(UsageMeasurements, {
      evidence: Effect.sync(() => ({ turns: state.turns, quotas: [] })),
      prices: Effect.succeed(() => null),
      read: () => Effect.succeed(report),
    }),
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

/**
 * Room for every test account: a Codex worker costs a dollar an hour and Codex accounts may use
 * their whole weekly limit each day, so the preference order and margin decide between them.
 */
const roomy = Effect.gen(function* () {
  const store = yield* Store.AllocationStore;
  yield* store.saveLearned({
    learnedAt: at,
    costs: [
      {
        driver: ProviderDriverKind.make("codex"),
        model: "astra",
        effort: "high",
        kind: "worker",
        dollarsPerHour: 1,
        perHundredK: 0,
        contextTokens: 0,
        samples: 1,
        hours: 1,
        source: "measured",
      },
    ],
    limits: [],
    workerHours: null,
    notes: [],
  });
  const policy = yield* store.policy;
  yield* store.savePolicy({
    expectedVersion: policy.version,
    policy: { ...policy, codex: { ...legacyAllocationPolicyFields.codex, dailyPoints: 100 } },
  });
});

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
          // The unrelated computer's reading is abandoned as soon as the required ones are in.
          const started = yield* assignments
            .start(input, ThreadId.make("master"))
            .pipe(Effect.timeout("35 seconds"), Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("20 seconds");
          const result = yield* Fiber.join(started);
          expect(result.state).toBe("submitted");
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
        // The decision reads the execution host; so does the start, and that read fails.
        return ++reads >= 2 && !recovered
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
          ++reads <= 1
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
        // The start that may still be running elsewhere is a worker on the shared login.
        expect(chosen(baseline).workers).toBe(0);
        expect(chosen(result.allocation!.decision).workers).toBe(1);
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
    expect(f.calls).toHaveLength(1);
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
it.effect(
  "a drained account refuses the start; after the reset the same start is admitted with one durable intent",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      const master = ThreadId.make("master");
      const input: AllocationStart = {
        ...automaticStartInput,
        request: {
          selection: "automatic",
          assignmentId: startInput.request.assignmentId,
          environmentId: startInput.request.environmentId,
          threadId: startInput.request.threadId,
          allowedDrivers: [startInput.request.driver],
          policyVersion: 0,
          assessment: { difficulty: 8, stakes: 8 },
          override: {
            driver: startInput.request.driver,
            model: startInput.request.model,
            options: startInput.request.options,
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
      const refused = yield* assignments.start(input, master);
      expect(refused.state).toBe("unavailable");
      expect(refused.allocation).toBeNull();
      // Drained until both used-up windows have reset.
      expect(refused.selection?.drainedUntil).toBe("1970-01-07T00:00:00.000Z");
      expect(f.calls).toHaveLength(0);
      expect(yield* store.reservations).toHaveLength(0);
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
              resetsAt:
                w.kind === "weekly" ? "1970-01-14T00:00:00.000Z" : "1970-01-08T04:00:00.000Z",
            })),
          },
        },
      ];
      const recovered = yield* assignments.start(input, master);
      expect(recovered.state).toBe("submitted");
      expect(recovered.threadId).toBe(startInput.request.threadId);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.modelSelection).toEqual({
        instanceId: "chosen",
        model: "astra",
        options: startInput.request.options,
      });
      const intent = (yield* store.reservations)[0]?.startIntent;
      expect(intent).toBeTruthy();
      yield* assignments.start(input, master);
      expect((yield* store.reservations)[0]?.startIntent).toBe(intent);
      expect(yield* store.reservations).toHaveLength(1);
      expect(
        f.calls.every(
          (call) =>
            call.threadId === startInput.request.threadId &&
            call.allocation?.startIntent === intent,
        ),
      ).toBe(true);
      const changed = yield* assignments
        .start({ ...input, prompt: "Changed intent" }, master)
        .pipe(Effect.flip);
      expect(changed.code).toBe("conflict");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "weekly-only, partial, nearly used and stale readings all admit an exact assignment",
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
      expect(stale).toMatchObject({ outcome: "selected", waitUntil: null });
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
for (const failure of ["unreachable", "version-skew"] as const)
  it.effect(`a start decides locally when the coordinator is ${failure}`, () => {
    const f = fixture({
      remote: true,
      peerCall: (id) =>
        failure === "unreachable"
          ? Effect.fail(new PeerUnavailable({ environmentId: id, message: "remote: unreachable" }))
          : Effect.fail(new PeerRejected({ message: "remote: Invalid allocation peer request." })),
    });
    return Effect.gen(function* () {
      const { assignments, store } = yield* f.setup;
      // This computer is not the coordinator and only holds a copy of the policy.
      const current = yield* store.policy;
      yield* store.savePolicy({
        expectedVersion: current.version,
        policy: { ...current, coordinatorEnvironmentId: "remote" },
      });
      const started = yield* assignments.start(startInput, ThreadId.make("master"));
      expect(started.state).toBe("submitted");
      expect(started.allocation?.decision.selectedInstanceId).toBe(provider.instanceId);
      expect(f.calls).toHaveLength(1);
      // The reservation lives here, so its start and an identical retry stay here.
      expect((yield* store.reservations).map((r) => r.state)).toEqual(["starting"]);
      expect((yield* assignments.start(startInput, ThreadId.make("master"))).state).toBe(
        "submitted",
      );
      expect(yield* store.reservations).toHaveLength(1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

it.effect("a coordinator's deliberate refusal still fails the start", () => {
  const f = fixture({
    remote: true,
    peerCall: () =>
      Effect.fail(
        new PeerRejected({ message: "remote: This thread already has an active allocation." }),
      ),
  });
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    const error = yield* Effect.flip(assignments.start(startInput, ThreadId.make("master")));
    expect(error.code).toBe("unavailable");
    expect(f.calls).toHaveLength(0);
    expect(yield* store.reservations).toHaveLength(0);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

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
  "a linked computer that names another coordinator is noted without preventing a start there",
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
        (yield* allocation.execute({ _tag: "snapshot" })).snapshot?.notices.join(" "),
      ).toContain("name another coordinator");
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
    const preview = () => allocation.execute({ _tag: "snapshot" });
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
    const preview = () => allocation.execute({ _tag: "snapshot" });
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
      const preview = () => allocation.execute({ _tag: "snapshot" });
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

it.effect(
  "a restored model-scoped rejection clears only on a later accepted turn measured on that model",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const sql = yield* SqlClient.SqlClient;
      const reset = "1970-01-08T00:30:00.000Z";
      const now = "1970-01-01T01:00:00.000Z";
      f.state.threads = [
        { ...shell("ready"), session: { ...shell("ready").session!, status: "stopped" } },
      ];
      f.state.providers = [
        {
          ...provider,
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: claudeUsageResponseToLimits({
            checkedAt: now,
            response: {
              rate_limits_available: true,
              rate_limits: {
                seven_day: { utilization: 40, resets_at: reset },
                ...({
                  model_scoped: [{ display_name: "Fable", utilization: 20, resets_at: reset }],
                } as object),
              },
            },
          }).limits,
        },
      ];
      const write = (id: string, turn: string, kind: string, payload: unknown, createdAt: string) =>
        sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES (${id}, 'worker', ${turn}, 'info', ${kind}, '', ${encodeUnknown(payload)}, ${createdAt})`;
      // Claude rejected the Fable bucket at 100% of its use, then accepted a later turn.
      yield* write(
        "fable-rejected",
        "rejected-turn",
        "runtime.warning",
        {
          detail: {
            status: "rejected",
            rateLimitType: "seven_day_overage_included",
            resetsAt: Date.parse(reset) / 1000,
            isUsingOverage: false,
            unifiedWindows: { seven_day_overage_included: { utilization: 1 } },
          },
        },
        at,
      );
      yield* write(
        "accepted",
        "later-turn",
        "account.quota-state",
        {
          providerInstanceId: "chosen",
          quotaStates: [{ windowId: "seven_day", status: "allowed" }],
        },
        "1970-01-01T00:30:00.000Z",
      );
      yield* TestClock.adjust("1 hour");
      const preview = () => allocation.execute({ _tag: "snapshot" });
      const measured = (model: string) => ({
        instanceId: "chosen",
        accountKey: "chosen",
        threadId: "worker",
        turnId: "later-turn",
        model,
        effort: "high",
        selectionSource: "provider" as const,
        sessionCreatedAt: at,
        observedAt: "1970-01-01T00:29:00.000Z",
        startedAt: "1970-01-01T00:29:00.000Z",
        endedAt: "1970-01-01T00:31:00.000Z",
        state: "completed" as const,
        lastObservedAt: "1970-01-01T00:31:00.000Z",
        initialContextTokens: null,
        latestContextTokens: null,
        peakContextTokens: null,
        contextCapacityTokens: null,
        compactions: 0,
        mixedModels: false,
        toolWallMs: 0,
        toolTimingComplete: true,
        apiDurationMs: null,
        tokens: null,
        priced: null,
      });
      // Unmeasured, or measured on another model: the acceptance proves nothing about Fable.
      expectHistoricalWarning(yield* preview(), true);
      f.state.turns = [measured("claude-opus-5-5")];
      expectHistoricalWarning(yield* preview(), true);
      f.state.turns = [measured("claude-fable-5-2")];
      expectHistoricalWarning(yield* preview(), false);
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
      const preview = () => allocation.execute({ _tag: "snapshot" });
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
  "an explicit managed start runs on an account with no quota reading, no identity and an old rejection",
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
      expect(result.allocation?.decision.reasons[0]).toContain("pinned account.");
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

it.effect("a local fallback decides by the coordinator's policy as last read", () => {
  const coordinator = fixture({ localId: "remote" });
  let reachable = false;
  return Effect.gen(function* () {
    const authority = yield* coordinator.setup;
    const caller = fixture({
      remote: true,
      peerCall: (id, request) =>
        reachable
          ? authority.allocation.receive("local", wire(request)).pipe(
              Effect.map(wire),
              Effect.mapError((e) => new PeerRejected({ message: `remote: ${e.message}` })),
            )
          : Effect.fail(new PeerUnavailable({ environmentId: id, message: "remote: unreachable" })),
    });
    caller.state.providers = [provider, spareProvider];
    yield* roomy;
    yield* Effect.gen(function* () {
      const client = yield* caller.setup;
      yield* roomy;
      // The coordinator reads this computer's accounts over the link.
      coordinator.state.peers = [
        (yield* client.allocation.receive("remote", {
          _tag: "allocationInventory",
        })) as AllocationInventory,
      ];
      const preview = client.allocation
        .execute({ _tag: "preview", request: startInput.request })
        .pipe(Effect.map((response) => response.result?.decision.selectedInstanceId));
      // Nothing was ever read from the coordinator: this computer's own copy decides. chosen has
      // 100 points left and spare 95, so they are close and nothing prefers either.
      expect(yield* preview).toBe("chosen");
      // The order is saved on the coordinator only; this computer keeps what it last read.
      reachable = true;
      yield* client.allocation.editPolicy({ accountOrder: ["spare"] });
      expect((yield* client.store.policy).accountOrder).toEqual([]);
      expect((yield* authority.store.policy).accountOrder).toHaveLength(1);
      reachable = false;
      expect(yield* preview).toBe("spare");
      const started = yield* client.assignments.start(startInput, ThreadId.make("master"));
      expect(started.state).toBe("submitted");
      expect(caller.calls).toHaveLength(1);
      expect(caller.calls[0]?.modelSelection.instanceId).toBe("spare");
      // The reservation lives on this computer, not on the coordinator that never heard of it.
      expect((yield* client.store.reservations).map((r) => r.state)).toEqual(["starting"]);
      expect(yield* authority.store.reservations).toEqual([]);
    }).pipe(Effect.provide(Layer.fresh(caller.layer)), Effect.scoped);
  }).pipe(Effect.provide(coordinator.layer), Effect.scoped);
});

it.effect(
  "an allocation policy edit made on a linked computer applies to the coordinator's next start, with no restart",
  () => {
    const coordinator = fixture({ localId: "remote", label: "Remote" });
    return Effect.gen(function* () {
      const authority = yield* coordinator.setup;
      // The second computer reaches the coordinator only through the serialized peer call.
      const caller = fixture({
        remote: true,
        peerCall: (_id, request) =>
          authority.allocation.receive("local", wire(request)).pipe(
            Effect.map(wire),
            Effect.mapError((e) => new PeerRejected({ message: `remote: ${e.message}` })),
          ),
      });
      caller.state.providers = [provider, spareProvider];
      yield* roomy;
      yield* Effect.gen(function* () {
        const client = yield* caller.setup;
        coordinator.state.peers = [
          (yield* client.allocation.receive("remote", {
            _tag: "allocationInventory",
          })) as AllocationInventory,
        ];
        // A worker on the second computer, previewed from either one.
        const preview = (from: typeof client) =>
          from.allocation
            .execute({ _tag: "preview", request: startInput.request })
            .pipe(Effect.map((response) => response.result?.decision.selectedInstanceId));
        // chosen has 100 points left and spare 95: close, and nothing prefers either.
        expect(yield* preview(authority)).toBe("chosen");
        expect(yield* preview(client)).toBe("chosen");

        const view = yield* client.allocation.editPolicy({ accountOrder: ["spare"] });
        expect(view.accountOrder).toEqual(["spare"]);
        // It is stored on the coordinator; the editing computer's own copy is untouched.
        const stored = yield* authority.store.policy;
        expect(stored.accountOrder).toHaveLength(1);
        expect(stored.version).toBe(view.version);
        expect((yield* client.store.policy).accountOrder).toEqual([]);

        expect(yield* preview(authority)).toBe("spare");
        expect(yield* preview(client)).toBe("spare");
        const started = yield* authority.assignments.start(startInput, ThreadId.make("master"));
        expect(started.state).toBe("submitted");
        expect(coordinator.calls).toHaveLength(1);
        expect(coordinator.calls[0]).toMatchObject({
          environment: "local",
          modelSelection: { instanceId: "spare", model: "astra" },
        });

        // The margin is the same stored policy: at two points the accounts are no longer close.
        expect(
          (yield* client.allocation.editPolicy({ closeMarginPoints: 2 })).closeMarginPoints,
        ).toBe(2);
        expect(yield* preview(authority)).toBe("chosen");
        expect(yield* preview(client)).toBe("chosen");
      }).pipe(Effect.provide(Layer.fresh(caller.layer)));
    }).pipe(Effect.provide(coordinator.layer));
  },
);

it.effect(
  "a table and ladder edit made on a linked computer decides the coordinator's next start, with no restart",
  () => {
    const coordinator = fixture({ localId: "remote", label: "Remote" });
    return Effect.gen(function* () {
      const authority = yield* coordinator.setup;
      const caller = fixture({
        remote: true,
        peerCall: (_id, request) =>
          authority.allocation.receive("local", wire(request)).pipe(
            Effect.map(wire),
            Effect.mapError((e) => new PeerRejected({ message: `remote: ${e.message}` })),
          ),
      });
      caller.state.providers = [{ ...provider, models: tableModels }];
      yield* Effect.gen(function* () {
        const client = yield* caller.setup;
        coordinator.state.peers = [
          (yield* client.allocation.receive("remote", {
            _tag: "allocationInventory",
          })) as AllocationInventory,
        ];
        const request: ModelRoutingRequest = {
          selection: "automatic",
          assignmentId: "table",
          threadId: ThreadId.make("table"),
          environmentId: "local",
          allowedDrivers: [provider.driver],
          assessment: { difficulty: 3, stakes: 4 },
        };
        const chosen = (from: typeof client, wanted = request) =>
          from.allocation.execute({ _tag: "modelPreview", request: wanted }).pipe(
            Effect.map((response) => {
              const profile = response.selection?.allocation?.decision.request;
              return profile ? `${profile.model} / ${String(profile.options[0]?.value)}` : null;
            }),
          );
        expect(yield* chosen(authority)).toBe("gpt-6.1-sol / high");
        expect(yield* chosen(client)).toBe("gpt-6.1-sol / high");

        const view = yield* client.allocation.editPolicy({
          setCells: [
            { table: "codex", difficulty: 3, stakes: 4, model: "gpt-6-astra", effort: "xhigh" },
          ],
          showTable: "codex",
        });
        expect(view.modelVersion).toBe(1);
        expect(view.table?.[3]?.[4]).toBe("gpt-6-astra / xhigh");
        expect(view.table?.[3]?.[5]).toBe("gpt-6.1-sol / high");
        // Stored on the coordinator; the editing computer's own copy is untouched.
        expect((yield* authority.store.modelPolicy).codex.cells[3]![4]).toEqual({
          model: "gpt-6-astra",
          effort: "xhigh",
        });
        expect((yield* client.store.modelPolicy).version).toBe(0);
        expect(yield* chosen(authority)).toBe("gpt-6-astra / xhigh");
        expect(yield* chosen(client)).toBe("gpt-6-astra / xhigh");

        // A new build's request reaches the coordinator with the reasons older builds require.
        const forwarded = () =>
          caller.peerCalls
            .map(
              (call) =>
                call as {
                  operation?: {
                    _tag?: string;
                    request?: { assessment?: unknown; override?: unknown };
                  };
                },
            )
            .filter((call) => call.operation?._tag === "modelPreview")
            .at(-1)?.operation?.request;
        expect(forwarded()?.assessment).toEqual({
          difficulty: 3,
          stakes: 4,
          difficultyReason: "Scored by the master",
          stakesReason: "Scored by the master",
        });
        // A model-only pin takes the edited entry's effort on the coordinator.
        expect(
          yield* chosen(client, {
            ...request,
            override: { driver: provider.driver, model: "gpt-6.1-sol" },
          }),
        ).toBe("gpt-6.1-sol / xhigh");
        expect(forwarded()?.override).toEqual({
          driver: "codex",
          model: "gpt-6.1-sol",
          reason: "Pinned",
        });

        // The ladder and the fallback travel the same way; an unknown model is only warned about.
        const ladder = [{ model: "claude-next-9", effort: "high" }];
        const edited = yield* client.allocation.editPolicy({ ladder, fallback: null });
        expect(edited.ladder).toEqual(["claude-next-9 / high"]);
        expect(edited.fallback).toBeNull();
        expect(edited.warnings).toContain("Ladder: no connected account offers claude-next-9.");
        expect(yield* authority.store.modelPolicy).toMatchObject({
          version: 2,
          ladder,
          fallback: null,
        });
        // The table edit is still there.
        expect(yield* chosen(authority)).toBe("gpt-6-astra / xhigh");
      }).pipe(Effect.provide(Layer.fresh(caller.layer)));
    }).pipe(Effect.provide(coordinator.layer));
  },
);

it.effect(
  "a computer that cannot reach the coordinator decides with the copy it stored, after a restart too, and says how old it is",
  () => {
    const coordinator = fixture({ localId: "remote", label: "Remote" });
    let reachable = false;
    return Effect.gen(function* () {
      const authority = yield* coordinator.setup;
      const learned = {
        learnedAt: at,
        costs: [],
        limits: [],
        workerHours: 3,
        notes: ["learned on the coordinator"],
      };
      yield* authority.store.saveLearned(learned);
      const caller = fixture({
        remote: true,
        peerCall: (id, request) =>
          reachable
            ? authority.allocation.receive("local", wire(request)).pipe(
                Effect.map(wire),
                Effect.mapError((e) => new PeerRejected({ message: `remote: ${e.message}` })),
              )
            : Effect.fail(
                new PeerUnavailable({ environmentId: id, message: "remote: unreachable" }),
              ),
      });
      caller.state.providers = [{ ...provider, models: tableModels }];
      yield* Effect.gen(function* () {
        const client = yield* caller.setup;
        coordinator.state.peers = [
          (yield* client.allocation.receive("remote", {
            _tag: "allocationInventory",
          })) as AllocationInventory,
        ];
        const request: ModelRoutingRequest = {
          selection: "automatic",
          assignmentId: "copy",
          threadId: ThreadId.make("copy"),
          environmentId: "local",
          allowedDrivers: [provider.driver],
          assessment: { difficulty: 3, stakes: 4 },
        };
        const preview = (from: typeof client.allocation) =>
          from.execute({ _tag: "modelPreview", request }).pipe(
            Effect.map((response) => {
              const profile = response.selection?.allocation?.decision.request;
              return {
                chosen: profile ? `${profile.model} / ${String(profile.options[0]?.value)}` : null,
                notes: response.selection?.notes ?? [],
              };
            }),
          );
        // Nothing ever came from the coordinator: this computer's own settings decide, and say so.
        expect(yield* preview(client.allocation)).toEqual({
          chosen: "gpt-6.1-sol / high",
          notes: [
            "The coordinator could not be reached and never sent its settings here: decided with this computer's own settings.",
          ],
        });
        yield* authority.allocation.editPolicy({
          setCells: [
            { table: "codex", difficulty: 3, stakes: 4, model: "gpt-6-astra", effort: "xhigh" },
          ],
        });
        // The regular read of the coordinator's settings stores them here with what it learned.
        reachable = true;
        yield* TestClock.adjust("1 minute");
        expect((yield* client.allocation.execute({ _tag: "caps" })).learned).toEqual(learned);
        expect(yield* client.store.copy).toMatchObject({
          coordinatorEnvironmentId: "remote",
          learned,
        });
        expect((yield* client.store.modelPolicy).version).toBe(0);
        reachable = false;
        yield* TestClock.adjust("7 minutes");
        // A restarted server starts from the stored copy, never from built-in defaults.
        yield* Effect.gen(function* () {
          const restarted = yield* Allocation.ProviderAllocation;
          expect(yield* preview(restarted)).toEqual({
            chosen: "gpt-6-astra / xhigh",
            notes: [
              "The coordinator could not be reached: decided here with the settings and learned numbers it last sent, 7m ago.",
            ],
          });
        }).pipe(Effect.provide(Layer.fresh(Allocation.layer)));
      }).pipe(Effect.provide(Layer.fresh(caller.layer)));
    }).pipe(Effect.provide(coordinator.layer));
  },
);

const unmeasured = {
  cpuThreadsIdle: null,
  cpuThreads: null,
  memoryFreeGiB: null,
  memoryTotalGiB: null,
  workDiskFreeGiB: null,
};

it.effect(
  "computer numbers list this computer and every linked one, with null for what was not measured",
  () => {
    const down = new PeerUnavailable({ environmentId: "down", message: "offline" });
    const session = (state: "running" | "pending" | "uncertain") => ({
      environmentId: "roomy",
      threadId: ThreadId.make(`roomy-${state}`),
      instanceId: provider.instanceId,
      accountKey: null,
      model: "astra",
      options: [],
      state,
    });
    const readings: Record<string, AllocationInventory> = {
      roomy: linkedInventory("roomy", {
        computer: {
          ...capacityAt(0),
          resources: {
            ...capacityAt(0).resources,
            availableMemoryBytes: 15 * GIB,
            cpuUtilization: 0.5,
          },
        },
        // A start whose outcome is unknown is not a running session.
        demand: [session("running"), session("pending"), session("uncertain")],
      }),
      // A server that predates capacity readings reports none: unknown, never zero.
      older: linkedInventory("older"),
    };
    const f = fixture({
      peerCall: (id) => (id === "down" ? Effect.fail(down) : Effect.succeed(readings[id])),
    });
    f.state.peers = ["roomy", "older", "down"].map((id) => linkedInventory(id));
    f.state.threads = [shell()];
    return Effect.gen(function* () {
      const { allocation, store } = yield* f.setup;
      const report = yield* allocation.computers({});
      expect(report.at).toBe(at);
      expect(report.computers).toEqual([
        {
          environmentId: "local",
          label: "Local",
          reachable: true,
          cpuThreadsIdle: 12,
          cpuThreads: 16,
          memoryFreeGiB: 10,
          memoryTotalGiB: 16,
          workDiskFreeGiB: 120,
          sessions: 1,
          projectId: null,
        },
        {
          environmentId: "roomy",
          label: "roomy",
          reachable: true,
          cpuThreadsIdle: 8,
          cpuThreads: 16,
          memoryFreeGiB: 15,
          memoryTotalGiB: 16,
          workDiskFreeGiB: 120,
          sessions: 2,
          projectId: null,
        },
        {
          environmentId: "older",
          label: "older",
          reachable: true,
          ...unmeasured,
          sessions: 0,
          projectId: null,
        },
        {
          environmentId: "down",
          label: "down",
          reachable: false,
          ...unmeasured,
          sessions: null,
          projectId: null,
        },
      ]);
      expect(report.notes).toEqual(["down: load unavailable for this decision: offline"]);
      // Numbers only: nothing is ranked or recommended.
      expect(Object.keys(report).toSorted()).toEqual(["at", "computers", "notes"]);
      // Every linked computer is asked once; this one is measured once; nothing is reserved.
      expect(f.peerCalls).toEqual(
        ["roomy", "older", "down"].map(() => ({ _tag: "allocationInventory", placement: {} })),
      );
      expect(f.state.workPaths).toHaveLength(1);
      expect(yield* store.reservations).toHaveLength(0);

      // An ordinary preview asks no one for capacity and measures nothing.
      f.peerCalls.length = 0;
      f.state.workPaths.length = 0;
      yield* allocation.execute({ _tag: "preview", request: startInput.request });
      expect(f.peerCalls.every((call) => !("placement" in (call as object)))).toBe(true);
      expect(f.state.workPaths).toHaveLength(0);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("computer numbers find the project on each computer by its repository", () => {
  const f = fixture({
    peerCall: (id, input) =>
      Effect.succeed(
        linkedInventory(
          id,
          (input as { placement?: { repositoryKey?: string } }).placement?.repositoryKey ===
            "repo:example"
            ? { projects: [{ id: ProjectId.make("remote-project"), title: "scratch-remote" }] }
            : {},
        ),
      ),
  });
  f.state.peers = [linkedInventory("remote")];
  f.state.projects = [
    checkout("local-project", "scratch", "repo:example"),
    checkout("other-project", "unrelated", "repo:other"),
    checkout("no-identity", "loose", null),
  ];
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const projects = (projectId: string) =>
      allocation.computers({ projectId: ProjectId.make(projectId) }).pipe(
        Effect.map((report) => ({
          ids: report.computers.map((computer) => [computer.label, computer.projectId]),
          notes: report.notes,
        })),
      );
    // This computer turns its own project ID into the repository every computer can match.
    expect(yield* projects("local-project")).toEqual({
      ids: [
        ["Local", "local-project"],
        ["remote", "remote-project"],
      ],
      notes: [],
    });
    expect(f.peerCalls).toEqual([
      { _tag: "allocationInventory", placement: { repositoryKey: "repo:example" } },
    ]);
    // With no agent work root configured, new work would be written beside the checkout.
    expect(f.state.workPaths).toEqual(["/repos/scratch"]);
    yield* (yield* Settings.ServerSettingsService).updateSettings({
      agentWorkRoot: "/agent/jobs",
    });
    yield* projects("local-project");
    expect(f.state.workPaths).toEqual(["/repos/scratch", "/agent/jobs"]);

    const loose = yield* projects("no-identity");
    expect(loose.ids).toEqual([
      ["Local", null],
      ["remote", null],
    ]);
    expect(loose.notes.join(" ")).toContain("The project has no repository identity");
    // An unknown project, such as another computer's ID, still gets the numbers, with a note.
    const missing = yield* projects("nowhere");
    expect(missing.ids).toEqual([
      ["Local", null],
      ["remote", null],
    ]);
    expect(missing.notes).toEqual([
      "Project nowhere was not found on this computer, so no checkout was matched.",
    ]);
  }).pipe(Effect.provide(f.layer));
});

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
    const report = yield* Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      return yield* allocation.computers({ projectId: ProjectId.make("local-project") });
    }).pipe(Effect.provide(f.layer));
    expect(
      report.computers.map((computer) => [
        computer.label,
        computer.reachable,
        computer.memoryFreeGiB,
        computer.projectId,
      ]),
    ).toEqual([
      ["Local", true, 10, "local-project"],
      ["Remote", true, 15, "remote-project"],
    ]);
    expect(report.notes).toEqual([]);
  }).pipe(Effect.scoped),
);

// Difficulty 3 / stakes 4 maps to gpt-6.1-sol / high in the default Codex table.
const automaticStart = (id: string, pins: Partial<ModelRoutingRequest> = {}): AllocationStart => ({
  kind: "worker",
  projectId: startInput.projectId,
  title: startInput.title,
  prompt: startInput.prompt,
  request: {
    selection: "automatic",
    assignmentId: id,
    threadId: ThreadId.make(id),
    environmentId: "local",
    allowedDrivers: [provider.driver],
    assessment: { difficulty: 3, stakes: 4 },
    ...pins,
  },
});
const storedRecommendations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    thread_id: string;
    record_json: string;
  }>`SELECT thread_id, record_json FROM worker_recommendations ORDER BY thread_id`).map((row) => ({
    threadId: row.thread_id,
    ...(decodeJson(row.record_json) as { recommendation: unknown; request: unknown }),
  }));
});

it.effect("a worker start records the server's own choice next to the one that ran", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments } = yield* f.setup;
    const master = ThreadId.make("master");
    f.state.providers = [
      { ...provider, models: tableModels },
      { ...spareProvider, models: tableModels },
    ];
    const astra = {
      driver: provider.driver,
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    };
    // The user named the account and the model.
    const pinned = yield* assignments.start(
      automaticStart("pinned", { explicitInstanceId: spareProvider.instanceId, override: astra }),
      master,
    );
    expect(pinned.state).toBe("submitted");
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: "spare",
      model: "gpt-6-astra",
      options: astra.options,
    });
    const free = yield* assignments.start(automaticStart("free"), master);
    expect(free.state).toBe("submitted");
    expect(f.calls[1]?.modelSelection).toEqual({
      instanceId: "chosen",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(yield* storedRecommendations).toEqual([
      {
        threadId: "free",
        recommendation: {
          at,
          assessment: { difficulty: 3, stakes: 4 },
          model: { recommended: "gpt-6.1-sol / high", chosen: "gpt-6.1-sol / high" },
          account: { recommended: "chosen", chosen: "chosen" },
        },
        request: {
          driver: "codex",
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
      {
        threadId: "pinned",
        recommendation: {
          at,
          assessment: { difficulty: 3, stakes: 4 },
          model: { recommended: "gpt-6.1-sol / high", chosen: "gpt-6-astra / xhigh" },
          account: { recommended: "chosen", chosen: "spare" },
        },
        request: astra,
      },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a model-only pin takes its effort from the table", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments } = yield* f.setup;
    f.state.providers = [{ ...provider, models: tableModels }];
    const result = yield* assignments.start(
      automaticStart("pinned-model", {
        explicitInstanceId: provider.instanceId,
        override: { driver: provider.driver, model: "gpt-6-astra" },
      }),
      ThreadId.make("master"),
    );
    expect(result.state).toBe("submitted");
    expect(f.calls[0]?.modelSelection).toEqual({
      instanceId: provider.instanceId,
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("an identical retry reuses the reservation and the recorded choice", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    f.state.providers = [{ ...provider, models: tableModels }];
    const input = automaticStart("retry");
    const first = yield* assignments.start(input, ThreadId.make("master"));
    yield* TestClock.adjust("1 minute");
    const retry = yield* assignments.start(input, ThreadId.make("master"));
    expect(retry.state).toBe("submitted");
    expect(retry.selection).toEqual(first.selection);
    expect(yield* store.reservations).toHaveLength(1);
    expect(yield* storedRecommendations).toHaveLength(1);
    // The worker spawn is itself idempotent and receives the identical intent both times.
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toEqual(f.calls[0]);
  }).pipe(Effect.provide(f.layer));
});

const ladderModels = [...new Set(defaultModelLadder.map((rung) => rung.model))].map((slug) => ({
  ...provider.models[0]!,
  slug,
  name: slug,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
      },
    ],
  },
}));
// The default ladder ends: ... opus xhigh, fable medium, fable high.
const OPUS = defaultModelLadder[6]!.model;
const FABLE = defaultModelLadder[8]!.model;
/** A Claude login. `fable` is how much of Fable's own weekly window is used, and when it resets. */
const claudeAccount = (
  id: string,
  usage: { weekly?: number; fable?: number; fableResetHours?: number } = {},
): ServerProvider => ({
  ...provider,
  instanceId: ProviderInstanceId.make(id),
  displayName: id,
  driver: ProviderDriverKind.make("claudeAgent"),
  auth: { ...provider.auth, email: `${id}@example.test` },
  models: ladderModels,
  usageLimits: {
    checkedAt: at,
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: usage.weekly ?? 20,
        resetsAt: hoursIn(100),
        windowDurationMins: 10080,
      },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        modelScope: "Fable",
        usedPercent: usage.fable ?? 0,
        resetsAt: hoursIn(usage.fableResetHours ?? 100),
        windowDurationMins: 10080,
      },
    ],
  },
});

it.effect(
  "a limited worker moves account first, waits for a near reset, and changes model only for a far one",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const current = {
        instanceId: ProviderInstanceId.make("a"),
        model: FABLE,
        options: [{ id: "effort", value: "high" }],
      };
      const route = (options?: { rejected?: boolean; switchAccount?: boolean }) =>
        allocation.reroute(ThreadId.make("worker"), current, options);
      const fableDrained = (id: string, resetHours: number) =>
        claudeAccount(id, { fable: 100, fableResetHours: resetHours });

      // Nothing is known against the account: the worker stays where it is.
      f.state.providers = [claudeAccount("a"), claudeAccount("b")];
      expect(yield* allocation.limited(current)).toBe(false);
      expect(yield* route()).toEqual({ _tag: "proceed" });

      // 1. The same model on another account that is not drained.
      f.state.providers = [fableDrained("a", 10), claudeAccount("b")];
      expect(yield* allocation.limited(current)).toBe(true);
      // Only Fable is drained there; a worker on another model is not limited.
      expect(yield* allocation.limited({ ...current, model: OPUS })).toBe(false);
      expect(yield* route()).toEqual({
        _tag: "switch",
        selection: { ...current, instanceId: "b" },
        modelChanged: false,
      });
      // A worker that supervises its own workers only waits.
      expect(yield* route({ switchAccount: false })).toEqual({
        _tag: "wait",
        until: hoursIn(10),
        observed: true,
        long: true,
      });

      // 2. No other account has the model, and the reset is within the long wait: wait.
      f.state.providers = [fableDrained("a", 2), fableDrained("b", 50)];
      expect(yield* route()).toEqual({
        _tag: "wait",
        until: hoursIn(2),
        observed: true,
        long: false,
      });

      // 3. The reset is far: the closest model that has room, and the master is told. Only
      // Fable is drained, so the worker's own account, which has the most room, may keep it.
      f.state.providers = [fableDrained("a", 10), fableDrained("b", 50)];
      expect(yield* route()).toEqual({
        _tag: "switch",
        selection: {
          instanceId: "a",
          model: OPUS,
          options: [{ id: "effort", value: "xhigh" }],
        },
        modelChanged: true,
      });

      // 4. No model has room anywhere: wait, and the master is told. Codex is never the way out.
      f.state.providers = [
        claudeAccount("a", { fable: 100, weekly: 100 }),
        claudeAccount("b", { weekly: 100 }),
        provider,
      ];
      expect(yield* route()).toEqual({
        _tag: "wait",
        until: hoursIn(100),
        observed: true,
        long: true,
      });

      // The long wait is stored policy: raised, a ten-hour reset is near; lowered, two hours is far.
      f.state.providers = [fableDrained("a", 10), fableDrained("b", 50)];
      expect((yield* allocation.editPolicy({ longWaitHours: 12 })).longWaitHours).toBe(12);
      expect(yield* route()).toEqual({
        _tag: "wait",
        until: hoursIn(10),
        observed: true,
        long: false,
      });
      expect((yield* allocation.editPolicy({ longWaitHours: 1 })).longWaitHours).toBe(1);
      f.state.providers = [fableDrained("a", 2), fableDrained("b", 50)];
      expect(yield* route()).toMatchObject({
        _tag: "switch",
        selection: { instanceId: "a", model: OPUS },
        modelChanged: true,
      });
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect("in Fable mode a limited worker changes model only between Fable rungs", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const current = {
      instanceId: ProviderInstanceId.make("a"),
      model: FABLE,
      options: [{ id: "effort", value: "high" }],
    };
    // Fable is drained everywhere and resets far away; Opus has room.
    f.state.providers = [
      claudeAccount("a", { fable: 100, fableResetHours: 10 }),
      claudeAccount("b", { fable: 100, fableResetHours: 50 }),
    ];
    // Turning Fable mode on turns Fable workers on.
    yield* allocation.editPolicy({ fableWorkers: false });
    expect(yield* allocation.editPolicy({ fableOnly: true })).toMatchObject({
      fableWorkers: true,
      fableOnly: true,
    });
    expect(yield* allocation.reroute(ThreadId.make("worker"), current)).toEqual({
      _tag: "wait",
      until: hoursIn(10),
      observed: true,
      long: true,
    });
    // Turning Fable workers off turns Fable mode off: the worker leaves Fable.
    expect(yield* allocation.editPolicy({ fableWorkers: false })).toMatchObject({
      fableWorkers: false,
      fableOnly: false,
    });
    expect(yield* allocation.reroute(ThreadId.make("worker"), current)).toMatchObject({
      _tag: "switch",
      selection: { model: OPUS },
      modelChanged: true,
    });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "a rejected worker takes the same model on another login, and otherwise retries in half an hour",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      yield* roomy;
      const selection = { instanceId: provider.instanceId, model: "astra", options: [] };
      const route = allocation.reroute(ThreadId.make("worker"), selection, { rejected: true });
      const used = (base: ServerProvider, windowId?: string): ServerProvider => ({
        ...base,
        usageLimits: {
          ...base.usageLimits!,
          windows: base.usageLimits!.windows.map((w) =>
            windowId === undefined || w.id === windowId ? { ...w, usedPercent: 100 } : w,
          ),
        },
      });
      // No reading names the exhausted window, so the rejected account is retried in half an hour.
      const wait = {
        _tag: "wait",
        until: "1970-01-01T00:30:00.000Z",
        observed: false,
        long: false,
      };
      f.state.providers = [provider, spareProvider];
      expect(yield* route).toEqual({
        _tag: "switch",
        selection: { ...selection, instanceId: "spare" },
        modelChanged: false,
      });
      f.state.providers = [provider, used(spareProvider)];
      expect(yield* route).toEqual(wait);
      // The same login under another alias was rejected with it.
      f.state.providers = [provider, { ...spareProvider, auth: provider.auth }];
      expect(yield* route).toEqual(wait);
      // An account without a reading is not known to be drained.
      f.state.providers = [provider, { ...spareProvider, usageLimits: undefined }];
      expect(yield* route).toMatchObject({ _tag: "switch", selection: { instanceId: "spare" } });
      // A week's wait never moves a Codex worker to another model or to Claude.
      f.state.providers = [used(provider, "weekly"), claudeAccount("claude")];
      expect(yield* route).toEqual({
        _tag: "wait",
        until: "1970-01-07T00:00:00.000Z",
        observed: true,
        long: true,
      });
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

it.effect("a reached hard cap closes its account to workers until the provider reset", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation } = yield* f.setup;
    const selection = { instanceId: provider.instanceId, model: "astra", options: [] };
    const route = allocation.reroute(ThreadId.make("worker"), selection);
    const at81 = (base: ServerProvider): ServerProvider => ({
      ...base,
      usageLimits: {
        ...base.usageLimits!,
        windows: base.usageLimits!.windows.map((w) =>
          w.id === "weekly" ? { ...w, usedPercent: 81 } : w,
        ),
      },
    });
    const cap = { weeklyPercent: 80, fiveHourPercent: null, stopMasters: true };
    f.state.providers = [at81(provider), spareProvider];
    // A cap that does not stop workers leaves them alone.
    yield* allocation.editPolicy({ setCaps: [{ account: "chosen", ...cap, stopWorkers: false }] });
    expect(yield* allocation.limited(selection)).toBe(false);
    expect(yield* route).toEqual({ _tag: "proceed" });
    yield* allocation.editPolicy({ setCaps: [{ account: "chosen", ...cap, stopWorkers: true }] });
    expect(yield* allocation.limited(selection)).toBe(true);
    expect(yield* route).toEqual({
      _tag: "switch",
      selection: { ...selection, instanceId: "spare" },
      modelChanged: false,
    });
    // A capped account is not a destination either.
    f.state.providers = [at81(provider), at81(spareProvider)];
    yield* allocation.editPolicy({ setCaps: [{ account: "spare", ...cap, stopWorkers: true }] });
    expect(yield* route).toEqual({
      _tag: "wait",
      until: "1970-01-07T00:00:00.000Z",
      observed: true,
      long: true,
    });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "worker availability defaults on and disabling an account excludes only new workers",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation, assignments } = yield* f.setup;
      const settings = yield* Settings.ServerSettingsService;
      expect((yield* settings.getSettings).workerDisabledInstanceIds).toEqual([]);
      const preview = () => allocation.execute({ _tag: "preview", request: startInput.request });
      expect((yield* preview()).result?.decision.selectedInstanceId).toBe(provider.instanceId);
      yield* settings.updateSettings({ workerDisabledInstanceIds: [provider.instanceId] });
      const disabled = (yield* preview()).result!.decision;
      expect(disabled.selectedInstanceId).toBeNull();
      expect(disabled.candidates[0]).toMatchObject({
        eligible: false,
        reasons: ["Turned off for workers in Provider allocation settings"],
      });
      const error = yield* Effect.flip(
        assignments.start(
          {
            ...startInput,
            request: { ...startInput.request, explicitInstanceId: provider.instanceId },
          },
          ThreadId.make("master"),
        ),
      );
      expect(error.detail).toBe("Turned off for workers in Provider allocation settings");
      expect(f.calls).toHaveLength(0);
      expect((yield* assignments.start({ ...startInput, kind: "session" })).state).toBe(
        "submitted",
      );
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "usage-limit recovery skips disabled worker accounts and can use them again when enabled",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      yield* roomy;
      const settings = yield* Settings.ServerSettingsService;
      const selection = { instanceId: provider.instanceId, model: "astra", options: [] };
      const spare = {
        ...provider,
        instanceId: ProviderInstanceId.make("spare"),
        auth: { ...provider.auth, email: "spare@example.test" },
      };
      const enabled = {
        ...provider,
        instanceId: ProviderInstanceId.make("enabled"),
        auth: { ...provider.auth, email: "enabled@example.test" },
      };
      f.state.providers = [provider, spare, enabled];
      yield* settings.updateSettings({ workerDisabledInstanceIds: [spare.instanceId] });
      const route = allocation.reroute(ThreadId.make("worker"), selection, { rejected: true });
      expect(yield* route).toMatchObject({ selection: { instanceId: enabled.instanceId } });
      yield* settings.updateSettings({
        workerDisabledInstanceIds: [spare.instanceId, enabled.instanceId],
      });
      expect((yield* route)._tag).toBe("wait");
      yield* settings.updateSettings({ workerDisabledInstanceIds: [enabled.instanceId] });
      expect(yield* route).toMatchObject({ selection: { instanceId: spare.instanceId } });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("explicit peer worker starts use the destination's availability setting", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { allocation, assignments } = yield* f.setup;
    const own = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!.inventories[0]!;
    f.state.peers = [
      {
        ...own,
        environmentId: "peer",
        accounts: own.accounts.map((a) => ({
          ...a,
          environmentId: "peer",
          availableForWorkers: false,
        })),
      },
    ];
    const error = yield* Effect.flip(
      assignments.start(
        {
          ...startInput,
          request: {
            ...startInput.request,
            environmentId: "peer",
            explicitInstanceId: provider.instanceId,
          },
        },
        ThreadId.make("master"),
      ),
    );
    expect(error.detail).toBe("Turned off for workers in Provider allocation settings");
    expect(f.calls).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "a decision refreshes stale quota readings first, and waits only briefly for them",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const { allocation } = yield* f.setup;
      const refreshed: string[] = [];
      const reading = (checkedAt: string, usedPercent: number): ServerProvider => ({
        ...provider,
        usageLimits: {
          ...provider.usageLimits!,
          checkedAt,
          windows: provider.usageLimits!.windows.map((w) =>
            w.id === "weekly" ? { ...w, usedPercent } : w,
          ),
        },
      });
      /** The room the decision saw. */
      const room = (response: AllocationResponse) =>
        response.result!.decision.candidates[0]!.roomPoints;
      const preview = allocation.execute({ _tag: "preview", request: startInput.request });
      f.state.refresh = (instanceId) =>
        Effect.sync(() => {
          refreshed.push(instanceId);
          f.state.providers = [reading("1970-01-01T00:11:00.000Z", 40)];
        });
      expect(room(yield* preview)).toBe(100);
      expect(refreshed).toEqual([]);
      yield* TestClock.adjust("11 minutes");
      // Looking at the accounts is not a decision and probes nothing.
      yield* allocation.execute({ _tag: "snapshot" });
      expect(refreshed).toEqual([]);
      // The decision sees the reading the probe brought back.
      expect(room(yield* preview)).toBe(60);
      expect(refreshed).toEqual([provider.instanceId]);
      // An account that does not answer costs a start three seconds, once a minute at most, and
      // the decision is made from the reading it has.
      f.state.refresh = (instanceId) =>
        Effect.sync(() => refreshed.push(instanceId)).pipe(Effect.andThen(Effect.never));
      yield* TestClock.adjust("11 minutes");
      const slow = yield* Effect.forkChild(preview);
      yield* TestClock.adjust("3 seconds");
      expect(room(yield* Fiber.join(slow))).toBe(60);
      expect(room(yield* preview)).toBe(60);
      expect(refreshed).toEqual([provider.instanceId, provider.instanceId]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);
