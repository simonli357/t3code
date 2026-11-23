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
import { accountRunways, decideAllocation } from "./decision.ts";
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
  account(label, codex, ["gpt-6.2-sol", "gpt-6.2-astra"], windows);
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
      "B: no goal line, 40% left (Weekly 60% used, 60% by the job's end), 0 workers",
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
    expect(rungs({ model: "gpt-6.2-astra", effort: "high" })).toEqual([]);
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
      only("gpt-6.2-sol", used, { resetsAt: inHours(hours) });
    const pick = (accounts: AllocationAccount[], policy: Partial<AllocationPolicy> = {}) =>
      choose(accounts, table, { request: forCodex, policy });
    // The default Codex table wants gpt-6.2-sol / medium for difficulty 0, stakes 0.
    expect(picked(pick([gpt("SL", [weekly(50)]), gpt("AD", [weekly(30)])]))).toBe(
      "AD gpt-6.2-sol / medium",
    );
    expect(picked(pick([gpt("SL", [weekly(20), sol(100)]), gpt("AD", [weekly(90)])]))).toBe(
      "AD gpt-6.2-sol / medium",
    );
    const order = { accountOrder: [allocationPreferenceKey(gpt("SL"))] };
    expect(picked(pick([gpt("SL", [weekly(35)]), gpt("AD", [weekly(30)])], order))).toBe(
      "SL gpt-6.2-sol / medium",
    );
    expect(picked(pick([gpt("SL", [weekly(45)]), gpt("AD", [weekly(30)])], order))).toBe(
      "AD gpt-6.2-sol / medium",
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

  it("keeps to the family a start asks for", () => {
    const wanted = { model: SONNET, effort: "high" };
    expect(picked(choose([gpt("SL", [weekly(0)]), claude("A", [weekly(90)])], wanted))).toBe(
      `A ${SONNET} / high`,
    );
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
    "gpt-6.2-sol/medium",
    "gpt-6.2-sol/high",
    "gpt-6.2-sol/max",
    "gpt-6.2-astra/medium",
    "gpt-6.2-astra/high",
    "gpt-6.2-astra/xhigh",
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
      model: "gpt-6.2-astra",
      effort: "xhigh",
    });
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES)
        expect(choice(edited, difficulty, stakes)).toBe(
          difficulty === 5 && stakes === 2
            ? "gpt-6.2-astra/xhigh"
            : choice(defaultModelRoutingPolicy, difficulty, stakes),
        );
  });

  it("resolves a saved band table exactly as the band lookup did for all 121 pairs", () => {
    const legacy = {
      version: 4,
      codex: {
        profiles: [
          { model: "gpt-6.2-sol", effort: "medium" },
          { model: "gpt-6.2-sol", effort: "ultra" },
          { model: "gpt-6.2-astra", effort: "high" },
          { model: "gpt-6-luna", effort: "high" },
          { model: "gpt-6.2-astra", effort: "medium" },
          { model: "gpt-6.2-sol", effort: "max" },
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
        allowedModels: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna"],
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
      ["codex", "gpt-6.2-sol"],
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
        { model: "gpt-6.2-astra", effort: "medium" },
      ],
    });
    const result = wantedProfiles(changed, forCodex, [inventory]);
    expect(result.candidates[0]!.reason).toContain("table alternative");
    expect(choice(changed, 0, 0)).toBe("gpt-6.2-astra/medium");
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
        withClaudeCell({ model: "gpt-6.2-astra", effort: "high" }, [SONNET, OPUS, "gpt-6.2-astra"]),
        [everything],
      ),
    ).toEqual(["claudeAgent table: no connected account offers gpt-6.2-astra."]);
  });

  it("checks the ladder and the fallback", () => {
    const policy: ModelRoutingPolicy = {
      ...defaultModelRoutingPolicy,
      ladder: [
        { model: SONNET, effort: "high" },
        { model: "claude-next-9", effort: "high" },
      ],
      fallback: { model: "kimi", effort: "max", below: { model: "gpt-6.2-astra", effort: "high" } },
    };
    expect(modelPolicyWarnings(policy, [everything])).toEqual([
      "Ladder: no connected account offers claude-next-9.",
      "Fallback: no connected account offers kimi.",
      "Fallback: gpt-6.2-astra / high is not on the ladder, so the fallback never applies.",
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

  it("queues the choice for a reset within the wait when everything is out now", () => {
    // The 5-hour limit is used up until the reset; after it, Fable's own limit still cannot
    // hold the job, so the nearest rung waits for the reset instead of a refusal.
    const out = (hours: number) => [
      claude("A", [
        weekly(100, {
          id: "five_hour",
          label: "Session",
          kind: "session",
          resetsAt: inHours(hours),
          durationHours: 5,
        }),
        weekly(69),
        only(FABLE, 99.9),
      ]),
    ];
    const fable = { model: FABLE, effort: "medium" };
    const queued = choose(out(0.4), fable);
    expect(picked(queued)).toBe(`A ${OPUS} / xhigh`);
    expect(queued.startAt).toBe(inHours(0.4));
    expect(queued.reason).toContain(
      "Every account is out now and a limit resets in 24m, so the start waits for it.",
    );
    // Nothing comes back within the wait: refused.
    const refused = choose(out(0.6), fable);
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(0.6));
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

describe("a pinned account's refusal", () => {
  const xy = (patch: Partial<AllocationAccount> = {}) =>
    claude("XY", [weekly(44), only(FABLE, 49)], {
      instanceId: ProviderInstanceId.make("claude_xiyang"),
      ...patch,
    });
  const fableHigh = { model: FABLE, effort: "high" };

  it("names the account, the limit and its end when that account is out of the model", () => {
    const refused = choose(
      [xy({ limits: [{ windowId: `weekly_${FABLE}`, until: inHours(30) }] }), claude("ARA")],
      fableHigh,
      { request: { explicitInstanceId: ProviderInstanceId.make("claude_xiyang") } },
    );
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(30));
    expect(refused.reason).toBe(
      `XY: drained until ${inHours(30)} (provider limit rejection on Weekly · ${FABLE}), 0 workers; a pinned account is exact.`,
    );
  });

  it("says the pin names no account here, not that no account offers the model", () => {
    const byLabel = choose([xy(), claude("ARA")], fableHigh, {
      request: { explicitInstanceId: ProviderInstanceId.make("xy") },
    });
    expect(picked(byLabel)).toBeNull();
    expect(byLabel.reason).toBe(
      "claudeAgent: the pinned account xy is not an account ID on this computer; XY is claude_xiyang, pin it by that ID.",
    );
    expect(
      choose([xy()], fableHigh, {
        request: { explicitInstanceId: ProviderInstanceId.make("elsewhere") },
      }).reason,
    ).toBe("claudeAgent: the pinned account elsewhere is not an account ID on this computer.");
    // A pinned account asks only its own family.
    const pinned = wantedProfiles(
      wanting({ model: FABLE, effort: "high" }),
      {
        ...request,
        allowedDrivers: [claudeAgent, codex],
        explicitInstanceId: ProviderInstanceId.make("claude_xiyang"),
      },
      [host([xy(), gpt("G")])],
    );
    expect(pinned.reasons).toEqual([]);
    expect(pinned.candidates.map((c) => c.request.driver)).toEqual([claudeAgent]);
  });
});

describe("Fable mode", () => {
  /** Fable mode on these Claude accounts only. */
  const fableFor = (...labels: string[]) => ({
    policy: { fableAccounts: labels.map((label) => allocationPreferenceKey(claude(label))) },
  });
  /** A Claude account whose Fable model offers only `efforts`. */
  const fableAt = (label: string, efforts: readonly string[]) =>
    claude("B", [weekly(20)], {
      instanceId: ProviderInstanceId.make(label),
      label,
      accountKey: label,
      models: models(claudeAgent, [HAIKU, SONNET, OPUS, FABLE]).map((m) =>
        m.slug === FABLE
          ? {
              ...m,
              capabilities: {
                optionDescriptors: [
                  {
                    ...m.capabilities.optionDescriptors[0]!,
                    options: efforts.map((id) => ({ id, label: id })),
                  },
                ],
              },
            }
          : m,
      ),
    });
  const opusHigh = { model: OPUS, effort: "high" };

  it("starts a worker on a Fable-mode account from the first Fable rung at or above its entry", () => {
    // The default ladder, weakest first, and the Fable rung each entry starts from.
    const expected = ["low", "low", "low", "low", "low", "low", "medium", "medium", "high"];
    defaultModelLadder.forEach((entry, i) => {
      const choice = choose([claude("A")], entry, fableFor("A"));
      expect(picked(choice), `${entry.model} / ${entry.effort}`).toBe(
        `A ${FABLE} / ${expected[i]}`,
      );
      if (entry.model === FABLE) {
        expect(choice.wanted).toBeUndefined();
        expect(choice.notes).toEqual([]);
      } else {
        expect(wantedLabel(choice)).toBe(`${entry.model} / ${entry.effort}`);
        expect(choice.notes).toEqual([
          `Fable mode on A: ${entry.model} / ${entry.effort} starts from ${FABLE} / ${expected[i]}, the first Fable rung at or above it.`,
        ]);
      }
      // An account that is not in Fable mode runs the table's entry.
      expect(picked(choose([claude("B")], entry, fableFor("A")))).toBe(
        `B ${entry.model} / ${entry.effort}`,
      );
    });
  });

  it("judges each account on the model it would run there", () => {
    // A runs Fable, which has little room there; B runs Opus with more.
    const fableTight = [claude("A", [weekly(20), only(FABLE, 80)]), claude("B", [weekly(50)])];
    const normal = choose(fableTight, opusHigh, fableFor("A"));
    expect(picked(normal)).toBe(`B ${OPUS} / high`);
    expect(normal.wanted).toBeUndefined();
    expect(normal.notes).toEqual([]);
    expect(normal.accounts[0]).toMatch(
      new RegExp(`^A \\(Fable mode\\): no goal line, 20% left \\(Weekly · ${FABLE} 80% used`),
    );
    expect(normal.accounts[1]).toMatch(/^B: no goal line, 50% left \(Weekly 50% used/);
    // Admission chooses among the accounts that run the chosen model only.
    expect(normal.decision!.request.allowedInstanceIds).toEqual(["B"]);
    // With more room for Fable on A than for Opus on B, A runs Fable.
    const fableRoomy = [claude("A", [weekly(20), only(FABLE, 10)]), claude("B", [weekly(50)])];
    const fable = choose(fableRoomy, opusHigh, fableFor("A"));
    expect(picked(fable)).toBe(`A ${FABLE} / low`);
    expect(wantedLabel(fable)).toBe(`${OPUS} / high`);
    expect(fable.notes).toEqual([
      `Fable mode on A: ${OPUS} / high starts from ${FABLE} / low, the first Fable rung at or above it.`,
    ]);
    expect(fable.decision!.request.allowedInstanceIds).toEqual(["A"]);
    // Without Fable mode both run Opus, and A has the most room.
    expect(picked(choose(fableRoomy, opusHigh))).toBe(`A ${OPUS} / high`);
  });

  it("keeps a Fable-mode account out while its Fable limit is used up", () => {
    const aDrained = claude("A", [weekly(20), only(FABLE, 100, { resetsAt: inHours(30) })]);
    // A has more room for Opus than B, but in Fable mode it runs only Fable.
    const choice = choose([aDrained, claude("B", [weekly(60)])], opusHigh, fableFor("A"));
    expect(picked(choice)).toBe(`B ${OPUS} / high`);
    expect(choice.accounts[0]).toBe(
      `A (Fable mode): drained until ${inHours(30)} (Weekly · ${FABLE} 100% used), 0 workers`,
    );
    // When B is out too, the start is refused: A never falls back to its normal models.
    const refused = choose([aDrained, claude("B", [weekly(100)])], opusHigh, fableFor("A"));
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(30));
    expect(refused.reason).toBe(
      `Drained: ${OPUS} / high (${FABLE} / low in Fable mode) and every model that may stand in for it are out; earliest reset ${inHours(30)}. Fable mode on A: only Fable rungs stand in there.`,
    );
    // A Fable limit that resets within the wait: the start waits for it, as without the mode.
    const soon = [claude("A", [weekly(20), only(FABLE, 100, { resetsAt: inHours(0.4) })])];
    const waiting = choose(soon, { model: SONNET, effort: "high" }, fableFor("A"));
    expect(picked(waiting)).toBe(`A ${FABLE} / low`);
    expect(waiting.startAt).toBe(inHours(0.4));
  });

  it("stands in only another Fable rung on a Fable-mode account", () => {
    // A's Fable is drained; B offers Fable at medium and high only.
    const accounts = [
      claude("A", [weekly(20), only(FABLE, 100)]),
      fableAt("B", ["medium", "high"]),
    ];
    const fableLow = { model: FABLE, effort: "low" };
    expect(picked(choose(accounts, fableLow))).toBe(`A ${OPUS} / high`);
    const choice = choose(accounts, fableLow, fableFor("A", "B"));
    expect(picked(choice)).toBe(`B ${FABLE} / medium`);
    expect(choice.reason).toContain(`the nearest ladder rung that fits is ${FABLE} / medium.`);
    // Fable high is three rungs above Fable low on the ladder but two Fable rungs: still in reach.
    expect(
      picked(choose([accounts[0]!, fableAt("B", ["high"])], fableLow, fableFor("A", "B"))),
    ).toBe(`B ${FABLE} / high`);
  });

  it("stands the fallback in for the other accounts only", () => {
    const fableOut = [
      claude("A", [weekly(20), only(FABLE, 100)]),
      claude("B", [weekly(20), only(FABLE, 100, { resetsAt: inHours(7) })]),
      deepseek,
    ];
    // The fallback would apply to anything below Fable high.
    const modelPolicy = {
      fallback: { model: "deepseek-flash", effort: "max", below: { model: FABLE, effort: "high" } },
    };
    const sonnetHigh = { model: SONNET, effort: "high" };
    const refused = choose(fableOut, sonnetHigh, { ...fableFor("A", "B"), modelPolicy });
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(7));
    expect(new Set(refused.tried.map((t) => t.request.model))).toEqual(new Set([SONNET]));
    // A normal Claude account that is out takes the fallback by the usual rule.
    const withC = [...fableOut, claude("C", [weekly(100)])];
    expect(picked(choose(withC, sonnetHigh, { ...fableFor("A", "B"), modelPolicy }))).toBe(
      "DS deepseek-flash / max",
    );
  });

  it("carries the single switch stored before over as every Claude account", () => {
    const accounts = [claude("A", [weekly(30)]), claude("B", [weekly(20)])];
    const every = choose(accounts, opusHigh, { policy: { fableOnly: true } });
    expect(picked(every)).toBe(`B ${FABLE} / low`);
    expect(every.accounts.every((line) => line.includes("(Fable mode)"))).toBe(true);
    // A list, once saved, replaces it; off or absent is none.
    expect(
      picked(choose(accounts, opusHigh, { policy: { fableOnly: true, ...fableFor("A").policy } })),
    ).toBe(`B ${OPUS} / high`);
    expect(picked(choose(accounts, opusHigh, { policy: { fableOnly: false } }))).toBe(
      `B ${OPUS} / high`,
    );
    // Codex has no Fable mode.
    const viaCodex = choose([gpt("G")], opusHigh, {
      policy: { fableOnly: true },
      request: { allowedDrivers: [codex] },
    });
    expect(picked(viaCodex)).not.toBeNull();
    expect(viaCodex.notes).toEqual([]);
  });

  it("keeps a pinned model with a note, runs a pinned Fable-mode account on Fable, leaves masters", () => {
    const accounts = [claude("A"), claude("B", [weekly(60)])];
    const pin = (model: string, effort: string) => ({
      ...fableFor("A"),
      request: {
        override: { driver: claudeAgent, model, options: [{ id: "effort", value: effort }] },
      },
    });
    const opus = choose(accounts, { model: SONNET, effort: "high" }, pin(OPUS, "high"));
    expect(picked(opus)).toBe(`A ${OPUS} / high`);
    expect(opus.notes).toEqual([
      `Fable mode is on for A, but ${OPUS} / high is pinned for this worker and runs as pinned.`,
    ]);
    const fable = choose(accounts, { model: SONNET, effort: "high" }, pin(FABLE, "high"));
    expect(picked(fable)).toBe(`A ${FABLE} / high`);
    expect(fable.notes).toEqual([]);
    const account = (id: string) => ({
      ...fableFor("A"),
      request: { explicitInstanceId: ProviderInstanceId.make(id) },
    });
    expect(picked(choose(accounts, opusHigh, account("A")))).toBe(`A ${FABLE} / low`);
    expect(picked(choose(accounts, opusHigh, account("B")))).toBe(`B ${OPUS} / high`);
    const master = choose(accounts, opusHigh, { ...fableFor("A"), request: { kind: "session" } });
    expect(picked(master)).toBe(`A ${OPUS} / high`);
    expect(master.notes).toEqual([]);
    expect(master.accounts.some((line) => line.includes("Fable mode"))).toBe(false);
  });
});

describe("Fable goal", () => {
  const opusHigh = { model: OPUS, effort: "high" };
  /** A Claude account 20% into its week whose Fable limit is `fable` percent used. */
  const fableUsed = (label: string, fable: number, patch: Partial<AllocationAccount> = {}) =>
    claude(label, [weekly(20), only(FABLE, fable)], patch);
  /** A Fable goal of `percentPerDay` on these accounts; its line is 14 × 70 / 24 = 40.8% at 14. */
  const fableGoals = (percentPerDay: number, ...labels: string[]) => ({
    fableGoals: labels.map((label) => ({
      key: allocationPreferenceKey(claude(label)),
      percentPerDay,
    })),
  });
  /** A daily goal of 20% (58.3% at the job's end) on these accounts. */
  const dailyGoals = (...labels: string[]) => ({
    accountGoals: labels.map((label) => ({
      key: allocationPreferenceKey(claude(label)),
      percentPerDay: 20,
    })),
  });

  it("changes nothing while unset: the daily goal paces the Fable window and no account switches", () => {
    const accounts = [
      fableUsed("A", 10),
      fableUsed("B", 60, { windows: [weekly(30), only(FABLE, 60)] }),
    ];
    const policy = dailyGoals("A", "B");
    for (const wanted of [opusHigh, { model: FABLE, effort: "high" }]) {
      const today = choose(accounts, wanted, { policy });
      expect(choose(accounts, wanted, { policy: { ...policy, fableGoals: [] } })).toEqual(today);
      // A goal on an account that is not here changes nothing either.
      expect(choose(accounts, wanted, { policy: { ...policy, ...fableGoals(14, "Z") } })).toEqual(
        today,
      );
      expect([...today.accounts, ...today.notes].join(" ")).not.toContain("Fable goal");
    }
    expect(picked(choose(accounts, opusHigh, { policy }))).toBe(`A ${OPUS} / high`);
    expect(choose(accounts, { model: FABLE, effort: "high" }, { policy }).accounts[1]).toContain(
      `against a goal of 58%`,
    );
  });

  it("is the Fable window's line, so a Fable job goes to the account furthest behind it", () => {
    // A's account-wide week is nearly at its line, B's Fable window is far behind the daily line.
    const started = { cycleStartedAt: inHours(-68) };
    const accounts = [
      claude("A", [weekly(50, started), only(FABLE, 10, started)]),
      claude("B", [weekly(20, started), only(FABLE, 38, started)]),
    ];
    const fableJob = (policy: Partial<AllocationPolicy>) =>
      decideAllocation({
        at,
        policy: { ...defaultAllocationPolicy, ...noGoals, closeMarginPoints: 0, ...policy },
        request: {
          assignmentId: "job",
          environmentId: "host",
          threadId: request.threadId,
          driver: claudeAgent,
          model: FABLE,
          options: [{ id: "effort", value: "high" }],
        },
        inventories: [host(accounts)],
        reservations: [],
        authorityAvailable: true,
        learned: learned(accounts),
      });
    // Without a Fable goal, B's Fable window is 20 points behind the daily line, A only 8.
    expect(fableJob(dailyGoals("A", "B")).selectedInstanceId).toBe("B");
    // At 14% a day B is 3 points behind its Fable line; A's weekly line keeps counting.
    const decision = fableJob({ ...dailyGoals("A", "B"), ...fableGoals(14, "A", "B") });
    expect(decision.selectedInstanceId).toBe("A");
    expect(decision.candidates.map((c) => c.line)).toEqual([
      "A: 8 points behind its goal (Weekly 50% used, 50% by the job's end against a goal of 58%), 0 workers",
      `B: 3 points behind its Fable goal (Weekly · ${FABLE} 38% used, 38% by the job's end against a Fable goal of 41%), 0 workers`,
    ]);
    // The usage page shows the Fable goal's budget by now on the Fable window: 14 × 68 / 24.
    const runway = (policy: Partial<AllocationPolicy>) =>
      accountRunways({
        at,
        policy: { ...defaultAllocationPolicy, ...noGoals, ...policy },
        inventories: [host(accounts)],
        learned: learned(accounts),
      })[0]!.windows.map((w) => Math.round(w.goalPercent! * 10) / 10);
    expect(runway(dailyGoals("A"))).toEqual([56.7, 56.7]);
    expect(runway({ ...dailyGoals("A"), ...fableGoals(14, "A") })).toEqual([56.7, 39.7]);
  });

  it("puts an account behind its Fable line in Fable mode and one ahead of it on the table", () => {
    const behind = choose([fableUsed("A", 10)], opusHigh, { policy: fableGoals(14, "A") });
    expect(picked(behind)).toBe(`A ${FABLE} / low`);
    expect(wantedLabel(behind)).toBe(`${OPUS} / high`);
    expect(behind.notes).toEqual([
      `Fable goal: A would end 31 points behind its Fable goal, so this worker starts on ${FABLE} / low.`,
    ]);
    expect(behind.accounts).toEqual([
      `A (Fable mode): 31 points behind its Fable goal (Weekly · ${FABLE} 10% used, 10% by the job's end against a Fable goal of 41%), 0 workers`,
    ]);
    const ahead = choose([fableUsed("B", 60)], opusHigh, { policy: fableGoals(14, "B") });
    expect(picked(ahead)).toBe(`B ${OPUS} / high`);
    expect(ahead.notes).toEqual([
      "Fable goal: B would end 19 points ahead of its Fable goal, so this worker runs the table's choice.",
    ]);
    expect(ahead.accounts).toEqual([
      "B: no goal line, 80% left (Weekly 20% used, 20% by the job's end), 0 workers; 19 points ahead of its Fable goal, so the table's choice",
    ]);
    // Each account is judged on its own line: A runs Fable, B the table's choice.
    const both = choose([fableUsed("A", 10), fableUsed("B", 60)], opusHigh, {
      policy: fableGoals(14, "A", "B"),
    });
    expect(both.accounts.map((line) => line.split(":")[0])).toEqual(["A (Fable mode)", "B"]);
    // Masters are never moved onto Fable.
    expect(
      picked(
        choose([fableUsed("A", 10)], opusHigh, {
          policy: fableGoals(14, "A"),
          request: { kind: "session" },
        }),
      ),
    ).toBe(`A ${OPUS} / high`);
  });

  it("never refuses or delays: behind the line but with Fable rejected, the table's choice starts now", () => {
    const rejected = fableUsed("C", 10, {
      limits: [{ windowId: `weekly_${FABLE}`, until: inHours(3) }],
    });
    const choice = choose([rejected], opusHigh, { policy: fableGoals(14, "C") });
    expect(picked(choice)).toBe(`C ${OPUS} / high`);
    expect(choice.startAt).toBeUndefined();
    expect(choice.notes).toEqual([
      `Fable goal: C would end 31 points behind its Fable goal, but ${FABLE} / low does not fit there, so this worker runs the table's choice.`,
    ]);
  });

  it("leaves the stored list and the Fable workers switch in charge", () => {
    // Listed, B stays in Fable mode although it is ahead of its Fable goal.
    const listed = choose([fableUsed("B", 60)], opusHigh, {
      policy: { ...fableGoals(14, "B"), fableAccounts: [allocationPreferenceKey(claude("B"))] },
    });
    expect(picked(listed)).toBe(`B ${FABLE} / low`);
    expect(listed.notes).toEqual([
      `Fable mode on B: ${OPUS} / high starts from ${FABLE} / low, the first Fable rung at or above it.`,
    ]);
    expect(listed.accounts.join(" ")).not.toContain("Fable goal,");
    // With Fable workers off, an account far behind its Fable goal still runs the table's choice.
    const off = choose([fableUsed("A", 10)], opusHigh, {
      policy: { ...fableGoals(14, "A"), fableWorkers: false },
    });
    expect(picked(off)).toBe(`A ${OPUS} / high`);
    expect([...off.accounts, ...off.notes].join(" ")).not.toContain("Fable goal,");
  });

  it("never takes Fable from a table entry or a pin, and keeps a pin as pinned", () => {
    const fableHigh = { model: FABLE, effort: "high" };
    const table = choose([fableUsed("B", 60)], fableHigh, { policy: fableGoals(14, "B") });
    expect(picked(table)).toBe(`B ${FABLE} / high`);
    expect(table.notes).toEqual([
      "Fable goal: B would end 19 points ahead of its Fable goal, so this worker runs the table's choice.",
    ]);
    const pin = (model: string) => ({
      policy: fableGoals(14, "A", "B"),
      request: {
        override: { driver: claudeAgent, model, options: [{ id: "effort", value: "high" }] },
      },
    });
    const pinnedFable = choose([fableUsed("B", 60)], opusHigh, pin(FABLE));
    expect(picked(pinnedFable)).toBe(`B ${FABLE} / high`);
    expect(pinnedFable.notes).toEqual([]);
    const pinnedOpus = choose([fableUsed("A", 10)], opusHigh, pin(OPUS));
    expect(picked(pinnedOpus)).toBe(`A ${OPUS} / high`);
    expect(pinnedOpus.notes).toEqual([]);
  });
});

describe("a worker start that names no provider family", () => {
  const both = { allowedDrivers: [claudeAgent, codex] };
  const opusHigh = { model: OPUS, effort: "high" };
  /** What the Codex table gives for difficulty 0, stakes 0. */
  const cell = defaultModelRoutingPolicy.codex.cells[0]![0]!;
  const SOL = `${cell.model} / ${cell.effort}`;
  /** 68 hours into the week: a goal of 20% a day is at 58% when a two-hour job ends. */
  const used = (points: number, patch: Partial<AllocationWindow> = {}) => [
    weekly(points, { cycleStartedAt: inHours(-68), ...patch }),
  ];
  const goals = { claude: { dailyPoints: 20 }, codex: { dailyPoints: 20 } };
  const sol = (
    label: string,
    windows: AllocationWindow[],
    patch: Partial<AllocationAccount> = {},
  ) => account(label, codex, [cell.model], windows, patch);
  const start = (accounts: AllocationAccount[], patch: Parameters<typeof choose>[2] = {}) =>
    choose(accounts, opusHigh, {
      ...patch,
      request: { ...both, ...patch.request },
      policy: { ...goals, ...patch.policy },
    });
  const order = (...accounts: AllocationAccount[]) => ({
    policy: { accountOrder: accounts.map(allocationPreferenceKey) },
  });

  it("ranks the accounts of both families together, each on its own table entry", () => {
    const codexBehind = start([claude("A", used(40)), claude("B", used(50)), sol("AD", used(10))]);
    expect(picked(codexBehind)).toBe(`AD ${SOL}`);
    expect(codexBehind.wanted).toBeUndefined();
    expect(codexBehind.startAt).toBeUndefined();
    expect(codexBehind.accounts).toEqual([
      `A (${OPUS} / high): 18 points behind its goal (Weekly 40% used, 40% by the job's end against a goal of 58%), 0 workers`,
      `AD (${SOL}): 48 points behind its goal (Weekly 10% used, 10% by the job's end against a goal of 58%), 0 workers`,
      `B (${OPUS} / high): 8 points behind its goal (Weekly 50% used, 50% by the job's end against a goal of 58%), 0 workers`,
    ]);
    expect(codexBehind.reason).toBe(
      `${codexBehind.accounts[1]}; furthest behind its goal of 3 accounts.`,
    );
    // Admission chooses among the accounts that run the chosen model.
    expect(codexBehind.decision!.request.driver).toBe(codex);
    expect(codexBehind.decision!.request.allowedInstanceIds).toEqual(["AD"]);
    expect(codexBehind.tried.map((t) => [t.request.driver, t.chosen])).toEqual([
      [claudeAgent, false],
      [codex, true],
    ]);

    const claudeBehind = start([claude("A", used(10)), claude("B", used(50)), sol("AD", used(40))]);
    expect(picked(claudeBehind)).toBe(`A ${OPUS} / high`);
    expect(claudeBehind.wanted).toBeUndefined();
    expect(claudeBehind.decision!.request.allowedInstanceIds).toEqual(["A", "B"]);
    expect(claudeBehind.reason).toMatch(
      new RegExp(`^A \\(${OPUS} / high\\): 48 points behind .* furthest behind its goal of 3`),
    );
    // AD has no goal of its own: without the Codex family's goal it has no line and ranks after.
    expect(
      picked(start([claude("A", used(50)), sol("AD", used(10))], { policy: { codex: undefined } })),
    ).toBe(`A ${OPUS} / high`);
  });

  it("lets the preference order decide between close accounts of either family", () => {
    const a = claude("A", used(25));
    const ad = sol("AD", used(30));
    expect(picked(start([a, ad]))).toBe(`A ${OPUS} / high`);
    const preferred = start([a, ad], order(ad, a));
    expect(picked(preferred)).toBe(`AD ${SOL}`);
    expect(preferred.reason).toContain(
      "within 10 points of A (33 points behind its goal) and earlier in the preference order.",
    );
    expect(picked(start([a, ad], order(a, ad)))).toBe(`A ${OPUS} / high`);
    // Beyond the margin the order does not count.
    expect(picked(start([a, sol("AD", used(45))], order(ad, a)))).toBe(`A ${OPUS} / high`);
    expect(picked(start([claude("A", used(45)), ad], order(a, ad)))).toBe(`AD ${SOL}`);
  });

  it("changes nothing for a start that names a family, an account or a model", () => {
    const accounts = [claude("A", used(40)), claude("B", used(50)), sol("AD", used(10))];
    const claudeOnly = accounts.slice(0, 2);
    const options = { learned: learned(accounts), policy: goals };
    const one = (request: Partial<ModelRoutingRequest>, among = accounts) =>
      choose(among, opusHigh, { ...options, request });
    // Claude asked for: as if the Codex account were not there.
    const asked = one({ allowedDrivers: [claudeAgent] });
    expect(picked(asked)).toBe(`A ${OPUS} / high`);
    expect(asked).toEqual(one({ allowedDrivers: [claudeAgent] }, claudeOnly));
    expect(picked(one({ allowedDrivers: [codex] }, [claude("A", used(0)), accounts[2]!]))).toBe(
      `AD ${SOL}`,
    );
    // A pinned account is exact, whatever the other family's accounts would rank.
    const b = { explicitInstanceId: ProviderInstanceId.make("B") };
    expect(one({ ...both, ...b })).toEqual(one({ allowedDrivers: [claudeAgent], ...b }));
    expect(picked(one({ ...both, ...b }))).toBe(`B ${OPUS} / high`);
    const ad = { explicitInstanceId: ProviderInstanceId.make("AD") };
    const pinnedCodex = one({ ...both, ...ad }, [claude("A", used(0)), accounts[2]!]);
    expect(pinnedCodex).toEqual(
      one({ allowedDrivers: [codex], ...ad }, [claude("A", used(0)), accounts[2]!]),
    );
    expect(picked(pinnedCodex)).toBe(`AD ${SOL}`);
    expect(pinnedCodex.accounts).toHaveLength(1);
    // A pinned model goes to the family that offers it.
    const sonnet = { override: { driver: claudeAgent, model: SONNET } };
    expect(one({ ...both, ...sonnet })).toEqual(one({ allowedDrivers: [claudeAgent], ...sonnet }));
    expect(picked(one({ ...both, ...sonnet }))).toBe(`A ${SONNET} / high`);
    const pinnedSol = one({
      ...both,
      override: {
        driver: claudeAgent,
        model: cell.model,
        options: [{ id: "effort", value: "xhigh" }],
      },
    });
    expect(picked(pinnedSol)).toBe(`AD ${cell.model} / xhigh`);
    expect(pinnedSol.decision!.request.options).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
    ]);
    expect(pinnedSol).toEqual(
      one({
        allowedDrivers: [codex],
        override: {
          driver: codex,
          model: cell.model,
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
      }),
    );
    // A master's start is not a worker's.
    expect(picked(one({ ...both, kind: "session" }))).toBe(`A ${OPUS} / high`);
  });

  it("leaves out an account that lacks its family's model or is off for workers, without delay", () => {
    const a = claude("A", used(50));
    const free = account("SL", codex, ["gpt-mini"], used(0));
    // No Codex account offers the entry: they are listed, and the Claude choice starts now.
    const unoffered = start([a, free, deepseek]);
    expect(picked(unoffered)).toBe(`A ${OPUS} / high`);
    expect(unoffered.startAt).toBeUndefined();
    expect(unoffered.wanted).toBeUndefined();
    expect(unoffered.accounts).toEqual([
      `A (${OPUS} / high): 8 points behind its goal (Weekly 50% used, 50% by the job's end against a goal of 58%), 0 workers`,
      `DS (${SOL}): not usable (Exact model/options are not supported.), 0 workers`,
      `SL (${SOL}): not usable (Exact model/options are not supported.), 0 workers`,
    ]);
    // One offers it: the others stay out and it is ranked as usual.
    const offered = start([a, free, deepseek, sol("AD", used(10))]);
    expect(picked(offered)).toBe(`AD ${SOL}`);
    expect(offered.accounts.filter((line) => line.includes("not usable"))).toHaveLength(2);
    // The workers switch keeps an account out.
    const off = start([a, sol("AD", used(10), { availableForWorkers: false })]);
    expect(picked(off)).toBe(`A ${OPUS} / high`);
    expect(off.accounts[1]).toMatch(new RegExp(`^AD \\(${SOL.replace(".", "\\.")}\\): not usable`));
    // Only unusable Codex accounts and a drained Claude model: the usual stand-in, at once.
    const rung = start([claude("A", [...used(50), only(OPUS, 100)]), free]);
    expect(picked(rung)).toBe(`A ${SONNET} / xhigh`);
    expect(rung.startAt).toBeUndefined();
  });

  it("keeps the sequence when no account fits its table entry, and Codex on its model", () => {
    const opusOut = (label: string, hours: number) =>
      claude(label, [...used(50), only(OPUS, 100, { resetsAt: inHours(hours) })]);
    // The Codex account fits: no wait and no stand-in.
    const fits = start([opusOut("A", 0.2), sol("AD", used(50))]);
    expect(picked(fits)).toBe(`AD ${SOL}`);
    expect(fits.startAt).toBeUndefined();
    // Nothing fits now and a limit resets within the wait: the start waits for it.
    const out = (hours: number) => sol("AD", used(100, { resetsAt: inHours(hours) }));
    const waits = start([opusOut("A", 0.2), out(30)]);
    expect(picked(waits)).toBe(`A ${OPUS} / high`);
    expect(waits.startAt).toBe(inHours(0.2));
    expect(waits.reason).toContain(
      `${OPUS} / high (${SOL} on Codex accounts) fits on no account now; a limit in its way resets in`,
    );
    const codexBack = start([opusOut("A", 30), out(0.2)]);
    expect(picked(codexBack)).toBe(`AD ${SOL}`);
    expect(codexBack.startAt).toBe(inHours(0.2));
    expect(codexBack.decision!.request.startAt).toBe(inHours(0.2));
    // No reset in reach: a Claude rung stands in; the Codex account never changes model.
    const rung = start([opusOut("A", 30), out(30)]);
    expect(picked(rung)).toBe(`A ${SONNET} / xhigh`);
    expect(wantedLabel(rung)).toBe(`${OPUS} / high`);
    expect(rung.accounts[1]).toMatch(/^AD \(.*\): drained until /);
    // Everything out: refused with the earliest reset of either family.
    const all = (hours: number) => claude("A", used(100, { resetsAt: inHours(hours) }));
    const refused = start([all(40), out(30)]);
    expect(picked(refused)).toBeNull();
    expect(refused.drainedUntil).toBe(inHours(30));
    expect(refused.accounts).toHaveLength(2);
    expect(refused.tried).toHaveLength(1);
  });

  it("leaves Fable mode and Fable goals as they are next to a Codex account", () => {
    const summary = (choice: ProfileChoice) => ({
      picked: picked(choice),
      wanted: wantedLabel(choice),
      notes: choice.notes,
      startAt: choice.startAt,
      // The lines without the model each account is judged on.
      accounts: choice.accounts
        .filter((line) => !line.startsWith("AD "))
        .map((line) =>
          line
            .replace(/^(\w+) \(Fable mode, [^)]*\)/, "$1 (Fable mode)")
            .replace(/^(\w+) \((?!Fable mode\))[^)]*\)/, "$1"),
        ),
    });
    const fableOn = (...labels: string[]) => ({
      fableAccounts: labels.map((label) => allocationPreferenceKey(claude(label))),
    });
    const fableGoal = (...labels: string[]) => ({
      fableGoals: labels.map((label) => ({
        key: allocationPreferenceKey(claude(label)),
        percentPerDay: 14,
      })),
    });
    // The Codex account is 5 points ahead of its goal, so it ranks after every account behind.
    const ad = sol("AD", used(63));
    const cases: [AllocationAccount[], Partial<AllocationPolicy>][] = [
      [[claude("A", [...used(20), only(FABLE, 80)]), claude("B", used(50))], fableOn("A")],
      [[claude("A", [...used(20), only(FABLE, 10)]), claude("B", used(50))], fableOn("A")],
      [[claude("A", [...used(20), only(FABLE, 100)]), claude("B", used(50))], fableOn("A", "B")],
      [[claude("A", [...used(20), only(FABLE, 10)])], fableGoal("A")],
      [[claude("B", [...used(20), only(FABLE, 60)])], fableGoal("B")],
      [
        [claude("A", [...used(20), only(FABLE, 10)]), claude("B", [...used(20), only(FABLE, 60)])],
        fableGoal("A", "B"),
      ],
    ];
    for (const [accounts, policy] of cases) {
      const alone = choose(accounts, opusHigh, { policy: { ...goals, ...policy } });
      const next = start([...accounts, ad], {
        policy,
        learned: learned([...accounts, ad]),
      });
      expect(alone.decision?.selectedInstanceId).not.toBe(undefined);
      expect(summary(next)).toEqual(summary(alone));
    }
    const fable = start([claude("A", [...used(20), only(FABLE, 10)]), ad], {
      policy: fableOn("A"),
    });
    expect(fable.accounts[0]).toMatch(new RegExp(`^A \\(Fable mode, ${FABLE} / low\\): `));
  });
});

describe("an account on the provider's credits", () => {
  const both = { allowedDrivers: [claudeAgent, codex] };
  const opusHigh = { model: OPUS, effort: "high" };
  const cell = defaultModelRoutingPolicy.codex.cells[0]![0]!;
  const SOL = `${cell.model} / ${cell.effort}`;
  const credits = { credits: { balance: 34_000, unlimited: false, checkedAt: at } };
  /** AD on Sol with its windows and 34,000 credits. */
  const ad = (windows: AllocationWindow[]) => account("AD", codex, [cell.model], windows, credits);
  const session = (usedPoints: number, hours: number) =>
    weekly(usedPoints, {
      id: "five_hour",
      label: "Session",
      kind: "session",
      durationHours: 5,
      resetsAt: inHours(hours),
    });
  const goals = { claude: { dailyPoints: 20 }, codex: { dailyPoints: 20 } };
  const cycle = { cycleStartedAt: inHours(-68) };

  it("loses to an account that runs the job inside its plan", () => {
    // After its weekly reset AD is far behind its goal, but its session window would overflow.
    const fresh = ad([weekly(5, cycle), session(99.9, 3)]);
    const choice = choose([claude("A", [weekly(70, cycle)]), fresh], opusHigh, {
      request: both,
      policy: goals,
    });
    expect(picked(choice)).toBe(`A ${OPUS} / high`);
    // Late in its cycle on credits, against an account far ahead of its goal.
    const late = ad([weekly(100, { resetsAt: inHours(6) })]);
    expect(
      picked(
        choose([claude("A", [weekly(70, { resetsAt: inHours(150) })]), late], opusHigh, {
          request: both,
          policy: goals,
        }),
      ),
    ).toBe(`A ${OPUS} / high`);
  });

  it("loses to a stand-in rung that fits inside a plan", () => {
    const choice = choose([...drainedEverywhere(OPUS), ad([weekly(100)])], opusHigh, {
      request: both,
    });
    expect(picked(choice)).toBe(`A ${SONNET} / xhigh`);
    expect(choice.reason).toContain(
      `${OPUS} / high (${SOL} on Codex accounts) fits on no account inside its plan for this job; the nearest ladder rung that fits is ${SONNET} / xhigh.`,
    );
  });

  it("starts on credits when nothing runs the job inside its plan, after a near reset", () => {
    const codexOnly = { allowedDrivers: [codex] };
    const now = choose([ad([weekly(20), session(99.9, 3)])], opusHigh, { request: codexOnly });
    expect(picked(now)).toBe(`AD ${SOL}`);
    expect(now.startAt).toBeUndefined();
    expect(now.reason).toMatch(
      /^AD: on credits in about 60m, 34,000 left, .*; no account lasts this job inside its plan\.$/,
    );
    expect(now.reason).not.toMatch(/fits on no account|runs out/);
    // Against a Claude account whose limit runs out, credits come first.
    const runsOut = choose([claude("A", [weekly(99.95)]), ad([weekly(100)])], opusHigh, {
      request: both,
    });
    expect(picked(runsOut)).toBe(`AD ${SOL}`);
    expect(runsOut.reason).toMatch(/; no account lasts this job inside its plan\.$/);
    // The used-up week resets in 24 minutes: the start waits for it and spends no credits.
    const soon = choose([ad([weekly(100, { resetsAt: inHours(0.4) })])], opusHigh, {
      request: codexOnly,
    });
    expect(picked(soon)).toBe(`AD ${SOL}`);
    expect(soon.startAt).toBe(inHours(0.4));
  });

  it("starts a pinned account on credits at once", () => {
    const pinned = choose([claude("A"), ad([weekly(100, { resetsAt: inHours(0.4) })])], opusHigh, {
      request: { ...both, explicitInstanceId: ProviderInstanceId.make("AD") },
    });
    expect(picked(pinned)).toBe(`AD ${SOL}`);
    expect(pinned.startAt).toBeUndefined();
    expect(pinned.reason).toMatch(/^AD: on credits.*; pinned account\.$/);
  });
});
