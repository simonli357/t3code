import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  UsageMeasurementsInput,
  UsageMeasurementsReport,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MeasurementHistory, type MeasurementEvent } from "./measurementHistory.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class UsageMeasurements extends Context.Service<
  UsageMeasurements,
  {
    readonly read: (input: UsageMeasurementsInput) => Effect.Effect<UsageMeasurementsReport>;
  }
>()("t3/usage/UsageMeasurements") {}

const itemLifecycle = (item: OrchestrationV2TurnItem): "item.started" | "item.completed" | null => {
  if (item.type === "compaction") return item.status === "completed" ? "item.completed" : null;
  if (
    item.type !== "command_execution" &&
    item.type !== "file_change" &&
    item.type !== "web_search" &&
    item.type !== "dynamic_tool"
  )
    return null;
  if (item.status === "pending" || item.status === "running") return "item.started";
  if (
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "interrupted" ||
    item.status === "cancelled"
  )
    return "item.completed";
  return null;
};

const terminalRunState = (
  status: OrchestrationV2Run["status"],
): "completed" | "failed" | "interrupted" | "cancelled" | null =>
  status === "completed" || status === "failed" || status === "interrupted"
    ? status
    : status === "cancelled" || status === "rolled_back"
      ? "cancelled"
      : null;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry;
  const threads = yield* ThreadManagementService.ThreadManagementService;
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

  type MeasurementSignal = Omit<
    MeasurementEvent,
    "providerInstanceId" | "threadId" | "turnId" | "createdAt"
  >;
  const observe = Effect.fn("UsageMeasurements.observe")(function* (
    signal: MeasurementSignal,
    run: OrchestrationV2Run,
    createdAt: string,
  ) {
    const shell =
      (yield* threads.getThreadShell(run.threadId).pipe(Effect.orElseSucceed(() => null))) ?? null;
    const modelSelection = run.modelSelection;
    history.observe(
      {
        ...signal,
        providerInstanceId: run.providerInstanceId,
        threadId: run.threadId,
        turnId: run.id,
        createdAt,
      },
      {
        model: modelSelection.model,
        effort:
          getModelSelectionStringOptionValue(modelSelection, "effort") ??
          getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        createdAt: shell?.createdAt
          ? DateTime.formatIso(shell.createdAt)
          : DateTime.formatIso(run.requestedAt),
      },
    );
  });

  const observeDomainEvent = Effect.fn("UsageMeasurements.observeDomainEvent")(
    function* (event: OrchestrationV2DomainEvent) {
      yield* updateScope;
      if (event.type === "run.created" || event.type === "run.updated") {
        const run = event.payload;
        if (!event.providerInstanceId || !allowed.has(event.providerInstanceId)) return;
        const terminal = terminalRunState(run.status);
        if (terminal !== null) {
          const createdAt = DateTime.formatIso(run.completedAt ?? event.occurredAt);
          yield* observe(
            {
              type:
                terminal === "cancelled" || terminal === "interrupted"
                  ? "turn.aborted"
                  : "turn.completed",
              payload: { state: terminal },
            },
            run,
            createdAt,
          );
          return;
        }
        if (run.startedAt === null) return;
        yield* observe(
          { type: "turn.started", payload: {} },
          run,
          DateTime.formatIso(run.startedAt),
        );
        return;
      }

      if (event.type === "provider-turn.updated") {
        if (!event.providerInstanceId || !event.runId || !allowed.has(event.providerInstanceId))
          return;
        const shell =
          (yield* threads.getThreadShell(event.threadId).pipe(Effect.orElseSucceed(() => null))) ??
          null;
        const selection = shell?.modelSelection;
        const base = {
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          turnId: event.runId,
        };
        if (event.payload.tokenUsage) {
          history.observe(
            {
              ...base,
              type: "context.updated",
              createdAt: event.payload.tokenUsage.updatedAt,
              payload: {
                usage: {
                  usedTokens: event.payload.tokenUsage.usedTokens,
                  ...(typeof event.payload.tokenUsage.maxTokens === "number"
                    ? { maxTokens: event.payload.tokenUsage.maxTokens }
                    : {}),
                },
              },
            },
            selection
              ? {
                  model: selection.model,
                  effort:
                    getModelSelectionStringOptionValue(selection, "effort") ??
                    getModelSelectionStringOptionValue(selection, "reasoningEffort"),
                  createdAt: shell?.createdAt
                    ? DateTime.formatIso(shell.createdAt)
                    : DateTime.formatIso(event.occurredAt),
                }
              : undefined,
          );
        }
        if (event.payload.turnTokenUsage) {
          history.observe({
            ...base,
            type: "turn.tokens",
            createdAt: DateTime.formatIso(event.payload.completedAt ?? event.occurredAt),
            payload: { tokenUsage: event.payload.turnTokenUsage },
          });
        }
        return;
      }

      if (event.type !== "turn-item.updated") return;
      if (!event.providerInstanceId || !event.runId || !allowed.has(event.providerInstanceId))
        return;
      const lifecycle = itemLifecycle(event.payload);
      if (lifecycle === null) return;
      const item = event.payload;
      history.observe({
        type: lifecycle,
        providerInstanceId: event.providerInstanceId,
        threadId: event.threadId,
        turnId: event.runId,
        itemId: item.id,
        createdAt: DateTime.formatIso(item.updatedAt),
        payload: {
          itemType:
            item.type === "compaction"
              ? "context_compaction"
              : item.type === "dynamic_tool"
                ? "dynamic_tool_call"
                : item.type,
          ...("parentItemId" in item && item.parentItemId !== null
            ? { parentToolUseId: item.parentItemId }
            : {}),
        },
      });
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("usage measurement event failed", cause)),
      ),
  );

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach(observeDomainEvent),
    Effect.catchCause((cause) =>
      Effect.logWarning("usage measurement domain event stream failed", { cause }),
    ),
    Effect.forkScoped,
  );

  return UsageMeasurements.of({
    read: Effect.fn("UsageMeasurements.read")(function* (input) {
      yield* updateScope;
      history.recordProviders(yield* providers.getProviders);
      const report = history.report(input, yield* Clock.currentTimeMillis);
      return { ...report, persistenceError };
    }),
  });
});

export const layer = Layer.effect(UsageMeasurements, make);
