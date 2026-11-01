import type { OrchestrationV2DomainEvent, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

// These already-persisted migration events describe historical ordinal ranges, not
// a provider activation or a replacement snapshot of its current runtime state.
export function isLegacyProviderRange(event: OrchestrationV2DomainEvent): boolean {
  return (
    event.type === "provider-thread.updated" &&
    event.id === `migration:v1:history:${event.threadId}:provider-range`
  );
}

export function mergeLegacyProviderRange(
  current: OrchestrationV2ProviderThread | undefined,
  history: OrchestrationV2ProviderThread,
): OrchestrationV2ProviderThread {
  if (!current) return history;
  return {
    ...current,
    firstRunOrdinal:
      current.firstRunOrdinal === null
        ? history.firstRunOrdinal
        : history.firstRunOrdinal === null
          ? current.firstRunOrdinal
          : Math.min(current.firstRunOrdinal, history.firstRunOrdinal),
    lastRunOrdinal:
      current.lastRunOrdinal === null
        ? history.lastRunOrdinal
        : history.lastRunOrdinal === null
          ? current.lastRunOrdinal
          : Math.max(current.lastRunOrdinal, history.lastRunOrdinal),
  };
}

export function laterActivityTime(current: DateTime.Utc, incoming: DateTime.Utc): DateTime.Utc {
  return current.epochMilliseconds >= incoming.epochMilliseconds ? current : incoming;
}
