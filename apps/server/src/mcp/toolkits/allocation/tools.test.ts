import * as DateTime from "effect/DateTime";
import { expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationAccount,
  type AllocationInventory,
  type AllocationOperation,
  type AllocationPolicyEdit,
  type AllocationPolicyView,
  type AllocationStart,
  type AllocationWindow,
  type ComputersReport,
  type ComputersRequest,
  type ModelRoutingDecision,
  type ModelRoutingRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import { chooseProfile } from "../../../allocation/modelDecision.ts";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AllocationTools from "./tools.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-11-10T12:00:00.000Z";
const inHours = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + hours * 3_600_000));
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const OPUS = defaultModelLadder[6]!.model;
const FABLE = defaultModelLadder[8]!.model;
const window = (
  id: string,
  label: string,
  usedPoints: number,
  hours: number,
  patch: Partial<AllocationWindow> = {},
): AllocationWindow => ({
  id,
  label,
  kind: id === "five_hour" ? "session" : "weekly",
  usedPoints,
  checkedAt: at,
  resetsAt: inHours(hours),
  cycleStartedAt: null,
  durationHours: id === "five_hour" ? 5 : 168,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
  ...patch,
});
/** A Claude subscription as the provider reports it; Fable's own weekly window is used up. */
const claude = (
  instanceId: string,
  label: string,
  fiveHour: number,
  weekly: number,
  fableResetHours: number,
): AllocationAccount => ({
  environmentId: "local",
  instanceId: ProviderInstanceId.make(instanceId),
  driver: claudeAgent,
  accountKey: `login-${label}`,
  label,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [...new Set(defaultModelLadder.map((rung) => rung.model))].map((slug) => ({
    slug,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          type: "select" as const,
          label: "Effort",
          options: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
  shortWindow: "reported",
  windows: [
    window("five_hour", "5-hour", fiveHour, 2),
    window("seven_day", "Weekly", weekly, 90),
    window("seven_day_fable", "Weekly · Fable", 100, fableResetHours, { models: [FABLE] }),
  ],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
});
// The user's five Claude accounts. Room is the tighter of the two account-wide windows:
// ARA 62, ES 45, XL 29, AC 10, XY 40.
const inventory: AllocationInventory = {
  environmentId: "local",
  observedAt: at,
  complete: true,
  notices: [],
  accounts: [
    claude("claudeAgent", "ARA", 20, 38, 40),
    claude("claude_eol", "ES", 5, 55, 9),
    claude("claude_xinya", "XL", 40, 71, 60),
    claude("claude_antoine", "AC", 0, 90, 26),
    claude("claude_xiyang", "XY", 60, 12, 100),
  ],
  demand: [
    {
      environmentId: "local",
      threadId: ThreadId.make("busy"),
      instanceId: ProviderInstanceId.make("claudeAgent"),
      accountKey: "login-ARA",
      model: OPUS,
      options: [],
      state: "running",
      worker: true,
    },
  ],
};
// The table asks for Fable high everywhere.
const modelPolicy = {
  ...defaultModelRoutingPolicy,
  claudeAgent: {
    allowedModels: [OPUS, FABLE],
    cells: defaultModelRoutingPolicy.claudeAgent.cells.map((row) =>
      row.map(() => ({ model: FABLE, effort: "high" })),
    ),
  },
};
/** The selection a coordinator answers with, from the real decision. */
const select = (request: ModelRoutingRequest): ModelRoutingDecision => {
  const choice = chooseProfile({
    at,
    policy: defaultAllocationPolicy,
    modelPolicy,
    request,
    inventories: [inventory],
    reservations: [],
    authorityAvailable: true,
  });
  return {
    at,
    policyVersion: 0,
    request,
    revision: 0,
    selectedProfile: null,
    rule: choice.rule,
    profiles: [],
    reasons: [choice.reason],
    allocation: choice.decision
      ? { decision: choice.decision, reservation: null, mode: "automatic" }
      : null,
    ...(choice.wanted && choice.decision
      ? {
          wanted: {
            driver: choice.wanted.driver,
            model: choice.wanted.model,
            options: choice.wanted.options,
          },
        }
      : {}),
    ...(choice.drainedUntil !== undefined ? { drainedUntil: choice.drainedUntil } : {}),
    accounts: [...choice.accounts],
  };
};
const view: AllocationPolicyView = {
  version: 4,
  modelVersion: 2,
  accountOrder: ["ES", "XL"],
  closeMarginPoints: 10,
  longWaitHours: 2,
  caps: [],
  ladder: defaultModelLadder.map(({ model, effort }) => `${model} / ${effort}`),
  fallback: null,
  accounts: [
    { label: "ES", driver: claudeAgent, instanceIds: [ProviderInstanceId.make("claude_eol")] },
  ],
  warnings: ["claudeAgent table: no connected account offers claude-next-9."],
};
const report: ComputersReport = {
  at,
  computers: [
    {
      environmentId: "local",
      label: "Desk",
      reachable: true,
      cpuThreadsIdle: 6.4,
      cpuThreads: 8,
      memoryFreeGiB: 8,
      memoryTotalGiB: 16,
      workDiskFreeGiB: 120.5,
      sessions: 3,
      projectId: null,
    },
    {
      environmentId: "laptop",
      label: "Laptop",
      reachable: false,
      cpuThreadsIdle: null,
      cpuThreads: null,
      memoryFreeGiB: null,
      memoryTotalGiB: null,
      workDiskFreeGiB: null,
      sessions: null,
      projectId: null,
    },
  ],
  notes: ["Laptop: load unavailable for this decision."],
};

it.effect("agents preview, start, read numbers and edit the policy with compact results", () => {
  const edits: AllocationPolicyEdit[] = [];
  const operations: AllocationOperation[] = [];
  const starts: { input: AllocationStart; owner: string | undefined }[] = [];
  const asked: ComputersRequest[] = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          threadId: ThreadId.make("master"),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<Invocation.McpCapability>(),
          issuedAt: 1,
        }),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            clientCapabilities: {},
            clientInfo: { name: "test", version: "1" },
            protocolVersion: "2025-06-18",
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );

    // A preview needs the two scores and the computer, nothing else.
    const scores = { environmentId: "local", difficulty: 9, stakes: 9 };
    const preview = yield* call("t3_allocate_account", scores);
    expect(preview.isError).not.toBe(true);
    expect(operations).toEqual([
      {
        _tag: "modelPreview",
        request: {
          selection: "automatic",
          assignmentId: "preview:master",
          environmentId: "local",
          threadId: "preview:master",
          assessment: { difficulty: 9, stakes: 9 },
          allowedDrivers: ["claudeAgent"],
        },
      },
    ]);
    // Nothing learned yet: at the starting estimates no account lasts the whole job.
    const chosen = {
      instanceId: "claude_eol",
      driver: "claudeAgent",
      model: OPUS,
      effort: "xhigh",
    };
    const choice = preview.structuredContent as Record<string, unknown>;
    expect(choice).toMatchObject({ state: "chosen", chosen, wanted: `${FABLE} / high` });
    // Exactly the compact shape: no candidates, windows, forecasts or history.
    expect(Object.keys(choice).sort()).toEqual(["accounts", "chosen", "reason", "state", "wanted"]);
    expect(choice.reason).toContain(
      `${FABLE} / high is out on every account; ${OPUS} / xhigh is the nearest rung that is not.`,
    );
    expect(choice.reason).toContain("no account lasts the whole job, this one lasts longest.");
    expect(choice.accounts).toEqual([
      `AC: drained until ${inHours(26)} (Weekly · Fable 100% used), 0 workers`,
      `ARA: drained until ${inHours(40)} (Weekly · Fable 100% used), 1 worker`,
      `ES: drained until ${inHours(9)} (Weekly · Fable 100% used), 0 workers`,
      `XL: drained until ${inHours(60)} (Weekly · Fable 100% used), 0 workers`,
      `XY: drained until ${inHours(100)} (Weekly · Fable 100% used), 0 workers`,
    ]);
    expect(encode(choice).length).toBeLessThan(2048);
    yield* Effect.flip(call("t3_allocate_account", { environmentId: "local", tier: "hard" }));

    const start = {
      assignmentId: "assignment",
      threadId: "worker",
      projectId: "project",
      title: "task",
      prompt: "Do the task",
      ...scores,
    };
    const started = yield* call("t3_start_allocated_assignment", start);
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toEqual({ threadId: "worker", started: true, ...choice });
    expect(starts).toEqual([
      {
        owner: "master",
        input: {
          kind: "worker",
          projectId: "project",
          title: "task",
          prompt: "Do the task",
          request: {
            selection: "automatic",
            assignmentId: "assignment",
            environmentId: "local",
            threadId: "worker",
            assessment: { difficulty: 9, stakes: 9 },
            allowedDrivers: ["claudeAgent"],
          },
        },
      },
    ]);
    // A pinned account that is drained for the pinned model: nothing starts.
    const refused = yield* call("t3_start_allocated_assignment", {
      ...start,
      assignmentId: "pinned",
      threadId: "pinned",
      account: "claude_antoine",
      model: FABLE,
      effort: "high",
    });
    expect(refused.isError).not.toBe(true);
    expect(refused.structuredContent).toMatchObject({
      threadId: "pinned",
      started: false,
      state: "drained",
      chosen: null,
      drainedUntil: inHours(26),
      accounts: [`AC: drained until ${inHours(26)} (Weekly · Fable 100% used), 0 workers`],
    });
    expect(starts[1]!.input.request).toMatchObject({
      explicitInstanceId: "claude_antoine",
      override: { driver: "claudeAgent", model: FABLE, options: [{ id: "effort", value: "high" }] },
    });

    const computers = yield* call("t3_recommend_computer", { projectId: "project" });
    expect(computers.structuredContent).toEqual(report);
    expect(asked).toEqual([{ projectId: "project" }]);

    const read = yield* call("t3_allocation_policy", {});
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toEqual(view);
    const edit = {
      accountOrder: ["ES", "XL"],
      longWaitHours: 2,
      fallback: null,
      // A model no code lists is accepted; the view says what could not be confirmed.
      setCells: [{ difficulty: 9, stakes: 9, model: "claude-next-9", effort: "high" }],
    };
    const saved = yield* call("t3_allocation_policy", edit);
    expect(saved.isError).not.toBe(true);
    expect(encode(saved.structuredContent)).toContain("no connected account offers claude-next-9");
    expect(edits).toEqual([{}, edit]);
  }).pipe(
    Effect.provide(
      McpServer.toolkit(AllocationTools.AllocationToolkit).pipe(
        Layer.provide(AllocationTools.handlers),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(Allocation.ProviderAllocation)({
            editPolicy: (edit) =>
              Effect.sync(() => {
                edits.push(edit);
                return view;
              }),
            execute: (operation) =>
              Effect.sync(() => {
                operations.push(operation);
                return operation._tag === "modelPreview"
                  ? { selection: select(operation.request) }
                  : {};
              }),
            computers: (request) =>
              Effect.sync(() => {
                asked.push(request);
                return report;
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(Assignments.AllocationAssignments)({
            start: (input, owner) =>
              Effect.sync(() => {
                starts.push({ input, owner });
                if (input.request.selection !== "automatic")
                  return {
                    allocation: null,
                    threadId: input.request.threadId,
                    state: "unavailable",
                  };
                const selection = select(input.request);
                return {
                  allocation: selection.allocation,
                  selection,
                  threadId: input.request.threadId,
                  state: selection.allocation ? "submitted" : "unavailable",
                };
              }),
          }),
        ),
      ),
    ),
  );
});
