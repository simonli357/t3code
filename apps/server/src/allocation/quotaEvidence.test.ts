import { expect, it } from "@effect/vitest";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";
import { unresolvedQuotaRejections, type QuotaEvidence } from "./quotaEvidence.ts";

const at = "2026-10-23T19:30:00.000Z";
const reset = "2026-10-23T18:00:00.000Z";
const nextReset = "2026-10-30T18:00:00.000Z";
const rejected: QuotaEvidence = {
  instanceId: "claude",
  windowId: "seven_day_overage_included",
  at: "2026-10-23T17:00:00.000Z",
  status: "rejected",
  resetsAt: reset,
  ordinal: 1,
};
const entry = (display_name: string) => ({ display_name, utilization: 0, resets_at: nextReset });
const probe = (entries: unknown[] = [entry("Fable")], checkedAt = at) =>
  claudeUsageResponseToLimits({
    checkedAt,
    response: {
      rate_limits_available: true,
      rate_limits: { ...({ model_scoped: entries } as object) },
    },
  });
const remaining = (limits = probe().limits, evidence = [rejected]) =>
  unresolvedQuotaRejections(evidence, limits, at, 15);

it("recovers a stopped scoped rejection from a proven late mapping and fresh reset, never elapsed time alone", () => {
  expect(remaining()).toEqual([]);
  const fresh = probe().limits;
  for (const patch of [
    { resetsAt: reset },
    { resetsAt: undefined },
    { checkedAt: "2026-10-23T18:00:00.000Z" },
    { usedPercent: 100 },
    { enforcement: undefined },
  ])
    expect(
      remaining({ ...fresh, windows: fresh.windows.map((w) => ({ ...w, ...patch })) }),
    ).toHaveLength(1);
  expect(remaining(probe([], at).limits)).toHaveLength(1);
  expect(remaining(probe([entry("Fable")], "2026-10-23T19:00:00.000Z").limits)).toHaveLength(1);
});

it("requires one proven association without guessing the first model or colliding numeric identities", () => {
  for (const entries of [
    [entry("Fable"), entry("Opus")],
    [entry("Fable"), { display_name: "Ghost", utilization: null }],
    [entry("Fable"), {}],
    [entry("A B"), entry("A-B")],
    [{ display_name: "Fable", utilization: Number.NaN }],
  ]) {
    for (const ordered of [entries, entries.toReversed()]) {
      const result = probe(ordered);
      expect(result.names.overageIncluded).toBeUndefined();
      expect(remaining(result.limits)).toHaveLength(1);
    }
  }
  const fresh = probe().limits;
  const numeric = fresh.windows[0]!;
  expect(
    remaining({ ...fresh, windows: [numeric, { ...numeric, id: "seven_day_other" }] }),
  ).toHaveLength(1);
});

it("preserves a rejection's known numeric scope and does not clear another rejected window", () => {
  const bound = { ...rejected, usageWindowId: "seven_day_fable" };
  expect(remaining(probe([entry("Other")]).limits, [bound])).toHaveLength(1);
  // A persisted association is enough to identify a subsequent fresh numeric reading.
  const fresh = probe().limits;
  expect(
    remaining({ ...fresh, windows: fresh.windows.map(({ enforcement: _mapping, ...w }) => w) }, [
      bound,
    ]),
  ).toEqual([]);
  const other: QuotaEvidence = {
    ...rejected,
    windowId: "seven_day",
    resetsAt: "2026-10-24T18:00:00.000Z",
  };
  expect(remaining(fresh, [rejected, other])).toEqual([other]);
  const allowed: QuotaEvidence = { ...rejected, status: "allowed", ordinal: 2 };
  const again = { ...rejected, ordinal: 3 };
  const noReset = { ...fresh, windows: fresh.windows.map((w) => ({ ...w, resetsAt: reset })) };
  expect(remaining(noReset, [rejected, allowed])).toEqual([]);
  expect(remaining(noReset, [allowed, again, rejected])).toEqual([again]);
  expect(remaining(noReset, [again, rejected, allowed])).toEqual([again]);
});

it("sparse numeric updates retain but cannot renew stale association evidence", () => {
  const old = probe([entry("Fable")], "2026-10-23T19:00:00.000Z").limits;
  const { enforcement: _mapping, ...numeric } = old.windows[0]!;
  const merged = applyUsageLimitsUpdate({
    previous: old,
    checkedAt: at,
    update: { windows: [{ ...numeric, usedPercent: 1 }] },
  })!;
  expect(merged.windows[0]?.enforcement?.checkedAt).toBe(old.checkedAt);
  expect(remaining(merged)).toHaveLength(1);
  expect(remaining(probe().limits)).toEqual([]);
});
