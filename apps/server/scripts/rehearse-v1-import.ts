#!/usr/bin/env node
// Rehearses the V1 -> V2 import on a copy of a V1 database in an isolated directory.
// Usage: node apps/server/scripts/rehearse-v1-import.ts <directory containing state.sqlite>
// The directory's state.sqlite is opened read-only; statev2.sqlite and receipts appear beside it.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../src/config.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { describeDatabase, verifyV1ImportCounts } from "../src/persistence/importReceipts.ts";
import { validateCustomSchema } from "../src/persistence/siteMigrations.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";

const directory = NodePath.resolve(process.argv[2] ?? "");
const sourcePath = NodePath.join(directory, "state.sqlite");
const destinationPath = NodePath.join(directory, "statev2.sqlite");

const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const program = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const layerDatabase = SqlitePersistence.layerConfig.pipe(
    Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
  );
  const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(layerDatabase),
  );
  const layerImporter = LegacyV1ThreadImporter.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerStores, EventSink.layer.pipe(Layer.provide(layerStores))),
    ),
  );
  const before = yield* Effect.promise(() => describeDatabase(sourcePath));
  const startedAt = yield* Clock.currentTimeMillis;
  const problems = yield* Effect.gen(function* () {
    const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* legacy.reconcileShells;
    yield* legacy.importPendingTranscripts;
    const pending = yield* legacy.pendingThreadCount;
    if (pending !== 0) return yield* Effect.die(`${pending} threads still pending`);
    return yield* validateCustomSchema();
  }).pipe(Effect.provide(layerImporter));
  const after = yield* Effect.promise(() => describeDatabase(sourcePath));
  const checks = verifyV1ImportCounts({ sourcePath, destinationPath });
  const report = {
    seconds: ((yield* Clock.currentTimeMillis) - startedAt) / 1000,
    sourceUnchanged: before.sha256 === after.sha256 && before.sizeBytes === after.sizeBytes,
    sourceSha256: before.sha256,
    sourceLedger: before.ledger.length,
    v2Ledger: (yield* Effect.promise(() => describeDatabase(destinationPath))).ledger.length,
    customSchemaProblems: problems,
    counts: checks,
    allCountsMatch: checks.every((check) => check.matches),
  };
  yield* Console.log(encodeReport(report));
  if (!report.allCountsMatch || !report.sourceUnchanged || problems.length > 0)
    process.exitCode = 1;
}).pipe(
  Effect.provide(
    ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

await Effect.runPromise(program);
