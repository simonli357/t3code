import {
  WS_METHODS,
  allocationFableMode,
  allocationFamilyGoal,
  allocationPreferenceKey,
  modelLadder,
  routingEffortOptionId,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationInventory,
  type AllocationPolicy,
  type AllocationSnapshot,
  type ModelRoutingPolicy,
  type RoutingProfile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { sameStoredValue, type AutosaveOptions, type AutosaveResult } from "./autosave.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createAllocationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
  };
}

export function allocationAccountCap(
  policy: AllocationPolicy,
  key: string,
): AllocationAccountCap | undefined {
  return policy.accountCaps?.find((cap) => cap.key === key);
}

export function allocationSupportsFiveHourCap(driver: string): boolean {
  return driver === "claudeAgent";
}

export function allocationSubscriptionCapSource(
  accounts: readonly AllocationAccount[],
): "available" | "probeFailed" | "unsupported" | "unverified" {
  if (accounts.some((account) => account.usageLimitsUnavailableReason === undefined))
    return "available";
  if (accounts.some((account) => account.usageLimitsUnavailableReason === "unsupported"))
    return "unsupported";
  if (accounts.some((account) => account.usageLimitsUnavailableReason === "unverified"))
    return "unverified";
  return accounts.length > 0 &&
    accounts.every((account) => account.usageLimitsUnavailableReason === "probeFailed")
    ? "probeFailed"
    : "unverified";
}

export function allocationSupportsSubscriptionCaps(
  accounts: readonly AllocationAccount[],
): boolean {
  const source = allocationSubscriptionCapSource(accounts);
  return source === "available" || source === "probeFailed";
}

export function allocationAccountGroups(snapshot: AllocationSnapshot | null) {
  const groups = new Map<string, AllocationAccount[]>();

  for (const host of snapshot?.inventories ?? [])
    for (const account of host.accounts) {
      // An account with no known login is one account per driver and label on every computer.
      const key =
        account.accountKey === null
          ? JSON.stringify([account.driver, "label", account.label])
          : allocationPreferenceKey(account);

      groups.set(key, [...(groups.get(key) ?? []), account]);
    }

  const rows = [...groups.values()].map((members) => {
    // Caps and the preference order are stored per computer for an unknown login; edits write every key.
    const keys = [...new Set(members.map(allocationPreferenceKey))].sort();
    return {
      key: keys[0]!,
      keys,
      members,
      driver: members[0]!.driver,

      label: [...new Set(members.map((m) => m.label))].sort().join(" / "),

      hosts: [
        ...new Set(
          members.map(
            (m) =>
              snapshot?.inventories.find((i) => i.environmentId === m.environmentId)
                ?.environmentLabel ?? m.environmentId,
          ),
        ),
      ].sort(),
    };
  });

  return rows.sort(
    (a, b) =>
      a.driver.localeCompare(b.driver) ||
      a.label.localeCompare(b.label) ||
      a.key.localeCompare(b.key),
  );
}

/** "4 min", "3 h" or "2 d": how old a reading is. */
export function allocationReadingAge(checkedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 60_000));
  if (!Number.isFinite(minutes)) return "age unknown";
  return minutes < 60
    ? `${minutes} min`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`;
}

/**
 * One row per login: what it reads now and the policy values that apply to it. `other` logins
 * cannot usefully take a setting: their provider is turned off, or it reports no subscription
 * quota and no cap is saved for it.
 */
export function allocationAccountRows(
  snapshot: AllocationSnapshot | null,
  policy: AllocationPolicy,
  now: number,
) {
  const inventories = snapshot?.inventories ?? [];
  const computer = (environmentId: string) =>
    inventories.find((i) => i.environmentId === environmentId)?.environmentLabel ?? environmentId;
  const demand = inventories.flatMap((inventory) => inventory.demand);
  return allocationAccountGroups(snapshot).map((group) => {
    const login = group.members[0]!.accountKey;
    const newest = new Map<string, AllocationAccount["windows"][number]>();
    for (const window of group.members
      .filter((account) => account.usageLimitsUnavailableReason === undefined)
      .flatMap((account) => account.windows)
      .sort((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt)))
      if (!newest.has(window.id)) newest.set(window.id, window);
    const supportsCaps = allocationSupportsSubscriptionCaps(group.members);
    const saved = snapshot?.policy ?? policy;
    const ownGoal = policy.accountGoals?.find((goal) => group.keys.includes(goal.key));
    const familyGoal = allocationFamilyGoal(policy, group.driver);
    const workersOffOn = group.members.flatMap((member) =>
      member.availableForWorkers === false ? [computer(member.environmentId)] : [],
    );
    return {
      ...group,
      login,
      // A login that is not known is told apart by its computers.
      name: `${group.label}${login === null ? ` (${group.hosts.join(", ")})` : ""}`,
      /** The plan and its usage tier as the provider reports them, such as Max 20x. */
      plan: group.members.find((member) => member.plan)?.plan ?? null,
      instances: group.members.map((member) => ({
        environmentId: member.environmentId,
        computer: computer(member.environmentId),
        instanceId: member.instanceId,
        workersEnabled: member.availableForWorkers !== false,
      })),
      /** Each usage window once, from the computer that read it last. */
      windows: [...newest.values()].map((window) => ({
        id: window.id,
        label: window.label,
        kind: window.kind,
        models: window.models ?? [],
        usedPercent: window.usedPoints,
        resetsAt: window.resetsAt,
        checkedAt: window.checkedAt,
        age: allocationReadingAge(window.checkedAt, now),
      })),
      /** Managed workers running or starting on this login, on every computer. */
      workers: demand.filter(
        (d) =>
          d.worker === true &&
          group.members.some(
            (m) =>
              (login !== null && d.accountKey === login) ||
              (m.environmentId === d.environmentId && m.instanceId === d.instanceId),
          ),
      ).length,
      /** False when every computer's own settings keep workers off this login. */
      workersEnabled: workersOffOn.length < group.members.length,
      workersOffOn,
      /** Workers here run on Fable rungs only; null when the login cannot run Fable. */
      fableMode:
        group.driver === "claudeAgent"
          ? group.members.some((member) => allocationFableMode(policy, member))
          : null,
      supportsCaps,
      capSource: allocationSubscriptionCapSource(group.members),
      cap: group.keys.map((key) => allocationAccountCap(policy, key)).find(Boolean),
      /** Percent of the weekly limit a day; the provider family's unless the account has its own. */
      goal: ownGoal
        ? { percentPerDay: ownGoal.percentPerDay, own: true }
        : familyGoal === null
          ? null
          : { percentPerDay: familyGoal, own: false },
      /** How long the account lasts and what each limit holds, from the coordinator. */
      runway: snapshot?.runways?.find((runway) => group.keys.includes(runway.key)) ?? null,
      // Decided from the saved policy, so a row does not move while it is being edited.
      other:
        group.members.every((member) => member.enabled === false) ||
        (!supportsCaps && !group.keys.some((key) => allocationAccountCap(saved, key))),
    };
  });
}
export type AllocationAccountRow = ReturnType<typeof allocationAccountRows>[number];

/** The policy with the login's own daily goal set, or cleared so it uses its family's. */
export function withAllocationAccountGoal(
  policy: AllocationPolicy,
  row: Pick<AllocationAccountRow, "keys">,
  percentPerDay: number | undefined,
): AllocationPolicy {
  return {
    ...policy,
    accountGoals: [
      ...(policy.accountGoals ?? []).filter((goal) => !row.keys.includes(goal.key)),
      ...(percentPerDay === undefined ? [] : row.keys.map((key) => ({ key, percentPerDay }))),
    ],
  };
}

/**
 * The policy with the login's Fable mode on or off. A policy from before Fable mode was per
 * account, with it on, starts from every Claude login in the snapshot.
 */
export function withAllocationAccountFableMode(
  policy: AllocationPolicy,
  snapshot: AllocationSnapshot | null,
  row: Pick<AllocationAccountRow, "keys">,
  on: boolean,
): AllocationPolicy {
  const { fableOnly: _everyAccount, ...rest } = policy;
  const current =
    policy.fableAccounts ??
    (snapshot?.inventories ?? [])
      .flatMap((inventory) => inventory.accounts)
      .filter((account) => allocationFableMode(policy, account))
      .map(allocationPreferenceKey);
  return {
    ...rest,
    fableAccounts: [
      ...new Set([...current.filter((key) => !row.keys.includes(key)), ...(on ? row.keys : [])]),
    ],
  };
}

type OrderRow = Pick<AllocationAccountRow, "key" | "keys">;
/** The preference order: logins the policy lists, in its order, then the rest as given. */
export function allocationAccountOrder<Row extends OrderRow>(
  rows: readonly Row[],
  policy: AllocationPolicy,
): Row[] {
  const order = policy.accountOrder ?? [];
  const rank = (row: Row) => {
    const listed = row.keys.map((key) => order.indexOf(key)).filter((index) => index >= 0);
    return listed.length ? Math.min(...listed) : Number.POSITIVE_INFINITY;
  };
  // Array.sort is stable, so unlisted logins keep the order they came in.
  return [...rows].sort((a, b) => {
    const [left, right] = [rank(a), rank(b)];
    return left === right ? 0 : left - right;
  });
}

/** `list` with the item at `index` moved by `delta` places; unchanged when it cannot move. */
export function allocationMoved<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const to = index + delta;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  next.splice(to, 0, ...next.splice(index, 1));
  return next;
}

/**
 * The policy with the login `key` moved up (-1) or down (1) the preference order. Every login in
 * `rows` becomes listed; keys the policy lists for logins not in `rows` stay, after them.
 */
export function withAllocationAccountMoved(
  policy: AllocationPolicy,
  rows: readonly OrderRow[],
  key: string,
  delta: -1 | 1,
): AllocationPolicy {
  const ordered = allocationAccountOrder(rows, policy);
  const keys = allocationMoved(
    ordered,
    ordered.findIndex((row) => row.key === key),
    delta,
  ).flatMap((row) => row.keys);
  return {
    ...policy,
    accountOrder: [...keys, ...(policy.accountOrder ?? []).filter((k) => !keys.includes(k))],
  };
}

/**
 * A policy as the parts a page edits one at a time: each account's cap and daily goal, and
 * every other value whole. The version is not a part.
 */
function allocationPolicyParts(policy: AllocationPolicy) {
  const { version: _version, accountCaps = [], accountGoals = [], ...values } = policy;
  return new Map<string, unknown>([
    ...Object.entries(values).filter(([, value]) => value !== undefined),
    ...accountCaps.map((cap) => [`cap:${cap.key}`, cap] as const),
    ...accountGoals.map((goal) => [`goal:${goal.key}`, goal] as const),
  ]);
}

/**
 * The parts that differ: a value's name such as `accountOrder`, `cap:` and an account key, or
 * `goal:` and an account key. Against the stored policy these are the values not stored yet.
 */
export function allocationPolicyChanges(from: AllocationPolicy, to: AllocationPolicy) {
  const [before, after] = [allocationPolicyParts(from), allocationPolicyParts(to)];
  return new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      (part) => !sameStoredValue(before.get(part), after.get(part)),
    ),
  );
}

/**
 * The edits `mine` made to `base`, applied onto the newer stored `theirs`. `collides` when
 * `theirs` changed one of the edited parts to something else: the edit still wins in the
 * returned policy, so the caller asks before storing it.
 */
export function rebaseAllocationPolicy(
  base: AllocationPolicy,
  mine: AllocationPolicy,
  theirs: AllocationPolicy,
): { policy: AllocationPolicy; collides: boolean } {
  const changed = allocationPolicyChanges(base, mine);
  const before = allocationPolicyParts(base);
  const edited = allocationPolicyParts(mine);
  const newer = allocationPolicyParts(theirs);
  const ofAccount = (part: string) => part.startsWith("cap:") || part.startsWith("goal:");
  const perAccount = <T extends { readonly key: string }>(
    prefix: string,
    own: readonly T[] = [],
    stored: readonly T[] = [],
  ) => [
    ...stored.filter((item) => !changed.has(`${prefix}:${item.key}`)),
    ...own.filter((item) => changed.has(`${prefix}:${item.key}`)),
  ];
  return {
    policy: Object.assign(
      {},
      theirs,
      // The whole values the edits changed; one they removed becomes undefined.
      Object.fromEntries(
        [...changed].filter((part) => !ofAccount(part)).map((part) => [part, edited.get(part)]),
      ),
      {
        accountCaps: perAccount("cap", mine.accountCaps, theirs.accountCaps),
        accountGoals: perAccount("goal", mine.accountGoals, theirs.accountGoals),
      },
    ),
    collides: [...changed].some((part) => {
      const stored = newer.get(part);
      return (
        !sameStoredValue(stored, before.get(part)) && !sameStoredValue(stored, edited.get(part))
      );
    }),
  };
}

/** Why a policy cannot be stored as it is; null when every number is in range. */
export function allocationPolicyInvalid(policy: AllocationPolicy): string | null {
  const within = (value: number | null | undefined, max: number) =>
    value == null || (Number.isFinite(value) && value >= 0 && value <= max);
  if (!within(policy.closeMarginPoints, 50)) return "The margin must be a number from 0 to 50.";
  if (!within(policy.longWaitHours, 168)) return "The wait must be a number from 0 to 168 hours.";
  if (
    !(policy.accountCaps ?? []).every(
      (cap) => within(cap.weeklyPercent, 100) && within(cap.fiveHourPercent, 100),
    )
  )
    return "A cap must be a number from 0 to 100.";
  if (!(policy.accountGoals ?? []).every((goal) => within(goal.percentPerDay, 100)))
    return "A daily goal must be a number from 0 to 100.";
  return null;
}

/** How the allocation policy is compared, merged and checked when it saves itself. */
export const allocationAutosaveRules = {
  dirty: (baseline, policy) => allocationPolicyChanges(baseline, policy).size > 0,
  rebase: rebaseAllocationPolicy,
  invalid: allocationPolicyInvalid,
} satisfies Pick<AutosaveOptions<AllocationPolicy>, "dirty" | "rebase" | "invalid">;

/** What a refused save of either policy means: a newer stored version, or why it failed. */
export function allocationSaveFailure(
  cause: Cause.Cause<unknown> | undefined,
): AutosaveResult<never> {
  const failure = cause ? Cause.squash(cause) : undefined;
  if (typeof failure === "object" && failure !== null && "code" in failure) {
    if (failure.code === "conflict") return { conflict: true };
    if (failure instanceof Error && failure.message) return { error: failure.message };
  }
  return { error: "The computer that keeps these settings did not answer." };
}

/** The ladder (weakest first) changed by one edit, as the policy to save. */
export function withModelLadderEdit(
  policy: ModelRoutingPolicy,
  edit:
    | { readonly type: "add"; readonly rung: RoutingProfile }
    | { readonly type: "remove"; readonly index: number }
    | { readonly type: "move"; readonly index: number; readonly delta: -1 | 1 }
    | { readonly type: "set"; readonly index: number; readonly rung: Partial<RoutingProfile> },
): ModelRoutingPolicy {
  const ladder = modelLadder(policy);
  return {
    ...policy,
    ladder:
      edit.type === "add"
        ? [...ladder, edit.rung]
        : edit.type === "remove"
          ? ladder.filter((_, index) => index !== edit.index)
          : edit.type === "move"
            ? allocationMoved(ladder, edit.index, edit.delta)
            : ladder.map((rung, index) =>
                index === edit.index ? { ...rung, ...edit.rung } : rung,
              ),
  };
}

/** The models a provider's connected accounts offer, each with the efforts it can run at. */
export function allocationModelChoices(
  inventories: readonly AllocationInventory[],
  driver?: string,
) {
  const choices = new Map<string, Set<string>>();
  for (const account of inventories.flatMap((i) => i.accounts)) {
    if (driver !== undefined && account.driver !== driver) continue;
    for (const model of account.models) {
      const effort = model.capabilities?.optionDescriptors?.find(
        (option) => option.id === routingEffortOptionId(account.driver),
      );
      const efforts = choices.get(model.slug) ?? new Set<string>();
      if (effort?.type === "select") for (const option of effort.options) efforts.add(option.id);
      choices.set(model.slug, efforts);
    }
  }
  return [...choices].map(([model, efforts]) => ({ model, efforts: [...efforts] }));
}
