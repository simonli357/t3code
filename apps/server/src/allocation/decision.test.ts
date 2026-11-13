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
  type AllocationInventory,
  type AllocationPolicy,
  type AllocationRequest,
  type AllocationReservation,
  type AllocationWindow,
} from "@t3tools/contracts";
import { accountRoom, decideAllocation } from "./decision.ts";

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
const decide = (
  accounts: AllocationAccount[],
  patch: {
    policy?: Partial<AllocationPolicy>;
    request?: Partial<AllocationRequest>;
    demand?: AllocationDemand[];
    reservations?: AllocationReservation[];
    inventories?: AllocationInventory[];
  } = {},
) =>
  decideAllocation({
    at,
    policy: { ...defaultAllocationPolicy, ...patch.policy },
    request: { ...request, ...patch.request },
    inventories: patch.inventories ?? [inventory(accounts, { demand: patch.demand ?? [] })],
    reservations: patch.reservations ?? [],
    authorityAvailable: true,
  });
const key = (id: string) => allocationPreferenceKey(account(id));
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
    expect(candidate(decision, "a").line).toBe("a: 5-hour 20% left, resets in 2h 0m, 0 workers");
  });

  it("sends the worker to the account with the most room and says so in one line", () => {
    const decision = decide([account("a", 60), account("b", 20), account("c", 45)]);
    expect(decision).toMatchObject({ outcome: "selected", selectedInstanceId: "b" });
    expect(decision.reasons).toEqual([
      "b: Weekly 80% left, resets in 4d, 0 workers; most room of 3 accounts.",
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

  it("says nothing from a window whose reset has passed", () => {
    const a = account("a", 0, { windows: [weekly(100, { resetsAt: inHours(-1) })] });
    const decision = decide([a]);
    expect(decision.selectedInstanceId).toBe("a");
    expect(candidate(decision, "a")).toMatchObject({ eligible: true, roomPoints: null });
    expect(candidate(decision, "a").line).toBe("a: no usage reading, 0 workers");
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
    const decision = decide([account("a", 50), account("b", 55)], { policy: order("b", "a") });
    expect(decision.selectedInstanceId).toBe("b");
    expect(decision.reasons[0]).toBe(
      "b: Weekly 45% left, resets in 4d, 0 workers; close to a (50% left) and earlier in the preference order.",
    );
    // Exactly the margin is still close.
    expect(
      decide([account("a", 50), account("b", 60)], { policy: order("b") }).selectedInstanceId,
    ).toBe("b");
    // A listed account comes before an unlisted one.
    expect(
      decide([account("a", 50), account("b", 55), account("c", 52)], { policy: order("c") })
        .selectedInstanceId,
    ).toBe("c");
  });

  it("never lets the preference order override a clear difference", () => {
    const accounts = [account("a", 50), account("b", 61)];
    expect(decide(accounts, { policy: order("b", "a") }).selectedInstanceId).toBe("a");
    // The margin is policy: widen it and the same accounts are close.
    expect(
      decide(accounts, { policy: { ...order("b", "a"), closeMarginPoints: 15 } })
        .selectedInstanceId,
    ).toBe("b");
    expect(
      decide([account("a", 50), account("b", 51)], {
        policy: { ...order("b", "a"), closeMarginPoints: 0 },
      }).selectedInstanceId,
    ).toBe("a");
  });

  it("then prefers fewer workers, then the sooner reset", () => {
    const busy = decide([account("a", 50), account("b", 55)], {
      demand: [worker("a", "w1"), worker("a", "w2"), worker("b", "w3")],
    });
    expect(busy.selectedInstanceId).toBe("b");
    expect(busy.reasons[0]).toContain("close to a (50% left) and has fewer workers.");
    expect(candidate(busy, "a").workers).toBe(2);

    const sooner = decide([
      account("a", 50),
      account("b", 55, { windows: [weekly(55, { resetsAt: inHours(10) })] }),
    ]);
    expect(sooner.selectedInstanceId).toBe("b");
    expect(sooner.reasons[0]).toContain("close to a (50% left) and resets sooner.");

    // Fewer workers outranks the sooner reset; the preference order outranks both.
    const accounts = [
      account("a", 50, { windows: [weekly(50, { resetsAt: inHours(10) })] }),
      account("b", 55),
    ];
    expect(decide(accounts, { demand: [worker("a", "w1")] }).selectedInstanceId).toBe("b");
    expect(
      decide(accounts, { demand: [worker("a", "w1")], policy: order("a") }).selectedInstanceId,
    ).toBe("a");
    // Neither outranks a clear difference.
    expect(
      decide(
        [account("a", 30), account("b", 55, { windows: [weekly(55, { resetsAt: inHours(1) })] })],
        {
          demand: [worker("a", "w1"), worker("a", "w2")],
        },
      ).selectedInstanceId,
    ).toBe("a");
  });

  it("never treats an account without a reading as close to one that has one", () => {
    const unread = account("b", 0, { windows: [] });
    expect(decide([account("a", 95), unread], { policy: order("b") }).selectedInstanceId).toBe("a");
    expect(decide([unread]).selectedInstanceId).toBe("b");
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
    expect(candidate(below, "a").line).toContain("Weekly 30% left below its 80% cap");
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
