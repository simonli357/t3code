import { assert, it } from "@effect/vitest";
import {
  allocationPreferenceKey,
  defaultAllocationPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WORKER_ACCOUNT_DISABLED_REASON,
  type AllocationStart,
  type ProviderInstanceId as InstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  failLatestRun,
  layerPlacementProbe,
  layerWorld,
  master,
  project,
  seed,
  setLatestRun,
} from "../workers/integration.testkit.ts";
import * as WorkerService from "../workers/WorkerService.ts";
import * as Assignments from "./AllocationAssignments.ts";
import { allocationIdentity } from "./inventory.ts";
import * as AllocationStore from "./AllocationStore.ts";
import * as Allocation from "./ProviderAllocation.ts";
import * as UsageCapEnforcement from "./UsageCapEnforcement.ts";

/**
 * Two codex logins with the models the routing table names. Their quota readings are made at the
 * test clock's start, so every account is fresh and eligible unless a test says otherwise.
 */
const START = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T12:00:00.000Z";
const efforts = ["medium", "high", "max", "xhigh"];
const capabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: efforts.map((id) => ({ id, label: id })),
    },
  ],
};
const account = (instanceId: string, email: string, weeklyUsed: number) => ({
  instanceId,
  driver: "codex",
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated", email },
  checkedAt,
  models: ["gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities,
  })),
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt,
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: weeklyUsed,
        resetsAt: "2026-11-04T12:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
  },
});
const providers = [
  account("codex", "one@example.test", 20),
  account("codex2", "two@example.test", 60),
];
const local = "environment:local";
const codex = ProviderDriverKind.make("codex");
const assessment = {
  difficulty: 5,
  difficultyReason: "Moderate refactor.",
  stakes: 4,
  stakesReason: "Easy to revert.",
};

const automatic = (threadId: string): AllocationStart => ({
  kind: "worker",
  projectId: project,
  title: "Worker",
  prompt: "Do the task.",
  request: {
    selection: "automatic",
    assignmentId: `assign:${threadId}`,
    environmentId: local,
    threadId: ThreadId.make(threadId),
    assessment,
    allowedDrivers: [codex],
  },
});

const pinned = (threadId: string, instanceId: InstanceId, extra: Partial<AllocationStart> = {}) =>
  ({
    kind: "worker",
    projectId: project,
    title: "Worker",
    prompt: "Do the task.",
    assessment,
    request: {
      assignmentId: `assign:${threadId}`,
      environmentId: local,
      threadId: ThreadId.make(threadId),
      driver: codex,
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
      explicitInstanceId: instanceId,
    },
    ...extra,
  }) satisfies AllocationStart;

const recorded = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM worker_recommendations WHERE thread_id = ${threadId}`;
    return JSON.parse(rows[0]!.record_json) as {
      recommendation: Record<"model" | "account" | "computer", Record<string, string>>;
    };
  });

it.layer(layerWorld(providers))("allocation over the real orchestrator", (it) => {
  it.effect("records an automatic and a pinned start with recommended and chosen values", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seed();
      const assignments = yield* Assignments.AllocationAssignments;
      const workers = yield* WorkerService.WorkerService;

      const auto = yield* assignments.start(automatic("thread:auto"), master);
      assert.equal(auto.state, "submitted");
      assert.equal(auto.threadId, "thread:auto");
      const autoRecord = (yield* recorded("thread:auto")).recommendation;
      assert.equal(autoRecord.account!.recommended, autoRecord.account!.chosen);
      assert.equal(autoRecord.model!.recommended, autoRecord.model!.chosen);
      assert.isDefined(autoRecord.computer!.recommended);
      assert.isTrue((yield* workers.list(master)).some((w) => w.threadId === "thread:auto"));

      // A pin that differs from the recommendation needs a reason, which is then recorded.
      const refused = yield* assignments
        .start(pinned("thread:pinned", ProviderInstanceId.make("codex2")), master)
        .pipe(Effect.flip);
      assert.match(refused.detail, /overrides\.(model|account)/);
      const overrides = {
        model: "user specified Astra xhigh",
        account: "user specified the second login",
      };
      const pin = yield* assignments.start(
        pinned("thread:pinned", ProviderInstanceId.make("codex2"), { overrides }),
        master,
      );
      assert.equal(pin.state, "submitted");
      const pinRecord = (yield* recorded("thread:pinned")).recommendation;
      assert.equal(pinRecord.account!.chosen, "codex2");
      assert.equal(pinRecord.account!.overrideReason, overrides.account);
      assert.equal(pinRecord.model!.overrideReason, overrides.model);
      assert.match(pinRecord.model!.chosen!, /gpt-6-astra \/ xhigh/);
      assert.equal(
        (yield* workers.read(master, { threadId: ThreadId.make("thread:pinned") })).worker
          .modelSelection.instanceId,
        "codex2",
      );

      // A retried start repeats its first answer instead of creating a second worker.
      const again = yield* assignments.start(automatic("thread:auto"), master);
      assert.equal(again.state, "submitted");
      assert.lengthOf(
        (yield* workers.list(master)).filter((w) => w.threadId === "thread:auto"),
        1,
      );
    }),
  );

  it.effect("never chooses an account turned off for workers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seed();
      const assignments = yield* Assignments.AllocationAssignments;
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({
        workerDisabledInstanceIds: [ProviderInstanceId.make("codex")],
      });
      const started = yield* assignments.start(automatic("thread:off-auto"), master);
      const chosen = (yield* recorded("thread:off-auto")).recommendation.account!.chosen;
      assert.equal(started.state, "submitted");
      assert.equal(chosen, "codex2");
      const refused = yield* assignments
        .start(pinned("thread:off-pinned", ProviderInstanceId.make("codex")), master)
        .pipe(Effect.flip);
      assert.equal(refused.detail, WORKER_ACCOUNT_DISABLED_REASON);
      yield* settings.updateSettings({ workerDisabledInstanceIds: [] });
    }),
  );

  it.effect("keeps a decision across a rebuilt service", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seed();
      const assignments = yield* Assignments.AllocationAssignments;
      const allocation = yield* Allocation.ProviderAllocation;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* assignments.start(automatic("thread:restart"), master);
      const before = (yield* allocation.execute({ _tag: "snapshot" })).snapshot!;
      const recordBefore = yield* recorded("thread:restart");

      // A restart rebuilds the services over the same database and runtime.
      const context = yield* Effect.context<
        | SqlClient.SqlClient
        | WorkerService.WorkerService
        | ServerSettingsService
        | ThreadManagementService.ThreadManagementService
        | Orchestrator.OrchestratorV2
      >();
      const rebuilt = yield* Layer.build(
        Assignments.layer.pipe(
          Layer.provideMerge(
            Allocation.layer.pipe(
              Layer.provide(layerPlacementProbe),
              Layer.provideMerge(AllocationStore.layer),
            ),
          ),
          Layer.fresh,
          Layer.provide(Layer.succeedContext(context)),
        ),
      );
      const restartedAssignments = Context.get(rebuilt, Assignments.AllocationAssignments);
      const restartedAllocation = Context.get(rebuilt, Allocation.ProviderAllocation);
      const after = (yield* restartedAllocation.execute({ _tag: "snapshot" })).snapshot!;
      assert.deepEqual(after.history, before.history);
      assert.deepEqual(after.reservations, before.reservations);
      assert.deepEqual(yield* recorded("thread:restart"), recordBefore);

      const again = yield* restartedAssignments.start(automatic("thread:restart"), master);
      assert.equal(again.threadId, first.threadId);
      const counts = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM worker_recommendations WHERE thread_id = ${"thread:restart"}`;
      assert.equal(counts[0]!.count, 1);
    }),
  );

  it.effect("blocks a start on an account at its verified hard cap", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seed();
      const allocation = yield* Allocation.ProviderAllocation;
      const enforcement = yield* UsageCapEnforcement.UsageCapEnforcement;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const workers = yield* WorkerService.WorkerService;
      const key = allocationPreferenceKey({
        driver: "codex",
        accountKey: allocationIdentity(providers[1] as never),
        environmentId: local,
        instanceId: "codex2",
      });
      // A worker already on the account when the cap is reached is stopped and its master told.
      const early = ThreadId.make("thread:capped-early");
      yield* workers.spawn(master, {
        threadId: early,
        title: "Early",
        projectId: project,
        prompt: "Work.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex2"), model: "gpt-6.1-sol" },
      });
      const policy = (yield* allocation.execute({ _tag: "caps" })).policy!;
      yield* allocation.execute({
        _tag: "policy",
        input: {
          expectedVersion: policy.version,
          policy: {
            ...defaultAllocationPolicy,
            version: policy.version,
            accountCaps: [
              {
                key,
                weeklyPercent: 50,
                fiveHourPercent: null,
                stopWorkers: true,
                stopMasters: false,
              },
            ],
          },
        },
      });
      const reaches = yield* enforcement.evaluate();
      assert.lengthOf(reaches, 1);
      assert.equal(reaches[0]!.capPercent, 50);

      const target = ThreadId.make("thread:capped");
      yield* workers.spawn(master, {
        threadId: target,
        title: "Capped",
        projectId: project,
        prompt: "Work.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex2"), model: "gpt-6.1-sol" },
      });
      yield* worker.drain();
      const projection = yield* orchestrator.getThreadProjection(target);
      const failure = projection.turnItems.find((item) => item.type === "error");
      assert.equal(projection.runs.at(-1)?.status, "failed");
      assert.match(
        JSON.stringify(failure),
        /Account usage cap reached\. Weekly usage is 60% of the configured 50% cap/,
      );
      const jobs = yield* (yield* SqlClient.SqlClient)<{
        id: string;
        worker_id: string;
      }>`SELECT id, worker_id FROM custom_worker_jobs WHERE id LIKE 'usage-cap:%'`;
      assert.isTrue(jobs.some((job) => job.worker_id === early));
      yield* workers.drain();
      const told = yield* orchestrator.getThreadProjection(master);
      assert.isTrue(
        told.messages.some((message) =>
          message.text.includes("[T3 worker stopped by account usage cap]"),
        ),
      );
    }),
  );

  it.effect("switches a usage-limited worker once and tells its master", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* seed();
      const workers = yield* WorkerService.WorkerService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const target = ThreadId.make("thread:limited");
      yield* workers.spawn(master, {
        threadId: target,
        title: "Limited",
        projectId: project,
        prompt: "Work.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
      });
      yield* setLatestRun(target, "running");
      yield* failLatestRun(target, {
        class: "usage_limit",
        message: "You've hit your usage limit.",
      });
      yield* workers.drain();
      const shell = yield* orchestrator.getThreadShell(target);
      assert.equal(shell?.providerInstanceId, "codex2");
      const jobs = yield* sql<{
        id: string;
        state: string;
      }>`SELECT id, state FROM custom_worker_jobs WHERE worker_id = ${target} AND kind = 'work' ORDER BY rowid`;
      assert.deepEqual(
        jobs.map((job) => job.id),
        [`spawn:${target}`, `usage-retry:spawn:${target}`],
      );
      const notices = yield* sql<{
        prompt: string;
      }>`SELECT prompt FROM custom_worker_jobs WHERE id LIKE 'notice:usage-retry:%'`;
      assert.match(notices[0]!.prompt, /Usage-limit switch: moved Limited from codex to codex2/);
      // The retry is a new run on the new account; a second limit on it is reported, not switched again.
      yield* workers.drain();
      const retried = yield* orchestrator.getThreadProjection(target);
      assert.equal(retried.runs.at(-1)?.providerInstanceId, "codex2");
      yield* setLatestRun(target, "running");
      yield* failLatestRun(target, {
        class: "usage_limit",
        message: "You've hit your usage limit.",
      });
      yield* workers.drain();
      const after = yield* sql<{
        id: string;
      }>`SELECT id FROM custom_worker_jobs WHERE worker_id = ${target} AND kind = 'work'`;
      assert.lengthOf(after, 2);
    }),
  );
});
