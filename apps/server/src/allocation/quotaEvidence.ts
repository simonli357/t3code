import type { ProviderQuotaState, ServerProviderUsageLimits } from "@t3tools/contracts";

export type QuotaEvidence = typeof ProviderQuotaState.Type & {
  instanceId: string;
  at: string;
  ordinal?: number;
  threadId?: string;
  /** Native Claude rejection identifies exhaustion of this account-wide bucket. */
  exhausted?: boolean;
};
export function unresolvedQuotaRejections(
  evidence: readonly QuotaEvidence[],
  limits: ServerProviderUsageLimits | undefined,
  at: string,
  maxAgeMinutes: number,
): QuotaEvidence[] {
  const latest = new Map<string, QuotaEvidence>();
  // The projection supplies newest insertion first for same-clock events.
  for (const e of evidence) {
    const old = latest.get(e.windowId);
    if (!old || e.at > old.at || (e.at === old.at && (e.ordinal ?? 0) > (old.ordinal ?? 0)))
      latest.set(e.windowId, e);
  }
  return [...latest.values()].filter((e) => {
    if (e.status === "allowed") return false;
    const windows =
      e.windowId === "unknown"
        ? (limits?.windows ?? [])
        : (limits?.windows ?? []).filter((w) =>
            e.usageWindowId
              ? w.id === e.usageWindowId
              : w.id === e.windowId || w.enforcement?.windowId === e.windowId,
          );
    // A known event binding cannot migrate to another model. Otherwise a later
    // complete probe can establish it, but multiple possible buckets stay unknown.
    if (e.windowId !== "unknown" && windows.length !== 1) return true;
    if (!e.usageWindowId && windows[0]?.id !== e.windowId && e.windowId !== "unknown") {
      const mappedAt = Date.parse(windows[0]?.enforcement?.checkedAt ?? "");
      if (
        !Number.isFinite(mappedAt) ||
        mappedAt > Date.parse(at) ||
        Date.parse(at) - mappedAt > maxAgeMinutes * 60_000
      )
        return true;
    }
    // A passed timestamp is not replenishment. For legacy errors without a reset,
    // every reported window must prove a cycle beginning after the rejection.
    return (
      !windows.length ||
      !windows.every((w) => {
        const checked = Date.parse(w.checkedAt ?? limits!.checkedAt);
        if (
          checked > Date.parse(at) ||
          Date.parse(at) - checked > maxAgeMinutes * 60_000 ||
          checked <= Date.parse(e.at) ||
          w.usedPercent >= 100
        )
          return false;
        // An explicit empty/inactive five-hour probe confirms that the old rolling
        // window ended. Missing resets on sparse updates provide no such evidence.
        if (
          e.windowId === "five_hour" &&
          w.id === "five_hour" &&
          w.inactive &&
          w.usedPercent === 0 &&
          !w.resetsAt &&
          (e.resetsAt
            ? checked > Date.parse(e.resetsAt)
            : w.windowDurationMins === 300 && checked > Date.parse(e.at) + 300 * 60_000)
        )
          return true;
        if (!w.resetsAt) return false;
        // A restored account-wide allowance can retain its scheduled weekly reset.
        // Require recorded exhaustion AND later provider acceptance, not merely a
        // low reading. Scoped/unknown limits never borrow another bucket's recovery.
        if (
          e.exhausted &&
          (e.windowId === "five_hour" || e.windowId === "seven_day") &&
          w.id === e.windowId &&
          e.resetsAt &&
          Math.abs(Date.parse(w.resetsAt) - Date.parse(e.resetsAt)) <= 1000 &&
          evidence.some(
            (a) =>
              a.instanceId === e.instanceId &&
              a.status === "allowed" &&
              (a.windowId === "five_hour" || a.windowId === "seven_day") &&
              a.at > e.at &&
              Date.parse(a.at) <= checked,
          )
        )
          return true;
        if (e.resetsAt) return checked > Date.parse(e.resetsAt) && w.resetsAt > e.resetsAt;
        return (
          w.windowDurationMins !== undefined &&
          Date.parse(w.resetsAt) - w.windowDurationMins * 60_000 > Date.parse(e.at)
        );
      })
    );
  });
}
