import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AssignmentAssessment,
  defaultModelRoutingPolicy,
  MODEL_SCORES,
  ModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type ModelRoutingRequest,
  type RoutingCell,
} from "@t3tools/contracts";
import { modelCandidates, modelPolicyIssues } from "./modelDecision.ts";

const request: ModelRoutingRequest = {
  selection: "automatic",
  assignmentId: "one",
  environmentId: "host",
  threadId: ThreadId.make("one"),
  allowedDrivers: [ProviderDriverKind.make("codex")],
  assessment: {
    difficulty: 0,
    stakes: 0,
    difficultyReason: "Routine edit",
    stakesReason: "Easy to reverse",
  },
};
const inventory: AllocationInventory = {
  environmentId: "host",
  observedAt: "2026-10-23T12:00:00.000Z",
  complete: true,
  notices: [],
  demand: [],
  accounts: ["codex", "claudeAgent"].map((driver) => ({
    environmentId: "host",
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    label: driver,
    accountKey: driver,
    available: true,
    unavailableReason: null,
    limitedUntil: null,
    shortWindow: "unknown" as const,
    windows: [],
    resetCredits: null,
    profileSamples: 0,
    profileUncertainty: 1,
    models: (driver === "codex"
      ? defaultModelRoutingPolicy.codex
      : defaultModelRoutingPolicy.claudeAgent
    ).allowedModels.map((slug) => ({
      slug,
      capabilities: {
        optionDescriptors: [
          {
            id: driver === "codex" ? "reasoningEffort" : "effort",
            type: "select" as const,
            label: "Effort",
            options: ["medium", "high", "max", "xhigh"].map((id) => ({ id, label: id })),
          },
        ],
      },
    })),
  })),
};
const decodePolicy = Schema.decodeUnknownSync(ModelRoutingPolicy);
const assess = (difficulty: number, stakes: number): ModelRoutingRequest => ({
  ...request,
  assessment: { ...request.assessment, difficulty, stakes },
});
/** The choice a request resolves to as "model/effort", or null when nothing is eligible. */
const choice = (policy: ModelRoutingPolicy, difficulty: number, stakes: number) => {
  const [candidate] = modelCandidates(policy, assess(difficulty, stakes), [inventory]).candidates;
  return candidate ? `${candidate.request.model}/${candidate.request.options[0]!.value}` : null;
};
const withCell = (
  policy: ModelRoutingPolicy,
  difficulty: number,
  stakes: number,
  cell: RoutingCell,
): ModelRoutingPolicy => ({
  ...policy,
  codex: {
    ...policy.codex,
    cells: policy.codex.cells.map((row, d) =>
      row.map((existing, s) => (d === difficulty && s === stakes ? cell : existing)),
    ),
  },
});
// How scores were grouped before exact-score tables: 0-3, 4-6, then 7, 8, 9 and 10.
const band = (score: number) => (score <= 3 ? 0 : score <= 6 ? 1 : score - 5);

describe("deterministic model policy", () => {
  const defaults = [
    "gpt-6.1-sol/medium",
    "gpt-6.1-sol/high",
    "gpt-6.1-sol/max",
    "gpt-6-astra/medium",
    "gpt-6-astra/high",
    "gpt-6-astra/xhigh",
  ];
  const bands = [
    [1, 2, 2, 4, 5, 5],
    [2, 2, 3, 4, 5, 5],
    [3, 3, 4, 5, 5, 6],
    [3, 4, 5, 5, 6, 6],
    [5, 5, 5, 6, 6, 6],
    [6, 6, 6, 6, 6, 6],
  ];
  for (const difficulty of MODEL_SCORES)
    for (const stakes of MODEL_SCORES) {
      it(`routes difficulty ${difficulty}, stakes ${stakes} uniquely`, () => {
        const result = modelCandidates(defaultModelRoutingPolicy, assess(difficulty, stakes), [
          inventory,
        ]);
        expect(result.candidates).toHaveLength(1);
        expect(choice(defaultModelRoutingPolicy, difficulty, stakes)).toBe(
          defaults[bands[band(difficulty)]![band(stakes)]! - 1],
        );
        expect(result.rule).toBe(`Difficulty ${difficulty}, stakes ${stakes}`);
      });
    }
  it("changes only the exact score pair that was edited, even where the old bands were shared", () => {
    const edited = withCell(defaultModelRoutingPolicy, 5, 2, {
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    expect(modelPolicyIssues(edited, defaultModelRoutingPolicy, [inventory])).toEqual([]);
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES)
        expect(choice(edited, difficulty, stakes)).toBe(
          difficulty === 5 && stakes === 2
            ? "gpt-6-astra/xhigh"
            : choice(defaultModelRoutingPolicy, difficulty, stakes),
        );
  });
  it("resolves a saved band table exactly as the band lookup did for all 121 pairs", () => {
    const legacy = {
      version: 4,
      codex: {
        profiles: [
          { model: "gpt-6.1-sol", effort: "medium" },
          { model: "gpt-6.1-sol", effort: "ultra" },
          { model: "gpt-6-astra", effort: "high" },
          { model: "gpt-6-luna", effort: "high" },
          { model: "gpt-6-astra", effort: "medium" },
          { model: "gpt-6.1-sol", effort: "max" },
        ],
        grid: [
          [1, 2, 3, 4, 5, 6],
          [2, 2, 3, 4, 5, 6],
          [3, 3, 4, 5, 5, 1],
          [4, 4, 5, 5, 6, 6],
          [5, 5, 2, 6, 6, 6],
          [6, 6, 6, 2, 6, 1],
        ],
        alternatives: [[], [3, 6], [5], [1], [], []],
        allowedModels: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
      },
      claudeAgent: defaultModelRoutingPolicy.claudeAgent,
      maxReassessments: 2,
    };
    const policy = decodePolicy(legacy);
    // The old algorithm: the selected profile, then its configured alternatives, skipping
    // unapproved or unadvertised ones.
    const supported = (p: { model: string; effort: string }) =>
      ["medium", "high", "max", "xhigh"].includes(p.effort) &&
      legacy.codex.allowedModels.includes(p.model) &&
      !/luna/.test(p.model);
    let alternativeUsed = false;
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES) {
        const id = legacy.codex.grid[band(difficulty)]![band(stakes)]!;
        const choices = [id, ...legacy.codex.alternatives[id - 1]!].map(
          (n) => legacy.codex.profiles[n - 1]!,
        );
        const expected = choices.find(supported);
        alternativeUsed ||= expected !== undefined && expected !== choices[0];
        expect(choice(policy, difficulty, stakes)).toBe(
          expected ? `${expected.model}/${expected.effort}` : null,
        );
      }
    expect(alternativeUsed).toBe(true);
  });
  it("keeps independent provider tables", () => {
    const opus = { model: "claude-opus-5-5", effort: "xhigh" };
    const policy = {
      ...defaultModelRoutingPolicy,
      claudeAgent: {
        ...defaultModelRoutingPolicy.claudeAgent,
        cells: defaultModelRoutingPolicy.claudeAgent.cells.map((r) => r.map(() => opus)),
      },
    };
    const result = modelCandidates(
      policy,
      {
        ...request,
        allowedDrivers: [ProviderDriverKind.make("claudeAgent"), ProviderDriverKind.make("codex")],
      },
      [inventory],
    );
    expect(result.candidates.map((c) => [c.request.driver, c.request.model])).toEqual([
      ["claudeAgent", "claude-opus-5-5"],
      ["codex", "gpt-6.1-sol"],
    ]);
  });
  it("rejects missing, fractional, out-of-range and unreasoned assessment", () => {
    const decode = Schema.decodeUnknownSync(AssignmentAssessment);
    for (const value of [
      undefined,
      {},
      { ...request.assessment, difficulty: -1 },
      { ...request.assessment, stakes: 11 },
      { ...request.assessment, difficulty: 4.5 },
      { ...request.assessment, stakesReason: "" },
    ])
      expect(() => decode(value)).toThrow();
  });
  it("uses only explicitly configured capability alternatives, never Luna", () => {
    const approved = {
      ...defaultModelRoutingPolicy,
      codex: {
        ...defaultModelRoutingPolicy.codex,
        allowedModels: [...defaultModelRoutingPolicy.codex.allowedModels, "missing", "gpt-6-luna"],
      },
    };
    const changed = withCell(approved, 0, 0, {
      model: "missing",
      effort: "medium",
      alternatives: [
        { model: "gpt-6-luna", effort: "high" },
        { model: "gpt-6-astra", effort: "medium" },
      ],
    });
    const result = modelCandidates(changed, request, [inventory]);
    expect(result.candidates[0]!.reason).toContain("configured capability alternative");
    expect(choice(changed, 0, 0)).toBe("gpt-6-astra/medium");
    expect(result.reasons.join(" ")).toContain("excluded");
    expect(modelPolicyIssues(changed, defaultModelRoutingPolicy, [inventory]).join(" ")).toContain(
      "Luna",
    );
    expect(
      modelCandidates(defaultModelRoutingPolicy, request, [{ ...inventory, accounts: [] }])
        .candidates,
    ).toHaveLength(0);
    expect(
      choice(withCell(changed, 0, 0, { model: "missing", effort: "medium" }), 0, 0),
    ).toBeNull();
  });
  it("retains exact overrides and native/account pins, with honest conflict and unsupported paths", () => {
    const override = {
      driver: ProviderDriverKind.make("codex"),
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
      reason: "Explicit user choice",
    };
    expect(
      modelCandidates(defaultModelRoutingPolicy, { ...request, override }, [inventory])
        .candidates[0]!.request,
    ).toMatchObject({ model: override.model, options: override.options });
    expect(
      modelCandidates(
        defaultModelRoutingPolicy,
        { ...request, override: { ...override, driver: ProviderDriverKind.make("claudeAgent") } },
        [inventory],
      ).candidates,
    ).toHaveLength(0);
    expect(
      modelCandidates(
        defaultModelRoutingPolicy,
        { ...request, nativeInstanceId: ProviderInstanceId.make("missing") },
        [inventory],
      ).candidates,
    ).toHaveLength(0);
    expect(
      modelCandidates(
        defaultModelRoutingPolicy,
        { ...request, explicitInstanceId: ProviderInstanceId.make("missing") },
        [inventory],
      ).candidates,
    ).toHaveLength(0);
    expect(
      modelCandidates(
        defaultModelRoutingPolicy,
        { ...request, allowedDrivers: [ProviderDriverKind.make("cursor")] },
        [inventory],
      ).reasons.join(" "),
    ).toContain("unsupported");
  });
  it("validates changed effort against catalogs while retaining unavailable persisted choices", () => {
    const unsupported = withCell(defaultModelRoutingPolicy, 0, 0, {
      model: "gpt-6.1-sol",
      effort: "ultra",
    });
    expect(
      modelPolicyIssues(unsupported, defaultModelRoutingPolicy, [inventory]).join(" "),
    ).toContain("not advertised");
    expect(modelPolicyIssues(unsupported, unsupported, [inventory])).toEqual([]);
    expect(modelCandidates(unsupported, request, [inventory]).candidates).toHaveLength(0);
    const repeated = withCell(defaultModelRoutingPolicy, 0, 0, {
      model: "gpt-6.1-sol",
      effort: "medium",
      alternatives: [{ model: "gpt-6.1-sol", effort: "medium" }],
    });
    expect(modelPolicyIssues(repeated, defaultModelRoutingPolicy, [inventory]).join(" ")).toContain(
      "alternatives must be unique",
    );
  });
});
