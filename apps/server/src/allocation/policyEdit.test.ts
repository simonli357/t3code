import { expect, it } from "@effect/vitest";
import {
  allocationPreferenceKey,
  defaultAllocationPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationAccount,
  type AllocationPolicy,
  type AllocationPolicyEdit,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { accountRuleRefusal } from "./decision.ts";
import { allocationPolicyView, editAllocationPolicy } from "./policyEdit.ts";

const at = "2026-11-09T12:00:00.000Z";
const account = (
  environmentId: string,
  instanceId: string,
  label: string,
  accountKey: string | null,
): AllocationAccount => ({
  environmentId,
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  accountKey,
  label,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [],
  shortWindow: "unknown",
  windows: [
    {
      id: "weekly",
      label: "Weekly",
      kind: "weekly",
      usedPoints: environmentId === "laptop" ? 40 : 30,
      checkedAt: environmentId === "laptop" ? at : "2026-11-09T11:00:00.000Z",
      resetsAt: null,
      cycleStartedAt: null,
      durationHours: 168,
      ratePointsPerHour: null,
      samples: 0,
      rateAgeMinutes: null,
    },
  ],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
});
const es = account("desk", "claude_eol", "ES", "es-login");
const xl = account("desk", "claude_xinya", "XL", "xl-login");
const key = allocationPreferenceKey;
const snapshot = (policy: Partial<AllocationPolicy> = {}): AllocationSnapshot => ({
  accountRulesSupported: true,
  policy: { ...defaultAllocationPolicy, version: 3, ...policy },
  inventories: [
    {
      environmentId: "desk",
      observedAt: at,
      complete: true,
      demand: [],
      notices: [],
      accounts: [es, xl],
    },
    {
      environmentId: "laptop",
      observedAt: at,
      complete: true,
      demand: [],
      notices: [],
      // The same ES login under another alias, and an account whose login is unknown.
      accounts: [
        account("laptop", "claude_es_laptop", "ES", "es-login"),
        account("laptop", "local", "ES", null),
      ],
    },
  ],
  reservations: [],
  history: [],
  authorityAvailable: true,
  notices: [],
});
const edit = (change: AllocationPolicyEdit, policy?: Partial<AllocationPolicy>) =>
  editAllocationPolicy(snapshot(policy), change, at);

it.effect("resolves labels and instance IDs to the shared account identity", () =>
  Effect.gen(function* () {
    const next = yield* edit({
      setRules: [
        { account: "xl", kind: "exclude" },
        { account: "claude_es_laptop", kind: "maxWorkers", value: 1, note: "one at a time" },
      ],
    });
    expect(next.accountRules).toEqual([
      { key: key(xl), kind: "exclude" },
      { key: key(es), kind: "maxWorkers", value: 1, note: "one at a time" },
    ]);
    // A label covers the shared login and any account whose login is unknown.
    expect(
      (yield* edit({ setRules: [{ account: "ES", kind: "exclude" }] })).accountRules?.map(
        (rule) => rule.key,
      ),
    ).toEqual([key(es), key(account("laptop", "local", "ES", null))]);
    const unknown = yield* Effect.flip(edit({ clearRules: [{ account: "AD" }] }));
    expect(unknown.detail).toContain('No account matches "AD"');
    expect(unknown.detail).toContain("XL (claude_xinya)");
  }),
);

it.effect("sets one rule per account and kind, clears by kind, and drops expired rules", () =>
  Effect.gen(function* () {
    const saved = {
      accountRules: [
        { key: key(xl), kind: "exclude" as const },
        { key: key(xl), kind: "priority" as const, value: -5 },
        {
          key: key(es),
          kind: "priority" as const,
          value: 10,
          expiresAt: "2026-11-09T11:00:00.000Z",
        },
      ],
    };
    const next = yield* edit(
      {
        clearRules: [{ account: "XL", kind: "exclude" }],
        setRules: [
          { account: "XL", kind: "priority", value: 20, expiresAt: "2026-11-10T00:00:00+01:00" },
        ],
      },
      saved,
    );
    expect(next.accountRules).toEqual([
      { key: key(xl), kind: "priority", value: 20, expiresAt: "2026-11-09T23:00:00.000Z" },
    ]);
    expect(
      (yield* edit({ clearRules: [{ account: "claude_xinya" }] }, saved)).accountRules,
    ).toEqual([]);
    const past = yield* Effect.flip(
      edit({ setRules: [{ account: "XL", kind: "exclude", expiresAt: "2026-11-09T11:59:00Z" }] }),
    );
    expect(past.detail).toContain("must be a time after now");
  }),
);

it.effect("sets and clears curves, caps and timed overrides", () =>
  Effect.gen(function* () {
    const cap = { weeklyPercent: 80, fiveHourPercent: null, stopWorkers: true, stopMasters: false };
    const curve = { ...defaultAllocationPolicy.claude, dailyPoints: 25 };
    const next = yield* edit({
      curves: { claude: curve },
      setCaps: [{ account: "XL", ...cap }],
      setOverrides: [
        { account: "claude_eol", windowId: "weekly", expiresAt: "2026-11-12T00:00:00Z" },
      ],
    });
    expect(next.claude).toEqual(curve);
    expect(next.codex).toEqual(defaultAllocationPolicy.codex);
    expect(next.accountCaps).toEqual([{ key: key(xl), ...cap }]);
    // The override starts from the newest reading of the shared login's window.
    expect(next.overrides).toEqual([
      {
        accountKey: "es-login",
        windowId: "weekly",
        createdAt: at,
        baselineUsedPoints: 40,
        expiresAt: "2026-11-12T00:00:00.000Z",
      },
    ]);
    const cleared = yield* edit(
      { curves: { claude: null }, clearCaps: ["XL"], clearOverrides: [{ account: "claude_eol" }] },
      next,
    );
    expect(cleared.claude).toEqual(defaultAllocationPolicy.claude);
    expect(cleared.accountCaps).toEqual([]);
    expect(cleared.overrides).toEqual([]);
    const missing = yield* Effect.flip(
      edit({
        setOverrides: [{ account: "XL", windowId: "five_hour", expiresAt: "2026-11-12T00:00:00Z" }],
      }),
    );
    expect(missing.detail).toContain(
      'XL reports no usage window "five_hour". Its windows: weekly.',
    );
  }),
);

it("reads the policy with accounts by label and without expired entries", () => {
  const view = allocationPolicyView(
    snapshot({
      accountRules: [
        { key: key(xl), kind: "exclude", note: "never XL" },
        { key: key(es), kind: "priority", value: 10, expiresAt: "2026-11-09T11:00:00.000Z" },
        { key: "gone", kind: "maxWorkers", value: 1 },
      ],
      accountCaps: [
        {
          key: key(es),
          weeklyPercent: 90,
          fiveHourPercent: null,
          stopWorkers: true,
          stopMasters: false,
        },
      ],
    }),
    at,
  );
  expect(view.version).toBe(3);
  expect(view.rules).toEqual([
    { account: "XL", kind: "exclude", note: "never XL" },
    { account: "gone", kind: "maxWorkers", value: 1 },
  ]);
  expect(view.caps[0]?.account).toBe("ES");
  expect(view.accounts).toEqual([
    {
      label: "ES",
      driver: "claudeAgent",
      instanceIds: ["claude_eol", "claude_es_laptop"],
      windowIds: ["weekly"],
    },
    { label: "XL", driver: "claudeAgent", instanceIds: ["claude_xinya"], windowIds: ["weekly"] },
    { label: "ES", driver: "claudeAgent", instanceIds: ["local"], windowIds: ["weekly"] },
  ]);
});

// DS has no known login on any of three computers, so each computer keys it separately.
const threeComputers = ["desk", "laptop", "server"].map((environmentId) => ({
  environmentId,
  observedAt: at,
  complete: true,
  demand: [],
  notices: [],
  accounts: [account(environmentId, "ds", "DS", null)],
}));
const everywhere = { ...snapshot(), inventories: threeComputers };
const blocked = (policy: AllocationPolicy) =>
  threeComputers.map(({ accounts: [ds] }) => accountRuleRefusal(policy, ds!, [], at) !== undefined);

it.effect("lists an account with no known login once and applies its rules on every computer", () =>
  Effect.gen(function* () {
    expect(allocationPolicyView(everywhere, at).accounts).toEqual([
      { label: "DS", driver: "claudeAgent", instanceIds: ["ds"], windowIds: ["weekly"] },
    ]);
    const cap = { weeklyPercent: 80, fiveHourPercent: null, stopWorkers: true, stopMasters: false };
    const set = yield* editAllocationPolicy(
      everywhere,
      { setRules: [{ account: "DS", kind: "exclude" }], setCaps: [{ account: "ds", ...cap }] },
      at,
    );
    expect(set.accountRules).toHaveLength(3);
    expect(blocked(set)).toEqual([true, true, true]);
    // Three stored rules read back as one.
    const view = allocationPolicyView({ ...everywhere, policy: set }, at);
    expect(view.rules).toEqual([{ account: "DS", kind: "exclude" }]);
    expect(view.caps).toEqual([{ account: "DS", ...cap }]);
    const cleared = yield* editAllocationPolicy(
      { ...everywhere, policy: set },
      { clearRules: [{ account: "DS" }], clearCaps: ["DS"] },
      at,
    );
    expect(cleared.accountRules).toEqual([]);
    expect(cleared.accountCaps).toEqual([]);
    expect(blocked(cleared)).toEqual([false, false, false]);
    const override = yield* Effect.flip(
      editAllocationPolicy(
        everywhere,
        {
          setOverrides: [{ account: "DS", windowId: "weekly", expiresAt: "2026-11-12T00:00:00Z" }],
        },
        at,
      ),
    );
    expect(override.detail).toContain("has no known login");
  }),
);
