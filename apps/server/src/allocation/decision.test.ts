import { describe, expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationAccount,
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
    expect(targetPoints(window(), defaultAllocationPolicy.claude, at)).toBeCloseTo(95 / 7);
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
describe("deterministic admission", () => {
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
      expect(result.outcome).toBe("unavailable");
      expect(result.waitUntil).toBeNull();
    }
  });
  it("estimates the latest blocking reset of a compatible candidate, conditional on fresh confirmation", () => {
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
      outcome: "wait",
      waitUntil: "2026-10-23T19:00:00.000Z",
    });
    expect(decideAllocation({ ...x, authorityAvailable: false })).toMatchObject({
      outcome: "unavailable",
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
  it("rejects unsafe short windows despite weekly underuse or reset credits", () => {
    const a = account("a", {
      windows: [
        window({ usedPoints: 0 }),
        window({ id: "short", kind: "session", usedPoints: 99 }),
      ],
      resetCredits: { count: 2, expiresAt: null, scope: "unknown" },
    });
    expect(
      decideAllocation({ ...input(), inventories: [inventory([a])] }).selectedInstanceId,
    ).toBeNull();
  });
  it("requires confirmed replenishment and fresh readings, including arbitrary model buckets", () => {
    for (const w of [
      window({ resetsAt: at }),
      window({ checkedAt: "2026-10-23T11:00:00.000Z" }),
      window({ id: "astra-special", models: ["astra"], usedPoints: 100 }),
    ]) {
      expect(
        decideAllocation({ ...input(), inventories: [inventory([account("a", { windows: [w] })])] })
          .selectedInstanceId,
      ).toBeNull();
    }
  });
  it("distinguishes missing short data from a provider's known absence", () => {
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([account("a", { shortWindow: "unknown" })])],
      }).selectedInstanceId,
    ).toBeNull();
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
    expect(decideAllocation({ ...input(), authorityAvailable: false }).outcome).toBe("unavailable");
    expect(
      decideAllocation({
        ...input(),
        inventories: [inventory([account("a", { accountKey: null })])],
      }).selectedInstanceId,
    ).toBeNull();
    expect(
      decideAllocation({ ...input(), inventories: [{ ...inventory(), complete: false }] }).outcome,
    ).toBe("unavailable");
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
    ).toBeNull();
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
    expect(d.selectedInstanceId).toBeNull();
    expect(d.candidates.find((c) => c.environmentId === "host")?.reasons.join(" ")).toContain(
      "shared account",
    );
  });
  it("uses the newest shared window and rejects an omitted stale short window", () => {
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
    ).toBeNull();
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
      }).candidates[0]?.reasons.join(" "),
    ).toContain("stale");
  });
  it("protects model buckets independently and requires an applicable short reading", () => {
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
    ).toBeNull();
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
    ).toBeNull();
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
    ).toBeNull();
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
  expect(merged.selectedInstanceId).toBeNull();
  expect(merged.candidates[0]?.windows[0]?.forecastPoints).toBeCloseTo(
    alone.candidates[0]?.windows[0]?.forecastPoints ?? 0,
    1,
  );
  expect(merged.candidates[0]?.windows[0]?.forecastPoints).toBeGreaterThan(250);
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

it("charges completed borrowing against cumulative consumption and preserves explicit pacing override", () => {
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
  expect(run(consumed).selectedInstanceId).toBeNull();
  expect(run(80).selectedInstanceId).toBeNull();
  expect(run(80, true).selectedInstanceId).toBe("a");
  expect(run(95, true).selectedInstanceId).toBeNull();
});
