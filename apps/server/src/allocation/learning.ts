import {
  IDLE_AFTER_MINUTES,
  publishedPlanSize,
  type AllocationEvidence,
  type AllocationLearned,
  type EvidenceReading,
  type EvidenceTurn,
  type LearnedCost,
  type LearnedLimit,
  type SessionKind,
} from "@t3tools/contracts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Older evidence counts half as much every this many days. */
const COST_HALF_LIFE_DAYS = 7;
const LIMIT_HALF_LIFE_DAYS = 3;
/** Below these a cost has one best estimate and no context slope. */
const MIN_FIT_TURNS = 20;
const MIN_CONTEXT_SPREAD = 30_000;
/** A limit is measured once this much spend moved it over this many reading pairs. */
const MIN_LIMIT_DOLLARS = 20;
const MIN_LIMIT_PAIRS = 5;
/** Readings closer than this are merged into one pair, so whole-percent steps average out. */
const MIN_PAIR_MINUTES = 20;
/** Two readings name the same reset when they are this close. */
const SAME_RESET_MS = 5 * 60_000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const effortRank = (effort: string | null) => {
  const index = EFFORTS.indexOf(effort ?? "");
  return index < 0 ? 2 : index;
};

/** Dollars per token by price class. */
export interface Price {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}
export type PriceOf = (model: string) => Price | null;
export interface LearningAccount {
  readonly key: string;
  readonly label: string;
  readonly driver: string;
  readonly plan: string | null;
  readonly windows: readonly { readonly id: string; readonly label: string }[];
}
export interface Profile {
  readonly driver: string;
  readonly model: string;
  readonly effort: string | null;
}

const weight = (ageMs: number, halfLifeDays: number) =>
  0.5 ** (Math.max(0, ageMs) / (halfLifeDays * DAY));
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Each turn with the working time it stands for: the turn, and up to the idle limit after it. */
export function workingTurns(turns: readonly EvidenceTurn[], at: number) {
  const byThread = new Map<string, EvidenceTurn[]>();
  const seen = new Set<string>();
  for (const turn of turns) {
    const id = `${turn.threadId}@${turn.startedAt}`;
    if (seen.has(id)) continue;
    seen.add(id);
    byThread.set(turn.threadId, [...(byThread.get(turn.threadId) ?? []), turn]);
  }
  const idle = IDLE_AFTER_MINUTES * 60_000;
  return [...byThread.values()].flatMap((list) => {
    const sorted = list.toSorted((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return sorted.map((turn, index) => {
      const start = Date.parse(turn.startedAt);
      const end = Math.max(start, Date.parse(turn.endedAt));
      const next = sorted[index + 1];
      const tail = Math.min(idle, Math.max(0, (next ? Date.parse(next.startedAt) : at) - end));
      return { turn, start, end, hours: (end - start + tail) / HOUR };
    });
  });
}

const tokenCost = (mix: NonNullable<EvidenceTurn["tokens"]>, price: Price) =>
  mix.input * price.input +
  mix.cacheRead * price.cacheRead +
  mix.cacheWrite * price.cacheWrite +
  mix.output * price.output;

function measuredCosts(turns: ReturnType<typeof workingTurns>, at: number) {
  const groups = new Map<string, typeof turns>();
  for (const item of turns) {
    const { driver, model, effort, kind } = item.turn;
    const id = JSON.stringify([driver, model, effort, kind]);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return [...groups.values()].flatMap((items) => {
    const { driver, model, effort, kind } = items[0]!.turn;
    const rows = items.map(({ turn, hours, end }) => ({
      w: weight(at - end, COST_HALF_LIFE_DAYS),
      h: hours,
      c: turn.costUsd,
      x: turn.contextTokens,
      tokens: turn.tokens,
    }));
    const sumWH = rows.reduce((s, r) => s + r.w * r.h, 0);
    if (sumWH <= 0) return [];
    let a = rows.reduce((s, r) => s + r.w * r.c, 0) / sumWH;
    const withContext = rows.filter((r) => r.x !== null);
    const contextWeight = withContext.reduce((s, r) => s + r.w * r.h, 0);
    const mean = contextWeight
      ? withContext.reduce((s, r) => s + r.w * r.h * r.x!, 0) / contextWeight
      : 0;
    const spread = contextWeight
      ? Math.sqrt(
          withContext.reduce((s, r) => s + r.w * r.h * (r.x! - mean) ** 2, 0) / contextWeight,
        )
      : 0;
    let b = 0;
    if (withContext.length >= MIN_FIT_TURNS && spread >= MIN_CONTEXT_SPREAD) {
      // cost = hours × (a + b × (context − mean)), least squares weighted by recency.
      let s11 = 0;
      let s12 = 0;
      let s22 = 0;
      let t1 = 0;
      let t2 = 0;
      for (const r of withContext) {
        const x = r.x! - mean;
        s11 += r.w * r.h * r.h;
        s12 += r.w * r.h * r.h * x;
        s22 += r.w * r.h * r.h * x * x;
        t1 += r.w * r.h * r.c;
        t2 += r.w * r.h * r.c * x;
      }
      const det = s11 * s22 - s12 * s12;
      const fitA = det > 0 ? (t1 * s22 - t2 * s12) / det : NaN;
      const fitB = det > 0 ? (s11 * t2 - s12 * t1) / det : NaN;
      if (fitA > 0 && fitB > 0) {
        a = fitA;
        b = fitB;
      }
    }
    const mixed = rows.filter((r) => r.tokens);
    const mixHours = mixed.reduce((s, r) => s + r.h, 0);
    const mix =
      mixHours > 0
        ? {
            input: mixed.reduce((s, r) => s + r.tokens!.input, 0) / mixHours,
            cacheRead: mixed.reduce((s, r) => s + r.tokens!.cacheRead, 0) / mixHours,
            cacheWrite: mixed.reduce((s, r) => s + r.tokens!.cacheWrite, 0) / mixHours,
            output: mixed.reduce((s, r) => s + r.tokens!.output, 0) / mixHours,
          }
        : undefined;
    const cost: LearnedCost = {
      driver: driver as LearnedCost["driver"],
      model,
      effort,
      kind,
      dollarsPerHour: a,
      perHundredK: b * 100_000,
      contextTokens: Math.round(mean),
      samples: items.length,
      hours: rows.reduce((s, r) => s + r.h, 0),
      source: "measured",
    };
    return [{ cost, mix }];
  });
}

/**
 * A cost for a profile nothing measured: another model at the same effort repriced by its
 * token mix, else the same model at the nearest effort, else the other kind of session
 * scaled by how masters compare with workers.
 */
function estimateCost(
  profile: Profile,
  kind: SessionKind,
  measured: readonly { cost: LearnedCost; mix: Parameters<typeof tokenCost>[0] | undefined }[],
  price: PriceOf,
): LearnedCost | undefined {
  const target = price(profile.model);
  const sameKind = measured.filter((m) => m.cost.kind === kind && m.cost.driver === profile.driver);
  const byHours = <T extends { cost: LearnedCost }>(list: T[]) =>
    list.toSorted((a, b) => b.cost.hours - a.cost.hours);
  const repriced = (from: (typeof measured)[number]) => {
    const source = price(from.cost.model);
    if (!target || !source || !from.mix) return undefined;
    const ratio = tokenCost(from.mix, target) / tokenCost(from.mix, source);
    if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
    return {
      ...from.cost,
      model: profile.model,
      effort: profile.effort,
      dollarsPerHour: from.cost.dollarsPerHour * ratio,
      perHundredK: from.cost.perHundredK * ratio,
      source: "estimated" as const,
      basis: `${from.cost.model} / ${from.cost.effort ?? "default"} repriced`,
    };
  };
  for (const from of byHours(sameKind.filter((m) => m.cost.effort === profile.effort))) {
    const estimate = repriced(from);
    if (estimate) return estimate;
  }
  const sameModel = sameKind
    .filter((m) => m.cost.model === profile.model)
    .toSorted(
      (a, b) =>
        Math.abs(effortRank(a.cost.effort) - effortRank(profile.effort)) -
          Math.abs(effortRank(b.cost.effort) - effortRank(profile.effort)) ||
        b.cost.hours - a.cost.hours,
    )[0];
  if (sameModel)
    return {
      ...sameModel.cost,
      effort: profile.effort,
      source: "estimated",
      basis: `as ${sameModel.cost.model} / ${sameModel.cost.effort ?? "default"}`,
    };
  const other = kind === "worker" ? "master" : "worker";
  const pairs = measured.flatMap((m) => {
    if (m.cost.kind !== kind) return [];
    const twin = measured.find(
      (n) =>
        n.cost.kind === other &&
        n.cost.driver === m.cost.driver &&
        n.cost.model === m.cost.model &&
        n.cost.effort === m.cost.effort,
    );
    return twin
      ? [{ ratio: m.cost.dollarsPerHour / twin.cost.dollarsPerHour, w: m.cost.hours }]
      : [];
  });
  const kindRatio = pairs.length
    ? pairs.reduce((s, p) => s + p.ratio * p.w, 0) / pairs.reduce((s, p) => s + p.w, 0)
    : kind === "master"
      ? 0.5
      : 2;
  const otherKind = measured.find(
    (m) =>
      m.cost.kind === other &&
      m.cost.driver === profile.driver &&
      m.cost.model === profile.model &&
      m.cost.effort === profile.effort,
  );
  if (otherKind)
    return {
      ...otherKind.cost,
      kind,
      dollarsPerHour: otherKind.cost.dollarsPerHour * kindRatio,
      perHundredK: otherKind.cost.perHundredK * kindRatio,
      source: "estimated",
      basis: `${other} rate × ${kindRatio.toFixed(2)}`,
    };
  for (const from of byHours(sameKind)) {
    const estimate = repriced(from);
    if (estimate) return estimate;
  }
  return undefined;
}

interface Pair {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
}

/** Consecutive readings of one window cycle, merged until they are far enough apart. */
function readingPairs(readings: readonly EvidenceReading[]) {
  const sorted = [...new Map(readings.map((r) => [r.checkedAt, r])).values()].toSorted(
    (a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt),
  );
  const pairs: Pair[] = [];
  let anchor = sorted[0];
  for (const reading of sorted.slice(1)) {
    if (!anchor) break;
    const sameCycle =
      (reading.resetsAt === null && anchor.resetsAt === null) ||
      (reading.resetsAt !== null &&
        anchor.resetsAt !== null &&
        Math.abs(Date.parse(reading.resetsAt) - Date.parse(anchor.resetsAt)) <= SAME_RESET_MS);
    if (!sameCycle || reading.usedPercent < anchor.usedPercent) {
      anchor = reading;
      continue;
    }
    const start = Date.parse(anchor.checkedAt);
    const end = Date.parse(reading.checkedAt);
    if (end - start < MIN_PAIR_MINUTES * 60_000) continue;
    pairs.push({ start, end, delta: reading.usedPercent - anchor.usedPercent });
    anchor = reading;
  }
  return pairs;
}

/** Spend on this login inside [start, end], each turn spread evenly over its own span. */
function spend(turns: ReturnType<typeof workingTurns>, start: number, end: number) {
  let total = 0;
  for (const { turn, start: from, end: to } of turns) {
    if (to < start || from > end) continue;
    total +=
      to === from
        ? turn.costUsd
        : (turn.costUsd * (Math.min(to, end) - Math.max(from, start))) / (to - from);
  }
  return total;
}

/** Which quarter of the UTC day a time falls in: 00–06, 06–12, 12–18, 18–24. */
export const quarterOf = (time: number) => Math.floor((((time % DAY) + DAY) % DAY) / (6 * HOUR));

/** Hours of [start, end] in each quarter of the UTC day. */
function quarterHours(start: number, end: number) {
  const hours = [0, 0, 0, 0];
  for (let t = start; t < end;) {
    const quarterEnd = (Math.floor(t / (6 * HOUR)) + 1) * 6 * HOUR;
    const until = Math.min(end, quarterEnd);
    hours[quarterOf(t)]! += (until - t) / HOUR;
    t = until;
  }
  return hours;
}

/**
 * Weighted least squares with every coefficient kept at zero or above: solve, drop the most
 * negative coefficient, solve again. Small systems only.
 */
export function nonNegativeFit(
  rows: readonly { readonly x: readonly number[]; readonly y: number; readonly w: number }[],
) {
  const size = rows[0]?.x.length ?? 0;
  const free = new Set(Array.from({ length: size }, (_, i) => i));
  let result = Array.from({ length: size }, () => 0);
  for (let round = 0; round <= size && free.size; round++) {
    const index = [...free];
    const a = index.map((i) =>
      index.map((j) => rows.reduce((s, r) => s + r.w * r.x[i]! * r.x[j]!, 0)),
    );
    const b = index.map((i) => rows.reduce((s, r) => s + r.w * r.x[i]! * r.y, 0));
    const solved = solve(a, b);
    if (!solved) return undefined;
    result = Array.from({ length: size }, () => 0);
    index.forEach((i, k) => (result[i] = solved[k]!));
    const negative = index
      .filter((i) => result[i]! < 0)
      .toSorted((p, q) => result[p]! - result[q]!);
    if (!negative.length) return result;
    free.delete(negative[0]!);
  }
  return free.size ? result : undefined;
}

function solve(a: number[][], b: number[]) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    const pivot = m
      .slice(col)
      .reduce(
        (best, row, k) => (Math.abs(row[col]!) > Math.abs(m[best]![col]!) ? col + k : best),
        col,
      );
    if (Math.abs(m[pivot]![col]!) < 1e-12) return undefined;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Background by quarter of day only when every quarter is well covered. */
const MIN_QUARTER_PAIRS = 3;
const MIN_QUARTER_HOURS = 4;

function measuredLimit(
  account: LearningAccount,
  window: LearningAccount["windows"][number],
  readings: readonly EvidenceReading[],
  turns: ReturnType<typeof workingTurns>,
  at: number,
): LearnedLimit | undefined {
  let mine = readings.filter((r) => r.key === account.key && r.windowId === window.id);
  // A new plan is a new allowance: learning starts again from the first reading under it. A
  // window whose length changed (a weekly limit now monthly) is a new allowance too.
  const latestPlan = account.plan ?? mine.findLast((r) => r.plan !== null)?.plan ?? null;
  const length = mine.findLast((r) => r.durationHours !== null)?.durationHours ?? null;
  const changed = mine.findLast(
    (r) =>
      (r.plan !== null && r.plan !== latestPlan) ||
      (r.durationHours !== null && length !== null && r.durationHours !== length),
  );
  if (changed) mine = mine.filter((r) => r.checkedAt > changed.checkedAt);
  const models = mine.at(-1)?.models;
  const relevant = turns.filter(
    ({ turn, start }) =>
      turn.key === account.key &&
      (!models?.length || models.includes(turn.model)) &&
      (!changed || start > Date.parse(changed.checkedAt)),
  );
  const pairs = readingPairs(mine).map((pair) => ({
    ...pair,
    cost: spend(relevant, pair.start, pair.end),
    hours: (pair.end - pair.start) / HOUR,
    quarters: quarterHours(pair.start, pair.end),
    w: weight(at - pair.end, LIMIT_HALF_LIFE_DAYS),
  }));
  const dollars = pairs.reduce((s, p) => s + p.cost, 0);
  if (dollars < MIN_LIMIT_DOLLARS || pairs.filter((p) => p.cost > 0).length < MIN_LIMIT_PAIRS)
    return undefined;
  // delta = share × T3's spend + background × hours. Spend T3 cannot see lands in background,
  // never in the share per dollar.
  const byQuarter = [0, 1, 2, 3].every(
    (q) =>
      pairs.filter((p) => p.quarters[q]! > 0).length >= MIN_QUARTER_PAIRS &&
      pairs.reduce((s, p) => s + p.quarters[q]!, 0) >= MIN_QUARTER_HOURS,
  );
  const fit = nonNegativeFit(
    pairs.map((p) => ({
      x: byQuarter ? [p.cost, ...p.quarters] : [p.cost, p.hours],
      y: p.delta,
      w: p.w,
    })),
  );
  const share = fit?.[0];
  if (!fit || !(share! > 0)) return undefined;
  const quarters = byQuarter ? fit.slice(1) : undefined;
  const totalHours = pairs.reduce((s, p) => s + p.hours, 0);
  const background = quarters
    ? quarters.reduce((s, b, q) => s + b * pairs.reduce((h, p) => h + p.quarters[q]!, 0), 0) /
      totalHours
    : fit[1]!;
  return {
    key: account.key,
    label: account.label,
    driver: account.driver as LearnedLimit["driver"],
    windowId: window.id,
    windowLabel: window.label,
    plan: latestPlan,
    percentPerDollar: share!,
    backgroundPercentPerHour: background,
    ...(quarters ? { backgroundByQuarter: quarters } : {}),
    samples: pairs.length,
    hours: totalHours,
    source: "measured",
  };
}

/**
 * A limit for an account without history: a measured account's share of the same window,
 * scaled by the two plans' published sizes.
 */
export function estimateLimit(
  account: Pick<LearningAccount, "key" | "label" | "driver" | "plan">,
  window: LearningAccount["windows"][number],
  measured: readonly LearnedLimit[],
): LearnedLimit | undefined {
  const size = publishedPlanSize(account.driver, account.plan);
  const source = measured
    .filter(
      (m) =>
        m.source === "measured" &&
        m.driver === account.driver &&
        m.windowId === window.id &&
        publishedPlanSize(m.driver, m.plan) !== null,
    )
    .toSorted((a, b) => b.samples - a.samples)[0];
  if (!source) return undefined;
  const scale = size === null ? 1 : publishedPlanSize(source.driver, source.plan)! / size;
  return {
    key: account.key,
    label: account.label,
    driver: account.driver as LearnedLimit["driver"],
    windowId: window.id,
    windowLabel: window.label,
    plan: account.plan,
    percentPerDollar: source.percentPerDollar * scale,
    backgroundPercentPerHour: 0,
    samples: 0,
    hours: 0,
    source: "estimated",
    basis: `${source.label} × ${scale === 1 ? "1 (plan size unknown)" : scale.toFixed(2)} by plan`,
  };
}

/** Learns every number the choice needs from all computers' history. Pure. */
export function learnAllocation(input: {
  readonly at: string;
  readonly evidence: readonly AllocationEvidence[];
  readonly accounts: readonly LearningAccount[];
  /** Every profile a choice may need a cost for. */
  readonly profiles: readonly Profile[];
  readonly price: PriceOf;
  readonly notes?: readonly string[];
}): AllocationLearned {
  const at = Date.parse(input.at);
  const turns = workingTurns(
    input.evidence.flatMap((e) => e.turns),
    at,
  );
  const readings = input.evidence.flatMap((e) => e.readings);
  const measured = measuredCosts(turns, at);
  const costs = measured.map((m) => m.cost);
  for (const profile of input.profiles)
    for (const kind of ["worker", "master"] as const) {
      if (
        costs.some(
          (c) =>
            c.kind === kind &&
            c.driver === profile.driver &&
            c.model === profile.model &&
            c.effort === profile.effort,
        )
      )
        continue;
      const estimate = estimateCost(profile, kind, measured, input.price);
      if (estimate) costs.push(estimate);
    }
  const limits: LearnedLimit[] = [];
  for (const account of input.accounts)
    for (const window of account.windows) {
      const limit = measuredLimit(account, window, readings, turns, at);
      if (limit) limits.push(limit);
    }
  for (const account of input.accounts)
    for (const window of account.windows) {
      if (limits.some((l) => l.key === account.key && l.windowId === window.id)) continue;
      const estimate = estimateLimit(account, window, limits);
      if (estimate) limits.push(estimate);
    }
  const workerJobs = new Map<string, { start: number; end: number }>();
  for (const { turn, start, end } of turns) {
    if (turn.kind !== "worker") continue;
    const job = workerJobs.get(turn.threadId);
    workerJobs.set(turn.threadId, {
      start: Math.min(job?.start ?? start, start),
      end: Math.max(job?.end ?? end, end),
    });
  }
  const jobHours = [...workerJobs.values()].map((j) => (j.end - j.start) / HOUR);
  return {
    learnedAt: input.at,
    costs: costs.toSorted(
      (a, b) =>
        a.driver.localeCompare(b.driver) ||
        a.model.localeCompare(b.model) ||
        effortRank(a.effort) - effortRank(b.effort) ||
        a.kind.localeCompare(b.kind),
    ),
    limits: limits.toSorted(
      (a, b) => a.label.localeCompare(b.label) || a.windowId.localeCompare(b.windowId),
    ),
    workerHours: jobHours.length >= 3 ? median(jobHours) : null,
    notes: [...(input.notes ?? [])],
  };
}
