import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  defaultAllocationPolicy,
  ServerProvider,
  ThreadId,
  ProjectId,
  ProviderDriverKind,
  type AllocationInventory,
  OrchestrationThreadShell,
  type AllocationStart,
  type OrchestrationCommand,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./AllocationStore.ts";
import * as Allocation from "./ProviderAllocation.ts";
import * as Assignments from "./AllocationAssignments.ts";
import { PeerLinks, PeerUnavailable } from "../orchestration/PeerLinks.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import * as Settings from "../serverSettings.ts";
import * as Workers from "../orchestration/WorkerControls.ts";
import { codexRateLimitsToLimits } from "../provider/Layers/codexUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";

const at = "1970-01-01T00:00:00.000Z";
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
const startInput: AllocationStart = {
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
};

function fixture(options: { remote?: boolean; fail?: boolean } = {}) {
  const calls: Array<typeof Workers.RemoteSpawnInput.Type> = [];
  const dispatched: OrchestrationCommand[] = [];
  const state: {
    threads: OrchestrationThreadShell[];
    peers: AllocationInventory[];
    providers: ServerProvider[];
  } = {
    threads: [],
    peers: [],
    providers: [provider],
  };
  const db = NodeSqliteClient.layer({ filename: ":memory:" });
  const deps = Layer.mergeAll(
    db,
    Settings.layerTest({ allocationCoordinatorEnvironmentId: options.remote ? "remote" : "local" }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => state.providers) }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: state.threads,
          updatedAt: at,
        }),
      getThreadShellById: (id) =>
        Effect.succeed(Option.fromNullishOr(state.threads.find((t) => t.id === id))),
    }),
    Layer.succeed(UsageMeasurements, { read: () => Effect.succeed(report) }),
    Layer.succeed(PeerLinks, {
      list: Effect.sync(() =>
        state.peers.map((i) => ({ environmentId: i.environmentId, label: i.environmentId })),
      ),
      localEnvironment: Effect.succeed({ environmentId: "local", label: "Local" }),
      resolve: (id) =>
        Effect.succeed(
          Option.some({
            environmentId: id,
            label: id,
            url: "https://peer.invalid",
            token: "test-token",
          }),
        ),
      call: (id) => {
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
      policy: { ...defaultAllocationPolicy, coordinatorEnvironmentId: "local", mode: "automatic" },
    });
    return {
      store,
      allocation: yield* Allocation.ProviderAllocation,
      assignments: yield* Assignments.AllocationAssignments,
    };
  });
  return { layer, calls, dispatched, setup, state };
}

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
        outcome: "unavailable",
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
      expect((yield* preview()).result?.decision.selectedInstanceId).toBeNull();
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
      expect(stale.candidates[0]?.reasons.join(" ")).toContain("missing or stale");
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
it.effect("observation proposes without starting and refuses native-session replacement", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const { assignments, store } = yield* f.setup;
    const policy = yield* store.policy;
    yield* store.savePolicy({
      expectedVersion: policy.version,
      policy: { ...policy, mode: "observation" },
    });
    expect((yield* assignments.start(startInput, ThreadId.make("master"))).state).toBe(
      "observation",
    );
    expect(f.calls).toHaveLength(0);
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
});
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
  "all linked hosts must share the coordinator before admission, including remote execution",
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
        (yield* allocation.execute({ _tag: "allocate", request: startInput.request })).result
          ?.reservation,
      ).toBeNull();
      f.state.peers = [{ ...remote, coordinatorEnvironmentId: "local" }];
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
