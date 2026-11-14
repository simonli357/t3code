/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   * It subscribes before returning. Event handling waits for server activation.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Queue an idle compaction of the thread's provider context. It runs as no turn at all, in
   * order with the thread's turn starts; turns requested meanwhile wait for it as they do for
   * `/compact`. Skipped while the thread's session is starting or running or already compacting.
   */
  readonly compactIdleThread: (threadId: ThreadId) => Effect.Effect<void>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("t3/orchestration/Services/ProviderCommandReactor") {}
