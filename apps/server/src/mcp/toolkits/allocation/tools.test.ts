import { expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AllocationPolicyEdit,
  type AllocationPolicyView,
  type AllocationStart,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as Assignments from "../../../allocation/AllocationAssignments.ts";
import * as Allocation from "../../../allocation/ProviderAllocation.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as AllocationTools from "./tools.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const view: AllocationPolicyView = {
  version: 4,
  curves: {
    claude: defaultAllocationPolicy.claude,
    codex: defaultAllocationPolicy.codex,
    other: defaultAllocationPolicy.other,
  },
  rules: [{ account: "XL", kind: "exclude", note: "never XL" }],
  caps: [],
  overrides: [],
  workerModels: { claude: { model: "claude-fable-5", effort: "medium", note: "today" } },
  accounts: [],
};

it.effect("agents edit the policy and start workers without an assessment or reasons", () => {
  const edits: AllocationPolicyEdit[] = [];
  const starts: AllocationStart[] = [];
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
    const read = yield* call("t3_allocation_policy", {});
    expect(read.isError).not.toBe(true);
    expect(encode(read)).toContain("never XL");
    const rules = {
      setRules: [
        { account: "XL", kind: "exclude" },
        { account: "ARA", kind: "maxWorkers", value: 1 },
        { account: "ES", kind: "priority", value: 10, expiresAt: "2026-11-12T00:00:00Z" },
      ],
      clearRules: [{ account: "AD" }],
    };
    expect((yield* call("t3_allocation_policy", rules)).isError).not.toBe(true);
    expect(edits).toEqual([{}, rules]);
    // "Workers on Fable medium today", and back to the table.
    const models = [
      {
        workerModels: {
          claude: { model: "claude-fable-5", effort: "medium", expiresAt: "2026-11-10T05:00:00Z" },
        },
      },
      { workerModels: { claude: null } },
    ];
    for (const model of models) {
      const set = yield* call("t3_allocation_policy", model);
      expect(set.isError).not.toBe(true);
      expect(encode(set)).toContain("claude-fable-5");
    }
    expect(edits.slice(2)).toEqual(models);
    const unknownKind = yield* Effect.flip(
      call("t3_allocation_policy", { setRules: [{ account: "XL", kind: "never" }] }),
    );
    expect(unknownKind.message).toContain('"exclude" | "maxWorkers" | "priority"');
    const start = {
      kind: "worker",
      projectId: "project",
      title: "task",
      prompt: "Do the task",
      request: {
        selection: "automatic",
        assignmentId: "assignment",
        threadId: "worker",
        environmentId: "local",
        allowedDrivers: ["claudeAgent"],
        explicitInstanceId: "claude_eol",
      },
    };
    expect((yield* call("t3_start_allocated_assignment", start)).isError).not.toBe(true);
    expect(
      (yield* call("t3_start_allocated_assignment", { ...start, tier: "hard" })).isError,
    ).not.toBe(true);
    expect(starts.map((input) => input.tier)).toEqual([undefined, "hard"]);
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
          }),
        ),
        Layer.provide(
          Layer.mock(Assignments.AllocationAssignments)({
            start: (input) =>
              Effect.sync(() => {
                starts.push(input);
                return { allocation: null, threadId: input.request.threadId, state: "submitted" };
              }),
          }),
        ),
      ),
    ),
  );
});
