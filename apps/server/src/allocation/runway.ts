import {
  publishedPlanSize,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationDemand,
  type AllocationLearned,
  type AllocationWindow,
  type LearnedSource,
  type SessionKind,
} from "@t3tools/contracts";
import { findCatalogModel } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import { estimateLimit, quarterOf } from "./learning.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const effortRank = (effort: string | null) => {
  const index = EFFORTS.indexOf(effort ?? "");
  return index < 0 ? 2 : index;
};
/**
 * Only for an installation that has learned nothing: dollars per working hour, and dollars a
 * window of the smallest paid plan holds (from the first two weeks of measured history).
 */
const SEED_DOLLARS_PER_HOUR: Record<SessionKind, number> = { worker: 8, master: 3 };
const SEED_WINDOW_DOLLARS_PER_PLAN = { session: 13, weekly: 120, scoped: 36, monthly: 500 };
/** Job length when neither the start nor the history gives one. */
export const SEED_JOB_HOURS = 2;

export interface SessionLoad {
  readonly driver: string;
  readonly model: string;
  readonly effort: string | null;
  readonly kind: SessionKind;
  readonly contextTokens?: number | undefined;
}

/** Dollars per working hour of one session, from the learned costs. */
export function costPerHour(learned: AllocationLearned | undefined, session: SessionLoad) {
  const costs = (learned?.costs ?? []).filter(
    (c) => c.driver === session.driver && c.kind === session.kind,
  );
  const exact = costs.find((c) => c.model === session.model && c.effort === session.effort);
  const pick =
    exact ??
    costs
      .filter((c) => c.model === session.model)
      .toSorted(
        (a, b) =>
          Math.abs(effortRank(a.effort) - effortRank(session.effort)) -
          Math.abs(effortRank(b.effort) - effortRank(session.effort)),
      )[0] ??
    costs.toSorted((a, b) => b.hours - a.hours)[0];
  if (!pick)
    return { dollarsPerHour: SEED_DOLLARS_PER_HOUR[session.kind], source: "estimated" as const };
  const context = session.contextTokens ?? pick.contextTokens;
  return {
    dollarsPerHour: Math.max(
      pick.dollarsPerHour * 0.2,
      pick.dollarsPerHour + (pick.perHundredK * (context - pick.contextTokens)) / 100_000,
    ),
    source: exact ? exact.source : ("estimated" as LearnedSource),
  };
}

/** Percent of `window` a dollar uses, and the background use T3 does not see. */
export function limitShare(
  learned: AllocationLearned | undefined,
  account: { key: string; label: string; driver: string; plan: string | null },
  window: Pick<AllocationWindow, "id" | "label" | "kind" | "models">,
) {
  const entry =
    learned?.limits.find((l) => l.key === account.key && l.windowId === window.id) ??
    estimateLimit(account, window, learned?.limits ?? []);
  if (entry)
    return {
      percentPerDollar: entry.percentPerDollar,
      background: (from: number, hours: number) => {
        const quarters = entry.backgroundByQuarter;
        if (!quarters || quarters.length !== 4) return entry.backgroundPercentPerHour * hours;
        let total = 0;
        for (let t = from, end = from + hours * HOUR; t < end;) {
          const next = Math.min(end, (Math.floor(t / (6 * HOUR)) + 1) * 6 * HOUR);
          total += quarters[quarterOf(t)]! * ((next - t) / HOUR);
          t = next;
        }
        return total;
      },
      source: entry.source,
    };
  const size = publishedPlanSize(account.driver, account.plan, window.kind) ?? 1;
  const unit = window.models?.length
    ? SEED_WINDOW_DOLLARS_PER_PLAN.scoped
    : window.kind === "session"
      ? SEED_WINDOW_DOLLARS_PER_PLAN.session
      : window.kind === "monthly"
        ? SEED_WINDOW_DOLLARS_PER_PLAN.monthly
        : SEED_WINDOW_DOLLARS_PER_PLAN.weekly;
  return {
    percentPerDollar: 100 / (unit * size),
    background: () => 0,
    source: "estimated" as const,
  };
}

/**
 * The daily goal applies to weekly windows, account-wide or a model's own, and to an
 * account-wide monthly one; the 5-hour one has none.
 */
export const paced = (w: Pick<AllocationWindow, "kind" | "models">) =>
  w.kind === "weekly" || (w.kind === "monthly" && !w.models?.length);

export interface WindowProjection {
  readonly window: AllocationWindow;
  /** The hard cap, or 100. */
  readonly limit: number;
  readonly used: number;
  readonly resetsAt: number | null;
  /** Use at the job's end or the window's reset, whichever is first; everyone's use included. */
  readonly projected: number;
  readonly fits: boolean;
  /** Use at the job's end, in the next cycle when the window resets first. */
  readonly atEnd: number;
  /** The daily goal's line at the job's end; null without a goal. */
  readonly goal: number | null;
  readonly goalPerDay: number | null;
  /** Points the use at the job's end is below the goal line (negative: above); null without one. */
  readonly slack: number | null;
  /** Hours until this limit runs out at the projected load; null when it resets first. */
  readonly lastsHours: number | null;
}

export interface AccountProjection {
  readonly windows: readonly WindowProjection[];
  readonly fits: boolean;
  /** The smallest slack of a paced window; null when none has a goal line. */
  readonly slack: number | null;
  readonly paceWindow?: WindowProjection;
  /** Points left at the job's end on the tightest limit; null without a reading. */
  readonly leftPoints: number | null;
  readonly tightest?: WindowProjection;
  readonly lastsHours: number | null;
  /** When it does not fit: the reset that clears the limit in its way, null when unknown. */
  readonly fitsFrom?: string | null;
  readonly hours: number;
}

const effortOf = (options: AllocationDemand["options"]) => {
  const value = options.find((o) => o.id === "effort" || o.id === "reasoningEffort")?.value;
  return typeof value === "string" ? value : null;
};
export const demandLoad = (driver: string, d: AllocationDemand): SessionLoad => ({
  driver,
  model: d.model,
  effort: effortOf(d.options),
  kind: d.worker ? "worker" : "master",
  contextTokens: d.contextTokens,
});

/**
 * Every limit on the account projected to the job's end: the working sessions already on the
 * login (any computer), this one, and the background use T3 does not see.
 */
export function projectAccount(input: {
  readonly account: Pick<AllocationAccount, "driver" | "label" | "models" | "windows" | "plan">;
  readonly key: string;
  /** When the session would start. */
  readonly at: number;
  readonly hours: number;
  /** The session being placed; absent to project only the load already there. */
  readonly session?: SessionLoad | undefined;
  readonly load: readonly SessionLoad[];
  readonly learned: AllocationLearned | undefined;
  readonly cap?: AllocationAccountCap | undefined;
  /** Percent of the weekly window per day; null without one. */
  readonly goal: number | null;
}): AccountProjection {
  const { account, at, hours, learned } = input;
  const slug = (model: string) => findCatalogModel(account.models, model)?.slug ?? model;
  const applies = (w: AllocationWindow, model: string) =>
    !w.models || w.models.includes(slug(model));
  const rate = input.session ? costPerHour(learned, input.session).dollarsPerHour : 0;
  const identity = {
    key: input.key,
    label: account.label,
    driver: account.driver,
    plan: account.plan ?? null,
  };
  const windows = account.windows
    .filter((w) => !input.session || applies(w, input.session.model))
    .map((w): WindowProjection => {
      const duration = w.durationHours ?? null;
      let resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : null;
      let used = w.usedPoints;
      let cycleStart = resetsAt !== null && duration !== null ? resetsAt - duration * HOUR : null;
      // A window that has not started (nothing used, no reset) starts with the next use.
      if (resetsAt === null && duration !== null && used === 0) {
        resetsAt = at + duration * HOUR;
        cycleStart = at;
      }
      // A window that resets before the start begins fresh.
      if (resetsAt !== null && resetsAt <= at) {
        used = 0;
        cycleStart = resetsAt;
        resetsAt = duration !== null ? resetsAt + duration * HOUR : null;
      }
      const capPercent =
        w.id === "five_hour"
          ? input.cap?.fiveHourPercent
          : w.kind === "weekly" && !w.models?.length
            ? input.cap?.weeklyPercent
            : null;
      const limit = Math.min(100, capPercent ?? 100);
      const share = limitShare(learned, identity, w);
      const dollars =
        input.load
          .filter((s) => applies(w, s.model))
          .reduce((sum, s) => sum + costPerHour(learned, s).dollarsPerHour, 0) + rate;
      const reset = resetsAt === null ? null : (resetsAt - at) / HOUR;
      const span = reset === null ? hours : Math.min(hours, reset);
      const projected = used + share.percentPerDollar * dollars * span + share.background(at, span);
      const fits = projected <= limit + 1e-9;
      // After the job: what is left of this cycle, or of the next one when it resets first.
      const resetsFirst = reset !== null && reset < hours;
      const after = resetsFirst
        ? share.percentPerDollar * dollars * (hours - reset) +
          share.background(resetsAt!, hours - reset)
        : projected;
      const goalBudget =
        input.goal !== null && paced(w) && cycleStart !== null
          ? Math.min(
              limit,
              input.goal *
                ((resetsFirst ? at + hours * HOUR - resetsAt! : at + span * HOUR - cycleStart) /
                  DAY),
            )
          : null;
      const burn = share.percentPerDollar * dollars + share.background(at, 1);
      const runsOut = burn > 0 ? Math.max(0, limit - used) / burn : null;
      return {
        window: w,
        limit,
        used,
        resetsAt,
        projected,
        fits,
        atEnd: after,
        goal: goalBudget,
        goalPerDay: goalBudget === null ? null : input.goal,
        // The goal is measured against the meter's total, everyone's use included.
        slack: goalBudget === null ? null : goalBudget - after,
        lastsHours: runsOut === null || (reset !== null && runsOut >= reset) ? null : runsOut,
      };
    });
  const paceWindow = windows
    .filter((w) => w.slack !== null)
    .toSorted((a, b) => a.slack! - b.slack!)[0];
  const tightest = windows.toSorted((a, b) => a.limit - a.atEnd - (b.limit - b.atEnd))[0];
  const failing = windows.filter((w) => !w.fits);
  const lasts = windows.flatMap((w) => (w.lastsHours === null ? [] : [w.lastsHours]));
  return {
    windows,
    fits: failing.length === 0,
    slack: paceWindow?.slack ?? null,
    ...(paceWindow ? { paceWindow } : {}),
    leftPoints: tightest ? tightest.limit - tightest.atEnd : null,
    ...(tightest ? { tightest } : {}),
    lastsHours: lasts.length ? Math.min(...lasts) : null,
    ...(failing.length
      ? {
          fitsFrom: failing.some((w) => w.resetsAt === null)
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(Math.max(...failing.map((w) => w.resetsAt!)))),
        }
      : {}),
    hours,
  };
}

export const span = (hours: number) =>
  hours >= 48
    ? `${Math.round(hours / 24)}d`
    : hours >= 1
      ? `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`
      : `${Math.max(1, Math.round(hours * 60))}m`;

/** Where an account stands against its daily goal, or on its tightest limit without one. */
export const standing = (slack: number | null, leftPoints: number | null) =>
  slack !== null
    ? `${Math.round(Math.abs(slack))} points ${slack < 0 ? "ahead of" : "behind"} its goal`
    : leftPoints !== null
      ? `no goal line, ${Math.round(leftPoints)}% left`
      : "no usage reading";

/** The projection in words, without the account's name. */
export function runwayText(p: AccountProjection, at: number): string {
  const resetIn = (w: WindowProjection) =>
    w.resetsAt === null ? "" : ` in ${span((w.resetsAt - at) / HOUR)}`;
  const cap = (w: WindowProjection) => (w.limit < 100 ? `, hard cap ${w.limit}%` : "");
  if (!p.fits) {
    const out = p.windows
      .filter((w) => !w.fits)
      .toSorted((a, b) => (a.lastsHours ?? Infinity) - (b.lastsHours ?? Infinity))[0]!;
    return `${out.window.label} runs out ${
      out.lastsHours === null ? "before the job ends" : `in about ${span(out.lastsHours)}`
    }, before this ${span(p.hours)} job ends (${Math.round(out.used)}% used${cap(out)}, resets${
      resetIn(out) || " at an unknown time"
    })`;
  }
  const w = p.paceWindow ?? p.tightest;
  if (!w) return standing(null, null);
  const resetsFirst = w.resetsAt !== null && w.resetsAt < at + p.hours * HOUR;
  return `${standing(p.slack, p.leftPoints)} (${w.window.label} ${Math.round(w.used)}% used${
    resetsFirst ? `, resets${resetIn(w)}` : ""
  }, ${Math.round(w.atEnd)}% by the job's end${
    w.goal === null ? "" : ` against a goal of ${Math.round(w.goal)}%`
  }${cap(w)})`;
}
