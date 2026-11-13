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
import { lookupRate, parseRateTable, type RateTable } from "./usagePricing.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ fetchedAtMs: Schema.Number, document: Schema.Unknown })),
);
/** Dollars per token by price class, as allocation learning prices turns. */
export interface TokenPrice {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}
const RATES_RELOAD_MS = 60 * 60_000;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class UsageMeasurements extends Context.Service<
  UsageMeasurements,
  {
    readonly read: (input: UsageMeasurementsInput) => Effect.Effect<UsageMeasurementsReport>;
    /**
     * Every retained finished turn, with its cost (the provider's own figure, else its tokens
     * at API prices; null when neither is known), and every limit reading.
     */
    readonly evidence: Effect.Effect<{
      readonly turns: readonly (ReturnType<MeasurementHistory["evidence"]>["turns"][number] & {
        readonly priced: number | null;
      })[];
      readonly quotas: ReturnType<MeasurementHistory["evidence"]>["quotas"];
    }>;
    /** API prices from the usage page's cached rate table. */
    readonly prices: Effect.Effect<(model: string) => TokenPrice | null>;
  }
>()("t3/usage/UsageMeasurements") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const runtime = yield* ProviderService;
  const projection = yield* ProjectionSnapshotQuery;
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
  // Every account is measured: allocation learns each one's cost and size from this.
  const updateScope = Effect.gen(function* () {
    allowed = new Set((yield* providers.getProviders).map((p) => p.instanceId));
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
  // The usage page fetches and caches the rate table; learning only reads that copy.
  let rates: { table: RateTable; loadedAt: number } | undefined;
  const rateTable = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    if (rates && at - rates.loadedAt < RATES_RELOAD_MS) return rates.table;
    const table = yield* fs
      .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
      .pipe(
        Effect.flatMap(decodeRates),
        Effect.map((cached) => parseRateTable(cached.document)),
        Effect.catchCause(() => Effect.succeed(rates?.table ?? new Map())),
      );
    rates = { table, loadedAt: at };
    return table;
  });
  const prices = Effect.map(rateTable, (table) => (model: string) => {
    const rate = lookupRate(table, model);
    return rate
      ? {
          input: rate.inputCostPerToken,
          cacheRead: rate.cacheReadCostPerToken,
          cacheWrite: rate.cacheCreationCostPerToken,
          output: rate.outputCostPerToken,
        }
      : null;
  });
  return UsageMeasurements.of({
    prices,
    evidence: Effect.gen(function* () {
      history.recordProviders(yield* providers.getProviders);
      const price = yield* prices;
      const { turns, quotas } = history.evidence(yield* Clock.currentTimeMillis);
      return {
        quotas,
        turns: turns.map((turn) => {
          const tokens = turn.tokens;
          const rate = turn.model ? price(turn.model) : null;
          const priced =
            turn.costUsd ??
            (rate && tokens?.inputTokens !== undefined && tokens.outputTokens !== undefined
              ? Math.max(
                  0,
                  tokens.inputTokens -
                    (tokens.cachedInputTokens ?? 0) -
                    (tokens.cacheCreationTokens ?? 0),
                ) *
                  rate.input +
                (tokens.cachedInputTokens ?? 0) * rate.cacheRead +
                (tokens.cacheCreationTokens ?? 0) * rate.cacheWrite +
                tokens.outputTokens * rate.output
              : null);
          return { ...turn, priced };
        }),
      };
    }),
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
