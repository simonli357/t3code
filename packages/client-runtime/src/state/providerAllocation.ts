import {
  WS_METHODS,
  allocationFamilyGoal,
  allocationPreferenceKey,
  modelLadder,
  routingEffortOptionId,
  type AllocationAccount,
  type AllocationAccountCap,
  type AllocationInventory,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationRequest,
  type AllocationDecision,
  type ModelRoutingPolicy,
  type RoutingProfile,
} from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createAllocationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation:start",
      tag: WS_METHODS.providerAllocationStart,
    }),
  };
}

/** A preview is tied to the exact editor content and request, not just its version. */
export function allocationPreviewKey(policy: AllocationPolicy, request: AllocationRequest): string {
  return JSON.stringify({ policy, request });
}

export function allocationSummary(decision: AllocationDecision) {
  return {
    choice: decision.selectedInstanceId ?? decision.outcome,
    reason: decision.reasons.join(" "),
    eligible: decision.candidates.filter((c) => c.eligible).length,
    excluded: decision.candidates.filter((c) => !c.eligible).length,
  };
}

export function allocationAccountLabel(
  snapshot: AllocationSnapshot | null,
  environmentId: string,
  instanceId: string,
) {
  return (
    snapshot?.inventories
      .find((i) => i.environmentId === environmentId)
      ?.accounts.find((a) => a.instanceId === instanceId)?.label ?? "Unavailable account"
  );
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
