import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ThreadId } from "./baseSchemas.ts";
import { COMPUTER_CAPACITY_MAX_DISKS, type ComputerCapacity } from "./computers.ts";
import { ModelRoutingRequest } from "./modelRouting.ts";
import {
  AllocationAccount,
  AllocationCandidate,
  AllocationInventory,
  AllocationOperation,
  AllocationPolicy,
  AllocationPolicyEdit,
  AllocationResponse,
  ComputersReport,
  ComputersRequest,
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  WorkerChoice,
  WorkerChoiceInput,
  WorkerStartInput,
  defaultAllocationPolicy,
  legacyAllocationCandidateFields,
  legacyAllocationPolicyFields,
  profileLabel,
  workerChoice,
  workerChoiceRequest,
  type AllocationDecision,
  type ModelRoutingDecision,
} from "./providerAllocation.ts";

const decodeInventory = Schema.decodeUnknownSync(AllocationInventory);
const decodeOperation = Schema.decodeUnknownSync(AllocationOperation);
const decodeResponse = Schema.decodeUnknownSync(AllocationResponse);
const decodePolicy = Schema.decodeUnknownSync(AllocationPolicy);
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const capacity: ComputerCapacity = {
  sampledAt: 1_000,
  os: "linux",
  resources: {
    sampledAt: 1_000,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 2 ** 33,
    totalMemoryBytes: 2 ** 34,
  },
  disks: [{ path: "/", label: "root", totalBytes: 10, availableBytes: 4, freeBytes: 4 }],
  workDisk: "/",
  jobs: { active: 2, running: 1 },
  notices: [],
};
const inventory = {
  environmentId: "env",
  observedAt: "2026-10-26T12:00:00.000Z",
  accounts: [],
  demand: [],
  complete: true,
  notices: [],
};

describe("computer numbers wire contract", () => {
  // A peer on an older build sends none of the new fields; that must read as "not reported".
  it("reads an inventory from a server that predates capacity readings", () => {
    const decoded = decodeInventory(inventory);
    expect(decoded.computer).toBeUndefined();
    expect(decoded.projects).toBeUndefined();
  });

  it("carries a capacity reading and checkouts through JSON unchanged", () => {
    const sent = {
      ...inventory,
      computer: capacity,
      projects: [{ id: "project-1", title: "scratch" }],
    };
    const decoded = decodeInventory(wire(sent));
    expect(decoded.computer).toEqual(capacity);
    expect(decoded.projects).toEqual([{ id: "project-1", title: "scratch" }]);
  });

  it("keeps the reading bounded", () => {
    const disk = capacity.disks[0]!;
    const tooManyDisks = {
      ...capacity,
      disks: Array.from({ length: COMPUTER_CAPACITY_MAX_DISKS + 1 }, () => disk),
    };
    expect(() => decodeInventory({ ...inventory, computer: tooManyDisks })).toThrow();
    const tooManyProjects = Array.from({ length: 21 }, (_, index) => ({
      id: `project-${index}`,
      title: "scratch",
    }));
    expect(() => decodeInventory({ ...inventory, projects: tooManyProjects })).toThrow();
  });

  it("reports numbers per computer, with null for whatever was not measured", () => {
    const decode = Schema.decodeUnknownSync(ComputersReport);
    const measured = {
      environmentId: "desk",
      label: "Desk",
      reachable: true,
      cpuThreadsIdle: 6.4,
      cpuThreads: 8,
      memoryFreeGiB: 8,
      memoryTotalGiB: 16,
      workDiskFreeGiB: 120.5,
      sessions: 3,
      projectId: "project-1",
    };
    const unreachable = {
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
    };
    const report = {
      at: "2026-10-26T12:00:00.000Z",
      computers: [measured, unreachable],
      notes: ["Laptop: load unavailable for this decision."],
    };
    expect(decode(wire(report))).toEqual(report);
    // Nothing in it ranks or recommends a computer.
    expect(Object.keys(ComputersReport.fields).sort()).toEqual(["at", "computers", "notes"]);
    expect(() => decode({ ...report, computers: [{ ...measured, sessions: -1 }] })).toThrow();
    const request = Schema.decodeUnknownSync(ComputersRequest);
    expect(request({})).toEqual({});
    expect(request({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
  });
});

describe("allocation policy", () => {
  // The fields a build from before smart allocation wrote, with values of its own.
  const before = {
    version: 12,
    mode: "automatic",
    coordinatorEnvironmentId: "desk",
    maxReadingAgeMinutes: 10,
    reservationMinutes: 5,
    claude: { preset: "custom", dailyPoints: 25, burstPoints: 0, burstHours: 0, reservePoints: 5 },
    codex: { preset: "burst", dailyPoints: 10, burstPoints: 30, burstHours: 0, reservePoints: 5 },
    other: {
      preset: "sustainable",
      dailyPoints: 14,
      burstPoints: 0,
      burstHours: 0,
      reservePoints: 10,
    },
    coldShortPointsPerHour: 15,
    coldLongPointsPerHour: 5,
    uncertaintyMultiplier: 1.5,
    defaultHours: 1,
    maxForecastHours: 8,
    minimumSamples: 5,
    hysteresisPoints: 1,
    overrides: [{ accountKey: "a", windowId: "weekly", createdAt: "x", expiresAt: "y" }],
    accountRules: [
      { key: "k", kind: "exclude", note: "never" },
      { key: "k", kind: "maxWorkers", value: 2 },
      { key: "k", kind: "priority", value: 10, expiresAt: "2026-11-01T00:00:00.000Z" },
    ],
    workerModels: { claude: { model: "claude-fable-5", effort: "medium" } },
    accountCaps: [
      { key: "k", weeklyPercent: 90, fiveHourPercent: null, stopWorkers: true, stopMasters: false },
    ],
  };

  it("reads a policy stored with the removed fields, whatever they hold", () => {
    const decoded = decodePolicy(wire(before));
    expect(decoded).toEqual(before);
    expect(decoded.accountOrder).toBeUndefined();
    expect(decoded.closeMarginPoints).toBeUndefined();
    expect(decoded.longWaitHours).toBeUndefined();
    // Even values a later build would never write do not make the policy unreadable.
    expect(() =>
      decodePolicy({ ...before, claude: "gone", accountRules: 3, overrides: null }),
    ).not.toThrow();
    const { claude: _claude, overrides: _overrides, accountRules: _rules, ...bare } = before;
    expect(() => decodePolicy(bare)).not.toThrow();
  });

  it("carries the legacy fields in the default, with the margin and the long wait", () => {
    expect(defaultAllocationPolicy).toMatchObject(legacyAllocationPolicyFields);
    expect(defaultAllocationPolicy).toMatchObject({
      accountCaps: [],
      accountOrder: [],
      closeMarginPoints: DEFAULT_CLOSE_MARGIN_POINTS,
      longWaitHours: DEFAULT_LONG_WAIT_HOURS,
    });
    expect([DEFAULT_CLOSE_MARGIN_POINTS, DEFAULT_LONG_WAIT_HOURS]).toEqual([10, 3]);
    // Every field a build from before smart allocation required of a policy.
    expect(Object.keys(legacyAllocationPolicyFields).sort()).toEqual(
      [
        "claude",
        "codex",
        "other",
        "coldShortPointsPerHour",
        "coldLongPointsPerHour",
        "uncertaintyMultiplier",
        "defaultHours",
        "maxForecastHours",
        "minimumSamples",
        "hysteresisPoints",
        "overrides",
      ].sort(),
    );
    for (const curve of [
      legacyAllocationPolicyFields.claude,
      legacyAllocationPolicyFields.codex,
      legacyAllocationPolicyFields.other,
    ])
      expect(Object.keys(curve).sort()).toEqual([
        "borrowPoints",
        "burstHours",
        "burstPoints",
        "dailyPoints",
        "preset",
        "reservePoints",
      ]);
    expect(decodePolicy(wire(defaultAllocationPolicy))).toEqual(defaultAllocationPolicy);
  });

  it("bounds the margin and the long wait", () => {
    const valid = (patch: object) => () => decodePolicy({ ...defaultAllocationPolicy, ...patch });
    expect(valid({ closeMarginPoints: 0, longWaitHours: 0 })).not.toThrow();
    expect(valid({ closeMarginPoints: 50, longWaitHours: 168 })).not.toThrow();
    for (const patch of [
      { closeMarginPoints: -1 },
      { closeMarginPoints: 51 },
      { longWaitHours: -1 },
      { longWaitHours: 169 },
      { accountOrder: [""] },
    ])
      expect(valid(patch), JSON.stringify(patch)).toThrow();
  });

  it("accepts an edit that names any model, and one that names nothing", () => {
    const decode = Schema.decodeUnknownSync(AllocationPolicyEdit);
    expect(decode({})).toEqual({});
    const edit = {
      accountOrder: ["ES", "claude_xinya"],
      closeMarginPoints: 5,
      longWaitHours: 1.5,
      setCaps: [
        {
          account: "ES",
          weeklyPercent: 80,
          fiveHourPercent: null,
          stopWorkers: true,
          stopMasters: false,
        },
      ],
      clearCaps: ["XL"],
      ladder: [{ model: "a-model-no-code-lists", effort: "ultra" }],
      fallback: null,
      setCells: [
        {
          table: "codex",
          difficulty: 0,
          difficultyTo: 3,
          stakes: 10,
          model: "gpt-next",
          effort: "high",
        },
        { difficulty: 5, stakes: 5, model: "claude-next-9", effort: "max" },
      ],
      showTable: "claudeAgent",
    };
    expect(decode(wire(edit))).toEqual(edit);
    for (const broken of [
      { setCells: [{ difficulty: 11, stakes: 0, model: "m", effort: "high" }] },
      { setCells: [{ difficulty: 0, stakes: 0, model: "", effort: "high" }] },
      { setCells: [{ table: "cursor", difficulty: 0, stakes: 0, model: "m", effort: "high" }] },
      { fallback: { model: "m", effort: "max" } },
      { closeMarginPoints: 51 },
    ])
      expect(() => decode(broken), JSON.stringify(broken)).toThrow();
  });
});

describe("old and new builds on one wire", () => {
  const account = {
    environmentId: "env",
    instanceId: "claude_eol",
    driver: "claudeAgent",
    accountKey: "login",
    label: "ES",
    available: true,
    unavailableReason: null,
    limitedUntil: "2026-10-27T00:00:00.000Z",
    models: [],
    shortWindow: "unknown",
    windows: [],
    resetCredits: null,
    profileSamples: 0,
    profileUncertainty: 1,
  };

  it("reads an account from a computer that reports no per-window limit rejections", () => {
    const decode = Schema.decodeUnknownSync(AllocationAccount);
    expect(decode(account).limits).toBeUndefined();
    const limits = [
      { windowId: "weekly_fable", until: "2026-10-27T00:00:00.000Z" },
      { windowId: null, until: "2026-10-26T18:00:00.000Z" },
    ];
    expect(decode(wire({ ...account, limits })).limits).toEqual(limits);
  });

  it("reads a candidate from before smart allocation and writes one older builds can read", () => {
    const decode = Schema.decodeUnknownSync(AllocationCandidate);
    const old = {
      environmentId: "env",
      instanceId: "claude_eol",
      accountKey: "login",
      eligible: true,
      reasons: [],
      warnings: ["Weekly forecast is over target"],
      priority: 10,
      behindPoints: 4.5,
      resetInHours: 20,
      confidence: "low",
      windows: [
        {
          id: "weekly",
          actualPoints: 40,
          targetPoints: 50,
          forecastPoints: 45,
          headroomPoints: 5,
          samples: 6,
          ageMinutes: 2,
          resetsAt: null,
          reasons: [],
        },
      ],
    };
    expect(decode(wire(old))).toEqual(old);
    // What this build writes: the new numbers, and the constants older builds require.
    const current = {
      environmentId: "env",
      instanceId: "claude_eol",
      accountKey: "login",
      label: "ES",
      eligible: false,
      reasons: [],
      drainedUntil: null,
      roomPoints: 0,
      resetInHours: null,
      workers: 2,
      line: "ES: drained until an unknown time (Weekly 100% used), 2 workers",
      ...legacyAllocationCandidateFields,
    };
    expect(decode(wire(current))).toEqual(current);
    expect(legacyAllocationCandidateFields).toEqual({
      behindPoints: 0,
      confidence: "medium",
      windows: [],
    });
  });

  it("takes a request with or without the reasons older builds require", () => {
    const decode = Schema.decodeUnknownSync(ModelRoutingRequest);
    const request = {
      selection: "automatic",
      assignmentId: "one",
      environmentId: "env",
      threadId: "thread",
      allowedDrivers: ["claudeAgent"],
      assessment: { difficulty: 4, stakes: 6 },
      override: { driver: "claudeAgent", model: "claude-next-9" },
    };
    expect(decode(request)).toEqual(request);
    const reasoned = {
      ...request,
      assessment: { ...request.assessment, difficultyReason: "Hard", stakesReason: "Risky" },
      override: { ...request.override, reason: "The user named it" },
    };
    expect(decode(reasoned)).toEqual(reasoned);
  });

  it("answers a policy read and a model policy save in the existing response", () => {
    expect(decodeResponse({})).toEqual({});
    expect(decodeOperation({ _tag: "caps" })).toEqual({ _tag: "caps" });
    expect(
      decodeResponse({ warnings: ["Ladder: no connected account offers claude-next-9."] }).warnings,
    ).toHaveLength(1);
    expect(() => decodeOperation({ _tag: "placement", request: {} })).toThrow();
  });
});

describe("worker choice", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  const input = { environmentId: "desk", difficulty: 6, stakes: 3 };
  const identity = { assignmentId: "job", threadId: ThreadId.make("thread") };

  it("asks for difficulty, stakes and the computer, and nothing else", () => {
    const decode = Schema.decodeUnknownSync(WorkerChoiceInput);
    expect(decode(input)).toEqual(input);
    for (const broken of [
      { environmentId: "desk", difficulty: 6 },
      { difficulty: 6, stakes: 3 },
      { ...input, difficulty: 6.5 },
      { ...input, stakes: 11 },
      { ...input, model: "" },
    ])
      expect(() => decode(broken), JSON.stringify(broken)).toThrow();
    const start = Schema.decodeUnknownSync(WorkerStartInput);
    const full = { ...input, ...identity, projectId: "project", title: "Title", prompt: "Task" };
    expect(start(full)).toEqual(full);
    expect(() => start(input)).toThrow();
  });

  it("stands for an automatic Claude request unless the start asks for Codex or pins", () => {
    expect(workerChoiceRequest({ ...input, ...identity })).toEqual({
      selection: "automatic",
      assignmentId: "job",
      environmentId: "desk",
      threadId: "thread",
      assessment: { difficulty: 6, stakes: 3 },
      allowedDrivers: ["claudeAgent"],
    });
    const codex = ProviderDriverKind.make("codex");
    const pinned = workerChoiceRequest({
      ...input,
      ...identity,
      driver: codex,
      account: ProviderInstanceId.make("codex_antoine"),
      model: "gpt-6-astra",
      effort: "high",
    });
    expect(pinned).toMatchObject({
      allowedDrivers: ["codex"],
      explicitInstanceId: "codex_antoine",
      override: {
        driver: "codex",
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    // A model-only pin leaves the effort to the table.
    expect(
      workerChoiceRequest({ ...input, ...identity, model: "claude-opus-5-5" }).override,
    ).toEqual({ driver: "claudeAgent", model: "claude-opus-5-5" });
    // The request is one every build's schema reads.
    expect(Schema.decodeUnknownSync(ModelRoutingRequest)(wire(pinned))).toEqual(pinned);
  });

  const request = workerChoiceRequest({ ...input, ...identity });
  const allocated = (patch: Partial<AllocationDecision> = {}): AllocationDecision => ({
    at: "2026-10-26T12:00:00.000Z",
    policyVersion: 1,
    request: {
      assignmentId: "job",
      environmentId: "desk",
      threadId: identity.threadId,
      driver: claude,
      model: "claude-sonnet-5-5",
      options: [{ id: "effort", value: "xhigh" }],
    },
    outcome: "selected",
    selectedInstanceId: ProviderInstanceId.make("claude_eol"),
    candidates: [
      {
        environmentId: "desk",
        instanceId: ProviderInstanceId.make("claude_eol"),
        accountKey: "login",
        eligible: true,
        reasons: [],
        resetInHours: 20,
        line: "ES: Weekly 60% left, resets in 20h 0m, 1 worker",
        ...legacyAllocationCandidateFields,
        windows: [],
      },
      {
        environmentId: "desk",
        instanceId: ProviderInstanceId.make("claude_xinya"),
        accountKey: null,
        eligible: false,
        reasons: [],
        resetInHours: null,
        ...legacyAllocationCandidateFields,
        windows: [],
      },
    ],
    reasons: ["ES: Weekly 60% left, resets in 20h 0m, 1 worker; most room of 2 accounts."],
    confidence: "medium",
    waitUntil: null,
    ...patch,
  });
  const selection = (patch: Partial<ModelRoutingDecision> = {}): ModelRoutingDecision => ({
    at: "2026-10-26T12:00:00.000Z",
    policyVersion: 3,
    request,
    revision: 0,
    selectedProfile: null,
    rule: "Difficulty 6, stakes 3",
    profiles: [],
    reasons: ["The one-line reason."],
    allocation: { decision: allocated(), reservation: null, mode: "automatic" },
    accounts: [
      "ES: Weekly 60% left, resets in 20h 0m, 1 worker",
      "XL: no usage reading, 0 workers",
    ],
    ...patch,
  });
  const decodeChoice = Schema.decodeUnknownSync(WorkerChoice);

  it("is the chosen account, model and effort with one reason and a line per account", () => {
    const choice = workerChoice(selection());
    expect(choice).toEqual({
      state: "chosen",
      chosen: {
        instanceId: "claude_eol",
        driver: "claudeAgent",
        model: "claude-sonnet-5-5",
        effort: "xhigh",
      },
      reason: "The one-line reason.",
      accounts: [
        "ES: Weekly 60% left, resets in 20h 0m, 1 worker",
        "XL: no usage reading, 0 workers",
      ],
    });
    expect(decodeChoice(wire(choice))).toEqual(choice);
    expect(Object.keys(WorkerChoice.fields).sort()).toEqual([
      "accounts",
      "chosen",
      "drainedUntil",
      "notes",
      "reason",
      "startAt",
      "state",
      "wanted",
    ]);
  });

  it("names the wanted profile only when the chosen one differs", () => {
    const wanted = {
      driver: claude,
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    };
    expect(workerChoice(selection({ wanted })).wanted).toBe("claude-opus-5-5 / high");
    expect(workerChoice(selection()).wanted).toBeUndefined();
    expect(profileLabel("codex", "gpt-6-astra", [{ id: "reasoningEffort", value: "low" }])).toBe(
      "gpt-6-astra / low",
    );
    expect(profileLabel("claudeAgent", "claude-opus-5-5", [])).toBe("claude-opus-5-5 / default");
  });

  it("says drained with the earliest reset, or unavailable, when nothing was chosen", () => {
    const drained = workerChoice(
      selection({ allocation: null, drainedUntil: "2026-10-27T09:00:00.000Z" }),
    );
    expect(drained).toMatchObject({
      state: "drained",
      chosen: null,
      drainedUntil: "2026-10-27T09:00:00.000Z",
      reason: "The one-line reason.",
    });
    expect(drained.wanted).toBeUndefined();
    expect(decodeChoice(wire(drained))).toEqual(drained);
    expect(workerChoice(selection({ allocation: null, drainedUntil: null }))).toMatchObject({
      state: "drained",
      drainedUntil: null,
    });
    const unavailable = workerChoice(selection({ allocation: null, accounts: [] }));
    expect(unavailable).toEqual({
      state: "unavailable",
      chosen: null,
      reason: "The one-line reason.",
      accounts: [],
    });
  });

  it("reads a selection from a coordinator that predates the compact fields", () => {
    const { accounts: _accounts, ...old } = selection({ reasons: [] });
    expect(workerChoice(old)).toMatchObject({
      state: "chosen",
      reason: "ES: Weekly 60% left, resets in 20h 0m, 1 worker; most room of 2 accounts.",
      accounts: ["ES: Weekly 60% left, resets in 20h 0m, 1 worker", "claude_xinya"],
    });
    // Its refusal carries no reset: unavailable, never a made-up wait.
    expect(workerChoice({ ...old, allocation: null })).toEqual({
      state: "unavailable",
      chosen: null,
      reason: "No reason was recorded.",
      accounts: [],
    });
  });
});
