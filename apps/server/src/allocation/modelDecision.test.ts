import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AssignmentAssessment,
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type ModelRoutingRequest,
} from "@t3tools/contracts";
import { modelCandidates, modelPolicyIssues, scoreBand } from "./modelDecision.ts";

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

describe("deterministic model policy", () => {
  const expected = [
    [1, 2, 2, 4, 5, 5],
    [2, 2, 3, 4, 5, 5],
    [3, 3, 4, 5, 5, 6],
    [3, 4, 5, 5, 6, 6],
    [5, 5, 5, 6, 6, 6],
    [6, 6, 6, 6, 6, 6],
  ];
  for (let difficulty = 0; difficulty <= 10; difficulty++)
    for (let stakes = 0; stakes <= 10; stakes++) {
      it(`routes difficulty ${difficulty}, stakes ${stakes} uniquely`, () => {
        const result = modelCandidates(
          defaultModelRoutingPolicy,
          { ...request, assessment: { ...request.assessment, difficulty, stakes } },
          [inventory],
        );
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]!.profile).toBe(
          expected[scoreBand(difficulty)]![scoreBand(stakes)],
        );
      });
    }
  it("keeps individual 7/8/9/10 boundaries and independent provider tables", () => {
    expect([0, 3, 4, 6, 7, 8, 9, 10].map(scoreBand)).toEqual([0, 0, 1, 1, 2, 3, 4, 5]);
    const policy = {
      ...defaultModelRoutingPolicy,
      claudeAgent: {
        ...defaultModelRoutingPolicy.claudeAgent,
        grid: defaultModelRoutingPolicy.claudeAgent.grid.map((r) => r.map(() => 6)),
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
    expect(result.candidates.map((c) => [c.request.driver, c.request.model, c.profile])).toEqual([
      ["claudeAgent", "claude-opus-5-5", 6],
      ["codex", "gpt-6.1-sol", 1],
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
    const policy = structuredClone(defaultModelRoutingPolicy);
    const changed = {
      ...policy,
      codex: {
        ...policy.codex,
        profiles: policy.codex.profiles.map((p, i) =>
          i === 0
            ? { model: "missing", effort: "medium" }
            : i === 1
              ? { model: "gpt-6-luna", effort: "high" }
              : p,
        ),
        allowedModels: [...policy.codex.allowedModels, "missing", "gpt-6-luna"],
        alternatives: [[2, 4], [], [], [], [], []],
      },
    };
    const result = modelCandidates(changed, request, [inventory]);
    expect(result.candidates[0]!.profile).toBe(4);
    expect(result.reasons.join(" ")).toContain("excluded");
    expect(modelPolicyIssues(changed, policy, [inventory]).join(" ")).toContain("Luna");
    expect(
      modelCandidates(policy, request, [{ ...inventory, accounts: [] }]).candidates,
    ).toHaveLength(0);
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
  it("validates changed effort against catalogs while retaining unavailable persisted profiles", () => {
    const unsupported = {
      ...defaultModelRoutingPolicy,
      codex: {
        ...defaultModelRoutingPolicy.codex,
        profiles: defaultModelRoutingPolicy.codex.profiles.map((p, i) =>
          i === 0 ? { ...p, effort: "ultra" } : p,
        ),
      },
    };
    expect(
      modelPolicyIssues(unsupported, defaultModelRoutingPolicy, [inventory]).join(" "),
    ).toContain("not advertised");
    expect(modelPolicyIssues(unsupported, unsupported, [inventory])).toEqual([]);
    expect(modelCandidates(unsupported, request, [inventory]).candidates).toHaveLength(0);
  });
});
