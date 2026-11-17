import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as Measurements from "./UsageMeasurements.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("records every account without opt-in and never stores its email", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const providers = ["codex", "claudeAgent", "codex_antoine"].map((instanceId) =>
        decodeProvider({
          instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated", email: `${instanceId}@example.test` },
          checkedAt: "1970-01-01T00:00:00.000Z",
          models: [],
          usageLimits: {
            checkedAt: "1970-01-01T00:00:00.000Z",
            windows: [{ id: "five_hour", kind: "session", label: "5h", usedPercent: 10 }],
          },
        }),
      );
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), dir),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(providers),
          streamChanges: Stream.empty,
        }),
        Layer.mock(ProviderService)({ streamEvents: Stream.empty }),
        Layer.mock(ProjectionSnapshotQuery)({}),
      );
      const layer = Measurements.layer.pipe(Layer.provideMerge(dependencies));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Measurements.UsageMeasurements;
          const report = yield* service.read({});
          expect(report.accounts.flatMap((a) => a.instanceIds).sort()).toEqual([
            "claudeAgent",
            "codex",
            "codex_antoine",
          ]);
        }).pipe(Effect.provide(layer)),
      );
      const stored = yield* fs.readFileString(`${dir}/userdata/usage-measurements.json`);
      expect(stored).toContain("codex_antoine");
      expect(stored).not.toContain("@example.test");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "prices a turn without subagents from its tokens, whatever cost the provider reported",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${dir}/userdata`, { recursive: true });
        // A dollar per million tokens of every kind.
        yield* fs.writeFileString(
          `${dir}/userdata/usage-model-rates.json`,
          encodeJson({
            fetchedAtMs: 0,
            document: {
              "test-model": {
                input_cost_per_token: 1e-6,
                output_cost_per_token: 1e-6,
                cache_read_input_token_cost: 1e-6,
                cache_creation_input_token_cost: 1e-6,
              },
            },
          }),
        );
        const turn = (turnId: string, costUsd: number, hasSubagents: boolean) => ({
          instanceId: "claudeAgent",
          accountKey: "account",
          threadId: "thread",
          turnId,
          model: "test-model",
          effort: null,
          selectionSource: "provider",
          sessionCreatedAt: null,
          observedAt: "1970-01-01T00:00:00.000Z",
          startedAt: "1970-01-01T00:00:00.000Z",
          endedAt: "1970-01-01T00:10:00.000Z",
          state: "completed",
          lastObservedAt: "1970-01-01T00:10:00.000Z",
          initialContextTokens: null,
          latestContextTokens: null,
          peakContextTokens: null,
          contextCapacityTokens: null,
          compactions: 0,
          mixedModels: false,
          toolWallMs: 0,
          toolTimingComplete: true,
          apiDurationMs: null,
          tokens: {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents,
            inputTokens: 1_000_000,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 1_000_000,
          },
          costUsd,
        });
        // The first turn of a resumed session reported the session's running total.
        yield* fs.writeFileString(
          `${dir}/userdata/usage-measurements.json`,
          encodeJson({
            version: 1,
            turns: [turn("resumed", 80, false), turn("subagents", 5, true)],
            quotas: [],
          }),
        );
        const provider = decodeProvider({
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          version: "1",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "1970-01-01T00:00:00.000Z",
          models: [],
        });
        const layer = Measurements.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), dir),
              Layer.mock(ProviderRegistry)({
                getProviders: Effect.succeed([provider]),
                streamChanges: Stream.empty,
              }),
              Layer.mock(ProviderService)({ streamEvents: Stream.empty }),
              Layer.mock(ProjectionSnapshotQuery)({}),
            ),
          ),
        );
        const evidence = yield* Effect.flatMap(
          Measurements.UsageMeasurements,
          (service) => service.evidence,
        ).pipe(Effect.provide(layer));
        // Two million tokens at a dollar a million; the subagents' share is only in the provider's figure.
        expect(evidence.turns.map((t) => [t.turnId, t.priced])).toEqual([
          ["resumed", 2],
          ["subagents", 5],
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
