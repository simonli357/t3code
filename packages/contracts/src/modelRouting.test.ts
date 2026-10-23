import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ModelRoutingPolicy,
  defaultModelRoutingPolicy,
  ModelRoutingRequest,
} from "./modelRouting.ts";
import { AllocationStart } from "./providerAllocation.ts";
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
it("requires six by six tables and exactly six valid profiles independently", () => {
  const decode = Schema.decodeUnknownSync(ModelRoutingPolicy);
  expect(decode(defaultModelRoutingPolicy)).toEqual(defaultModelRoutingPolicy);
  for (const grid of [
    [],
    [[1]],
    defaultModelRoutingPolicy.codex.grid.slice(0, 5),
    defaultModelRoutingPolicy.codex.grid.map((r) => r.map(() => 7)),
  ])
    expect(() =>
      decode({ ...defaultModelRoutingPolicy, codex: { ...defaultModelRoutingPolicy.codex, grid } }),
    ).toThrow();
});
