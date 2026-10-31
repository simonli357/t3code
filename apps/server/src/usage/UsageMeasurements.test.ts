import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageMeasurements from "./UsageMeasurements.ts";

const at = DateTime.makeUnsafe("2026-10-30T12:00:00.000Z");
const later = DateTime.makeUnsafe("2026-10-30T13:00:00.000Z");
const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated", email: "owner@example.test" },
  checkedAt: DateTime.formatIso(at),
  models: [],
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  options: [{ id: "effort", value: "high" }],
};
const run = {
  id: "run:measured",
  threadId: "thread:measured",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection,
  providerThreadId: null,
  userMessageId: "message:measured",
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: at,
  startedAt: at,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
} as const;

it.effect("retains an opted-in V2 run and feeds its context into the report", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-usage-measurements-test-",
      }).pipe(Layer.provide(NodeServices.layer)),
      ServerSettings.layerTest({
        usageMeasurementInstanceIds: [ProviderInstanceId.make("codex")],
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        streamChanges: Stream.empty,
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        streamDomainEvents: Stream.fromQueue(events),
        getThreadShell: () =>
          Effect.succeed({
            createdAt: at,
            modelSelection,
          } as never),
      }),
    );

    yield* Effect.gen(function* () {
      const measurements = yield* UsageMeasurements.UsageMeasurements;
      yield* Queue.offer(events, {
        id: EventId.make("event:run-started"),
        type: "run.created",
        threadId: "thread:measured",
        providerInstanceId: "codex",
        occurredAt: at,
        payload: run,
      } as never);
      yield* Queue.offer(events, {
        id: EventId.make("event:context"),
        type: "provider-turn.updated",
        threadId: "thread:measured",
        runId: "run:measured",
        providerInstanceId: "codex",
        occurredAt: later,
        payload: {
          tokenUsage: {
            usedTokens: 64_000,
            maxTokens: 128_000,
            updatedAt: DateTime.formatIso(later),
          },
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 60_000,
            outputTokens: 4_000,
            cachedInputTokens: 50_000,
            reasoningTokens: 2_000,
          },
        },
      } as never);
      yield* Queue.offer(events, {
        id: EventId.make("event:run-completed"),
        type: "run.updated",
        threadId: "thread:measured",
        providerInstanceId: "codex",
        occurredAt: later,
        payload: { ...run, status: "completed", completedAt: later },
      } as never);
      yield* TestClock.adjust(Duration.millis(20));

      const report = yield* measurements.read({ instanceId: ProviderInstanceId.make("codex") });
      assert.deepEqual(report.monitoredInstanceIds, ["codex"]);
      assert.lengthOf(report.turns, 1);
      assert.equal(report.turns[0]?.state, "completed");
      assert.equal(report.turns[0]?.model, "gpt-5.4");
      assert.equal(report.turns[0]?.effort, "high");
      assert.equal(report.turns[0]?.peakContextTokens, 64_000);
      assert.equal(report.turns[0]?.contextCapacityTokens, 128_000);
      assert.equal(report.turns[0]?.tokens?.inputTokens, 60_000);
    }).pipe(
      Effect.scoped,
      Effect.provide(UsageMeasurements.layer.pipe(Layer.provide(dependencies))),
    );
  }),
);
