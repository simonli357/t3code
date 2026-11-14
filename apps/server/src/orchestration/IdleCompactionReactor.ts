/**
 * Idle compaction: a Claude thread with a large context that sits idle is compacted shortly
 * before its prompt cache expires, so a later return re-reads a summary instead of the whole
 * thread at full price.
 *
 * The Claude adapter stamps every context-size reading with when the prompt cache of the
 * session's latest request expires. Each reading re-arms one in-memory timer per thread for
 * `leadMinutes` before that. When it fires, the thread is compacted only if it is still idle
 * and is likely to be returned to (`idleCompactionSkip`); the compaction runs as no turn at all
 * (`ProviderCommandReactor.compactIdleThread`). After a restart the timers are rebuilt from the
 * stored readings and any whose start has passed is dropped, so nothing compacts early or twice.
 */
import {
  type IdleCompactionSettings,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProviderAllocation from "../allocation/ProviderAllocation.ts";
import * as UsageCapEnforcement from "../allocation/UsageCapEnforcement.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "./Services/ProviderCommandReactor.ts";

export class IdleCompactionReactor extends Context.Service<
  IdleCompactionReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration/IdleCompactionReactor") {}

/** A context-size reading: how large the context is and when its prompt cache expires. */
export interface IdleCompactionReading {
  readonly usedTokens: number;
  readonly expiresAtMs: number;
  readonly readAtMs: number;
}

/** When an idle compaction for this reading starts, or null when it never should. */
export function idleCompactionStartMs(
  reading: IdleCompactionReading,
  settings: IdleCompactionSettings,
): number | null {
  if (!settings.enabled || reading.usedTokens < settings.contextTokens) return null;
  const startMs = reading.expiresAtMs - settings.leadMinutes * 60_000;
  // A lead as long as the cache's life would compact right after every turn.
  return startMs > reading.readAtMs ? startMs : null;
}

/**
 * Why the thread's own state rules out compacting it now, or null. A thread is compacted only
 * while it waits for someone to come back: not mid-turn or waiting on an approval, input or
 * background work, and not parked (settled, archived, snoozed) or finished (a worker that
 * reported done). Workers, masters and human sessions are otherwise treated alike.
 */
export function idleCompactionSkip(thread: OrchestrationThreadShell): string | null {
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledAt !== null || thread.settledOverride === "settled") return "settled";
  if (thread.snoozedUntil != null) return "snoozed";
  const session = thread.session;
  if (session === null || session.providerName !== "claudeAgent") return "not a Claude session";
  // The thread's next turn would hand the context to another account or provider anyway.
  if (session.providerInstanceId !== thread.modelSelection.instanceId) return "switching accounts";
  if (
    session.status === "starting" ||
    session.status === "running" ||
    session.activeTurnId !== null ||
    thread.latestTurn?.state === "running"
  ) {
    return "turn running";
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting on the user";
  if (thread.backgroundLiveness != null) return "background work";
  const organization = thread.organization;
  if (organization?.owner != null && organization.reportOutcome === "done") {
    return "worker reported done";
  }
  return null;
}

const READING_KIND = "context-window.updated";

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const sameSettings = (left: IdleCompactionSettings, right: IdleCompactionSettings) =>
  left.enabled === right.enabled &&
  left.contextTokens === right.contextTokens &&
  left.leadMinutes === right.leadMinutes;

const readingFrom = (row: {
  readonly createdAt: string;
  readonly usedTokens: unknown;
  readonly expiresAt: unknown;
}): IdleCompactionReading | null => {
  const expiresAtMs = typeof row.expiresAt === "string" ? Date.parse(row.expiresAt) : Number.NaN;
  const readAtMs = Date.parse(row.createdAt);
  return typeof row.usedTokens === "number" &&
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(readAtMs)
    ? { usedTokens: row.usedTokens, expiresAtMs, readAtMs }
    : null;
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerCommands = yield* ProviderCommandReactor;
  const allocation = yield* ProviderAllocation.ProviderAllocation;
  const usageCaps = yield* Effect.serviceOption(UsageCapEnforcement.UsageCapEnforcement);
  const sql = yield* SqlClient.SqlClient;

  const settings = settingsService.getSettings.pipe(
    Effect.map((current) => current.idleCompaction),
  );
  /** The cache expiry each thread was last compacted for, so one idle spell compacts once. */
  const compactedFor = new Map<ThreadId, number>();

  const latestReading = (threadId: ThreadId) =>
    sql<{ createdAt: string; usedTokens: unknown; expiresAt: unknown }>`
      SELECT created_at AS "createdAt",
        json_extract(payload_json, '$.usedTokens') AS "usedTokens",
        json_extract(payload_json, '$.promptCacheExpiresAt') AS "expiresAt"
      FROM projection_thread_activities
      WHERE kind = ${READING_KIND} AND thread_id = ${threadId}
      ORDER BY created_at DESC LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? readingFrom(rows[0]) : null)),
    );

  /** What the thread's records say about it beyond its shell, as a skip reason or null. */
  const recordsSkip = (threadId: ThreadId, reading: IdleCompactionReading) =>
    sql<{
      turn: number;
      queued: number;
      moving: number;
      renewing: number;
      compacted: number;
    }>`
      SELECT
        EXISTS (SELECT 1 FROM projection_turns
          WHERE thread_id = ${threadId} AND state IN ('pending', 'running')) AS "turn",
        EXISTS (SELECT 1 FROM custom_worker_jobs
          WHERE target_id = ${threadId} AND state IN ('queued', 'submitted')) AS "queued",
        EXISTS (SELECT 1 FROM custom_session_moves
          WHERE thread_id = ${threadId} AND locked = 1) AS "moving",
        (EXISTS (SELECT 1 FROM custom_session_renewals
          WHERE thread_id = ${threadId} AND checkpoint_id IS NOT NULL
            AND state NOT IN ('completed', 'error'))
          OR EXISTS (SELECT 1 FROM custom_orchestrator_handoffs
            WHERE (thread_id = ${threadId} OR owner_id = ${threadId})
              AND state IN ('queued', 'error'))) AS "renewing",
        EXISTS (SELECT 1 FROM projection_thread_activities
          WHERE kind = 'context-compaction' AND thread_id = ${threadId}
            AND created_at >= ${isoAt(reading.readAtMs)}) AS "compacted"`.pipe(
      Effect.map(([row]) =>
        !row
          ? null
          : row.turn
            ? "turn running"
            : row.queued
              ? "work queued"
              : row.moving
                ? "being moved"
                : row.renewing
                  ? "being handed off"
                  : row.compacted
                    ? "already compacted"
                    : null,
      ),
    );

  /** A drained account, or one at the hard cap that stops this kind of session, cannot run it. */
  const accountSkip = (thread: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const kind = thread.organization?.owner != null ? "worker" : "session";
      if (yield* allocation.limited(thread.modelSelection, kind)) return "account drained";
      if (Option.isNone(usageCaps)) return null;
      const cap = yield* usageCaps.value.check(thread.id, thread.modelSelection.instanceId);
      return cap === null ? null : "account at its hard cap";
    });

  const compactIfDue = Effect.fn("IdleCompactionReactor.compactIfDue")(function* (
    threadId: ThreadId,
    armed: IdleCompactionReading,
  ) {
    if (compactedFor.get(threadId) === armed.expiresAtMs) return;
    const reading = yield* latestReading(threadId);
    // A newer request re-armed the thread, or its readings stopped carrying a cache expiry.
    if (reading === null || reading.expiresAtMs !== armed.expiresAtMs) return;
    const startMs = idleCompactionStartMs(reading, yield* settings);
    if (startMs === null || (yield* Clock.currentTimeMillis) >= reading.expiresAtMs) return;
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return;
    const skip =
      idleCompactionSkip(thread.value) ??
      (yield* recordsSkip(threadId, reading)) ??
      (yield* accountSkip(thread.value));
    if (skip !== null) {
      yield* Effect.logDebug("idle compaction skipped", { threadId, reason: skip });
      return;
    }
    compactedFor.set(threadId, reading.expiresAtMs);
    yield* providerCommands.compactIdleThread(threadId);
  });

  const start = Effect.fn("IdleCompactionReactor.start")(function* () {
    const timers = yield* FiberMap.make<ThreadId>();

    /** `late` says what a timer whose start has passed does: fire now, or nothing. */
    const arm = (threadId: ThreadId, reading: IdleCompactionReading | null, late: boolean) =>
      Effect.gen(function* () {
        const startMs = reading === null ? null : idleCompactionStartMs(reading, yield* settings);
        const nowMs = yield* Clock.currentTimeMillis;
        if (
          reading === null ||
          startMs === null ||
          nowMs >= reading.expiresAtMs ||
          (nowMs >= startMs && !late)
        ) {
          return yield* FiberMap.remove(timers, threadId);
        }
        yield* FiberMap.run(
          timers,
          threadId,
          Effect.sleep(Duration.millis(Math.max(0, startMs - nowMs))).pipe(
            Effect.andThen(compactIfDue(threadId, reading)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("idle compaction check failed", {
                    threadId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        );
      });

    /** Arms every thread from its stored latest reading. */
    const rearmAll = (late: boolean) =>
      Effect.gen(function* () {
        const nowIso = isoAt(yield* Clock.currentTimeMillis);
        // Only readings whose cache has not expired yet can arm anything.
        const rows = yield* sql<{
          threadId: string;
          createdAt: string;
          usedTokens: unknown;
          expiresAt: unknown;
        }>`
          SELECT thread_id AS "threadId", created_at AS "createdAt",
            json_extract(payload_json, '$.usedTokens') AS "usedTokens",
            json_extract(payload_json, '$.promptCacheExpiresAt') AS "expiresAt"
          FROM projection_thread_activities AS reading
          WHERE kind = ${READING_KIND}
            AND json_extract(payload_json, '$.promptCacheExpiresAt') > ${nowIso}
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities AS newer
              WHERE newer.kind = ${READING_KIND} AND newer.thread_id = reading.thread_id
                AND newer.created_at > reading.created_at)`;
        yield* Effect.forEach(
          rows,
          (row) => arm(ThreadId.make(row.threadId), readingFrom(row), late),
          { discard: true },
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("idle compaction timers could not be rebuilt", {
                cause: Cause.pretty(cause),
              }),
        ),
      );

    const onEvent = (event: OrchestrationEvent) => {
      if (
        event.type !== "thread.activity-appended" ||
        event.payload.activity.kind !== READING_KIND ||
        event.metadata.historyImport === true ||
        event.metadata.sessionMoveImport === true
      ) {
        return Effect.void;
      }
      const payload = event.payload.activity.payload as {
        readonly usedTokens?: unknown;
        readonly promptCacheExpiresAt?: unknown;
      } | null;
      return arm(
        event.payload.threadId,
        readingFrom({
          createdAt: event.payload.activity.createdAt,
          usedTokens: payload?.usedTokens,
          expiresAt: payload?.promptCacheExpiresAt,
        }),
        true,
      );
    };

    // Subscribe first so no reading lands between the rebuild and the live stream.
    const events = yield* engine.subscribeDomainEvents;
    const settingsChanges = yield* settingsService.subscribeChanges;
    let applied = (yield* settingsService.getSettings.pipe(Effect.orDie)).idleCompaction;
    yield* forkParked(
      // A restart drops timers whose start has passed: the compaction may already have run.
      rearmAll(false).pipe(Effect.andThen(Stream.runForEach(events, onEvent))),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (current) => {
        if (sameSettings(current.idleCompaction, applied)) return Effect.void;
        applied = current.idleCompaction;
        return rearmAll(true);
      }),
    );
  });

  return { start } satisfies IdleCompactionReactor["Service"];
});

export const layer = Layer.effect(IdleCompactionReactor, make);
export const liveLayer = layer.pipe(Layer.provide(ProviderAllocation.liveLayer));
