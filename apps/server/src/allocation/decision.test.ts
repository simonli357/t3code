import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  allocationPreferenceKey,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationAccount,
  type AllocationDemand,
  type AllocationLearned,
  type AllocationInventory,
  type AllocationPolicy,
  type AllocationRequest,
  type AllocationReservation,
  type AllocationWindow,
} from "@t3tools/contracts";
import { accountRoom, decideAllocation } from "./decision.ts";
import { costPerHour } from "./runway.ts";

const at = "2026-10-23T12:00:00.000Z";
const inHours = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + hours * 3_600_000));
const codex = ProviderDriverKind.make("codex");
const weekly = (usedPoints: number, patch: Partial<AllocationWindow> = {}): AllocationWindow => ({
  id: "weekly",
  label: "Weekly",
  kind: "weekly",
  usedPoints,
  checkedAt: at,
  resetsAt: inHours(100),
  cycleStartedAt: null,
  durationHours: 168,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
  ...patch,
});
const fiveHour = (usedPoints: number, patch: Partial<AllocationWindow> = {}) =>
  weekly(usedPoints, {
    id: "five_hour",
    label: "5-hour",
    kind: "session",
    durationHours: 5,
    resetsAt: inHours(2),
    ...patch,
  });
const model = (slug: string) => ({
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
      },
    ],
  },
});
/** An account with one weekly window `used` percent full, unless `patch` says otherwise. */
const account = (
  id: string,
  used = 10,
  patch: Partial<AllocationAccount> = {},
): AllocationAccount => ({
  environmentId: "host",
  instanceId: ProviderInstanceId.make(id),
  driver: codex,
  accountKey: id,
  label: id,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [model("astra"), model("sol")],
  shortWindow: "known-absent",
  windows: [weekly(used)],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  ...patch,
});
const request: AllocationRequest = {
  assignmentId: "job",
  environmentId: "host",
  threadId: ThreadId.make("thread"),
  driver: codex,
  model: "astra",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const inventory = (
  accounts: AllocationAccount[],
  patch: Partial<AllocationInventory> = {},
): AllocationInventory => ({
  environmentId: "host",
  observedAt: at,
  complete: true,
  demand: [],
  accounts,
  notices: [],
  ...patch,
});
const key = (id: string) => allocationPreferenceKey(account(id));
/**
 * A worker on astra / high costs $10 an hour, a master $4. A weekly window holds $10,000 of use
 * (0.01% a dollar) and a 5-hour window $100, unless `limits` says otherwise for an account.
 */
const learned = (
  limits: Record<string, { weekly?: number; five?: number; background?: number }> = {},
): AllocationLearned => ({
  learnedAt: at,
  workerHours: 2,
  notes: [],
  costs: (["worker", "master"] as const).map((kind) => ({
    driver: codex,
    model: "astra",
    effort: "high",
    kind,
    dollarsPerHour: kind === "worker" ? 10 : 4,
    perHundredK: kind === "worker" ? 5 : 2,
    contextTokens: 100_000,
    samples: 50,
    hours: 20,
    source: "measured" as const,
  })),
  limits: ["a", "b", "c", "login"].flatMap((id) =>
    (["weekly", "five_hour"] as const).map((windowId) => ({
      key: key(id),
      label: id,
      driver: codex,
      windowId,
      windowLabel: windowId,
      plan: null,
      percentPerDollar:
        windowId === "weekly" ? (limits[id]?.weekly ?? 0.01) : (limits[id]?.five ?? 1),
      backgroundPercentPerHour: windowId === "weekly" ? (limits[id]?.background ?? 0) : 0,
      samples: 40,
      hours: 100,
      source: "measured" as const,
    })),
  ),
});
/** No family goals unless a test sets them, so ranking is by spare capacity alone. */
const noGoals = { claude: undefined, codex: undefined, other: undefined };
const decide = (
  accounts: AllocationAccount[],
  patch: {
    policy?: Partial<AllocationPolicy>;
    request?: Partial<AllocationRequest>;
    demand?: AllocationDemand[];
    reservations?: AllocationReservation[];
    inventories?: AllocationInventory[];
    learned?: AllocationLearned;
  } = {},
) =>
  decideAllocation({
    at,
    policy: { ...defaultAllocationPolicy, ...noGoals, ...patch.policy },
    request: { ...request, ...patch.request },
    inventories: patch.inventories ?? [inventory(accounts, { demand: patch.demand ?? [] })],
    reservations: patch.reservations ?? [],
    authorityAvailable: true,
    learned: patch.learned ?? learned(),
  });
const worker = (accountId: string, thread: string): AllocationDemand => ({
  environmentId: "host",
  threadId: ThreadId.make(thread),
  instanceId: ProviderInstanceId.make(accountId),
  accountKey: accountId,
  model: "astra",
  options: request.options,
  state: "running",
  worker: true,
});
const candidate = (decision: ReturnType<typeof decide>, id: string) =>
  decision.candidates.find((c) => c.instanceId === id)!;

describe("room", () => {
  it("is the points left on the tightest window that applies to the model", () => {
    const a = account("a", 0, { windows: [weekly(30), fiveHour(80)] });
    expect(accountRoom({ account: a, model: "astra", at })).toMatchObject({
      roomPoints: 20,
      resetInHours: 2,
    });
    expect(accountRoom({ account: a, model: "astra", at }).drainedUntil).toBeUndefined();
    const decision = decide([a]);
    expect(candidate(decision, "a")).toMatchObject({ eligible: true, roomPoints: 20, workers: 0 });
    // $10 an hour for 2 hours on a 5-hour window that holds $100 is 20 points: exactly full.
    expect(candidate(decision, "a").line).toBe(
      "a: room for less than one more astra / high worker until the 5-hour reset in 2h 0m; tightest limit 5-hour, 0 workers",
    );
  });

  it("sends the worker to the account with the most room and says so in one line", () => {
    const decision = decide([account("a", 60), account("b", 20), account("c", 45)]);
    expect(decision).toMatchObject({ outcome: "selected", selectedInstanceId: "b" });
    // 79.8 points left after the job, at $100 a point, over the 98 hours to the reset: $81 an
    // hour, room for about 8 more $10-an-hour workers.
    expect(decision.reasons).toEqual([
      "b: room for about 8 more astra / high workers until the Weekly reset in 4d; tightest limit Weekly, 0 workers; most room of 3 accounts.",
    ]);
  });

  it("is the same decision whatever order the accounts arrive in", () => {
    const accounts = [account("b"), account("a"), account("c", 40)];
    expect(decide(accounts).selectedInstanceId).toBe("a");
    expect(JSON.stringify(decide(accounts))).toBe(JSON.stringify(decide(accounts.toReversed())));
  });

  it("never excludes an account for being nearly full, stale or forecast to run out", () => {
    const nearlyFull = decide([account("a", 99)]);
    expect(nearlyFull).toMatchObject({ outcome: "selected", selectedInstanceId: "a" });
    expect(candidate(nearlyFull, "a")).toMatchObject({ eligible: true, roomPoints: 1 });

    const stale = decide([
      account("a", 99, { windows: [weekly(99, { checkedAt: inHours(-90) })] }),
    ]);
    expect(stale).toMatchObject({ outcome: "selected", selectedInstanceId: "a", waitUntil: null });

    // A burn rate that would empty the account within the hour changes nothing.
    const burning = account("a", 40, {
      windows: [weekly(40, { ratePointsPerHour: 90, samples: 8, rateAgeMinutes: 0 })],
    });
    expect(decide([burning, account("b", 60)]).selectedInstanceId).toBe("a");
  });

  it("counts a window whose reset has passed as a fresh one, never as drained", () => {
    const a = account("a", 0, { windows: [weekly(100, { resetsAt: inHours(-1) })] });
    const decision = decide([a]);
    expect(decision.selectedInstanceId).toBe("a");
    expect(candidate(decision, "a")).toMatchObject({
      eligible: true,
      roomPoints: null,
      fits: true,
    });
  });

  it("takes one login's newest reading from whichever computer reports it", () => {
    const local = account("local", 10, {
      accountKey: "login",
      windows: [weekly(10, { checkedAt: inHours(-1) })],
    });
    const remote = account("remote", 100, { accountKey: "login", environmentId: "peer" });
    const decision = decide([], {
      inventories: [inventory([local]), inventory([remote], { environmentId: "peer" })],
    });
    expect(decision.candidates.map((c) => c.instanceId)).toEqual(["local"]);
    expect(decision).toMatchObject({ outcome: "wait", waitUntil: inHours(100) });
    // A limit rejection another computer recorded for the login is in force here too.
    const rejectedThere = decide([], {
      inventories: [
        inventory([account("local", 10, { accountKey: "login" })]),
        inventory(
          [
            account("remote", 10, {
              accountKey: "login",
              environmentId: "peer",
              limitedUntil: inHours(3),
              limits: [{ windowId: null, until: inHours(3) }],
            }),
          ],
          { environmentId: "peer" },
        ),
      ],
    });
    expect(rejectedThere).toMatchObject({ outcome: "wait", waitUntil: inHours(3) });
  });
});

describe("close accounts", () => {
  const order = (...ids: string[]) => ({ accountOrder: ids.map(key) });

  it("lets the preference order decide between accounts within the margin", () => {
    // 49.8 and 46.8 points spare after the job: within 10 percent of each other.
    const decision = decide([account("a", 50), account("b", 53)], { policy: order("b", "a") });
    expect(decision.selectedInstanceId).toBe("b");
    expect(decision.reasons[0]).toBe(
      "b: room for about 4 more astra / high workers until the Weekly reset in 4d; tightest limit Weekly, 0 workers; close to a (room for about 5 more) and earlier in the preference order.",
    );
    // A listed account comes before an unlisted one.
    expect(
      decide([account("a", 50), account("b", 53), account("c", 52)], { policy: order("c") })
        .selectedInstanceId,
    ).toBe("c");
  });

  it("never lets the preference order override a clear difference", () => {
    const accounts = [account("a", 50), account("b", 61)];
    expect(decide(accounts, { policy: order("b", "a") }).selectedInstanceId).toBe("a");
    // The margin is policy: widen it and the same accounts are close.
    expect(
      decide(accounts, { policy: { ...order("b", "a"), closeMarginPoints: 30 } })
        .selectedInstanceId,
    ).toBe("b");
    expect(
      decide([account("a", 50), account("b", 51)], {
        policy: { ...order("b", "a"), closeMarginPoints: 0 },
      }).selectedInstanceId,
    ).toBe("a");
  });

  it("then prefers fewer workers, then the sooner reset", () => {
    const fewer = decide([account("a", 50), account("b", 51)], {
      demand: [worker("a", "w1"), worker("a", "w2")],
    });
    expect(candidate(fewer, "a").workers).toBe(2);
    expect(fewer.selectedInstanceId).toBe("b");
    expect(fewer.reasons[0]).toContain("and has fewer workers.");

    const sooner = decide([
      account("a", 50),
      account("b", 51, { windows: [weekly(51, { resetsAt: inHours(99) })] }),
    ]);
    expect(sooner.selectedInstanceId).toBe("b");
    expect(sooner.reasons[0]).toContain("and resets sooner.");
  });

  it("never treats an account without a reading as close to one that has one", () => {
    const unread = account("b", 0, { windows: [] });
    expect(decide([account("a", 95), unread], { policy: order("b") }).selectedInstanceId).toBe("a");
    expect(decide([unread]).selectedInstanceId).toBe("b");
  });
});

describe("runway", () => {
  it("prefers a bigger plan with a lower percentage left over a smaller one with more", () => {
    // a is 70% used but holds $10,000 a week; b is 20% used but holds $500.
    const decision = decide([account("a", 70), account("b", 20)], {
      learned: learned({ b: { weekly: 0.2 } }),
    });
    expect(decision.selectedInstanceId).toBe("a");
    expect(candidate(decision, "a").roomWorkers!).toBeGreaterThan(
      candidate(decision, "b").roomWorkers!,
    );
  });

  it("charges more for a session with a larger context", () => {
    const rate = (contextTokens: number) =>
      costPerHour(learned(), {
        driver: codex,
        model: "astra",
        effort: "high",
        kind: "worker",
        contextTokens,
      }).dollarsPerHour;
    expect(rate(500_000)).toBe(rate(100_000) + 20);
    // A loaded account fills sooner when its sessions carry a larger context.
    const small = decide([account("a", 50)], {
      demand: [{ ...worker("a", "w1"), contextTokens: 50_000 }],
    });
    const large = decide([account("a", 50)], {
      demand: [{ ...worker("a", "w1"), contextTokens: 800_000 }],
    });
    expect(candidate(large, "a").roomWorkers!).toBeLessThan(candidate(small, "a").roomWorkers!);
  });

  it("counts a master at the master rate, below a worker", () => {
    const { worker: _worker, ...master } = worker("a", "m1");
    const withMaster = decide([account("a", 50), account("b", 50)], { demand: [master] });
    const withWorker = decide([account("a", 50), account("b", 50)], {
      demand: [worker("a", "w1")],
    });
    expect(candidate(withMaster, "a").roomWorkers!).toBeGreaterThan(
      candidate(withWorker, "a").roomWorkers!,
    );
    expect(candidate(withMaster, "a").roomWorkers!).toBeLessThan(
      candidate(withMaster, "b").roomWorkers!,
    );
  });

  it("projects outside use as load", () => {
    const quiet = decide([account("a", 50)]);
    const busy = decide([account("a", 50)], { learned: learned({ a: { background: 0.2 } }) });
    expect(candidate(busy, "a").roomWorkers!).toBeLessThan(candidate(quiet, "a").roomWorkers!);
  });

  it("starts a 5-hour window that has not begun with the job, so it resets during a long one", () => {
    // $10 an hour is 10% of the 5-hour window an hour: 12 hours in one window would not fit.
    const idle = account("a", 10, { windows: [weekly(10), fiveHour(0, { resetsAt: null })] });
    const decision = decide([idle], { request: { expectedHours: 12 } });
    expect(candidate(decision, "a")).toMatchObject({ fits: true });
  });

  it("does not fit when a limit runs out before the job ends, and says when it would", () => {
    // $10 an hour is 0.1 points an hour: 99.5% used runs out in 5 hours, before an 8-hour job ends.
    const decision = decide([account("a", 99.5)], { request: { expectedHours: 8 } });
    expect(candidate(decision, "a")).toMatchObject({ fits: false, fitsFrom: inHours(100) });
    // Not out: it is still chosen, as the account that lasts longest.
    expect(decision.selectedInstanceId).toBe("a");
    expect(candidate(decision, "a").line).toContain("Weekly runs out in about");
  });

  it("measures a hard cap as the limit", () => {
    const capped = decide([account("a", 50), account("b", 60)], {
      policy: {
        accountCaps: [
          {
            key: key("a"),
            weeklyPercent: 55,
            fiveHourPercent: null,
            stopWorkers: true,
            stopMasters: false,
          },
        ],
      },
    });
    expect(capped.selectedInstanceId).toBe("b");
    expect(candidate(capped, "a").line).toContain("(hard cap 55%)");
  });
});

describe("daily goal", () => {
  // The weekly window started three days ago; a goal of 20% a day allows 60% by now.
  const started = (used: number) =>
    weekly(used, { cycleStartedAt: inHours(-72), resetsAt: inHours(96), durationHours: 168 });
  const goals = (entries: Record<string, number>) => ({
    accountGoals: Object.entries(entries).map(([id, percentPerDay]) => ({
      key: key(id),
      percentPerDay,
    })),
  });

  it("ranks an account within its goal ahead of one over its goal with more raw room", () => {
    const decision = decide(
      [account("a", 40, { windows: [started(40)] }), account("b", 20, { windows: [started(20)] })],
      { policy: goals({ a: 20, b: 5 }) },
    );
    expect(candidate(decision, "b")).toMatchObject({ withinGoal: false });
    expect(candidate(decision, "a")).toMatchObject({ withinGoal: true });
    expect(decision.selectedInstanceId).toBe("a");
    expect(decision.reasons[0]).toContain("Weekly 40% used against a goal of 20% a day");
  });

  it("still uses an account over its goal when none is within, the least over first", () => {
    const decision = decide(
      [account("a", 40, { windows: [started(40)] }), account("b", 30, { windows: [started(30)] })],
      { policy: goals({ a: 5, b: 5 }) },
    );
    expect(decision.selectedInstanceId).toBe("b");
    expect(decision.reasons[0]).toContain("every account that fits is over its daily goal");
  });

  it("never refuses or redirects a pinned account that is over its goal", () => {
    const decision = decide(
      [account("a", 40, { windows: [started(40)] }), account("b", 10, { windows: [started(10)] })],
      { policy: goals({ a: 1 }), request: { explicitInstanceId: ProviderInstanceId.make("a") } },
    );
    expect(decision).toMatchObject({ outcome: "selected", selectedInstanceId: "a" });
  });

  it("takes a hard cap below the paced budget as the wall", () => {
    const decision = decide([account("a", 50, { windows: [started(50)] })], {
      policy: {
        ...goals({ a: 30 }),
        accountCaps: [
          {
            key: key("a"),
            weeklyPercent: 51,
            fiveHourPercent: null,
            stopWorkers: true,
            stopMasters: false,
          },
        ],
      },
      request: { expectedHours: 24 },
    });
    // The goal would allow 120% by the job's end; the cap allows 51%, so the job does not fit.
    expect(candidate(decision, "a")).toMatchObject({ fits: false });
    expect(candidate(decision, "a").line).toContain("hard cap 51%");
  });

  it("takes a family's stored goal for an account without its own", () => {
    const decision = decide([account("a", 40, { windows: [started(40)] })], {
      policy: { codex: { dailyPoints: 10 } },
    });
    expect(candidate(decision, "a").withinGoal).toBe(false);
    expect(decision.reasons[0]).toContain("against a goal of 10% a day");
  });
});

describe("drained", () => {
  it("refuses with the earliest reset when the model is used up on every account", () => {
    const decision = decide([
      account("a", 100, { windows: [weekly(100, { resetsAt: inHours(30) })] }),
      account("b", 100, { windows: [weekly(100, { resetsAt: inHours(7) })] }),
    ]);
    expect(decision).toMatchObject({
      outcome: "wait",
      selectedInstanceId: null,
      waitUntil: inHours(7),
    });
    expect(decision.reasons).toEqual([
      `astra is drained on every account; earliest reset ${inHours(7)}.`,
    ]);
    expect(candidate(decision, "a")).toMatchObject({
      eligible: false,
      drainedUntil: inHours(30),
      roomPoints: 0,
    });
    expect(candidate(decision, "a").line).toBe(
      `a: drained until ${inHours(30)} (Weekly 100% used), 0 workers`,
    );
  });

  it("is drained until every used-up window has reset", () => {
    const a = account("a", 0, { windows: [weekly(100), fiveHour(100)] });
    expect(accountRoom({ account: a, model: "astra", at }).drainedUntil).toBe(inHours(100));
    const unknown = account("a", 0, { windows: [weekly(100, { resetsAt: null })] });
    expect(accountRoom({ account: unknown, model: "astra", at }).drainedUntil).toBeNull();
    expect(decide([unknown])).toMatchObject({ outcome: "wait", waitUntil: null });
  });

  it("refuses a pinned account that is drained and never substitutes another", () => {
    const decision = decide([account("a", 100), account("b", 10)], {
      request: { explicitInstanceId: ProviderInstanceId.make("a") },
    });
    expect(decision).toMatchObject({
      outcome: "wait",
      selectedInstanceId: null,
      waitUntil: inHours(100),
    });
    expect(decision.reasons[0]).toContain("a pinned account is exact.");
    // Pinned with room: chosen though another account has more.
    const pinned = decide([account("a", 90), account("b", 10)], {
      request: { explicitInstanceId: ProviderInstanceId.make("a") },
    });
    expect(pinned.selectedInstanceId).toBe("a");
    expect(pinned.reasons[0]).toContain("pinned account.");
  });

  it("counts a reached hard cap as drained and measures room to the cap", () => {
    const cap = (patch: object = {}) => ({
      accountCaps: [
        {
          key: key("a"),
          weeklyPercent: 80,
          fiveHourPercent: 50,
          stopWorkers: true,
          stopMasters: false,
          ...patch,
        },
      ],
    });
    const below = decide([account("a", 50)], { policy: cap() });
    expect(candidate(below, "a")).toMatchObject({ eligible: true, roomPoints: 30 });
    expect(candidate(below, "a").line).toContain("tightest limit Weekly (hard cap 80%)");
    // Room to the cap decides the ranking: b has more of its allowance left, a more to its cap.
    expect(
      decide([account("a", 50), account("b", 60)], {
        policy: cap({ key: key("b"), weeklyPercent: 65 }),
      }).selectedInstanceId,
    ).toBe("a");

    const reached = decide([account("a", 80)], { policy: cap() });
    expect(reached).toMatchObject({ outcome: "wait", waitUntil: inHours(100) });
    expect(candidate(reached, "a").line).toContain("Weekly 80% used, hard cap 80%");

    const session = decide([account("a", 0, { windows: [weekly(10), fiveHour(50)] })], {
      policy: cap(),
    });
    expect(session).toMatchObject({ outcome: "wait", waitUntil: inHours(2) });

    // A cap that does not stop workers does not drain for them; one that stops masters does.
    expect(
      decide([account("a", 80)], { policy: cap({ stopWorkers: false }) }).selectedInstanceId,
    ).toBe("a");
    expect(
      decide([account("a", 80)], { policy: cap(), request: { kind: "session" } })
        .selectedInstanceId,
    ).toBe("a");
    expect(
      decide([account("a", 80)], {
        policy: cap({ stopMasters: true }),
        request: { kind: "session" },
      }).outcome,
    ).toBe("wait");
    // The weekly cap is for the account-wide window, never a model's own.
    expect(
      decide(
        [account("a", 0, { windows: [weekly(85, { id: "weekly_astra", models: ["astra"] })] })],
        {
          policy: cap(),
        },
      ).selectedInstanceId,
    ).toBe("a");
  });

  it("drains only the model a model-scoped window applies to", () => {
    const a = account("a", 20, {
      windows: [
        weekly(20),
        weekly(100, { id: "weekly_astra", label: "Weekly · Astra", models: ["astra"] }),
      ],
    });
    expect(decide([a])).toMatchObject({ outcome: "wait", waitUntil: inHours(100) });
    const other = decide([a], { request: { model: "sol" } });
    expect(other.selectedInstanceId).toBe("a");
    expect(candidate(other, "a").roomPoints).toBe(80);
    // The wanted model moves to the account where its own window has room.
    const b = account("b", 70, {
      windows: [weekly(70), weekly(40, { id: "weekly_astra", models: ["astra"] })],
    });
    expect(decide([a, b]).selectedInstanceId).toBe("b");
  });

  it("drains while a provider limit rejection is in force, for the models its window covers", () => {
    const scoped = [weekly(20), weekly(60, { id: "weekly_astra", models: ["astra"] })];
    const limited = (patch: Partial<AllocationAccount>) =>
      account("a", 20, { windows: scoped, ...patch });

    // An older computer reports only `limitedUntil`: the whole account.
    const legacy = decide([limited({ limitedUntil: inHours(3) })]);
    expect(legacy).toMatchObject({ outcome: "wait", waitUntil: inHours(3) });
    expect(candidate(legacy, "a").line).toContain("provider limit rejection");
    expect(
      decide([limited({ limitedUntil: inHours(3) })], { request: { model: "sol" } }).outcome,
    ).toBe("wait");

    const accountWide = { limits: [{ windowId: null, until: inHours(3) }] };
    expect(decide([limited(accountWide)], { request: { model: "sol" } }).outcome).toBe("wait");

    const forAstra = {
      limitedUntil: inHours(3),
      limits: [{ windowId: "weekly_astra", until: inHours(3) }],
    };
    expect(decide([limited(forAstra)])).toMatchObject({ outcome: "wait", waitUntil: inHours(3) });
    expect(decide([limited(forAstra)], { request: { model: "sol" } }).selectedInstanceId).toBe("a");

    // A rejection whose reset has passed is no longer in force.
    expect(
      decide([limited({ limits: [{ windowId: null, until: inHours(-1) }] })]).selectedInstanceId,
    ).toBe("a");
    expect(decide([limited({ limitedUntil: inHours(-1) })]).selectedInstanceId).toBe("a");
  });

  it("is unavailable, not drained, when no account can run the request at all", () => {
    for (const change of [
      { model: "luna" },
      { options: [{ id: "reasoningEffort", value: "max" }] },
      { environmentId: "other" },
      { driver: ProviderDriverKind.make("claudeAgent") },
      { nativeInstanceId: ProviderInstanceId.make("missing") },
      { explicitInstanceId: ProviderInstanceId.make("missing") },
      { allowedInstanceIds: [] },
    ]) {
      const decision = decide([account("a", 100), account("b", 100)], { request: change });
      expect(decision).toMatchObject({
        outcome: "unavailable",
        selectedInstanceId: null,
        waitUntil: null,
      });
    }
  });
});

describe("usable accounts", () => {
  it("honors a pin, the native binding and the allowed accounts exactly", () => {
    const accounts = [account("a", 10), account("b", 50)];
    const pick = (patch: Partial<AllocationRequest>) =>
      decide(accounts, { request: patch }).selectedInstanceId;
    expect(pick({ explicitInstanceId: ProviderInstanceId.make("b") })).toBe("b");
    expect(pick({ nativeInstanceId: ProviderInstanceId.make("b") })).toBe("b");
    expect(pick({ allowedInstanceIds: [ProviderInstanceId.make("b")] })).toBe("b");
    expect(decide(accounts).request).toEqual(request);
  });

  it("accepts the short name of one provider-qualified model, never an ambiguous one", () => {
    const pick = (slugs: string[], wanted: string) =>
      decide([account("a", 10, { models: slugs.map(model) })], { request: { model: wanted } })
        .selectedInstanceId;
    const catalog = ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-flash"];
    expect(pick(catalog, "deepseek-flash")).toBe("a");
    expect(pick(catalog, "deepseek-official/deepseek-flash")).toBe("a");
    expect(pick(catalog, "flash")).toBeNull();
    expect(pick(["one/deepseek-flash", "two/deepseek-flash"], "deepseek-flash")).toBeNull();
  });

  it("rejects duplicate option IDs and a computer that was not read", () => {
    const twice = decide([account("a")], {
      request: { options: [...request.options, ...request.options] },
    });
    expect(twice.outcome).toBe("unavailable");
    expect(twice.reasons[0]).toContain("Duplicate option IDs");
    const elsewhere = decide([account("a")], { request: { environmentId: "offline" } });
    expect(elsewhere.reasons[0]).toBe("Execution environment unavailable.");
  });

  it("keeps a provider that is off, or closed to workers, out of worker starts only where it is set", () => {
    const disabled = account("disabled", 10, { availableForWorkers: false, accountKey: "shared" });
    const enabled = account("enabled", 10, { accountKey: "shared" });
    const elsewhere = account("disabled", 10, { environmentId: "peer", accountKey: "shared" });
    const peer = inventory([elsewhere], { environmentId: "peer" });
    const here = decide([], { inventories: [inventory([disabled, enabled]), peer] });
    expect(here.selectedInstanceId).toBe("enabled");
    expect(candidate(here, "disabled").eligible).toBe(false);
    expect(candidate(here, "disabled").line).toContain("not usable");
    expect(
      decide([], {
        inventories: [inventory([disabled]), peer],
        request: { environmentId: "peer" },
      }).selectedInstanceId,
    ).toBe("disabled");
    // A human session may still use it; a provider turned off is closed to everyone.
    expect(decide([disabled], { request: { kind: "session" } }).selectedInstanceId).toBe(
      "disabled",
    );
    expect(
      decide([account("off", 10, { enabled: false })], { request: { kind: "session" } }).outcome,
    ).toBe("unavailable");
  });
});

describe("active workers", () => {
  const held = (
    demand: AllocationDemand,
    state: AllocationReservation["state"] = "starting",
    patch: Partial<AllocationReservation> = {},
  ): AllocationReservation => ({
    assignmentId: `held-${demand.threadId}`,
    request: { ...request, assignmentId: `held-${demand.threadId}`, threadId: demand.threadId },
    accountKey: demand.accountKey,
    instanceId: demand.instanceId,
    createdAt: inHours(-1),
    expiresAt: inHours(1),
    state,
    decision: decide([account("a")]),
    ...patch,
  });
  const workers = (decision: ReturnType<typeof decide>, id = "a") =>
    candidate(decision, id).workers;

  it("counts each worker once across live sessions and reservations, never the incoming one", () => {
    const live = worker("a", "live");
    const decision = decide([account("a")], {
      demand: [
        live,
        // A master's own session is not a worker.
        { ...worker("a", "master"), worker: false },
        { ...worker("a", "thread"), threadId: request.threadId },
      ],
      reservations: [
        held(live, "consumed"),
        held(worker("a", "reserved"), "reserved"),
        held(worker("a", "starting")),
        held(worker("a", "released"), "released"),
        held(worker("a", "expired"), "reserved", { expiresAt: at }),
      ],
    });
    expect(workers(decision)).toBe(3);
  });

  it("drops a consumed reservation only once its computer confirms the session idle", () => {
    const consumed = [held(worker("a", "done"), "consumed")];
    expect(workers(decide([account("a")], { reservations: consumed }))).toBe(0);
    for (const patch of [{ complete: false }, { observedAt: inHours(-2) }])
      expect(
        workers(
          decide([], { inventories: [inventory([account("a")], patch)], reservations: consumed }),
        ),
      ).toBe(1);
    const base = held({ ...worker("a", "remote"), environmentId: "offline" }, "consumed");
    const offline = { ...base, request: { ...base.request, environmentId: "offline" } };
    expect(workers(decide([account("a")], { reservations: [offline] }))).toBe(1);
  });

  it("shares a known login's workers across computers but never guesses an unknown one", () => {
    const remote = {
      ...worker("a", "remote"),
      environmentId: "peer",
      instanceId: ProviderInstanceId.make("alias"),
    };
    const peer = inventory([account("alias", 10, { accountKey: "a", environmentId: "peer" })], {
      environmentId: "peer",
      demand: [remote],
    });
    expect(workers(decide([], { inventories: [inventory([account("a")]), peer] }))).toBe(1);

    const unknown = account("a", 10, { accountKey: null });
    const local = { ...worker("a", "local"), accountKey: null };
    const decision = decide([], {
      inventories: [
        inventory([unknown], { demand: [local] }),
        inventory([], {
          environmentId: "peer",
          demand: [{ ...local, environmentId: "peer", threadId: ThreadId.make("remote") }],
        }),
      ],
    });
    expect(workers(decision)).toBe(1);
  });
});
