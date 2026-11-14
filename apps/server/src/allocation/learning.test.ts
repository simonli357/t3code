import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type AllocationEvidence,
  type EvidenceReading,
  type EvidenceTurn,
} from "@t3tools/contracts";
import { estimateLimit, learnAllocation, quarterOf, type PriceOf } from "./learning.ts";

const HOUR = 3_600_000;
const base = Date.parse("2026-11-08T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const driver = ProviderDriverKind.make("claudeAgent");
const price: PriceOf = (model) =>
  model === "opus"
    ? { input: 5e-6, cacheRead: 0.5e-6, cacheWrite: 6.25e-6, output: 25e-6 }
    : model === "sonnet"
      ? { input: 3e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6, output: 15e-6 }
      : null;
const evidence = (turns: EvidenceTurn[], readings: EvidenceReading[] = []): AllocationEvidence => ({
  environmentId: "host",
  observedAt: iso(base),
  turns,
  readings,
});
/** A 30-minute turn starting ten minutes into hour `hour`. */
const turn = (thread: string, hour: number, costUsd: number, extra: Partial<EvidenceTurn> = {}) =>
  ({
    key: "acct",
    driver,
    model: "opus",
    effort: "high",
    kind: "worker",
    threadId: thread,
    startedAt: iso(base + hour * HOUR + 10 * 60_000),
    endedAt: iso(base + hour * HOUR + 40 * 60_000),
    contextTokens: null,
    costUsd,
    ...extra,
  }) satisfies EvidenceTurn;
const reading = (hour: number, usedPercent: number, plan = "Max 5x"): EvidenceReading => ({
  key: "acct",
  label: "AC",
  driver,
  windowId: "weekly",
  windowLabel: "Weekly",
  kind: "weekly",
  usedPercent,
  checkedAt: iso(base + hour * HOUR),
  resetsAt: "2026-11-15T00:00:00.000Z",
  durationHours: 168,
  plan,
});
const account = (key: string, plan: string) => ({
  key,
  label: key === "acct" ? "AC" : "XY",
  driver,
  plan,
  windows: [{ id: "weekly", label: "Weekly" }],
});

describe("cost per working hour", () => {
  // Turns an hour apart: each stands for its 30 minutes and the 15-minute idle tail after it.
  const contexts = Array.from({ length: 30 }, (_, i) => 50_000 + ((i * 7) % 30) * 7_000);
  const worker = contexts.map((x, i) =>
    turn("worker", i, 0.75 * (4 + 3e-5 * x), {
      contextTokens: x,
      tokens: { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 1_000 },
    }),
  );
  const master = Array.from({ length: 20 }, (_, i) =>
    turn("master", i, 0.75 * 2, { kind: "master", contextTokens: 120_000 }),
  );
  const learned = learnAllocation({
    at: iso(base + 100 * HOUR),
    evidence: [evidence([...worker, ...master])],
    accounts: [],
    profiles: [
      { driver, model: "sonnet", effort: "high" },
      { driver, model: "opus", effort: "max" },
    ],
    price,
  });
  const cost = (model: string, effort: string, kind: string) =>
    learned.costs.find((c) => c.model === model && c.effort === effort && c.kind === kind);

  it("charges working time with at most 15 idle minutes per turn, and context raises the rate", () => {
    const worker = cost("opus", "high", "worker")!;
    expect(worker).toMatchObject({ source: "measured", samples: 30, hours: 22.5 });
    // The rate is quoted at the typical context, and every 100k tokens more add $3 an hour.
    expect(worker.dollarsPerHour).toBeCloseTo(4 + 3e-5 * worker.contextTokens, 4);
    expect(worker.perHundredK).toBeCloseTo(3, 6);
  });

  it("learns masters separately, at their own lower rate", () => {
    expect(cost("opus", "high", "master")).toMatchObject({ source: "measured", perHundredK: 0 });
    expect(cost("opus", "high", "master")!.dollarsPerHour).toBeCloseTo(2, 6);
  });

  it("weighs a thin measurement against its price-based estimate by its evidence", () => {
    // Three cheap Sonnet turns: 3 of 20 turns, 2.25 of 10 hours, so 15% measured.
    const thin = Array.from({ length: 3 }, (_, i) =>
      turn("thin", i, 0.75, { model: "sonnet", contextTokens: 60_000 }),
    );
    const costs = learnAllocation({
      at: iso(base + 100 * HOUR),
      evidence: [evidence([...worker, ...thin])],
      accounts: [],
      profiles: [],
      price,
    }).costs;
    const opus = costs.find((c) => c.model === "opus" && c.kind === "worker")!;
    const sonnet = costs.find((c) => c.model === "sonnet" && c.kind === "worker")!;
    expect(opus.measuredShare).toBeUndefined();
    expect(sonnet).toMatchObject({
      source: "measured",
      samples: 3,
      measuredShare: 0.15,
      basis: "15% measured, the rest estimated from opus / high repriced",
    });
    // Both at the blended context: the thin rate's own $1 an hour, Opus's repriced to Sonnet.
    const context = 0.15 * 60_000 + 0.85 * opus.contextTokens;
    expect(sonnet.contextTokens).toBe(Math.round(context));
    expect(sonnet.dollarsPerHour).toBeCloseTo(
      0.15 * 1 +
        0.85 *
          0.6 *
          (opus.dollarsPerHour + (opus.perHundredK * (context - opus.contextTokens)) / 1e5),
      6,
    );
  });

  it("estimates an unmeasured model by price and an unmeasured effort from the nearest one, marked estimated", () => {
    const sonnet = cost("sonnet", "high", "worker")!;
    expect(sonnet).toMatchObject({ source: "estimated", basis: "opus / high repriced" });
    expect(sonnet.dollarsPerHour).toBeCloseTo(
      cost("opus", "high", "worker")!.dollarsPerHour * 0.6,
      6,
    );
    expect(cost("opus", "max", "worker")).toMatchObject({
      source: "estimated",
      basis: "opus / high, the nearest effort",
    });
  });
});

describe("share of a limit per dollar", () => {
  // T3 spends 2 to 12 dollars an hour; the limit moves 0.1% a dollar, and someone outside T3
  // uses 0.4% an hour every afternoon (12–18 UTC).
  const spendAt = (hour: number) => 2 + ((hour * 7) % 11);
  const outside = (hour: number) => (quarterOf(base + hour * HOUR) === 2 ? 0.4 : 0);
  const history = (share: (hour: number) => number, plan: (hour: number) => string) => {
    const turns = Array.from({ length: 48 }, (_, h) => turn("limit", h, spendAt(h)));
    let used = 0;
    const readings = Array.from({ length: 49 }, (_, h) => {
      const r = reading(h, used, plan(h));
      used += share(h) * spendAt(h) + outside(h);
      return r;
    });
    return evidence(turns, readings);
  };

  it("separates T3's own use from outside use, by time of day, and never counts outside use as T3's", () => {
    const learned = learnAllocation({
      at: iso(base + 48 * HOUR),
      evidence: [
        history(
          () => 0.1,
          () => "Max 5x",
        ),
      ],
      accounts: [account("acct", "Max 5x")],
      profiles: [],
      price,
    });
    const limit = learned.limits.find((l) => l.key === "acct")!;
    expect(limit).toMatchObject({ source: "measured", samples: 48, plan: "Max 5x" });
    expect(limit.percentPerDollar).toBeCloseTo(0.1, 6);
    expect(limit.backgroundByQuarter?.map((b) => Number(b.toFixed(6)))).toEqual([0, 0, 0.4, 0]);
    expect(limit.backgroundPercentPerHour).toBeCloseTo(0.1, 6);
  });

  it("starts again when the plan changes", () => {
    const learned = learnAllocation({
      at: iso(base + 48 * HOUR),
      evidence: [
        history(
          (h) => (h < 24 ? 0.4 : 0.1),
          (h) => (h < 24 ? "Max 5x" : "Max 20x"),
        ),
      ],
      accounts: [account("acct", "Max 20x")],
      profiles: [],
      price,
    });
    const limit = learned.limits.find((l) => l.key === "acct")!;
    expect(limit).toMatchObject({ plan: "Max 20x", samples: 24 });
    expect(limit.percentPerDollar).toBeCloseTo(0.1, 6);
  });

  it("starts again when the limit's length changes, as when a weekly limit becomes monthly", () => {
    const { turns, readings } = history(
      (h) => (h < 24 ? 0.4 : 0.1),
      () => "Max 5x",
    );
    const learned = learnAllocation({
      at: iso(base + 48 * HOUR),
      evidence: [
        evidence(
          [...turns],
          readings.map((r, h) => (h < 24 ? r : { ...r, durationHours: 720 })),
        ),
      ],
      accounts: [account("acct", "Max 5x")],
      profiles: [],
      price,
    });
    const limit = learned.limits.find((l) => l.key === "acct")!;
    expect(limit.samples).toBe(24);
    expect(limit.percentPerDollar).toBeCloseTo(0.1, 6);
  });

  it("estimates an account without readings from a measured one, scaled by plan tier", () => {
    const learned = learnAllocation({
      at: iso(base + 48 * HOUR),
      evidence: [
        history(
          () => 0.1,
          () => "Max 5x",
        ),
      ],
      accounts: [account("acct", "Max 5x"), account("other", "Max 20x"), account("pro", "Pro")],
      profiles: [],
      price,
    });
    // A weekly limit: Max 20x (now Ultra) holds twice Max 5x's, Pro a fifth.
    const other = learned.limits.find((l) => l.key === "other")!;
    expect(other).toMatchObject({
      source: "estimated",
      samples: 0,
      basis: "plan: Max 20x holds 2× AC's Max 5x",
    });
    expect(other.percentPerDollar).toBeCloseTo(0.05, 6);
    expect(learned.limits.find((l) => l.key === "pro")!.percentPerDollar).toBeCloseTo(0.5, 6);
    // The 5-hour limit scales by the full tier: four times Max 5x's.
    const session = estimateLimit(
      { key: "other", label: "XY", driver, plan: "Max 20x" },
      { id: "weekly", label: "Weekly", kind: "session" },
      learned.limits.filter((l) => l.key === "acct"),
    )!;
    expect(session.basis).toBe("plan: Max 20x holds 4× AC's Max 5x");
    expect(session.percentPerDollar).toBeCloseTo(0.025, 6);
    // Without a plan to compare, the account is taken to be as large as the measured one.
    const unknown = learnAllocation({
      at: iso(base + 48 * HOUR),
      evidence: [
        history(
          () => 0.1,
          () => "Max 5x",
        ),
      ],
      accounts: [account("acct", "Max 5x"), account("other", "Gift plan")],
      profiles: [],
      price,
    }).limits.find((l) => l.key === "other")!;
    expect(unknown).toMatchObject({
      source: "estimated",
      basis: "AC, as large (plan size unknown)",
    });
    expect(unknown.percentPerDollar).toBeCloseTo(0.1, 6);
  });
});
