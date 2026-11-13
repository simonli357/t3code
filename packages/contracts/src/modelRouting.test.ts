import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AssignmentAssessment,
  ModelRoutingPolicy,
  defaultModelFallback,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  modelFallback,
  modelLadder,
  ModelRoutingRequest,
} from "./modelRouting.ts";
import { AllocationOperation, AllocationResponse, AllocationStart } from "./providerAllocation.ts";
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);

it("keeps legacy exact startup and automatic assessment as disjoint request paths", () => {
  const decode = Schema.decodeUnknownSync(AllocationStart);
  const start = {
    kind: "worker",
    projectId: "project",
    title: "Title",
    prompt: "Task",
    request: {
      assignmentId: "one",
      environmentId: "host",
      threadId: "thread",
      driver: "codex",
      model: "exact-user-model",
      options: [],
    },
  };
  expect(decode(start).request).toMatchObject({ model: "exact-user-model" });
  expect(() =>
    decode({ ...start, request: { ...start.request, selection: "automatic" } }),
  ).toThrow();
  expect(() =>
    decodeRequest({
      selection: "automatic",
      assignmentId: "one",
      environmentId: "host",
      threadId: "thread",
      allowedDrivers: ["codex"],
      assessment: { difficulty: 5, difficultyReason: "", stakes: 4, stakesReason: "Impact" },
    }),
  ).toThrow();
});
const decodePolicy = Schema.decodeUnknownSync(ModelRoutingPolicy);
const encodePolicy = Schema.encodeSync(ModelRoutingPolicy);
const legacyBand = (score: number) => (score <= 3 ? 0 : score <= 6 ? 1 : score - 5);
const scores = Array.from({ length: 11 }, (_, score) => score);

it("requires an exact 11 by 11 table with valid entries for each provider independently", () => {
  expect(decodePolicy(defaultModelRoutingPolicy)).toEqual(defaultModelRoutingPolicy);
  const wire = JSON.parse(JSON.stringify(encodePolicy(defaultModelRoutingPolicy)));
  expect(wire.codex.cells).toHaveLength(11);
  expect(decodePolicy(wire)).toEqual(defaultModelRoutingPolicy);
  const { cells } = defaultModelRoutingPolicy.codex;
  for (const broken of [
    [],
    [[cells[0]![0]]],
    cells.slice(0, 10),
    cells.map((row) => row.slice(0, 10)),
    cells.map((row, d) =>
      row.map((cell, s) => (d === 3 && s === 4 ? { ...cell, model: "" } : cell)),
    ),
  ])
    expect(() =>
      decodePolicy({
        ...defaultModelRoutingPolicy,
        claudeAgent: { ...defaultModelRoutingPolicy.claudeAgent, cells: broken },
      }),
    ).toThrow();
  expect(
    decodePolicy({
      ...defaultModelRoutingPolicy,
      codex: { ...defaultModelRoutingPolicy.codex, cells: cells.map((row) => row.slice()) },
    }),
  ).toEqual(defaultModelRoutingPolicy);
});

it("keeps the default choices for all 121 score pairs", () => {
  const bands = [
    [1, 2, 2, 4, 5, 5],
    [2, 2, 3, 4, 5, 5],
    [3, 3, 4, 5, 5, 6],
    [3, 4, 5, 5, 6, 6],
    [5, 5, 5, 6, 6, 6],
    [6, 6, 6, 6, 6, 6],
  ];
  const efforts = ["medium", "high", "max", "medium", "high", "xhigh"];
  const models = {
    codex: ["gpt-6.1-sol", "gpt-6-astra"],
    claudeAgent: ["claude-sonnet-5-5", "claude-opus-5-5"],
  } as const;
  for (const driver of ["codex", "claudeAgent"] as const)
    for (const d of scores)
      for (const s of scores) {
        const id = bands[legacyBand(d)]![legacyBand(s)]!;
        expect(defaultModelRoutingPolicy[driver].cells[d]![s]).toEqual({
          model: models[driver][id <= 3 ? 0 : 1],
          effort: efforts[id - 1],
        });
      }
});

it("expands saved band tables so every score pair keeps its profile and alternatives", () => {
  const profiles = [
    { model: "gpt-6.1-sol", effort: "medium" },
    { model: "gpt-6.1-sol", effort: "high" },
    { model: "gpt-6-astra", effort: "max" },
    { model: "gpt-6-astra", effort: "xhigh" },
    { model: "gpt-6.1-sol", effort: "max" },
    { model: "gpt-6-astra", effort: "high" },
  ];
  const grid = [
    [1, 2, 3, 4, 5, 6],
    [6, 5, 4, 3, 2, 1],
    [1, 1, 2, 2, 3, 3],
    [4, 4, 5, 5, 6, 6],
    [3, 2, 1, 6, 5, 4],
    [2, 3, 4, 5, 6, 1],
  ];
  const alternatives = [[2, 4], [], [5], [], [1], []];
  const saved = {
    version: 7,
    codex: { profiles, grid, alternatives, allowedModels: ["gpt-6.1-sol", "gpt-6-astra"] },
    claudeAgent: defaultModelRoutingPolicy.claudeAgent,
    maxReassessments: 1,
  };
  const policy = decodePolicy(saved);
  expect(policy.version).toBe(7);
  expect(policy.maxReassessments).toBe(1);
  expect(policy.codex.allowedModels).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
  expect(policy.claudeAgent).toEqual(defaultModelRoutingPolicy.claudeAgent);
  for (const d of scores)
    for (const s of scores) {
      const id = grid[legacyBand(d)]![legacyBand(s)]!;
      const expected = {
        ...profiles[id - 1],
        ...(alternatives[id - 1]!.length
          ? { alternatives: alternatives[id - 1]!.map((a) => profiles[a - 1]) }
          : {}),
      };
      expect(policy.codex.cells[d]![s]).toEqual(expected);
    }
  // Editing one expanded pair never changes the others that shared its old band.
  const edited = {
    ...policy.codex,
    cells: policy.codex.cells.map((row, d) =>
      row.map((cell, s) => (d === 5 && s === 2 ? { model: "gpt-6-astra", effort: "high" } : cell)),
    ),
  };
  expect(decodePolicy({ ...policy, codex: edited }).codex.cells[4]![2]).toEqual(
    policy.codex.cells[4]![2],
  );
  expect(() =>
    decodePolicy({ ...saved, codex: { ...saved.codex, profiles: profiles.slice(0, 5) } }),
  ).toThrow();
});

it("crosses the JSON codecs of the HTTP and RPC allocation endpoints in both table shapes", () => {
  const operation = Schema.toCodecJson(AllocationOperation);
  const reply = Schema.toCodecJson(AllocationResponse);
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  const sent = wire(
    Schema.encodeSync(operation)({
      _tag: "modelPolicy",
      expectedVersion: 1,
      policy: defaultModelRoutingPolicy,
    }),
  );
  expect(sent.policy.codex.cells).toHaveLength(11);
  expect(Schema.decodeSync(operation)(sent)).toEqual({
    _tag: "modelPolicy",
    expectedVersion: 1,
    policy: defaultModelRoutingPolicy,
  });
  const band = (id: number) => ({
    profiles: Array.from({ length: 6 }, (_, i) => ({
      model: "gpt-6.1-sol",
      effort: i + 1 === id ? "high" : "medium",
    })),
    grid: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => id)),
    alternatives: Array.from({ length: 6 }, () => []),
    allowedModels: ["gpt-6.1-sol"],
  });
  const old = Schema.decodeSync(operation)({
    ...sent,
    policy: { ...sent.policy, codex: band(2) },
  });
  expect(old._tag === "modelPolicy" && old.policy.codex.cells[10]![10]).toEqual({
    model: "gpt-6.1-sol",
    effort: "high",
  });
  const answered = wire(Schema.encodeSync(reply)({ modelPolicy: defaultModelRoutingPolicy }));
  expect(Schema.decodeSync(reply)(answered)).toEqual({ modelPolicy: defaultModelRoutingPolicy });
});

it("scores an assignment with two whole numbers and needs no reasons", () => {
  const decode = Schema.decodeUnknownSync(AssignmentAssessment);
  expect(decode({ difficulty: 0, stakes: 10 })).toEqual({ difficulty: 0, stakes: 10 });
  // Builds from before smart allocation send a reason beside each score.
  const reasoned = { difficulty: 5, stakes: 4, difficultyReason: "Hard", stakesReason: "Risky" };
  expect(decode(reasoned)).toEqual(reasoned);
  for (const broken of [
    { difficulty: 5 },
    { difficulty: 5.5, stakes: 1 },
    { difficulty: 5, stakes: 11 },
  ])
    expect(() => decode(broken)).toThrow();
  expect(
    decodeRequest({
      selection: "automatic",
      assignmentId: "one",
      environmentId: "host",
      threadId: "thread",
      allowedDrivers: ["claudeAgent"],
      assessment: { difficulty: 5, stakes: 4 },
    }).assessment,
  ).toEqual({ difficulty: 5, stakes: 4 });
});

it("defaults the ladder and the fallback for a policy saved before them", () => {
  // Weakest first: haiku max, sonnet high, opus medium, sonnet xhigh, opus high, fable low,
  // opus xhigh, fable medium, fable high.
  expect(defaultModelLadder.map(({ model, effort }) => `${model.split("-")[1]} ${effort}`)).toEqual(
    [
      "haiku max",
      "sonnet high",
      "opus medium",
      "sonnet xhigh",
      "opus high",
      "fable low",
      "opus xhigh",
      "fable medium",
      "fable high",
    ],
  );
  expect(defaultModelFallback).toEqual({
    model: "deepseek-flash",
    effort: "max",
    below: defaultModelLadder[3],
  });
  expect(defaultModelRoutingPolicy.ladder).toBeUndefined();
  expect(defaultModelRoutingPolicy.fallback).toBeUndefined();
  expect(modelLadder(defaultModelRoutingPolicy)).toBe(defaultModelLadder);
  expect(modelFallback(defaultModelRoutingPolicy)).toBe(defaultModelFallback);
});

it("stores any ladder and fallback, and null turns the fallback off", () => {
  const ladder = [
    { model: "a-model-no-code-lists", effort: "ultra" },
    { model: "claude-opus-5-5", effort: "high" },
  ];
  const fallback = { model: "kimi", effort: "max", below: ladder[1]! };
  const policy = decodePolicy(
    JSON.parse(JSON.stringify(encodePolicy({ ...defaultModelRoutingPolicy, ladder, fallback }))),
  );
  expect(modelLadder(policy)).toEqual(ladder);
  expect(modelFallback(policy)).toEqual(fallback);
  const off = decodePolicy({ ...defaultModelRoutingPolicy, ladder: [], fallback: null });
  expect(modelLadder(off)).toEqual([]);
  expect(modelFallback(off)).toBeNull();
  for (const broken of [
    { ladder: [{ model: "", effort: "high" }] },
    { ladder: Array.from({ length: 31 }, () => ladder[0]) },
    { fallback: { model: "kimi", effort: "max" } },
  ])
    expect(() => decodePolicy({ ...defaultModelRoutingPolicy, ...broken })).toThrow();
});
