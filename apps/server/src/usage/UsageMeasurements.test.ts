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
