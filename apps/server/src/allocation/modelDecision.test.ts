import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  allocationPreferenceKey,
  AssignmentAssessment,
  defaultAllocationPolicy,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  MODEL_SCORES,
  ModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationAccount,
  type AllocationInventory,
  type AllocationLearned,
  type AllocationPolicy,
  type AllocationWindow,
  type ModelRoutingRequest,
  type RoutingCell,
  type RoutingProfile,
} from "@t3tools/contracts";
import {
  chooseProfile,
  ladderPosition,
  modelPolicyWarnings,
  nearestRungs,
  wantedProfiles,
  type ProfileChoice,
} from "./modelDecision.ts";

const at = "2026-10-23T12:00:00.000Z";
const inHours = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + hours * 3_600_000));
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const models = (driver: string, slugs: readonly string[]) =>
  slugs.map((slug) => ({
    slug,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          type: "select" as const,
          label: "Effort",
          options: EFFORTS.map((id) => ({ id, label: id })),
        },
      ],
    },
  }));
// The default ladder's models, weakest first: haiku max, sonnet high, opus medium, sonnet xhigh,
// opus high, fable low, opus xhigh, fable medium, fable high.
const HAIKU = defaultModelLadder[0]!.model;
const SONNET = defaultModelLadder[1]!.model;
const OPUS = defaultModelLadder[2]!.model;
const FABLE = defaultModelLadder[8]!.model;
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
/** A model's own weekly window, such as "Weekly · Fable". */
const only = (slug: string, usedPoints: number, patch: Partial<AllocationWindow> = {}) =>
  weekly(usedPoints, { id: `weekly_${slug}`, label: `Weekly · ${slug}`, models: [slug], ...patch });
const account = (
  label: string,
  driver: ProviderDriverKind,
  slugs: readonly string[],
  windows: AllocationWindow[],
  patch: Partial<AllocationAccount> = {},
): AllocationAccount => ({
  environmentId: "host",
  instanceId: ProviderInstanceId.make(label),
  driver,
  label,
  accountKey: label,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  shortWindow: "unknown",
  windows,
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  models: models(driver, slugs),
  ...patch,
});
/** A Claude account 20% into its week unless `windows` says otherwise. */
const claude = (
  label: string,
  windows: AllocationWindow[] = [weekly(20)],
  patch: Partial<AllocationAccount> = {},
) => account(label, claudeAgent, [HAIKU, SONNET, OPUS, FABLE], windows, patch);
const gpt = (label: string, windows: AllocationWindow[] = [weekly(20)]) =>
  account(label, codex, ["gpt-6.1-sol", "gpt-6-astra"], windows);
/** DeepSeek as the user runs it: a Codex-protocol account without usage windows. */
const deepseek = account("DS", codex, ["deepseek-flash"], []);
const host = (accounts: AllocationAccount[]): AllocationInventory => ({
  environmentId: "host",
  observedAt: at,
  complete: true,
  notices: [],
  demand: [],
  accounts,
});
const request: ModelRoutingRequest = {
  selection: "automatic",
  assignmentId: "one",
  environmentId: "host",
  threadId: ThreadId.make("one"),
  allowedDrivers: [claudeAgent],
  assessment: { difficulty: 0, stakes: 0 },
};
/** The default policy with every Claude table entry set to `profile`. */
const wanting = (profile: RoutingProfile, patch: Partial<ModelRoutingPolicy> = {}) => ({
  ...defaultModelRoutingPolicy,
  claudeAgent: {
    allowedModels: [HAIKU, SONNET, OPUS, FABLE],
    cells: defaultModelRoutingPolicy.claudeAgent.cells.map((row) => row.map(() => profile)),
  },
  ...patch,
});
/**
 * Every model costs a worker $10 an hour (a master $4); every weekly window, account-wide or a
 * model's own, holds $10,000 of use. Ranking then follows the percentages, as on equal plans.
 */
const learned = (accounts: readonly AllocationAccount[]): AllocationLearned => ({
  learnedAt: at,
  workerHours: 2,
  notes: [],
  costs: accounts.flatMap((a) =>
    a.models.flatMap((m) =>
      (["worker", "master"] as const).map((kind) => ({
        driver: a.driver,
        model: m.slug,
        effort: "high",
        kind,
        dollarsPerHour: kind === "worker" ? 10 : 4,
        perHundredK: 0,
        contextTokens: 100_000,
        samples: 50,
        hours: 20,
        source: "measured" as const,
      })),
    ),
  ),
  limits: accounts.flatMap((a) =>
    a.windows.map((w) => ({
      key: allocationPreferenceKey(a),
      label: a.label,
      driver: a.driver,
      windowId: w.id,
      windowLabel: w.label,
      plan: null,
      percentPerDollar: 0.01,
      backgroundPercentPerHour: 0,
      samples: 40,
      hours: 100,
      source: "measured" as const,
    })),
  ),
});
const noGoals = { claude: undefined, codex: undefined, other: undefined };
const choose = (
  accounts: AllocationAccount[],
  wanted: RoutingProfile,
  patch: {
    request?: Partial<ModelRoutingRequest>;
    modelPolicy?: Partial<ModelRoutingPolicy>;
    policy?: Partial<AllocationPolicy>;
    learned?: AllocationLearned;
  } = {},
) =>
  chooseProfile({
    at,
    policy: { ...defaultAllocationPolicy, ...noGoals, ...patch.policy },
    modelPolicy: wanting(wanted, patch.modelPolicy),
    request: { ...request, ...patch.request },
    inventories: [host(accounts)],
    reservations: [],
    authorityAvailable: true,
    learned: patch.learned ?? learned(accounts),
  });
/** `account model / effort`, or null when the start is refused. */
const picked = (choice: ProfileChoice) => {
  const chosen = choice.decision?.request;
  return chosen
    ? `${choice.decision!.selectedInstanceId} ${chosen.model} / ${chosen.options[0]!.value}`
    : null;
};
const wantedLabel = (choice: ProfileChoice) =>
  choice.wanted ? `${choice.wanted.model} / ${choice.wanted.options[0]!.value}` : undefined;
const drainedEverywhere = (slug: string) => [
  claude("A", [weekly(20), only(slug, 100, { resetsAt: inHours(30) })]),
  claude("B", [weekly(60), only(slug, 100, { resetsAt: inHours(7) })]),
];

describe("account, model and effort together", () => {
  it("moves to another account before it changes the model", () => {
    const choice = choose(
      [claude("A", [weekly(20), only(FABLE, 100)]), claude("B", [weekly(60)])],
      { model: FABLE, effort: "medium" },
    );
    expect(picked(choice)).toBe(`B ${FABLE} / medium`);
    expect(choice.wanted).toBeUndefined();
    expect(choice.drainedUntil).toBeUndefined();
    expect(choice.tried).toHaveLength(1);
    expect(choice.accounts).toEqual([
      `A: drained until ${inHours(100)} (Weekly · ${FABLE} 100% used), 0 workers`,
      `B: room for about 4 more ${FABLE} / medium workers until the Weekly reset in 4d; tightest limit Weekly, 0 workers`,
    ]);
  });

  it("takes the nearest rung when the wanted model is drained on every account", () => {
    const opus = choose(drainedEverywhere(OPUS), { model: OPUS, effort: "high" });
    // Sonnet xhigh and Fable low are equally near Opus high: the tie goes to the lower rung.
    expect(picked(opus)).toBe(`A ${SONNET} / xhigh`);
    expect(wantedLabel(opus)).toBe(`${OPUS} / high`);
    expect(opus.reason).toContain(
      `${OPUS} / high is drained on every account (earliest reset ${inHours(7)}); the nearest ladder rung that fits is ${SONNET} / xhigh.`,
    );
    expect(opus.tried.map((t) => [t.request.model, t.chosen])).toEqual([
      [OPUS, false],
      [SONNET, true],
    ]);

    // With the lower neighbour drained too, the upper one.
    const both = choose(
      drainedEverywhere(OPUS).map((a) => ({ ...a, windows: [...a.windows, only(SONNET, 100)] })),
      { model: OPUS, effort: "high" },
    );
    expect(picked(both)).toBe(`A ${FABLE} / low`);

    // Nearest by position, not the next weaker model: Fable's other rungs are drained with it.
    expect(picked(choose(drainedEverywhere(FABLE), { model: FABLE, effort: "high" }))).toBe(
      `A ${OPUS} / xhigh`,
    );
    expect(picked(choose(drainedEverywhere(HAIKU), { model: HAIKU, effort: "max" }))).toBe(
      `A ${SONNET} / high`,
    );
  });

  it("follows the policy's ladder", () => {
    const ladder = [
      { model: HAIKU, effort: "max" },
      { model: OPUS, effort: "high" },
      { model: FABLE, effort: "low" },
      { model: SONNET, effort: "high" },
    ];
    const choice = choose(
      drainedEverywhere(OPUS),
      { model: OPUS, effort: "high" },
      {
        modelPolicy: { ladder },
      },
    );
    expect(picked(choice)).toBe(`A ${HAIKU} / max`);
  });

  it("places a profile that is not a rung between its model's rungs by effort", () => {
    const rungs = (profile: RoutingProfile) =>
      nearestRungs(
        [
          { model: HAIKU, effort: "max" },
          { model: OPUS, effort: "medium" },
          { model: SONNET, effort: "xhigh" },
          { model: OPUS, effort: "xhigh" },
        ],
        profile,
      ).map((r) => `${r.model} / ${r.effort}`);
    // Opus high stands between Opus medium and Sonnet xhigh; the tie goes to the lower rung.
    expect(rungs({ model: OPUS, effort: "high" }).slice(0, 2)).toEqual([
      `${OPUS} / medium`,
      `${SONNET} / xhigh`,
    ]);
    // An older Opus is still Opus; a model the ladder does not know has no neighbours.
    expect(
      ladderPosition([{ model: OPUS, effort: "high" }], {
        model: "claude-opus-4-8",
        effort: "high",
      }),
    ).toBe(0);
    expect(rungs({ model: "gpt-6-astra", effort: "high" })).toEqual([]);
  });

  it("uses the fallback only when no Claude rung has room and the wanted rung is below the threshold", () => {
    const drained = [
      claude("A", [weekly(100, { resetsAt: inHours(30) })]),
      claude("B", [weekly(100, { resetsAt: inHours(7) })]),
      deepseek,
    ];
    for (const below of [
      { model: HAIKU, effort: "max" },
      { model: SONNET, effort: "high" },
      { model: OPUS, effort: "medium" },
    ]) {
      const choice = choose(drained, below);
      expect(picked(choice)).toBe("DS deepseek-flash / max");
      expect(choice.decision!.request).toMatchObject({
        driver: "codex",
        options: [{ id: "reasoningEffort", value: "max" }],
      });
      expect(wantedLabel(choice)).toBe(`${below.model} / ${below.effort}`);
      expect(choice.reason).toContain(
        `no Claude rung within 2 fits, and below ${SONNET} / xhigh the fallback deepseek-flash / max applies.`,
      );
    }
    for (const atOrAbove of [
      { model: SONNET, effort: "xhigh" },
      { model: OPUS, effort: "high" },
      { model: FABLE, effort: "high" },
    ]) {
      const choice = choose(drained, atOrAbove);
      expect(picked(choice)).toBeNull();
      expect(choice.drainedUntil).toBe(inHours(7));
      expect(choice.wanted).toBeUndefined();
      expect(choice.reason).toBe(
        `Drained: ${atOrAbove.model} / ${atOrAbove.effort} and every model that may stand in for it are out; earliest reset ${inHours(7)}.`,
      );
      expect(choice.accounts).toHaveLength(2);
    }

    // A Claude rung with room is used before the fallback.
    const haikuLeft = claude("A", [
      weekly(20),
      only(SONNET, 100),
      only(OPUS, 100),
      only(FABLE, 100),
    ]);
    expect(picked(choose([haikuLeft, deepseek], { model: SONNET, effort: "high" }))).toBe(
      `A ${HAIKU} / max`,
    );
    // The threshold, the model and the switch itself are policy.
    const opusHigh = { model: OPUS, effort: "high" };
    expect(
      picked(
        choose(drained, opusHigh, {
          modelPolicy: {
            fallback: {
              model: "deepseek-flash",
              effort: "high",
              below: { model: OPUS, effort: "xhigh" },
            },
          },
        }),
      ),
    ).toBe("DS deepseek-flash / high");
    const off = choose(
      drained,
      { model: SONNET, effort: "high" },
      { modelPolicy: { fallback: null } },
    );
    expect(picked(off)).toBeNull();
    expect(off.drainedUntil).toBe(inHours(7));
    // No account offers the fallback model: refused as drained.
    const none = choose(drained.slice(0, 2), { model: SONNET, effort: "high" });
    expect(picked(none)).toBeNull();
    expect(none.drainedUntil).toBe(inHours(7));
  });

  it("refuses a pinned account that is drained and never substitutes", () => {
    const accounts = [
      claude("A", [weekly(20), only(FABLE, 100, { resetsAt: inHours(9) })]),
      claude("B"),
      deepseek,
    ];
    const pinned = { explicitInstanceId: ProviderInstanceId.make("A") };
    const refused = choose(accounts, { model: FABLE, effort: "medium" }, { request: pinned });
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(9));
    expect(refused.reason).toContain("a pinned account is exact.");
    expect(refused.tried).toHaveLength(1);
    // Below the fallback threshold too: the pin is exact.
    const low = choose(
      [claude("A", [weekly(100, { resetsAt: inHours(9) })]), claude("B"), deepseek],
      { model: SONNET, effort: "high" },
      { request: pinned },
    );
    expect(picked(low)).toBeNull();
    expect(low.drainedUntil).toBe(inHours(9));
    // With room there, the pin is honoured against an account with more.
    expect(
      picked(
        choose(
          [claude("A", [weekly(90)]), claude("B")],
          { model: FABLE, effort: "medium" },
          { request: pinned },
        ),
      ),
    ).toBe(`A ${FABLE} / medium`);
  });

  it("starts from a pinned model and substitutes from there", () => {
    const table = { model: SONNET, effort: "high" };
    const pin = (options?: { id: string; value: string }[]) => ({
      override: { driver: claudeAgent, model: FABLE, ...(options ? { options } : {}) },
    });
    // A model-only pin takes the table's effort.
    const free = choose([claude("A"), claude("B", [weekly(60)])], table, { request: pin() });
    expect(picked(free)).toBe(`A ${FABLE} / high`);
    expect(free.wanted).toBeUndefined();
    expect(free.rule).toBe("Difficulty 0, stakes 0; model pinned");
    expect(
      picked(choose([claude("A")], table, { request: pin([{ id: "effort", value: "low" }]) })),
    ).toBe(`A ${FABLE} / low`);

    const drained = choose(drainedEverywhere(FABLE), table, { request: pin() });
    expect(picked(drained)).toBe(`A ${OPUS} / xhigh`);
    expect(wantedLabel(drained)).toBe(`${FABLE} / high`);
  });

  it("counts a reached hard cap as drained", () => {
    const cap = {
      accountCaps: [
        {
          key: allocationPreferenceKey(claude("A")),
          weeklyPercent: 80,
          fiveHourPercent: null,
          stopWorkers: true,
          stopMasters: false,
        },
      ],
    };
    const wanted = { model: FABLE, effort: "medium" };
    // A has more of its allowance left than B, but is at its cap.
    const moved = choose([claude("A", [weekly(85)]), claude("B", [weekly(90)])], wanted, {
      policy: cap,
    });
    expect(picked(moved)).toBe(`B ${FABLE} / medium`);
    expect(moved.wanted).toBeUndefined();
    const alone = choose([claude("A", [weekly(85, { resetsAt: inHours(40) })])], wanted, {
      policy: cap,
    });
    expect(picked(alone)).toBeNull();
    expect(alone.drainedUntil).toBe(inHours(40));
    expect(picked(choose([claude("A", [weekly(85)])], wanted))).toBe(`A ${FABLE} / medium`);
  });

  it("drains only the model a model-scoped window or rejection applies to", () => {
    const wanted = { model: FABLE, effort: "high" };
    const window = choose([claude("A", [weekly(20), only(FABLE, 100)])], wanted);
    expect(picked(window)).toBe(`A ${OPUS} / xhigh`);
    expect(wantedLabel(window)).toBe(`${FABLE} / high`);

    const windows = [weekly(20), only(FABLE, 50)];
    const rejected = choose(
      [
        claude("A", windows, {
          limitedUntil: inHours(5),
          limits: [{ windowId: `weekly_${FABLE}`, until: inHours(5) }],
        }),
      ],
      wanted,
    );
    expect(picked(rejected)).toBe(`A ${OPUS} / xhigh`);
    expect(rejected.reason).toContain(`the nearest ladder rung that fits is ${OPUS} / xhigh`);

    // A rejection that names no window closes the whole account.
    for (const patch of [
      { limitedUntil: inHours(5) },
      { limits: [{ windowId: null, until: inHours(5) }] },
    ]) {
      const closed = choose([claude("A", windows, patch)], wanted);
      expect(picked(closed)).toBeNull();
      expect(closed.drainedUntil).toBe(inHours(5));
    }
  });

  it("never changes the model for a nearly used, stale or fast-burning window", () => {
    const wanted = { model: FABLE, effort: "high" };
    for (const patch of [
      {},
      { checkedAt: inHours(-90) },
      { ratePointsPerHour: 90, samples: 20, rateAgeMinutes: 0, resetsAt: inHours(160) },
    ]) {
      const choice = choose([claude("A", [weekly(99, patch), only(FABLE, 99, patch)])], wanted);
      expect(picked(choice)).toBe(`A ${FABLE} / high`);
      expect(choice.wanted).toBeUndefined();
      expect(choice.tried).toHaveLength(1);
    }
    // The account with more room takes it; the model stays.
    expect(
      picked(
        choose([claude("A", [weekly(99), only(FABLE, 99)]), claude("B", [weekly(70)])], wanted),
      ),
    ).toBe(`B ${FABLE} / high`);
  });

  it("gives Codex the same drained rule and ranking, and never another model", () => {
    const forCodex = { allowedDrivers: [codex] };
    const table = { model: OPUS, effort: "high" };
    const sol = (used: number, hours = 100) =>
      only("gpt-6.1-sol", used, { resetsAt: inHours(hours) });
    const pick = (accounts: AllocationAccount[], policy: Partial<AllocationPolicy> = {}) =>
      choose(accounts, table, { request: forCodex, policy });
    // The default Codex table wants gpt-6.1-sol / medium for difficulty 0, stakes 0.
    expect(picked(pick([gpt("SL", [weekly(50)]), gpt("AD", [weekly(30)])]))).toBe(
      "AD gpt-6.1-sol / medium",
    );
    expect(picked(pick([gpt("SL", [weekly(20), sol(100)]), gpt("AD", [weekly(90)])]))).toBe(
      "AD gpt-6.1-sol / medium",
    );
    const order = { accountOrder: [allocationPreferenceKey(gpt("SL"))] };
    expect(picked(pick([gpt("SL", [weekly(35)]), gpt("AD", [weekly(30)])], order))).toBe(
      "SL gpt-6.1-sol / medium",
    );
    expect(picked(pick([gpt("SL", [weekly(45)]), gpt("AD", [weekly(30)])], order))).toBe(
      "AD gpt-6.1-sol / medium",
    );
    // Drained on every account: refused, though Astra, Claude and the fallback all have room.
    const refused = pick([
      gpt("SL", [weekly(20), sol(100, 30)]),
      gpt("AD", [weekly(20), sol(100, 7)]),
      claude("A"),
      deepseek,
    ]);
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(7));
    expect(refused.tried).toHaveLength(1);
  });

  it("uses Codex only when the start asks for it", () => {
    const both = { allowedDrivers: [codex, claudeAgent] };
    const wanted = { model: SONNET, effort: "high" };
    expect(
      picked(
        choose([gpt("SL", [weekly(0)]), claude("A", [weekly(90)])], wanted, { request: both }),
      ),
    ).toBe(`A ${SONNET} / high`);
    expect(picked(choose([gpt("SL"), claude("A")], wanted))).toBe(`A ${SONNET} / high`);
  });

  it("is unavailable, not drained, when no account offers the wanted model", () => {
    const choice = choose([gpt("SL")], { model: SONNET, effort: "high" });
    expect(picked(choice)).toBeNull();
    expect(choice.drainedUntil).toBeUndefined();
    expect(choice.reason).toContain(`no account on this computer offers ${SONNET} / high`);
  });
});

describe("the table", () => {
  const inventory = host([
    account("codex", codex, defaultModelRoutingPolicy.codex.allowedModels, []),
    account("claudeAgent", claudeAgent, defaultModelRoutingPolicy.claudeAgent.allowedModels, []),
  ]);
  const forCodex: ModelRoutingRequest = { ...request, allowedDrivers: [codex] };
  const decodePolicy = Schema.decodeUnknownSync(ModelRoutingPolicy);
  const assess = (difficulty: number, stakes: number): ModelRoutingRequest => ({
    ...forCodex,
    assessment: { difficulty, stakes },
  });
  /** The table's choice as "model/effort", or null when no account offers it. */
  const choice = (policy: ModelRoutingPolicy, difficulty: number, stakes: number) => {
    const [candidate] = wantedProfiles(policy, assess(difficulty, stakes), [inventory]).candidates;
    return candidate ? `${candidate.request.model}/${candidate.request.options[0]!.value}` : null;
  };
  const withCell = (
    policy: ModelRoutingPolicy,
    difficulty: number,
    stakes: number,
    cell: RoutingCell,
  ): ModelRoutingPolicy => ({
    ...policy,
    codex: {
      ...policy.codex,
      cells: policy.codex.cells.map((row, d) =>
        row.map((existing, s) => (d === difficulty && s === stakes ? cell : existing)),
      ),
    },
  });
  // How scores were grouped before exact-score tables: 0-3, 4-6, then 7, 8, 9 and 10.
  const band = (score: number) => (score <= 3 ? 0 : score <= 6 ? 1 : score - 5);
  const defaults = [
    "gpt-6.1-sol/medium",
    "gpt-6.1-sol/high",
    "gpt-6.1-sol/max",
    "gpt-6-astra/medium",
    "gpt-6-astra/high",
    "gpt-6-astra/xhigh",
  ];
  const bands = [
    [1, 2, 2, 4, 5, 5],
    [2, 2, 3, 4, 5, 5],
    [3, 3, 4, 5, 5, 6],
    [3, 4, 5, 5, 6, 6],
    [5, 5, 5, 6, 6, 6],
    [6, 6, 6, 6, 6, 6],
  ];

  it("gives one choice for every score pair", () => {
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES) {
        const result = wantedProfiles(defaultModelRoutingPolicy, assess(difficulty, stakes), [
          inventory,
        ]);
        expect(result.candidates).toHaveLength(1);
        expect(choice(defaultModelRoutingPolicy, difficulty, stakes)).toBe(
          defaults[bands[band(difficulty)]![band(stakes)]! - 1],
        );
        expect(result.rule).toBe(`Difficulty ${difficulty}, stakes ${stakes}`);
      }
  });

  it("changes only the exact score pair that was edited, even where the old bands were shared", () => {
    const edited = withCell(defaultModelRoutingPolicy, 5, 2, {
      model: "gpt-6-astra",
      effort: "xhigh",
    });
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES)
        expect(choice(edited, difficulty, stakes)).toBe(
          difficulty === 5 && stakes === 2
            ? "gpt-6-astra/xhigh"
            : choice(defaultModelRoutingPolicy, difficulty, stakes),
        );
  });

  it("resolves a saved band table exactly as the band lookup did for all 121 pairs", () => {
    const legacy = {
      version: 4,
      codex: {
        profiles: [
          { model: "gpt-6.1-sol", effort: "medium" },
          { model: "gpt-6.1-sol", effort: "ultra" },
          { model: "gpt-6-astra", effort: "high" },
          { model: "gpt-6-luna", effort: "high" },
          { model: "gpt-6-astra", effort: "medium" },
          { model: "gpt-6.1-sol", effort: "max" },
        ],
        grid: [
          [1, 2, 3, 4, 5, 6],
          [2, 2, 3, 4, 5, 6],
          [3, 3, 4, 5, 5, 1],
          [4, 4, 5, 5, 6, 6],
          [5, 5, 2, 6, 6, 6],
          [6, 6, 6, 2, 6, 1],
        ],
        alternatives: [[], [3, 6], [5], [1], [], []],
        allowedModels: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
      },
      claudeAgent: defaultModelRoutingPolicy.claudeAgent,
      maxReassessments: 2,
    };
    const policy = decodePolicy(legacy);
    // The selected profile, then its configured alternatives, skipping ones no account offers.
    const offered = (p: { model: string; effort: string }) =>
      EFFORTS.includes(p.effort) && !/luna/.test(p.model);
    let alternativeUsed = false;
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES) {
        const id = legacy.codex.grid[band(difficulty)]![band(stakes)]!;
        const choices = [id, ...legacy.codex.alternatives[id - 1]!].map(
          (n) => legacy.codex.profiles[n - 1]!,
        );
        const expected = choices.find(offered);
        alternativeUsed ||= expected !== undefined && expected !== choices[0];
        expect(choice(policy, difficulty, stakes)).toBe(
          expected ? `${expected.model}/${expected.effort}` : null,
        );
      }
    expect(alternativeUsed).toBe(true);
  });

  it("keeps independent provider tables and asks Claude first", () => {
    const opus = { model: OPUS, effort: "xhigh" };
    const policy = {
      ...defaultModelRoutingPolicy,
      claudeAgent: {
        ...defaultModelRoutingPolicy.claudeAgent,
        cells: defaultModelRoutingPolicy.claudeAgent.cells.map((r) => r.map(() => opus)),
      },
    };
    const result = wantedProfiles(policy, { ...forCodex, allowedDrivers: [codex, claudeAgent] }, [
      inventory,
    ]);
    expect(result.candidates.map((c) => [c.request.driver, c.request.model])).toEqual([
      ["claudeAgent", OPUS],
      ["codex", "gpt-6.1-sol"],
    ]);
  });

  it("needs two whole scores from 0 to 10 and no reasons", () => {
    const decode = Schema.decodeUnknownSync(AssignmentAssessment);
    expect(decode({ difficulty: 3, stakes: 10 })).toEqual({ difficulty: 3, stakes: 10 });
    // A build from before smart allocation still sends reasons.
    expect(
      decode({ difficulty: 0, stakes: 0, difficultyReason: "Routine", stakesReason: "Reversible" }),
    ).toMatchObject({ difficultyReason: "Routine" });
    for (const value of [
      undefined,
      {},
      { difficulty: 3 },
      { difficulty: -1, stakes: 0 },
      { difficulty: 0, stakes: 11 },
      { difficulty: 4.5, stakes: 0 },
    ])
      expect(() => decode(value)).toThrow();
  });

  it("uses a configured alternative only when no account offers the entry itself", () => {
    const changed = withCell(defaultModelRoutingPolicy, 0, 0, {
      model: "missing",
      effort: "medium",
      alternatives: [
        { model: "gpt-6-luna", effort: "high" },
        { model: "gpt-6-astra", effort: "medium" },
      ],
    });
    const result = wantedProfiles(changed, forCodex, [inventory]);
    expect(result.candidates[0]!.reason).toContain("table alternative");
    expect(choice(changed, 0, 0)).toBe("gpt-6-astra/medium");
    const none = wantedProfiles(
      withCell(changed, 0, 0, { model: "missing", effort: "medium" }),
      forCodex,
      [inventory],
    );
    expect(none.candidates).toHaveLength(0);
    expect(none.reasons.join(" ")).toContain("no account on this computer offers missing / medium");
    expect(wantedProfiles(defaultModelRoutingPolicy, forCodex, [host([])]).candidates).toHaveLength(
      0,
    );
  });

  it("takes a model the code does not list straight from the table", () => {
    const slugs = [HAIKU, "claude-next-9"];
    const claudeInventory = host([account("claude", claudeAgent, slugs, [])]);
    const table = defaultModelRoutingPolicy.claudeAgent;
    const policy = {
      ...defaultModelRoutingPolicy,
      claudeAgent: {
        // The model list does not gate a choice.
        allowedModels: table.allowedModels,
        cells: table.cells.map((row, d) =>
          row.map((cell, s) =>
            d === 0 && s === 0
              ? { model: HAIKU, effort: "max" }
              : d === 10 && s === 10
                ? { model: "claude-next-9", effort: "high" }
                : cell,
          ),
        ),
      },
    };
    const wanted = (difficulty: number, stakes: number) =>
      wantedProfiles(policy, { ...request, assessment: { difficulty, stakes } }, [claudeInventory])
        .candidates[0]?.request.model;
    expect(wanted(0, 0)).toBe(HAIKU);
    expect(wanted(10, 10)).toBe("claude-next-9");
  });

  it("keeps a pinned model exactly, within the allowed family and account constraints", () => {
    const override = {
      driver: codex,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    expect(
      wantedProfiles(defaultModelRoutingPolicy, { ...forCodex, override }, [inventory])
        .candidates[0]!.request,
    ).toMatchObject({ model: override.model, options: override.options });
    const other = wantedProfiles(
      defaultModelRoutingPolicy,
      { ...forCodex, override: { ...override, driver: claudeAgent } },
      [inventory],
    );
    expect(other.candidates).toHaveLength(0);
    expect(other.reasons[0]).toContain("not among the allowed ones");
    for (const pin of [
      { nativeInstanceId: ProviderInstanceId.make("missing") },
      { explicitInstanceId: ProviderInstanceId.make("missing") },
      { allowedInstanceIds: [] },
    ])
      expect(
        wantedProfiles(defaultModelRoutingPolicy, { ...forCodex, ...pin }, [inventory]).candidates,
      ).toHaveLength(0);
    expect(
      wantedProfiles(
        defaultModelRoutingPolicy,
        { ...forCodex, allowedDrivers: [ProviderDriverKind.make("cursor")] },
        [inventory],
      ).reasons.join(" "),
    ).toContain("the table covers Claude and Codex only");
    expect(
      wantedProfiles(defaultModelRoutingPolicy, { ...forCodex, allowedDrivers: [codex, codex] }, [
        inventory,
      ]).reasons,
    ).toEqual(["Allowed provider families must be unique."]);
  });
});

describe("model policy warnings", () => {
  const everything = host([
    claude("A"),
    account("SL", codex, defaultModelRoutingPolicy.codex.allowedModels, []),
    deepseek,
  ]);
  const withClaudeCell = (cell: RoutingCell, allowedModels?: string[]): ModelRoutingPolicy => ({
    ...defaultModelRoutingPolicy,
    claudeAgent: {
      allowedModels: allowedModels ?? defaultModelRoutingPolicy.claudeAgent.allowedModels,
      cells: defaultModelRoutingPolicy.claudeAgent.cells.map((row, d) =>
        row.map((old, s) => (d === 0 && s === 0 ? cell : old)),
      ),
    },
  });

  it("has nothing to say about the defaults when their accounts are connected", () => {
    expect(modelPolicyWarnings(defaultModelRoutingPolicy, [everything])).toEqual([]);
  });

  it("names a model or effort that no connected account offers, and a model outside the list", () => {
    expect(
      modelPolicyWarnings(withClaudeCell({ model: "claude-next-9", effort: "high" }), [everything]),
    ).toEqual([
      "claudeAgent table: no connected account offers claude-next-9.",
      "claudeAgent table: claude-next-9 is not in the table's model list.",
    ]);
    expect(
      modelPolicyWarnings(withClaudeCell({ model: SONNET, effort: "ultra" }), [everything]),
    ).toEqual([`claudeAgent table: no connected account offers ${SONNET} at ultra.`]);
    // A Codex account that offers the model does not make it a Claude choice.
    expect(
      modelPolicyWarnings(
        withClaudeCell({ model: "gpt-6-astra", effort: "high" }, [SONNET, OPUS, "gpt-6-astra"]),
        [everything],
      ),
    ).toEqual(["claudeAgent table: no connected account offers gpt-6-astra."]);
  });

  it("checks the ladder and the fallback", () => {
    const policy: ModelRoutingPolicy = {
      ...defaultModelRoutingPolicy,
      ladder: [
        { model: SONNET, effort: "high" },
        { model: "claude-next-9", effort: "high" },
      ],
      fallback: { model: "kimi", effort: "max", below: { model: "gpt-6-astra", effort: "high" } },
    };
    expect(modelPolicyWarnings(policy, [everything])).toEqual([
      "Ladder: no connected account offers claude-next-9.",
      "Fallback: no connected account offers kimi.",
      "Fallback: gpt-6-astra / high is not on the ladder, so the fallback never applies.",
    ]);
    expect(
      modelPolicyWarnings({ ...defaultModelRoutingPolicy, fallback: null }, [everything]),
    ).toEqual([]);
  });

  it("warns about every model while no computer could be read", () => {
    const warnings = modelPolicyWarnings(defaultModelRoutingPolicy, []);
    expect(warnings).toContain(`Ladder: no connected account offers ${FABLE}.`);
    expect(warnings).toContain("Fallback: no connected account offers deepseek-flash.");
  });
});

describe("when the wanted model fits nowhere", () => {
  const opusHigh = { model: OPUS, effort: "high" };

  it("waits for a limit that resets within 30 minutes, 45 at high stakes", () => {
    const soon = (hours: number) => [
      claude("A", [weekly(20), only(OPUS, 100, { resetsAt: inHours(hours) })]),
    ];
    const waits = choose(soon(0.4), opusHigh);
    expect(picked(waits)).toBe(`A ${OPUS} / high`);
    expect(waits.startAt).toBe(inHours(0.4));
    expect(waits.reason).toContain("resets in 24m, so the start waits for it.");
    // 36 minutes is too long at ordinary stakes: the nearest rung that fits instead.
    const moves = choose(soon(0.6), opusHigh);
    expect(moves.startAt).toBeUndefined();
    expect(picked(moves)).toBe(`A ${SONNET} / xhigh`);
    // At stakes 8 the start waits up to 45 minutes.
    const high = choose(soon(0.6), opusHigh, {
      request: { assessment: { difficulty: 5, stakes: 8 } },
    });
    expect(high.startAt).toBe(inHours(0.6));
    expect(picked(high)).toBe(`A ${OPUS} / high`);
  });

  it("moves at most two rungs", () => {
    // Fable high's two nearest rungs are Fable medium and Opus xhigh; both are out.
    const out = [claude("A", [weekly(20), only(OPUS, 100), only(FABLE, 100)])];
    const choice = choose(out, { model: FABLE, effort: "high" });
    expect(picked(choice)).toBeNull();
    expect(choice.drainedUntil).toBe(inHours(100));
    expect(choice.tried.map((t) => t.request.model)).not.toContain(SONNET);
  });

  it("starts the wanted model on the account that lasts longest when nothing fits the job", () => {
    const tight = [claude("A", [weekly(99.5)]), claude("B", [weekly(99.7)])];
    const choice = choose(tight, opusHigh, { request: { expectedHours: 8 } });
    expect(picked(choice)).toBe(`A ${OPUS} / high`);
    expect(choice.reason).toContain("no account lasts the whole job, this one lasts longest.");
    // Refused as drained only when every account is really out.
    const out = choose([claude("A", [weekly(100)]), claude("B", [weekly(100)])], opusHigh);
    expect(picked(out)).toBeNull();
    expect(out.drainedUntil).toBe(inHours(100));
  });
});

describe("Fable switch", () => {
  const off = { policy: { fableWorkers: false } };

  it("starts a table or pinned Fable choice from the nearest rung without Fable, and says so", () => {
    const table = choose([claude("A")], { model: FABLE, effort: "medium" }, off);
    expect(picked(table)).toBe(`A ${OPUS} / xhigh`);
    expect(wantedLabel(table)).toBe(`${FABLE} / medium`);
    expect(table.notes[0]).toBe(
      `Fable workers are off: ${FABLE} / medium starts from ${OPUS} / xhigh, the nearest rung without Fable.`,
    );
    const pinned = choose(
      [claude("A")],
      { model: SONNET, effort: "high" },
      {
        ...off,
        request: {
          override: {
            driver: claudeAgent,
            model: FABLE,
            options: [{ id: "effort", value: "high" }],
          },
        },
      },
    );
    expect(picked(pinned)).toBe(`A ${OPUS} / xhigh`);
    // Masters are not workers: the switch leaves them alone.
    expect(
      picked(
        choose(
          [claude("A")],
          { model: FABLE, effort: "medium" },
          { ...off, request: { kind: "session" } },
        ),
      ),
    ).toBe(`A ${FABLE} / medium`);
  });

  it("never substitutes a Fable rung", () => {
    const opusOut = [claude("A", [weekly(20), only(OPUS, 100)])];
    const on = choose(opusOut, { model: OPUS, effort: "xhigh" });
    expect(picked(on)).toBe(`A ${FABLE} / low`);
    const offChoice = choose(opusOut, { model: OPUS, effort: "xhigh" }, off);
    expect(picked(offChoice)).toBeNull();
    expect(offChoice.tried.map((t) => t.request.model)).not.toContain(FABLE);
  });
});
