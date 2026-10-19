import { type UsageMeasurementsInput, type UsageMeasurementsReport } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { MeasurementHistory } from "./measurementHistory.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class UsageMeasurements extends Context.Service<
  UsageMeasurements,
  {
    readonly read: (input: UsageMeasurementsInput) => Effect.Effect<UsageMeasurementsReport>;
  }
>()("t3/usage/UsageMeasurements") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const runtime = yield* ProviderService;
  const projection = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const history = new MeasurementHistory();
  const file = path.join(config.stateDir, "usage-measurements.json");
  let persistenceError: string | null = null;
  if (yield* fs.exists(file)) {
    yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.flatMap((raw) => Effect.try(() => history.restore(raw))),
      Effect.catchCause(() =>
        Effect.sync(() => {
          persistenceError = "Could not load retained measurements; collecting new observations.";
        }),
      ),
    );
  }
  let allowed = new Set<string>();
  const updateScope = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.catchCause(() => Effect.succeed(null)));
    allowed = new Set(current?.usageMeasurementInstanceIds ?? []);
    history.setAllowed([...allowed]);
  });
  yield* updateScope;
  history.recordProviders(yield* providers.getProviders);
  const lock = yield* Semaphore.make(1);
  const flush = lock.withPermit(
    Effect.gen(function* () {
      yield* updateScope;
      const now = yield* Clock.currentTimeMillis;
      const serialized = yield* encodeJson(history.snapshot(now));
      yield* fs.writeFileString(`${file}.tmp`, serialized, { mode: 0o600 });
      yield* fs.rename(`${file}.tmp`, file);
      persistenceError = null;
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          persistenceError =
            "Could not persist measurements; current observations are memory-only.";
        }),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => flush);
  yield* flush.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  yield* providers.streamChanges.pipe(
    Stream.runForEach((snapshots) =>
      updateScope.pipe(Effect.andThen(Effect.sync(() => history.recordProviders(snapshots)))),
    ),
    Effect.forkScoped,
  );
  // No disk writes or transcript parsing on the provider ingestion path.
  yield* runtime.streamEvents.pipe(
    Stream.filter((event) =>
      [
        "turn.started",
        "turn.completed",
        "turn.aborted",
        "thread.token-usage.updated",
        "item.started",
        "item.completed",
        "model.rerouted",
      ].includes(event.type),
    ),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        yield* updateScope;
        if (!event.providerInstanceId || !allowed.has(event.providerInstanceId)) return;
        if (event.type === "turn.started") {
          const thread = yield* projection
            .getThreadShellById(event.threadId)
            .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
          if (
            Option.isSome(thread) &&
            thread.value.modelSelection.instanceId === event.providerInstanceId
          ) {
            const selection = thread.value.modelSelection;
            history.observe(event, {
              model: selection.model,
              effort:
                getModelSelectionStringOptionValue(selection, "effort") ??
                getModelSelectionStringOptionValue(selection, "reasoningEffort"),
              createdAt: thread.value.createdAt,
            });
            return;
          }
        }
        history.observe(event);
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("usage measurement event failed", cause)),
      ),
    ),
    Effect.forkScoped,
  );
  return UsageMeasurements.of({
    read: (input) =>
      Effect.gen(function* () {
        yield* updateScope;
        history.recordProviders(yield* providers.getProviders);
        const report = history.report(input, yield* Clock.currentTimeMillis);
        return { ...report, persistenceError };
      }),
  });
});

export const layer = Layer.effect(UsageMeasurements, make);
