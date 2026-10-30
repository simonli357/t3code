import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("keeps omitted window age and model scope through repeated sparse updates", () => {
    const first = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:10:00.000Z",
      update: { windows: [{ ...weekly, usedPercent: 25, applicableModels: ["astra"] }] },
    });
    const second = applyUsageLimitsUpdate({
      previous: first,
      checkedAt: "2026-09-03T12:15:00.000Z",
      update: { windows: [{ ...weekly, usedPercent: 30 }] },
    });
    expect(second?.windows.find((w) => w.id === session.id)?.checkedAt).toBe(checkedAt);
    expect(second?.windows.find((w) => w.id === weekly.id)).toMatchObject({
      checkedAt: "2026-09-03T12:15:00.000Z",
      applicableModels: ["astra"],
    });
  });
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" },
        { ...weekly, checkedAt },
      ],
    });
  });

  it("leaves unsupported and unverified accounts and empty updates alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    const unverified = { checkedAt, windows: [], unavailable: { reason: "unverified" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: unverified, checkedAt, update: { windows: [session] } }),
    ).toBe(unverified);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" },
        { ...weekly, checkedAt },
      ],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("does not renew complete-read absence evidence with sparse updates or failed probes", () => {
    const previous = {
      checkedAt,
      shortWindowAbsent: true,
      shortWindowAbsentCheckedAt: checkedAt,
      windows: [weekly],
    };
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt: "2026-09-03T14:00:00.000Z",
      update: { windows: [{ ...weekly, usedPercent: 25 }] },
    });
    expect(next?.shortWindowAbsentCheckedAt).toBe(checkedAt);
    expect(next?.checkedAt).toBe("2026-09-03T14:00:00.000Z");
    expect(
      resolveUsageLimitsAfterProbe({
        published: next,
        probed: {
          checkedAt: "2026-09-03T14:10:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      })?.shortWindowAbsentCheckedAt,
    ).toBe(checkedAt);
    expect(
      resolveUsageLimitsAfterProbe({ published: next, probed: { checkedAt, windows: [weekly] } })
        ?.shortWindowAbsent,
    ).toBeUndefined();
  });
  it("keeps the last good windows through a failed probe but not an authoritative exclusion", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    const unverified = { checkedAt, windows: [], unavailable: { reason: "unverified" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unverified })).toBe(unverified);
    expect(resolveUsageLimitsAfterProbe({ published: unverified, probed: failed })).toBe(
      unverified,
    );
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});
