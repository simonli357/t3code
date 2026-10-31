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
  type AllocationRequest,
  type AllocationReservation,
  type AllocationWindow,
} from "@t3tools/contracts";
import { decideAllocation, targetPoints } from "./decision.ts";

const at = "2026-10-23T12:00:00.000Z";
const window = (patch: Partial<AllocationWindow> = {}): AllocationWindow => ({
  id: "weekly",
  label: "Weekly",
  kind: "weekly",
  usedPoints: 10,
  checkedAt: at,
  resetsAt: "2026-10-29T12:00:00.000Z",
  cycleStartedAt: "2026-10-22T12:00:00.000Z",
  durationHours: 168,
  ratePointsPerHour: null,
  samples: 0,
  rateAgeMinutes: null,
  ...patch,
});
const account = (id: string, patch: Partial<AllocationAccount> = {}): AllocationAccount => ({
  environmentId: "host",
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  accountKey: id,
  label: id,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [
    {
      slug: "astra",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  shortWindow: "reported",
  shortWindowAbsentCheckedAt: at,
  windows: [
    window(),
    window({
      id: "short",
      label: "Short",
      kind: "session",
      durationHours: 5,
      resetsAt: "2026-10-23T16:00:00.000Z",
      cycleStartedAt: "2026-10-23T11:00:00.000Z",
    }),
  ],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  ...patch,
});
const request: AllocationRequest = {
  assignmentId: "job",
  environmentId: "host",
  threadId: ThreadId.make("thread"),
  driver: ProviderDriverKind.make("codex"),
  model: "astra",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const inventory = (accounts = [account("b"), account("a")]): AllocationInventory => ({
  environmentId: "host",
  observedAt: at,
  complete: true,
  demand: [],
  accounts,
  notices: [],
});
const input = () => ({
  at,
  policy: defaultAllocationPolicy,
  request,
  inventories: [inventory()],
  reservations: [],
  authorityAvailable: true,
});

describe("allowance curves", () => {
  it("uses Codex's 30-point allowance plus 10 per elapsed day", () => {
    expect(targetPoints(window(), defaultAllocationPolicy.codex, at)).toBe(40);
    expect(targetPoints(window(), { ...defaultAllocationPolicy.codex, burstHours: 48 }, at)).toBe(
      25,
    );
  });
  it("labels aggressive 17/day separately from sustainable seven-day pacing", () => {
    expect(targetPoints(window(), defaultAllocationPolicy.claude, at)).toBe(17);
    expect(
      targetPoints(
        window(),
        { ...defaultAllocationPolicy.claude, preset: "sustainable", dailyPoints: 100 / 7 },
        at,
      ),
    ).toBeCloseTo(95 / 7);
    expect(
      targetPoints(window(), { ...defaultAllocationPolicy.claude, preset: "aggressive17" }, at),
    ).toBe(17);
    expect(
      targetPoints(
        window(),
        { ...defaultAllocationPolicy.claude, preset: "aggressive17" },
        "2026-10-28T12:00:00.000Z",
      ),
    ).toBe(95);
  });
  it("counts real hours through Toronto DST and never resets at midnight", () => {
    const w = window({ cycleStartedAt: "2026-11-01T04:00:00.000Z" });
    expect(targetPoints(w, defaultAllocationPolicy.codex, "2026-11-02T04:00:00.000Z")).toBe(40);
    expect(targetPoints(w, defaultAllocationPolicy.codex, "2026-11-02T05:00:00.000Z")).toBeCloseTo(
      40 + 10 / 24,
    );
  });
});
describe("deterministic recommendations", () => {
  it("never borrows unrelated resets for unknown or incompatible account blockers", () => {
    const claude = account("claude", { driver: ProviderDriverKind.make("claudeAgent") });
    for (const patch of [
      { shortWindow: "unknown" as const, windows: [window()] },
      { models: [] },
      { accountKey: null },
      { available: false },
      { environmentId: "other" },
      {
        shortWindow: "known-absent" as const,
        shortWindowAbsentCheckedAt: "2026-10-22T12:00:00.000Z",
        windows: [window()],
      },
    ]) {
      const result = decideAllocation({
        ...input(),
        inventories: [inventory([account("a", patch), claude])],
      });
      expect(result.outcome).toBe(
        "models" in patch || "environmentId" in patch ? "unavailable" : "selected",
      );
      expect(result.waitUntil).toBeNull();
    }
  });
  it("retains reset warnings without forcing a wait on a compatible candidate", () => {
    const full = account("full", {
      windows: [
        window({
          id: "short",
          kind: "session",
          durationHours: 5,
          usedPoints: 99,
          resetsAt: "2026-10-23T18:00:00.000Z",
        }),
        window({
          id: "other-short",
          kind: "session",
          durationHours: 5,
          usedPoints: 99,
          resetsAt: "2026-10-23T19:00:00.000Z",
        }),
      ],
    });
    const x = {
      ...input(),
      inventories: [
        inventory([full, account("claude", { driver: ProviderDriverKind.make("claudeAgent") })]),
      ],
    };
    expect(decideAllocation(x)).toMatchObject({
      outcome: "selected",
      waitUntil: null,
    });
    expect(decideAllocation({ ...x, authorityAvailable: false })).toMatchObject({
      outcome: "selected",
      waitUntil: null,
    });
    expect(
      decideAllocation({
        ...x,
        request: { ...request, explicitInstanceId: ProviderInstanceId.make("missing") },
      }).waitUntil,
    ).toBeNull();
    expect(
      decideAllocation({
        ...x,
        inventories: [
          inventory([
            {
              ...full,
              windows: full.windows.map((w) => ({ ...w, checkedAt: "2026-10-22T12:00:00.000Z" })),
            },
          ]),
        ],
      }).waitUntil,
    ).toBeNull();
  });
  it("replays byte-for-byte and breaks ties by stable identity, not input order", () => {
    const x = input();
    expect(decideAllocation(x).selectedInstanceId).toBe("a");
    expect(JSON.stringify(decideAllocation(x))).toBe(
      JSON.stringify(
        decideAllocation({
          ...x,
          inventories: [inventory(x.inventories[0]!.accounts.toReversed())],
        }),
      ),
    );
  });
  it("honors explicit accounts only within exact model/options/host compatibility", () => {
    const x = input();
    expect(
      decideAllocation({
        ...x,
        request: { ...request, explicitInstanceId: ProviderInstanceId.make("b") },
      }).selectedInstanceId,
    ).toBe("b");
    for (const change of [
      { model: "sol" },
      { options: [{ id: "reasoningEffort", value: "max" }] },
      { environmentId: "other" },
      { driver: ProviderDriverKind.make("claudeAgent") },
      { nativeInstanceId: ProviderInstanceId.make("missing") },
    ]) {
      expect(
        decideAllocation({ ...x, request: { ...request, ...change } }).selectedInstanceId,
      ).toBeNull();
    }
    expect(decideAllocation(x).request).toEqual(request);
  });
  it("accepts the short name of one provider-qualified model, never an ambiguous one", () => {
    const qualified = (...slugs: string[]) =>
      account("a", {
        models: slugs.map((slug) => ({ slug, capabilities: account("a").models[0]!.capabilities })),
      });
    const decide = (slugs: string[], model: string) =>
      decideAllocation({
        ...input(),
        request: { ...request, model },
        inventories: [inventory([qualified(...slugs)])],
      }).selectedInstanceId;
    const catalog = ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-flash"];
    expect(decide(catalog, "deepseek-flash")).toBe("a");
    expect(decide(catalog, "deepseek-official/deepseek-flash")).toBe("a");
    expect(decide(catalog, "flash")).toBeNull();
    expect(decide(["one/deepseek-flash", "two/deepseek-flash"], "deepseek-flash")).toBeNull();
  });
  it("warns on unsafe short windows despite weekly underuse or reset credits", () => {
    const a = account("a", {
      windows: [
        window({ usedPoints: 0 }),
        window({ id: "short", kind: "session", usedPoints: 99 }),
      ],
      resetCredits: { count: 2, expiresAt: null, scope: "unknown" },
    });
    expect(
      decideAllocation({ ...input(), inventories: [inventory([a])] }).selectedInstanceId,
    ).not.toBeNull();
  });
  it("warns on unconfirmed replenishment and stale readings, including arbitrary model buckets", () => {
    for (const w of [
      window({ resetsAt: at }),
      window({ checkedAt: "2026-10-23T11:00:00.000Z" }),
      window({ id: "astra-special", models: ["astra"], usedPoints: 100 }),
    ]) {
      expect(
        decideAllocation({ ...input(), inventories: [inventory([account("a", { windows: [w] })])] })
          .selectedInstanceId,
      ).not.toBeNull();
    }
  });
  it("distinguishes missing short data from a provider's known absence", () => {
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([account("a", { shortWindow: "unknown" })])],
      }).selectedInstanceId,
    ).not.toBeNull();
    expect(
      decideAllocation({
        ...input(),
        inventories: [
          inventory([account("a", { shortWindow: "known-absent", windows: [window()] })]),
        ],
      }).selectedInstanceId,
    ).toBe("a");
  });
  it("never treats missing identity or unreachable authority/host as spare capacity", () => {
    expect(decideAllocation({ ...input(), authorityAvailable: false }).outcome).toBe("selected");
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([account("a", { accountKey: null })])],
      }).selectedInstanceId,
    ).not.toBeNull();
    expect(
      decideAllocation({ ...input(), inventories: [{ ...inventory(), complete: false }] }).outcome,
    ).toBe("selected");
  });
  it("reserves ongoing and external demand without double-counting matching reservations", () => {
    const x = input();
    const d = {
      environmentId: "host",
      threadId: ThreadId.make("ongoing"),
      instanceId: ProviderInstanceId.make("a"),
      accountKey: "a",
      model: "astra",
      options: request.options,
      state: "running" as const,
    };
    const inventories = [{ ...inventory([account("a")]), demand: [d] }];
    const r: AllocationReservation = {
      assignmentId: "old",
      request: { ...request, threadId: d.threadId },
      accountKey: "a",
      instanceId: d.instanceId,
      createdAt: at,
      expiresAt: "2026-10-23T12:05:00.000Z",
      state: "starting",
      decision: decideAllocation(x),
    };
    expect(decideAllocation({ ...x, inventories, reservations: [r] })).toEqual(
      decideAllocation({ ...x, inventories }),
    );
    const external = account("a", {
      windows: [window({ ratePointsPerHour: 90, samples: 8, rateAgeMinutes: 0 })],
    });
    expect(
      decideAllocation({ ...x, inventories: [inventory([external])] }).selectedInstanceId,
    ).not.toBeNull();
  });
  it("uses conservative nonzero cold starts and admits safe work when all accounts are ahead", () => {
    const decision = decideAllocation({
      ...input(),
      inventories: [
        inventory([
          account("a", { shortWindow: "known-absent", windows: [window({ usedPoints: 42 })] }),
        ]),
      ],
    });
    expect(decision.selectedInstanceId).toBe("a");
    expect(decision.confidence).toBe("low");
    expect(decision.candidates[0]!.windows[0]!.forecastPoints).toBeGreaterThan(0);
  });
  it("expires temporary use-by overrides without credit redemption", () => {
    const x = input();
    const overrides = [
      {
        accountKey: "a",
        windowId: "weekly",
        createdAt: "2026-10-22T12:00:00.000Z",
        expiresAt: at,
        useBy: "2026-10-24T12:00:00.000Z",
        baselineUsedPoints: 10,
        resetPlan: "planned" as const,
      },
    ];
    expect(decideAllocation({ ...x, policy: { ...x.policy, overrides } })).toEqual(
      decideAllocation(x),
    );
  });
});

describe("shared host and window reconciliation", () => {
  it("shares quota rejections even when both computers use the same alias", () => {
    const local = account("same", { accountKey: "login" });
    const remote = {
      ...inventory([
        { ...local, environmentId: "remote", limitedUntil: "2026-10-23T15:00:00.000Z" },
      ]),
      environmentId: "remote",
    };
    const d = decideAllocation({ ...input(), inventories: [inventory([local]), remote] });
    expect(d.selectedInstanceId).not.toBeNull();
    expect(d.candidates.find((c) => c.environmentId === "host")?.warnings?.join(" ")).toContain(
      "shared account",
    );
  });
  it("uses the newest shared window and warns about an omitted stale short window", () => {
    const local = account("local", { accountKey: "login" });
    const remote = account("remote", {
      accountKey: "login",
      environmentId: "remote",
      windows: local.windows.map((w) => ({ ...w, usedPoints: 100 })),
    });
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([local]), { ...inventory([remote]), environmentId: "remote" }],
      }).selectedInstanceId,
    ).not.toBeNull();
    const sparse = {
      ...local,
      windows: local.windows.map((w) =>
        w.id === "short" ? { ...w, checkedAt: "2026-10-23T10:00:00.000Z" } : w,
      ),
    };
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([sparse])],
      }).candidates[0]?.warnings?.join(" "),
    ).toContain("stale");
  });
  it("forecasts model buckets independently and warns about missing applicable short readings", () => {
    const a = account("a");
    const unrelated = window({ id: "other-model", usedPoints: 100, models: ["other"] });
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([{ ...a, windows: [...a.windows, unrelated] }])],
      }).selectedInstanceId,
    ).toBe("a");
    const applicable = { ...unrelated, models: ["astra"] };
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([{ ...a, windows: [...a.windows, applicable] }])],
      }).selectedInstanceId,
    ).not.toBeNull();
    expect(
      decideAllocation({
        ...input(),
        inventories: [
          inventory([
            {
              ...a,
              windows: a.windows.map((w) => (w.id === "short" ? { ...w, models: ["other"] } : w)),
            },
          ]),
        ],
      }).selectedInstanceId,
    ).not.toBeNull();
  });
  it("requires confirmed resets and does not use insufficient rate samples as free capacity", () => {
    const a = account("a");
    const cold = decideAllocation({ ...input(), inventories: [inventory([a])] });
    const sparse = decideAllocation({
      ...input(),
      inventories: [
        inventory([
          {
            ...a,
            windows: a.windows.map((w) => ({
              ...w,
              ratePointsPerHour: 0,
              samples: 2,
              rateAgeMinutes: 0,
            })),
          },
        ]),
      ],
    });
    expect(sparse.candidates[0]?.windows.map((w) => w.forecastPoints)).toEqual(
      cold.candidates[0]?.windows.map((w) => w.forecastPoints),
    );
    const next = {
      ...a,
      windows: a.windows.map((w) => ({ ...w, cycleStartedAt: "2026-10-24T12:00:00.000Z" })),
    };
    expect(
      decideAllocation({ ...input(), inventories: [inventory([next])] }).selectedInstanceId,
    ).not.toBeNull();
  });
});

it("preserves fresh same-cycle aggregate burn when a newer alias has only percentages", () => {
  const measured = account("a", {
    windows: [
      window({
        checkedAt: "2026-10-23T11:59:59.000Z",
        ratePointsPerHour: 20,
        predictionErrorPointsPerHour: 1,
        samples: 8,
        rateAgeMinutes: 0,
      }),
    ],
    shortWindow: "known-absent",
  });
  const alias = {
    ...account("alias", { accountKey: "a", windows: [window()], shortWindow: "known-absent" }),
    environmentId: "other",
  };
  const run = (a = measured) =>
    decideAllocation({
      ...input(),
      inventories: [inventory([a]), { ...inventory([alias]), environmentId: "other" }],
    });
  const alone = decideAllocation({ ...input(), inventories: [inventory([measured])] });
  const merged = run();
  expect(merged.selectedInstanceId).not.toBeNull();
  expect(merged.candidates[0]?.windows[0]?.forecastPoints).toBeCloseTo(
    alone.candidates[0]?.windows[0]?.forecastPoints ?? 0,
    1,
  );
  expect(merged.candidates[0]?.windows[0]?.forecastPoints).toBe(58.5);
  // Neither expired measurement evidence nor a previous cycle may be transplanted.
  for (const patch of [
    { rateAgeMinutes: 60 },
    { samples: 1 },
    { cycleStartedAt: "2026-10-15T12:00:00.000Z", resetsAt: "2026-10-22T12:00:00.000Z" },
  ])
    expect(
      run({ ...measured, windows: measured.windows.map((w) => ({ ...w, ...patch })) })
        .selectedInstanceId,
    ).toBe("a");
  const duplicate = {
    ...measured,
    environmentId: "other",
    instanceId: ProviderInstanceId.make("alias"),
  };
  const replay = decideAllocation({
    ...input(),
    inventories: [{ ...inventory([duplicate]), environmentId: "other" }, inventory([measured])],
  });
  expect(replay.candidates[0]?.windows[0]?.forecastPoints).toBe(
    alone.candidates[0]?.windows[0]?.forecastPoints,
  );
});

it("charges completed borrowing against cumulative consumption and warns for explicit pacing choices too", () => {
  const run = (usedPoints: number, explicit = false) =>
    decideAllocation({
      ...input(),
      request: {
        ...request,
        ...(explicit ? { explicitInstanceId: ProviderInstanceId.make("a") } : {}),
      },
      inventories: [
        inventory([
          account("a", { shortWindow: "known-absent", windows: [window({ usedPoints })] }),
        ]),
      ],
    });
  const first = run(42);
  expect(first.selectedInstanceId).toBe("a");
  const consumed = 42 + first.candidates[0]!.windows[0]!.forecastPoints;
  expect(run(consumed).candidates[0]?.warnings?.join(" ")).toContain("bounded borrowing");
  expect(run(80).candidates[0]?.warnings?.join(" ")).toContain("bounded borrowing");
  expect(run(80, true).selectedInstanceId).toBe("a");
  expect(run(95, true).candidates[0]?.warnings?.join(" ")).toContain("headroom");
});

describe("bounded assignment duration forecasts", () => {
  const legacy = (id = "ongoing") => ({
    environmentId: "host",
    threadId: ThreadId.make(id),
    instanceId: ProviderInstanceId.make("a"),
    accountKey: "a",
    model: "astra",
    options: request.options,
    state: "running" as const,
  });
  const held = (
    expectedHours: number | undefined,
    patch: Partial<AllocationReservation> = {},
  ): AllocationReservation => ({
    assignmentId: "held",
    request: {
      ...request,
      threadId: legacy().threadId,
      ...(expectedHours === undefined ? {} : { expectedHours }),
    },
    instanceId: ProviderInstanceId.make("a"),
    accountKey: "a",
    createdAt: at,
    expiresAt: "2026-10-23T12:05:00.000Z",
    state: "consumed",
    decision: decideAllocation(input()),
    ...patch,
  });
  const run = (patch: Partial<Parameters<typeof decideAllocation>[0]> = {}) =>
    decideAllocation({
      ...input(),
      request: { ...request, expectedHours: 0.25 },
      inventories: [
        inventory([account("a", { shortWindow: "known-absent", windows: [window()] })]),
      ],
      ...patch,
    });
  const points = (d: ReturnType<typeof run>) => d.candidates[0]!.windows[0]!.forecastPoints;
  const withLegacy = (reservations: AllocationReservation[] = []) =>
    run({
      inventories: [
        {
          ...inventory([account("a", { shortWindow: "known-absent", windows: [window()] })]),
          demand: [legacy()],
        },
      ],
      reservations,
    });

  it("uses the default for a legacy session without duration and respects a 15-minute incoming assignment", () => {
    // 5 points/hour with 1.5 rate uncertainty, for 1.5 hours ongoing + 0.375 hours incoming.
    expect(points(withLegacy())).toBe(14.0625);
    expect(withLegacy().selectedInstanceId).toBe("a");
    expect(withLegacy().request).toEqual({ ...request, expectedHours: 0.25 });
    expect(points(run())).toBe(2.8125);
    expect(points(run({ request: { ...request, expectedHours: 4 } }))).toBe(45);
    expect(points(run({ request: { ...request, expectedHours: 8 } }))).toBe(60);
    expect(points(run({ request: { ...request, workClass: "long" } }))).toBe(11.25);
    expect(run({ request: { ...request, expectedHours: 9 } }).reasons.join(" ")).toContain(
      "forecast horizon",
    );
  });

  it("retains and caps known remaining work without counting its live session twice", () => {
    const oneHourOld = "2026-10-23T11:00:00.000Z";
    expect(points(withLegacy([held(4, { createdAt: oneHourOld })]))).toBe(40.3125);
    expect(points(withLegacy([held(8)]))).toBe(62.8125);
    expect(points(withLegacy([held(8)]))).toBe(
      points(
        run({
          inventories: [
            {
              ...inventory([account("a", { shortWindow: "known-absent", windows: [window()] })]),
              complete: false,
            },
          ],
          reservations: [held(8)],
        }),
      ),
    );
    expect(points(withLegacy([held(0.25)]))).toBe(5.625);
    expect(points(withLegacy([held(undefined)]))).toBe(14.0625);
  });

  it("keeps active overdue estimates nonzero without inflating a short reservation to the default", () => {
    const createdAt = "2026-10-23T02:00:00.000Z";
    expect(points(withLegacy([held(0.25, { createdAt })]))).toBe(5.625);
    expect(points(withLegacy([held(4, { createdAt })]))).toBe(14.0625);
    expect(points(withLegacy([held(undefined, { createdAt })]))).toBe(14.0625);
    // No execution clock exists before consume: time spent waiting is not completed work.
    for (const state of ["reserved", "starting"] as const)
      expect(points(withLegacy([held(4, { createdAt, state })]))).toBe(47.8125);
    for (const state of ["released", "expired"] as const)
      expect(points(withLegacy([held(8, { state })]))).toBe(14.0625);
    expect(points(withLegacy([held(8, { state: "reserved", expiresAt: at })]))).toBe(14.0625);
    expect(points(run({ reservations: [held(8, { state: "released" })] }))).toBe(2.8125);
  });

  it("uses one accountwide measured floor over the longest relevant remaining horizon", () => {
    const measured = account("a", {
      shortWindow: "known-absent",
      windows: [
        window({
          ratePointsPerHour: 20,
          predictionErrorPointsPerHour: 1,
          samples: 8,
          rateAgeMinutes: 0,
        }),
      ],
    });
    const local = { ...inventory([measured]), demand: [legacy()] };
    const remote = {
      ...inventory([{ ...measured, environmentId: "remote" }]),
      environmentId: "remote",
    };
    // Aggregate floor 31.5 points/hour * 1.5 hours, plus the short incoming work.
    const result = run({ inventories: [local, remote] });
    expect(points(result)).toBe(50.0625);
    expect(result.reasons.join(" ")).toContain("bounded borrowing"); // Debt remains visible.
    expect(points(result)).toBe(points(run({ inventories: [local, { ...remote, accounts: [] }] })));
    expect(points(run({ inventories: [local], reservations: [held(4)] }))).toBe(191.8125);
    expect(points(run({ inventories: [inventory([measured])] }))).toBe(14.625);
  });

  it("clips to a reported upcoming reset but preserves exhaustion, rejection and stale-load warnings", () => {
    const make = (patch: Partial<AllocationAccount>) =>
      inventory([account("a", { shortWindow: "known-absent", windows: [window()], ...patch })]);
    const nearingReset = make({ windows: [window({ resetsAt: "2026-10-23T12:15:00.000Z" })] });
    expect(points(run({ inventories: [{ ...nearingReset, demand: [legacy()] }] }))).toBe(3.75);
    for (const inv of [
      make({ windows: [window({ usedPoints: 99 })] }),
      make({ available: false, unavailableReason: "Provider rejected the weekly window." }),
      make({ limitedUntil: "2026-10-23T14:00:00.000Z" }),
      { ...make({}), observedAt: "2026-10-23T11:00:00.000Z" },
      { ...make({}), complete: false },
      make({ windows: [window({ checkedAt: "2026-10-23T11:00:00.000Z" })] }),
    ])
      expect(run({ inventories: [inv] }).reasons.length).toBeGreaterThan(1);
    const debt = make({ windows: [window({ usedPoints: 80 })] });
    expect(run({ inventories: [debt] }).reasons.join(" ")).toContain("bounded borrowing");
    expect(
      run({
        inventories: [debt],
        request: {
          ...request,
          expectedHours: 0.25,
          explicitInstanceId: ProviderInstanceId.make("a"),
        },
      }).selectedInstanceId,
    ).toBe("a");
  });
});

it("keeps known local demand when shared identity is missing without equating remote aliases", () => {
  const local = account("a", { accountKey: null });
  const demand = {
    environmentId: "host",
    threadId: ThreadId.make("ongoing"),
    instanceId: local.instanceId,
    accountKey: null,
    model: "astra",
    options: request.options,
    state: "running" as const,
  };
  const run = (entries: (typeof demand)[]) =>
    decideAllocation({ ...input(), inventories: [{ ...inventory([local]), demand: entries }] });
  const empty = run([]),
    ongoing = run([demand]);
  expect(ongoing.selectedInstanceId).toBe("a");
  expect(ongoing.reasons.join(" ")).toContain("identity");
  expect(ongoing.candidates[0]!.windows[0]!.forecastPoints).toBeGreaterThan(
    empty.candidates[0]!.windows[0]!.forecastPoints,
  );
  expect(
    run([demand, { ...demand, environmentId: "other", threadId: ThreadId.make("remote") }])
      .candidates[0]!.windows,
  ).toEqual(ongoing.candidates[0]!.windows);
});

describe("advisory account preferences", () => {
  it("changes comparable recommendations deterministically without changing forecasts or warnings", () => {
    const before = decideAllocation(input());
    const weighted = {
      ...input(),
      policy: {
        ...defaultAllocationPolicy,
        accountWeights: [
          { key: allocationPreferenceKey(account("a")), weight: 10 },
          { key: allocationPreferenceKey(account("b")), weight: 90 },
        ],
      },
    };
    const after = decideAllocation(weighted);
    expect(before.selectedInstanceId).toBe("a");
    expect(after.selectedInstanceId).toBe("b");
    expect(after.candidates).toEqual(before.candidates);
    expect(
      decideAllocation({
        ...weighted,
        inventories: [inventory(inventory().accounts.toReversed())],
      }),
    ).toEqual(after);
  });
  it("never rejects explicit, native or allowed zero-weight accounts, including all-zero preferences", () => {
    const policy = {
      ...defaultAllocationPolicy,
      accountWeights: [
        { key: allocationPreferenceKey(account("a")), weight: 0 },
        { key: allocationPreferenceKey(account("b")), weight: 100 },
      ],
    };
    for (const constraint of [
      { explicitInstanceId: ProviderInstanceId.make("a") },
      { nativeInstanceId: ProviderInstanceId.make("a") },
      { allowedInstanceIds: [ProviderInstanceId.make("a")] },
    ]) {
      const choice = decideAllocation({
        ...input(),
        policy,
        request: { ...request, ...constraint },
      });
      expect(choice.selectedInstanceId).toBe("a");
      expect(choice.request.model).toBe(request.model);
      expect(choice.request.options).toEqual(request.options);
    }
    expect(
      decideAllocation({
        ...input(),
        policy: {
          ...policy,
          accountWeights: policy.accountWeights.map((w) => ({ ...w, weight: 0 })),
        },
      }).selectedInstanceId,
    ).toBe("a");
  });
  it("shares known identity across aliases but never guesses unknown identities or overrides actual incompatibility", () => {
    const a = account("a"),
      alias = account("remote-alias", { environmentId: "peer", accountKey: "a" });
    expect(allocationPreferenceKey(a)).toBe(allocationPreferenceKey(alias));
    expect(allocationPreferenceKey({ ...a, accountKey: null })).not.toBe(
      allocationPreferenceKey({ ...alias, accountKey: null }),
    );
    const result = decideAllocation({
      ...input(),
      inventories: [inventory([account("a", { models: [] }), account("b")])],
      policy: {
        ...defaultAllocationPolicy,
        accountWeights: [{ key: allocationPreferenceKey(a), weight: 100 }],
      },
    });
    expect(result.selectedInstanceId).toBe("b");
  });
});

describe("projected budget recommendations", () => {
  const policy = {
    ...defaultAllocationPolicy,
    uncertaintyMultiplier: 1,
    coldLongPointsPerHour: 2,
    coldShortPointsPerHour: 2,
    codex: {
      ...defaultAllocationPolicy.codex,
      burstPoints: 80,
      dailyPoints: 0,
      reservePoints: 20,
      borrowPoints: 0,
    },
  };
  const a = (id: string, usedPoints: number) =>
    account(id, {
      shortWindow: "known-absent",
      windows: [window({ usedPoints })],
    });
  const load = (id: string, threadId = id) => ({
    environmentId: "host",
    threadId: ThreadId.make(threadId),
    instanceId: ProviderInstanceId.make(id),
    accountKey: id,
    model: request.model,
    options: request.options,
    state: "running" as const,
  });
  const run = (
    accounts: AllocationAccount[],
    demand: AllocationDemand[] = [],
    patch: Partial<Parameters<typeof decideAllocation>[0]> = {},
  ) =>
    decideAllocation({
      ...input(),
      policy,
      inventories: [{ ...inventory(accounts), coordinatorEnvironmentId: null, demand }],
      ...patch,
    });
  const held = (
    d: AllocationDemand = load("SL"),
    state: AllocationReservation["state"] = "reserved",
  ): AllocationReservation => ({
    assignmentId: d.threadId,
    request: { ...request, environmentId: d.environmentId, threadId: d.threadId },
    accountKey: d.accountKey,
    instanceId: d.instanceId,
    createdAt: at,
    expiresAt: "2026-10-23T12:05:00.000Z",
    state,
    decision: decideAllocation(input()),
  });

  it("recommends AD at 19 points headroom over SL at 7 before either has a warning", () => {
    const decision = run(
      [a("SL", 61), a("AD", 59)],
      Array.from({ length: 5 }, (_, n) => load("SL", `session-${n}`)),
    );
    expect(decision.selectedInstanceId).toBe("AD");
    expect(decision.candidates.every((c) => c.warnings?.length === 0)).toBe(true);
    expect(decision.candidates.find((c) => c.instanceId === "SL")?.windows[0]).toMatchObject({
      actualPoints: 61,
      forecastPoints: 12,
      budgetPoints: 80,
      budgetHeadroomPoints: 7,
      runningForecastPoints: 10,
      queuedForecastPoints: 0,
      incomingForecastPoints: 2,
    });
    expect(decision.candidates.find((c) => c.instanceId === "AD")?.windows[0]).toMatchObject({
      actualPoints: 59,
      forecastPoints: 2,
      budgetHeadroomPoints: 19,
    });
    // Moving the same load changes the recommendation, without changing observed usage.
    expect(
      run(
        [a("SL", 61), a("AD", 59)],
        Array.from({ length: 5 }, (_, n) => load("AD", `session-${n}`)),
      ).selectedInstanceId,
    ).toBe("SL");
  });

  it("accounts for concurrent work despite a tiny pacing advantage or a maximum preference", () => {
    const accounts = [a("SL", 59), a("AD", 59.1)];
    const weighted = {
      ...policy,
      accountWeights: [
        { key: allocationPreferenceKey(accounts[0]!), weight: 100 },
        { key: allocationPreferenceKey(accounts[1]!), weight: 0 },
      ],
    };
    expect(run(accounts, [], { policy: weighted }).selectedInstanceId).toBe("SL");
    expect(run(accounts, [load("SL")], { policy: weighted }).selectedInstanceId).toBe("AD");
    expect(
      run(accounts, [load("SL")], {
        policy: weighted,
        request: { ...request, explicitInstanceId: accounts[0]!.instanceId },
      }).selectedInstanceId,
    ).toBe("SL");
  });

  it("uses the tighter short or weekly allowance and ignores unrelated model buckets", () => {
    const withShort = (id: string, weekly: number, short: number) => ({
      ...a(id, weekly),
      shortWindow: "reported" as const,
      windows: [
        window({ usedPoints: weekly }),
        window({ id: "short", kind: "session", usedPoints: short, durationHours: 5 }),
      ],
    });
    expect(run([withShort("a", 50, 70), withShort("b", 60, 20)]).selectedInstanceId).toBe("b");
    expect(run([withShort("a", 50, 20), withShort("b", 70, 10)]).selectedInstanceId).toBe("a");
    const scoped = a("a", 50);
    expect(
      run([
        {
          ...scoped,
          windows: [...scoped.windows, window({ id: "other", models: ["other"], usedPoints: 100 })],
        },
        a("b", 60),
      ]).selectedInstanceId,
    ).toBe("a");
  });

  it("uses released initial/daily budgets and borrowing rather than raw quota alone", () => {
    const accounts = [
      a("a", 50),
      {
        ...a("b", 60),
        windows: [window({ usedPoints: 60, cycleStartedAt: "2026-10-20T12:00:00.000Z" })],
      },
    ];
    const paced = {
      ...policy,
      codex: { ...policy.codex, burstPoints: 40, dailyPoints: 10, borrowPoints: 20 },
    };
    // a: 70 - 50 - 2 = 18; b: 80 - 60 - 2 = 18. Stable tie favors a.
    expect(run(accounts, [], { policy: paced }).selectedInstanceId).toBe("a");
    const daily = { ...paced, codex: { ...paced.codex, dailyPoints: 11 } };
    // a: 71 - 50 - 2 = 19; b: 80 - 60 - 2 = 18, still a.
    expect(run(accounts, [], { policy: daily }).selectedInstanceId).toBe("a");
    const early = { ...paced, codex: { ...paced.codex, burstPoints: 30 } };
    // a: 60 - 50 - 2 = 8; b: 80 - 60 - 2 = 18.
    expect(run(accounts, [], { policy: early }).selectedInstanceId).toBe("b");
  });

  it("counts queued, reserved and remote shared sessions once and excludes the incoming session", () => {
    const sl = a("SL", 59),
      ad = a("AD", 60);
    const live = load("SL", "live");
    const queued = { ...load("SL", "queued"), state: "pending" as const };
    const remote = {
      ...load("SL", "remote"),
      environmentId: "peer",
      instanceId: ProviderInstanceId.make("alias"),
    };
    const decision = run([sl, ad], [], {
      inventories: [
        {
          ...inventory([sl, ad]),
          demand: [live, live, queued, { ...load("SL"), threadId: request.threadId }],
        },
        {
          ...inventory([{ ...sl, environmentId: "peer", instanceId: remote.instanceId }]),
          environmentId: "peer",
          demand: [remote],
        },
      ],
      reservations: [
        held(live, "consumed"),
        held(queued),
        held(load("SL", "reserved")),
        held(load("SL", "released"), "released"),
        { ...held(load("SL", "expired")), expiresAt: at },
      ],
    });
    expect(decision.selectedInstanceId).toBe("AD");
    expect(decision.candidates.find((c) => c.instanceId === "SL")?.windows[0]).toMatchObject({
      runningForecastPoints: 4,
      queuedForecastPoints: 4,
      incomingForecastPoints: 2,
      forecastPoints: 10,
    });
  });

  it("drops confirmed idle consumed sessions but retains uncertain reservations on stale/missing peers", () => {
    const accounts = [a("SL", 59), a("AD", 60)];
    expect(
      run(accounts, [], { reservations: [held(load("SL"), "consumed")] }).selectedInstanceId,
    ).toBe("SL");
    for (const host of [
      { ...inventory(accounts), complete: false },
      { ...inventory(accounts), observedAt: "2026-10-23T11:00:00.000Z" },
    ]) {
      const d = run(accounts, [], {
        inventories: [host],
        reservations: [held(load("SL"), "consumed")],
      });
      expect(d.selectedInstanceId).toBe("AD");
      expect(d.confidence).toBe("low");
      expect(d.reasons.join(" ")).toContain("unconfirmed execution");
      expect(d.reasons.join(" ")).toContain("unknown or stale");
    }
    const missing = run(accounts, [], {
      reservations: [held({ ...load("SL"), environmentId: "offline" }, "consumed")],
    });
    expect(missing.selectedInstanceId).toBe("AD");
    expect(missing.confidence).toBe("low");
    expect(missing.reasons.join(" ")).toContain("unconfirmed execution");
    const unknown = run([a("SL", 59), { ...a("AD", 0), windows: [], shortWindow: "unknown" }]);
    expect(unknown.selectedInstanceId).toBe("SL");
    expect(unknown.candidates.find((c) => c.instanceId === "AD")?.warnings?.join(" ")).toContain(
      "No measured allowance",
    );
  });

  it("forecasts each ongoing model/effort with its own variability and reserved duration", () => {
    const sl = {
      ...a("SL", 50),
      profileUncertainty: 2,
      usageProfiles: [
        {
          model: "sol",
          effort: "max",
          contextBand: "under32k",
          samples: 8,
          observedAt: at,
          outputTokensPerHour: 50,
          uncertainty: 1.5,
        },
        {
          model: "sol",
          effort: "high",
          contextBand: "under32k",
          samples: 8,
          observedAt: at,
          outputTokensPerHour: 50,
          uncertainty: 2,
        },
      ],
    };
    const d = { ...load("SL"), model: "sol", options: [{ id: "reasoningEffort", value: "max" }] };
    const reservation = {
      ...held(d),
      request: { ...held(d).request, model: d.model, options: d.options, expectedHours: 2 },
    };
    const decision = run([sl], [d], { reservations: [reservation] });
    expect(decision.candidates[0]?.windows[0]).toMatchObject({
      runningForecastPoints: 6,
      incomingForecastPoints: 4,
      forecastPoints: 10,
    });
    expect(
      run([{ ...sl, usageProfiles: [] }], [d], { reservations: [reservation] }).candidates[0]
        ?.windows[0]?.runningForecastPoints,
    ).toBe(4);
  });
});

it("missing or stale advisory load lowers confidence without claiming the reachable coordinator failed", () => {
  const known = inventory([
    account("chosen", {
      profileSamples: defaultAllocationPolicy.minimumSamples,
      shortWindow: "known-absent",
      windows: [
        window({
          samples: defaultAllocationPolicy.minimumSamples,
          ratePointsPerHour: 1,
          rateAgeMinutes: 0,
        }),
      ],
    }),
  ]);
  const base = {
    ...input(),
    inventories: [known],
    request: { ...request, explicitInstanceId: ProviderInstanceId.make("chosen") },
  };
  expect(decideAllocation(base).confidence).toBe("medium");
  for (const observer of [
    { ...inventory([]), environmentId: "observer", complete: false },
    { ...inventory([]), environmentId: "observer", observedAt: "2026-10-01T00:00:00.000Z" },
  ]) {
    const decision = decideAllocation({ ...base, inventories: [known, observer] });
    expect(decision.selectedInstanceId).toBe("chosen");
    expect(decision.confidence).toBe("low");
    expect(decision.reasons.join(" ")).toContain("unknown or stale");
    expect(decision.reasons.join(" ")).not.toContain("coordinator unavailable");
  }
});

it("keeps worker availability local to each instance, including shared logins on peers", () => {
  const disabled = account("disabled", { availableForWorkers: false, accountKey: "shared" });
  const enabled = account("enabled", { accountKey: "shared" });
  const elsewhere = account("disabled", { environmentId: "peer", accountKey: "shared" });
  const result = decideAllocation({
    ...input(),
    inventories: [
      inventory([disabled, enabled]),
      { ...inventory([elsewhere]), environmentId: "peer" },
    ],
  });
  expect(result.selectedInstanceId).toBe("enabled");
  expect(
    result.candidates.find((c) => c.environmentId === "host" && c.instanceId === "disabled")
      ?.eligible,
  ).toBe(false);
  expect(
    decideAllocation({
      ...input(),
      inventories: [inventory([disabled]), { ...inventory([elsewhere]), environmentId: "peer" }],
      request: { ...request, environmentId: "peer" },
    }).selectedInstanceId,
  ).toBe("disabled");
});
