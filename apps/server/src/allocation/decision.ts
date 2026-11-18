import {
  allocationFableWindow,
  allocationFamilyGoal,
  allocationPreferenceKey,
  DEFAULT_CLOSE_MARGIN_POINTS,
  legacyAllocationCandidateFields,
  profileLabel,
  WORKER_ACCOUNT_DISABLED_REASON,
} from "@t3tools/contracts";
import type {
  AccountRunway,
  AllocationAccount,
  AllocationAccountCap,
  AllocationCandidate,
  AllocationDecision,
  AllocationDemand,
  AllocationInventory,
  AllocationLearned,
  AllocationPolicy,
  AllocationRequest,
  AllocationReservation,
  AllocationWindow,
} from "@t3tools/contracts";
import { findCatalogModel } from "@t3tools/shared/model";
import {
  demandLoad,
  limitShare,
  paced,
  projectAccount,
  runwayText,
  SEED_JOB_HOURS,
  span,
  standing,
  type AccountProjection,
} from "./runway.ts";

const HOUR = 3_600_000;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compatible(account: AllocationAccount, request: AllocationRequest) {
  const model = findCatalogModel(account.models, request.model);
  if (!model) return false;
  return request.options.every((option) => {
    const descriptor = model.capabilities?.optionDescriptors?.find((d) => d.id === option.id);
    return descriptor?.type === "boolean"
      ? typeof option.value === "boolean"
      : descriptor?.type === "select" && descriptor.options.some((c) => c.id === option.value);
  });
}

function activeDemand(
  inventories: readonly AllocationInventory[],
  reservations: readonly AllocationReservation[],
  at: string,
  maxReadingAgeMinutes: number,
): AllocationDemand[] {
  const keyFor = (d: { environmentId: string; threadId: string }) =>
    JSON.stringify([d.environmentId, d.threadId]);
  const bySession = new Map<string, AllocationDemand>();
  for (const host of [...inventories].sort((a, b) => compare(b.observedAt, a.observedAt)))
    for (const d of host.demand) if (!bySession.has(keyFor(d))) bySession.set(keyFor(d), d);
  for (const reservation of reservations) {
    if (
      reservation.state !== "starting" &&
      reservation.state !== "consumed" &&
      !(reservation.state === "reserved" && reservation.expiresAt > at)
    )
      continue;
    const request = reservation.request;
    const key = keyFor(request);
    if (bySession.has(key)) continue;
    // A fresh complete snapshot confirms that a consumed session is now idle.
    // Missing/stale hosts cannot release this accounting on their own.
    const observedIdle = inventories.some(
      (host) =>
        host.environmentId === request.environmentId &&
        host.complete &&
        host.observedAt >= reservation.createdAt &&
        host.observedAt <= at &&
        Date.parse(at) - Date.parse(host.observedAt) <= maxReadingAgeMinutes * 60_000,
    );
    if (reservation.state === "consumed" && observedIdle) continue;
    bySession.set(key, {
      environmentId: request.environmentId,
      threadId: request.threadId,
      instanceId: reservation.instanceId,
      accountKey: reservation.accountKey,
      model: request.model,
      options: request.options,
      state: reservation.state === "consumed" ? "uncertain" : "pending",
      ...(request.kind !== "session" ? { worker: true } : {}),
    });
  }
  return [...bySession.values()];
}

/** Sessions other than `self` that draw on this account identity. */
const accountDemand = (
  account: Pick<AllocationAccount, "accountKey" | "environmentId" | "instanceId">,
  demand: readonly AllocationDemand[],
  self: { environmentId: string; threadId: string },
) =>
  demand.filter(
    (d) =>
      (account.accountKey !== null
        ? d.accountKey === account.accountKey
        : d.environmentId === account.environmentId && d.instanceId === account.instanceId) &&
      !(d.threadId === self.threadId && d.environmentId === self.environmentId),
  );

/**
 * One login is one allowance, whatever computer reports it: each window's newest observation,
 * the more used one when two are equally new, and every computer's limit rejections.
 */
function sharedReadings(account: AllocationAccount, all: readonly AllocationAccount[]) {
  const siblings = account.accountKey
    ? all.filter((a) => a.accountKey === account.accountKey)
    : [account];
  const byId = new Map<string, AllocationWindow>();
  for (const sibling of siblings)
    for (const w of sibling.windows) {
      const old = byId.get(w.id);
      if (
        !old ||
        w.checkedAt > old.checkedAt ||
        (w.checkedAt === old.checkedAt && w.usedPoints > old.usedPoints)
      )
        byId.set(w.id, w);
    }
  return {
    windows: [...byId.values()].sort((a, b) => compare(a.id, b.id)),
    limits: siblings.flatMap(
      (a) => a.limits ?? (a.limitedUntil ? [{ windowId: null, until: a.limitedUntil }] : []),
    ),
  };
}

export interface AccountRoom {
  /** Absent: not drained. Null: drained with no known reset. */
  readonly drainedUntil?: string | null;
  /** Percentage points left on the tightest applicable window; null without a reading. */
  readonly roomPoints: number | null;
  readonly resetInHours: number | null;
  /** The numbers in words, without the account's name. */
  readonly text: string;
}

/**
 * How much of this account is left for `model`. Drained means only this: a usage window that
 * applies to the model is used up (to its hard cap, when `cap` sets one), or a provider limit
 * rejection for it is still in force. A window whose reset has passed says nothing any more.
 */
export function accountRoom(input: {
  readonly account: Pick<AllocationAccount, "models" | "windows" | "limitedUntil"> & {
    readonly limits?: AllocationAccount["limits"] | undefined;
  };
  readonly model: string;
  readonly cap?: AllocationAccountCap | undefined;
  readonly at: string;
}): AccountRoom {
  const { account, cap, at } = input;
  const now = Date.parse(at);
  const model = findCatalogModel(account.models, input.model)?.slug ?? input.model;
  const applies = (w: AllocationWindow) => !w.models || w.models.includes(model);
  const readings = account.windows
    .filter((w) => applies(w) && !(w.resetsAt && Date.parse(w.resetsAt) <= now))
    .map((w) => {
      const capPercent =
        w.id === "five_hour"
          ? cap?.fiveHourPercent
          : w.kind === "weekly" && !w.models?.length
            ? cap?.weeklyPercent
            : null;
      const limit = Math.min(100, capPercent ?? 100);
      return { w, limit, left: limit - w.usedPoints };
    })
    .sort((a, b) => a.left - b.left);
  const rejections = (
    account.limits ??
    (account.limitedUntil ? [{ windowId: null, until: account.limitedUntil }] : [])
  ).filter((limit) => {
    if (Date.parse(limit.until) <= now) return false;
    const window = account.windows.find((w) => w.id === limit.windowId);
    return !window || applies(window);
  });
  const tightest = readings[0];
  const closed = readings.filter((r) => r.left <= 0);
  const resetInHours = tightest?.w.resetsAt ? (Date.parse(tightest.w.resetsAt) - now) / HOUR : null;
  if (closed.length || rejections.length) {
    const resets = [...closed.map((r) => r.w.resetsAt), ...rejections.map((r) => r.until)];
    const drainedUntil = resets.some((reset) => reset === null)
      ? null
      : (resets
          .filter((reset) => reset !== null)
          .sort()
          .at(-1) ?? null);
    const first = closed[0];
    const rejected = account.windows.find(
      (w) => w.id === (rejections.find((r) => r.until === drainedUntil) ?? rejections[0])?.windowId,
    );
    return {
      drainedUntil,
      roomPoints: 0,
      resetInHours,
      text: `drained until ${drainedUntil ?? "an unknown time"} (${
        first
          ? first.limit < 100
            ? `${first.w.label} ${first.w.usedPoints}% used, hard cap ${first.limit}%`
            : `${first.w.label} ${first.w.usedPoints}% used`
          : `provider limit rejection${rejected ? ` on ${rejected.label}` : ""}`
      })`,
    };
  }
  if (!tightest) return { roomPoints: null, resetInHours: null, text: "no usage reading" };
  return {
    roomPoints: tightest.left,
    resetInHours,
    text: `${tightest.w.label} ${Math.round(tightest.left)}% left${
      tightest.limit < 100 ? ` below its ${tightest.limit}% cap` : ""
    }${resetInHours === null ? "" : `, resets in ${span(resetInHours)}`}`,
  };
}

/** The account's hard cap, when it stops this kind of session. */
export const accountCap = (
  policy: AllocationPolicy,
  account: Pick<AllocationAccount, "driver" | "accountKey" | "environmentId" | "instanceId">,
  kind: AllocationRequest["kind"],
) =>
  policy.accountCaps?.find(
    (cap) =>
      cap.key === allocationPreferenceKey(account) &&
      (kind === "session" ? cap.stopMasters : cap.stopWorkers),
  );

const preferenceIndex = (policy: AllocationPolicy, driver: string) => (candidate: Ranked) => {
  const index = (policy.accountOrder ?? []).indexOf(
    allocationPreferenceKey({ ...candidate, driver: candidate.driver ?? driver }),
  );
  return index < 0 ? Infinity : index;
};

/** Percent of the weekly window this account should use per day, and whose value it is. */
export function accountGoal(
  policy: AllocationPolicy,
  account: Pick<AllocationAccount, "driver" | "accountKey" | "environmentId" | "instanceId">,
): { percentPerDay: number; from: "account" | "family" } | null {
  const own = policy.accountGoals?.find((g) => g.key === allocationPreferenceKey(account));
  if (own) return { percentPerDay: own.percentPerDay, from: "account" };
  const family = allocationFamilyGoal(policy, account.driver);
  return family === null ? null : { percentPerDay: family, from: "family" };
}

/** Percent of the Fable weekly window this account should use per day; null without one. */
export const accountFableGoal = (
  policy: AllocationPolicy,
  account: Pick<AllocationAccount, "driver" | "accountKey" | "environmentId" | "instanceId">,
) =>
  policy.fableGoals?.find((g) => g.key === allocationPreferenceKey(account))?.percentPerDay ?? null;

/**
 * A candidate with the points left on its tightest limit at the job's end and, with a Fable
 * goal, the points its Fable window ends behind that line (negative: ahead), kept internal.
 */
type Ranked = AllocationCandidate & {
  readonly leftPoints?: number | null;
  readonly fableSlack?: number;
  /** The account's provider family, when it is not the request's. */
  readonly driver?: string;
};

/** 0: fits, with a goal line; 1: fits, without one; 2: a limit runs out before the end. */
const group = (c: AllocationCandidate) =>
  c.fits === false ? 2 : c.goalSlackPoints === undefined ? 1 : 0;

/** Points behind the goal line, points left without one, hours it lasts when it does not fit. */
const score = (c: Ranked) =>
  group(c) === 0
    ? c.goalSlackPoints!
    : group(c) === 1
      ? (c.leftPoints ?? -Infinity)
      : (c.lastsHours ?? 0);

/**
 * Usable accounts, best first. Accounts that fit and have a goal line lead, the furthest behind
 * their daily goal first, in points of their tightest paced window at the job's end (negative
 * when ahead). Then accounts that fit without a goal line, by the points left on their tightest
 * limit; one without a reading comes last of them. In either group, accounts within the
 * policy's margin (points) of the best are close, but never across the goal line: one ahead of
 * its goal is never close to one behind it. The preference order decides between close
 * accounts, then fewer workers, then the sooner reset. Last, accounts where a limit runs out
 * before the job ends, the longest lasting first.
 */
export function rankCandidates(
  candidates: readonly Ranked[],
  policy: AllocationPolicy,
  driver: string,
) {
  const usable = candidates.filter((c) => c.eligible);
  const margin = policy.closeMarginPoints ?? DEFAULT_CLOSE_MARGIN_POINTS;
  const best = [0, 1].map((g) => Math.max(...usable.filter((c) => group(c) === g).map(score)));
  const close = (c: Ranked) =>
    group(c) < 2 &&
    score(c) >= best[group(c)]! - margin &&
    (group(c) === 1 || score(c) < 0 === best[0]! < 0);
  const preference = preferenceIndex(policy, driver);
  return usable.toSorted(
    (a, b) =>
      group(a) - group(b) ||
      Number(close(b)) - Number(close(a)) ||
      (close(a) && close(b)
        ? preference(a) - preference(b) ||
          (a.workers ?? 0) - (b.workers ?? 0) ||
          (a.resetInHours ?? Infinity) - (b.resetInHours ?? Infinity)
        : 0) ||
      score(b) - score(a) ||
      compare(a.label ?? "", b.label ?? "") ||
      compare(a.instanceId, b.instanceId),
  );
}

const effortOf = (request: AllocationRequest) => {
  const value = request.options.find((o) => o.id === "effort" || o.id === "reasoningEffort")?.value;
  return typeof value === "string" ? value : null;
};

/** The same model and options. */
const sameProfile = (a: AllocationRequest, b: AllocationRequest) =>
  a.driver === b.driver &&
  a.model === b.model &&
  JSON.stringify(a.options) === JSON.stringify(b.options);

/** Pure replay boundary. Callers persist the exact policy, inventories and timestamp. */
export function decideAllocation(input: {
  at: string;
  policy: AllocationPolicy;
  request: AllocationRequest;
  /**
   * Accounts in Fable mode and what they run in place of `request`, or null when they are out.
   * Each account is judged on what it would run. The decision's request is then the selected
   * account's, kept to the accounts that run it, so admission chooses among the same accounts.
   */
  fableMode?:
    | { readonly instanceIds: readonly string[]; readonly request: AllocationRequest | null }
    | undefined;
  /**
   * The requests of other provider families. An account of one of them is a candidate too,
   * judged on its family's request, and every line then names what its account would run.
   */
  others?: readonly AllocationRequest[] | undefined;
  inventories: readonly AllocationInventory[];
  reservations: readonly AllocationReservation[];
  authorityAvailable: boolean;
  learned?: AllocationLearned | undefined;
}): AllocationDecision {
  return judge(input).decision;
}

/**
 * Where each usable account with a Fable goal would stand against it running `request`, a Fable
 * rung: the points its Fable window ends the job behind the line (negative: ahead), and whether
 * the rung fits there (not drained, lasting the job).
 */
export const fableGoalStandings = (input: Parameters<typeof decideAllocation>[0]) =>
  judge(input).candidates.flatMap((c) =>
    c.fableSlack === undefined || c.reasons.length
      ? []
      : [
          {
            instanceId: c.instanceId,
            label: c.label,
            slack: c.fableSlack,
            fits: c.eligible && c.fits !== false,
          },
        ],
  );

/** The decision, and every candidate with the numbers it was ranked on. */
function judge(input: Parameters<typeof decideAllocation>[0]) {
  const { policy, request, inventories } = input;
  // A queued start is judged as of when it begins.
  const at = request.startAt && request.startAt > input.at ? request.startAt : input.at;
  const globalReasons: string[] = [];
  if (new Set(request.options.map((o) => o.id)).size !== request.options.length)
    globalReasons.push("Duplicate option IDs are ambiguous; supply each requested option once.");
  if (!inventories.some((i) => i.environmentId === request.environmentId))
    globalReasons.push("Execution environment unavailable.");
  const demand = activeDemand(
    inventories,
    input.reservations,
    input.at,
    policy.maxReadingAgeMinutes,
  );
  const everyAccount = inventories.flatMap((i) => i.accounts);
  const kind = request.kind === "session" ? ("master" as const) : ("worker" as const);
  const hours = request.expectedHours ?? input.learned?.workerHours ?? SEED_JOB_HOURS;
  const projections = new Map<string, AccountProjection>();
  /** What each account runs; null when it is out. */
  const runs = new Map<string, AllocationRequest | null>();
  const mixed = !!input.others?.length;
  const familyRequest = (driver: string) =>
    driver === request.driver ? request : input.others?.find((o) => o.driver === driver);
  const candidates = everyAccount
    .filter((a) => a.environmentId === request.environmentId && familyRequest(a.driver))
    .map((local) => {
      const account = { ...local, ...sharedReadings(local, everyAccount) };
      const reasons: string[] = [];
      const fable = input.fableMode?.instanceIds.includes(account.instanceId) === true;
      const own = fable ? input.fableMode!.request : familyRequest(account.driver)!;
      if (own === null) reasons.push("Fable mode: no Fable rung takes this place.");
      const run = own ?? request;
      const tags = [
        ...(fable ? ["Fable mode"] : []),
        ...(mixed ? [profileLabel(run.driver, run.model, run.options)] : []),
      ];
      runs.set(account.instanceId, own);
      if (account.enabled === false) reasons.push("Provider is turned off in settings.");
      if (request.kind !== "session" && account.availableForWorkers === false)
        reasons.push(WORKER_ACCOUNT_DISABLED_REASON);
      if (request.explicitInstanceId && account.instanceId !== request.explicitInstanceId)
        reasons.push("Explicit account selection.");
      if (request.nativeInstanceId && account.instanceId !== request.nativeInstanceId)
        reasons.push("Native session is bound to another account.");
      if (request.allowedInstanceIds && !request.allowedInstanceIds.includes(account.instanceId))
        reasons.push("Outside allowed accounts.");
      if (!compatible(account, run)) reasons.push("Exact model/options are not supported.");
      const cap = accountCap(policy, account, request.kind);
      const room = accountRoom({ account, model: run.model, cap, at });
      const others = accountDemand(account, demand, request);
      const workers = others.filter((d) => d.worker).length;
      const goal = accountGoal(policy, account);
      const projection = projectAccount({
        account,
        key: allocationPreferenceKey(account),
        at: Date.parse(at),
        hours,
        session: {
          driver: run.driver,
          model: run.model,
          effort: effortOf(run),
          kind,
          contextTokens: request.contextTokens,
        },
        load: others.map((d) => demandLoad(account.driver, d)),
        learned: input.learned,
        cap,
        goal: goal?.percentPerDay ?? null,
        fableGoal: accountFableGoal(policy, account),
      });
      projections.set(`${account.environmentId}:${account.instanceId}`, projection);
      const fableLine = projection.windows.find((w) => w.fableGoal);
      const usable = reasons.length === 0 && globalReasons.length === 0;
      const known = projection.windows.length > 0;
      return {
        environmentId: account.environmentId,
        instanceId: account.instanceId,
        accountKey: account.accountKey,
        label: account.label,
        eligible: usable && room.drainedUntil === undefined,
        reasons,
        ...(room.drainedUntil === undefined ? {} : { drainedUntil: room.drainedUntil }),
        roomPoints: room.roomPoints,
        resetInHours: room.resetInHours,
        workers,
        ...(known
          ? {
              fits: projection.fits,
              lastsHours: projection.lastsHours,
              ...(projection.slack === null ? {} : { goalSlackPoints: projection.slack }),
              ...(projection.fitsFrom === undefined ? {} : { fitsFrom: projection.fitsFrom }),
            }
          : {}),
        leftPoints: projection.leftPoints,
        ...(fableLine ? { fableSlack: fableLine.slack! } : {}),
        driver: account.driver,
        line: `${account.label}${tags.length ? ` (${tags.join(", ")})` : ""}: ${
          reasons.length
            ? `not usable (${reasons.join(" ")})`
            : room.drainedUntil !== undefined
              ? room.text
              : runwayText(projection, Date.parse(at))
        }, ${workers} worker${workers === 1 ? "" : "s"}`,
        ...legacyAllocationCandidateFields,
      };
    })
    .sort((a, b) => compare(a.label, b.label) || compare(a.instanceId, b.instanceId));
  const ranked = rankCandidates(candidates, policy, request.driver);
  const selected = ranked[0];
  const chosen = selected ? runs.get(selected.instanceId)! : request;
  const runsChosen = (c: AllocationCandidate) => {
    const run = runs.get(c.instanceId);
    return !!run && sameProfile(run, chosen);
  };
  // Accounts that run something else are no part of the chosen request.
  const decided = !selected
    ? request
    : candidates.every(runsChosen)
      ? sameProfile(chosen, request)
        ? request
        : chosen
      : {
          ...chosen,
          allowedInstanceIds: candidates
            .filter(
              (c) =>
                runsChosen(c) &&
                (!request.allowedInstanceIds || request.allowedInstanceIds.includes(c.instanceId)),
            )
            .map((c) => c.instanceId),
        };
  // The ranking is stable, so the selected account is the best when none scores higher.
  const best =
    selected &&
    ranked.filter((c) => group(c) === group(selected)).toSorted((a, b) => score(b) - score(a))[0];
  const preference = preferenceIndex(policy, request.driver);
  // Usable apart from being drained: these decide between "wait" and "unavailable".
  const drained = candidates.filter((c) => !c.reasons.length && c.drainedUntil !== undefined);
  const resets = drained.flatMap((c) => (c.drainedUntil ? [c.drainedUntil] : [])).sort();
  const reason = (() => {
    if (selected) {
      if (request.explicitInstanceId) return `${selected.line}; pinned account.`;
      if (ranked.length === 1) return `${selected.line}; the only account that is not out.`;
      if (group(selected) === 2)
        return `${selected.line}; no account lasts the whole job, this one lasts longest.`;
      if (!best || selected === best)
        return `${selected.line}; ${
          group(selected) === 1
            ? "no account that fits has a goal line; most left"
            : selected.goalSlackPoints! < 0
              ? "least ahead of its goal"
              : "furthest behind its goal"
        } of ${ranked.length} accounts.`;
      return `${selected.line}; within ${
        policy.closeMarginPoints ?? DEFAULT_CLOSE_MARGIN_POINTS
      } points of ${best.label} (${standing(best.goalSlackPoints ?? null, best.leftPoints ?? null)}) and ${
        preference(selected) < preference(best)
          ? "earlier in the preference order"
          : (selected.workers ?? 0) < (best.workers ?? 0)
            ? "has fewer workers"
            : "resets sooner"
      }.`;
    }
    if (globalReasons.length || !drained.length) return undefined;
    const models = mixed
      ? [...new Set(drained.map((c) => runs.get(c.instanceId)?.model ?? request.model))]
      : [request.model];
    return request.explicitInstanceId
      ? `${drained[0]!.line}; a pinned account is exact.`
      : `${models.join(" and ")} ${models.length > 1 ? "are" : "is"} drained on every account; earliest reset ${resets[0] ?? "unknown"}.`;
  })();
  const decision: AllocationDecision = {
    at: input.at,
    policyVersion: policy.version,
    request: decided,
    outcome: selected ? "selected" : reason ? "wait" : "unavailable",
    selectedInstanceId: selected?.instanceId ?? null,
    candidates: candidates.map(
      ({ leftPoints: _leftPoints, fableSlack: _fableSlack, driver: _driver, ...candidate }) =>
        candidate,
    ),
    confidence: "medium",
    reasons: reason
      ? [reason]
      : [
          ...globalReasons,
          ...(request.explicitInstanceId
            ? (candidates.find((c) => c.instanceId === request.explicitInstanceId)?.reasons ?? [])
            : []),
          "No account matches the requested profile, host and identity constraints.",
        ],
    waitUntil: selected || !reason ? null : (resets[0] ?? null),
  };
  return { decision, candidates };
}

/**
 * Each login once, for the accounts table: what its meters say, its daily goal's budget now,
 * how many dollars each window holds, and how long it lasts at the current load.
 */
export function accountRunways(input: {
  at: string;
  policy: AllocationPolicy;
  inventories: readonly AllocationInventory[];
  learned: AllocationLearned | undefined;
}): AccountRunway[] {
  const everyAccount = input.inventories.flatMap((i) => i.accounts);
  const demand = input.inventories.flatMap((i) => i.demand);
  const now = Date.parse(input.at);
  const logins = new Map<string, AllocationAccount>();
  for (const account of everyAccount)
    if (!logins.has(allocationPreferenceKey(account)))
      logins.set(allocationPreferenceKey(account), account);
  return [...logins].map(([key, local]) => {
    const account = { ...local, ...sharedReadings(local, everyAccount) };
    const load = demand
      .filter((d) =>
        account.accountKey !== null
          ? d.accountKey === account.accountKey
          : d.environmentId === account.environmentId && d.instanceId === account.instanceId,
      )
      .map((d) => demandLoad(account.driver, d));
    const goal = accountGoal(input.policy, account);
    const fableGoal = accountFableGoal(input.policy, account);
    const projection = projectAccount({
      account,
      key,
      at: now,
      hours: 0,
      load,
      learned: input.learned,
      cap: accountCap(input.policy, account, "worker"),
      goal: goal?.percentPerDay ?? null,
      fableGoal,
    });
    const identity = {
      key,
      label: account.label,
      driver: account.driver,
      plan: account.plan ?? null,
    };
    const windows = account.windows.map((w) => {
      const share = projection.windows.find((p) => p.window.id === w.id);
      const learnedShare = limitShare(input.learned, identity, w);
      const cycleStart = w.cycleStartedAt ? Date.parse(w.cycleStartedAt) : null;
      const perDay =
        allocationFableWindow(w) && fableGoal !== null ? fableGoal : (goal?.percentPerDay ?? null);
      return {
        id: w.id,
        label: w.label,
        meterPercent: w.usedPoints,
        goalPercent:
          perDay !== null && paced(w) && cycleStart !== null
            ? Math.min(share?.limit ?? 100, (perDay * (now - cycleStart)) / 86_400_000)
            : null,
        sizeDollars: 100 / learnedShare.percentPerDollar,
        source: learnedShare.source,
      };
    });
    const sessions = load.length;
    const first = projection.windows.find((w) => w.lastsHours === projection.lastsHours);
    // An account-wide limit first: a model's own limit leaves the other models usable.
    const usedUp = projection.windows
      .filter((w) => w.used >= w.limit)
      .toSorted((a, b) => Number(!!a.window.models?.length) - Number(!!b.window.models?.length))[0];
    const runsOut = projection.lastsHours === null ? undefined : first;
    return {
      key,
      label: account.label,
      // A hard cap below the provider's limit is what stops the account: say so.
      line: !account.windows.length
        ? "No usage reading."
        : usedUp
          ? `${usedUp.window.label} ${
              usedUp.limit < 100 ? `reached its ${usedUp.limit}% hard cap` : "is used up"
            }${
              usedUp.resetsAt === null
                ? ""
                : `; it resets in about ${span((usedUp.resetsAt - now) / 3_600_000)}`
            }.`
          : `${
              projection.lastsHours === null || !runsOut
                ? "No limit runs out before its reset"
                : `${runsOut.window.label} ${
                    runsOut.limit < 100 ? `reaches its ${runsOut.limit}% hard cap` : "runs out"
                  } in about ${span(projection.lastsHours)}`
            } at the current load (${sessions} working session${sessions === 1 ? "" : "s"}).`,
      tight: account.windows.length > 0 && (usedUp !== undefined || runsOut !== undefined),
      windows,
    };
  });
}
