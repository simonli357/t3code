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
import {
  lookupNearestVersionRate,
  lookupRate,
  parseRateTable,
  type RateTable,
} from "./usagePricing.ts";
import { UsageService } from "./UsageService.ts";

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
/** While a model stays unpriced, the rate table is fetched again this often. */
const RATES_REFETCH_MS = 24 * 60 * 60_000;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class UsageMeasurements extends Context.Service<
  UsageMeasurements,
  {
    readonly read: (input: UsageMeasurementsInput) => Effect.Effect<UsageMeasurementsReport>;
    /**
     * Every retained finished turn, with its cost (its tokens at API prices when it ran no
     * subagents, else the provider's own figure, else its tokens; null when neither is known),
     * and every limit reading.
     */
    readonly evidence: Effect.Effect<{
      readonly turns: readonly (ReturnType<MeasurementHistory["evidence"]>["turns"][number] & {
        readonly priced: number | null;
      })[];
      readonly quotas: ReturnType<MeasurementHistory["evidence"]>["quotas"];
    }>;
    /**
     * API prices from the usage page's cached rate table. A model the table lacks takes the
     * price of its nearest other version, and has the table fetched again before the next read.
     */
    readonly prices: Effect.Effect<(model: string) => TokenPrice | null>;
  }
>()("t3/usage/UsageMeasurements") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const runtime = yield* ProviderService;
  const usage = yield* UsageService;
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
  // The usage page fetches and caches the rate table; learning reads that copy. A model it
  // lacks was released since the fetch, so the table is fetched again: once when such a model
  // first appears, then daily while any stays unpriced.
  let rates: { table: RateTable; loadedAt: number } | undefined;
  const unpriced = new Set<string>();
  let refetched: { at: number; unpriced: number } | undefined;
  const rateTable = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
    const refetch =
      unpriced.size > 0 &&
      (!refetched || unpriced.size > refetched.unpriced || at - refetched.at >= RATES_REFETCH_MS);
    if (rates && !refetch && at - rates.loadedAt < RATES_RELOAD_MS) return rates.table;
    if (refetch) yield* usage.refreshRates;
    const table: RateTable = yield* fs
      .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
      .pipe(
        Effect.flatMap(decodeRates),
        Effect.map((cached) => parseRateTable(cached.document)),
        Effect.catchCause(() => Effect.succeed(rates?.table ?? new Map())),
      );
    if (refetch) {
      for (const model of unpriced) if (lookupRate(table, model)) unpriced.delete(model);
      refetched = { at, unpriced: unpriced.size };
    }
    rates = { table, loadedAt: at };
    return table;
  });
  const prices = Effect.map(rateTable, (table) => (model: string) => {
    const listed = lookupRate(table, model);
    if (!listed) unpriced.add(model);
    const rate = listed ?? lookupNearestVersionRate(table, model);
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
          const fromTokens =
            rate && tokens?.inputTokens !== undefined && tokens.outputTokens !== undefined
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
              : null;
          // A turn without subagents is all in its own tokens. The provider's figure is kept
          // for subagents, which those tokens leave out: before the cost baseline moved into
          // the resume cursor, a resumed Claude session's first turn carried the whole
          // session's running total.
          const priced =
            fromTokens !== null && tokens?.hasSubagents === false
              ? fromTokens
              : (turn.costUsd ?? fromTokens);
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
