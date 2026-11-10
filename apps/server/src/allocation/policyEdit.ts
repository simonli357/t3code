import {
  AllocationError,
  allocationPreferenceKey,
  defaultAllocationPolicy,
  type AllocationPolicy,
  type AllocationPolicyEdit,
  type AllocationPolicyView,
  type AllocationSnapshot,
  type AllocationWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const invalid = (detail: string) => new AllocationError({ code: "invalid", detail });
const live = (expiresAt: string | undefined, at: string) =>
  expiresAt === undefined || Date.parse(expiresAt) > Date.parse(at);

/**
 * One entry per account identity, however many computers and aliases reach it. An account with
 * no known login is one identity per driver and label, holding each computer's rule key.
 */
function identities(snapshot: AllocationSnapshot) {
  const byKey = new Map<
    string,
    {
      keys: Set<string>;
      accountKey: string | null;
      driver: AllocationPolicyView["accounts"][number]["driver"];
      labels: Set<string>;
      instanceIds: Set<AllocationPolicyView["accounts"][number]["instanceIds"][number]>;
      windows: Map<string, AllocationWindow>;
    }
  >();
  for (const account of snapshot.inventories.flatMap((i) => i.accounts)) {
    const key =
      account.accountKey === null
        ? JSON.stringify([account.driver, "label", account.label])
        : allocationPreferenceKey(account);
    const identity = byKey.get(key) ?? {
      keys: new Set<string>(),
      accountKey: account.accountKey,
      driver: account.driver,
      labels: new Set(),
      instanceIds: new Set(),
      windows: new Map(),
    };
    identity.keys.add(allocationPreferenceKey(account));
    identity.labels.add(account.label);
    identity.instanceIds.add(account.instanceId);
    for (const window of account.windows) {
      const known = identity.windows.get(window.id);
      if (!known || window.checkedAt > known.checkedAt) identity.windows.set(window.id, window);
    }
    byKey.set(key, identity);
  }
  return [...byKey.values()].map((identity) => ({
    ...identity,
    label: [...identity.labels].sort().join(" / "),
  }));
}

/** An account's rule on each computer reads back as one. */
const once = <T>(entries: readonly T[]) => [
  ...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values(),
];

/** The policy with every account named by its label and expired entries left out. */
export function allocationPolicyView(
  snapshot: AllocationSnapshot,
  at: string,
): AllocationPolicyView {
  const { policy } = snapshot;
  const known = identities(snapshot);
  const label = (key: string) => known.find((i) => i.keys.has(key))?.label ?? key;
  return {
    version: policy.version,
    curves: { claude: policy.claude, codex: policy.codex, other: policy.other },
    rules: once(
      (policy.accountRules ?? [])
        .filter((rule) => live(rule.expiresAt, at))
        .map(({ key, ...rule }) => ({ account: label(key), ...rule })),
    ),
    caps: once(
      (policy.accountCaps ?? []).map(({ key, ...cap }) => ({ account: label(key), ...cap })),
    ),
    overrides: policy.overrides
      .filter((override) => live(override.expiresAt, at))
      .map(({ accountKey, windowId, expiresAt, curve, useBy, resetPlan }) => ({
        account: known.find((i) => i.accountKey === accountKey)?.label ?? accountKey,
        windowId,
        expiresAt,
        ...(curve ? { curve } : {}),
        ...(useBy ? { useBy } : {}),
        ...(resetPlan ? { resetPlan } : {}),
      })),
    accounts: known.map(({ label, driver, instanceIds, windows }) => ({
      label,
      driver,
      instanceIds: [...instanceIds],
      windowIds: [...windows.keys()],
    })),
  };
}

/**
 * The policy after `edit`. A label or instance ID names its shared login; when the login is
 * unknown, every account carrying that name.
 */
export const editAllocationPolicy = Effect.fn("editAllocationPolicy")(function* (
  snapshot: AllocationSnapshot,
  edit: AllocationPolicyEdit,
  at: string,
) {
  const known = identities(snapshot);
  const resolve = Effect.fn(function* (account: string) {
    const name = account.toLowerCase();
    const matches = known.filter(
      (i) =>
        i.keys.has(account) ||
        [...i.labels, ...i.instanceIds].some((value) => value.toLowerCase() === name),
    );
    if (matches.length) return matches;
    return yield* invalid(
      `No account matches "${account}". Use a label or instance ID of: ${known.map((i) => `${i.label} (${[...i.instanceIds].join(", ")})`).join("; ")}.`,
    );
  });
  const time = Effect.fn(function* (value: string, name: string) {
    const parsed = Date.parse(value);
    if (!(parsed > Date.parse(at)))
      return yield* invalid(`${name} must be a time after now, such as 2026-01-31T18:00:00Z.`);
    return DateTime.formatIso(DateTime.makeUnsafe(parsed));
  });
  const { policy } = snapshot;
  let rules = (policy.accountRules ?? []).filter((rule) => live(rule.expiresAt, at));
  for (const { account, kind } of edit.clearRules ?? []) {
    const keys = new Set((yield* resolve(account)).flatMap((i) => [...i.keys]));
    rules = rules.filter(
      (rule) => !keys.has(rule.key) || (kind !== undefined && rule.kind !== kind),
    );
  }
  for (const { account, expiresAt, ...rule } of edit.setRules ?? []) {
    const keys = (yield* resolve(account)).flatMap((i) => [...i.keys]);
    const until = expiresAt ? { expiresAt: yield* time(expiresAt, "A rule's expiresAt") } : {};
    rules = [
      ...rules.filter((r) => !keys.includes(r.key) || r.kind !== rule.kind),
      ...keys.map((key) => ({ key, ...rule, ...until })),
    ];
  }
  let caps = policy.accountCaps ?? [];
  for (const account of edit.clearCaps ?? []) {
    const keys = new Set((yield* resolve(account)).flatMap((i) => [...i.keys]));
    caps = caps.filter((cap) => !keys.has(cap.key));
  }
  for (const { account, ...cap } of edit.setCaps ?? []) {
    const keys = (yield* resolve(account)).flatMap((i) => [...i.keys]);
    caps = [...caps.filter((c) => !keys.includes(c.key)), ...keys.map((key) => ({ key, ...cap }))];
  }
  let overrides = policy.overrides;
  // Overrides are stored by login, so an account whose login is unknown cannot take one.
  const logins = Effect.fn(function* (account: string) {
    const matches = (yield* resolve(account)).flatMap((i) =>
      i.accountKey === null ? [] : [{ ...i, accountKey: i.accountKey }],
    );
    if (matches.length) return matches;
    return yield* invalid(`${account} has no known login, so it cannot take a timed override.`);
  });
  for (const { account, windowId } of edit.clearOverrides ?? []) {
    const keys = new Set((yield* logins(account)).map((i) => i.accountKey));
    overrides = overrides.filter(
      (o) => !keys.has(o.accountKey) || (windowId !== undefined && o.windowId !== windowId),
    );
  }
  for (const { account, windowId, expiresAt, useBy, ...override } of edit.setOverrides ?? []) {
    const times = {
      expiresAt: yield* time(expiresAt, "An override's expiresAt"),
      ...(useBy ? { useBy: yield* time(useBy, "An override's useBy") } : {}),
    };
    for (const { accountKey, label, windows } of yield* logins(account)) {
      const window = windows.get(windowId);
      if (!window)
        return yield* invalid(
          `${label} reports no usage window "${windowId}". Its windows: ${[...windows.keys()].join(", ") || "none"}.`,
        );
      overrides = [
        ...overrides.filter((o) => o.accountKey !== accountKey || o.windowId !== windowId),
        {
          accountKey,
          windowId,
          createdAt: at,
          baselineUsedPoints: window.usedPoints,
          ...times,
          ...override,
        },
      ];
    }
  }
  const curve = (family: "claude" | "codex" | "other") =>
    edit.curves?.[family] === undefined
      ? policy[family]
      : (edit.curves[family] ?? defaultAllocationPolicy[family]);
  return {
    ...policy,
    claude: curve("claude"),
    codex: curve("codex"),
    other: curve("other"),
    accountRules: rules,
    accountCaps: caps,
    overrides,
  } satisfies AllocationPolicy;
});
