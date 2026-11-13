import {
  AllocationError,
  allocationPreferenceKey,
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  modelFallback,
  modelLadder,
  type AllocationPolicy,
  type AllocationPolicyEdit,
  type AllocationPolicyView,
  type AllocationSnapshot,
  type ModelRoutingPolicy,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const invalid = (detail: string) => new AllocationError({ code: "invalid", detail });

/**
 * One entry per account identity, however many computers and aliases reach it. An account with
 * no known login is one identity per driver and label, holding each computer's key.
 */
function identities(snapshot: AllocationSnapshot) {
  const byKey = new Map<
    string,
    {
      keys: Set<string>;
      driver: AllocationPolicyView["accounts"][number]["driver"];
      labels: Set<string>;
      instanceIds: Set<AllocationPolicyView["accounts"][number]["instanceIds"][number]>;
    }
  >();
  for (const account of snapshot.inventories.flatMap((i) => i.accounts)) {
    const key =
      account.accountKey === null
        ? JSON.stringify([account.driver, "label", account.label])
        : allocationPreferenceKey(account);
    const identity = byKey.get(key) ?? {
      keys: new Set<string>(),
      driver: account.driver,
      labels: new Set(),
      instanceIds: new Set(),
    };
    identity.keys.add(allocationPreferenceKey(account));
    identity.labels.add(account.label);
    identity.instanceIds.add(account.instanceId);
    byKey.set(key, identity);
  }
  return [...byKey.values()].map((identity) => ({
    ...identity,
    label: [...identity.labels].sort().join(" / "),
  }));
}

/** An account's entry on each computer reads back as one. */
const once = <T>(entries: readonly T[]) => [
  ...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values(),
];
const profile = ({ model, effort }: { model: string; effort: string }) => `${model} / ${effort}`;

/** Both policies with every account named by its label. */
export function allocationPolicyView(
  snapshot: AllocationSnapshot,
  model: ModelRoutingPolicy,
  options?: {
    readonly showTable?: AllocationPolicyEdit["showTable"];
    readonly warnings?: readonly string[];
  },
): AllocationPolicyView {
  const { policy } = snapshot;
  const known = identities(snapshot);
  const label = (key: string) => known.find((i) => i.keys.has(key))?.label ?? key;
  const fallback = modelFallback(model);
  return {
    version: policy.version,
    modelVersion: model.version,
    accountOrder: once((policy.accountOrder ?? []).map(label)),
    closeMarginPoints: policy.closeMarginPoints ?? DEFAULT_CLOSE_MARGIN_POINTS,
    longWaitHours: policy.longWaitHours ?? DEFAULT_LONG_WAIT_HOURS,
    caps: once(
      (policy.accountCaps ?? []).map(({ key, ...cap }) => ({ account: label(key), ...cap })),
    ),
    ladder: modelLadder(model).map(profile),
    fallback: fallback
      ? `${profile(fallback)} when the wanted rung is below ${profile(fallback.below)}`
      : null,
    ...(options?.showTable
      ? { table: model[options.showTable].cells.map((row) => row.map(profile)) }
      : {}),
    accounts: known.map(({ label, driver, instanceIds }) => ({
      label,
      driver,
      instanceIds: [...instanceIds],
    })),
    warnings: [...(options?.warnings ?? [])],
  };
}

/**
 * The allocation policy after `edit`. A label or instance ID names its shared login; when the
 * login is unknown, every account carrying that name.
 */
export const editAllocationPolicy = Effect.fn("editAllocationPolicy")(function* (
  snapshot: AllocationSnapshot,
  edit: AllocationPolicyEdit,
) {
  const known = identities(snapshot);
  const resolve = Effect.fn(function* (account: string) {
    const name = account.toLowerCase();
    const matches = known.filter(
      (i) =>
        i.keys.has(account) ||
        [...i.labels, ...i.instanceIds].some((value) => value.toLowerCase() === name),
    );
    if (matches.length) return matches.flatMap((i) => [...i.keys]);
    return yield* invalid(
      `No account matches "${account}". Use a label or instance ID of: ${known.map((i) => `${i.label} (${[...i.instanceIds].join(", ")})`).join("; ")}.`,
    );
  });
  const { policy } = snapshot;
  let caps = policy.accountCaps ?? [];
  for (const account of edit.clearCaps ?? []) {
    const keys = new Set(yield* resolve(account));
    caps = caps.filter((cap) => !keys.has(cap.key));
  }
  for (const { account, ...cap } of edit.setCaps ?? []) {
    const keys = yield* resolve(account);
    caps = [...caps.filter((c) => !keys.includes(c.key)), ...keys.map((key) => ({ key, ...cap }))];
  }
  let accountOrder = policy.accountOrder;
  if (edit.accountOrder) {
    const keys: string[] = [];
    for (const account of edit.accountOrder) keys.push(...(yield* resolve(account)));
    accountOrder = [...new Set(keys)];
  }
  return {
    ...policy,
    accountCaps: caps,
    ...(accountOrder ? { accountOrder } : {}),
    ...(edit.closeMarginPoints === undefined ? {} : { closeMarginPoints: edit.closeMarginPoints }),
    ...(edit.longWaitHours === undefined ? {} : { longWaitHours: edit.longWaitHours }),
  } satisfies AllocationPolicy;
});

/** The model policy after `edit`; a cell's model joins its table's model list. */
export function editModelPolicy(
  policy: ModelRoutingPolicy,
  edit: AllocationPolicyEdit,
): ModelRoutingPolicy {
  const tables = { claudeAgent: policy.claudeAgent, codex: policy.codex };
  for (const cell of edit.setCells ?? []) {
    const name = cell.table ?? "claudeAgent";
    const table = tables[name];
    const within = (score: number, from: number, to: number | undefined) =>
      score >= Math.min(from, to ?? from) && score <= Math.max(from, to ?? from);
    tables[name] = {
      allowedModels: table.allowedModels.includes(cell.model)
        ? table.allowedModels
        : [...table.allowedModels, cell.model],
      cells: table.cells.map((row, difficulty) =>
        row.map((old, stakes) =>
          within(difficulty, cell.difficulty, cell.difficultyTo) &&
          within(stakes, cell.stakes, cell.stakesTo)
            ? { model: cell.model, effort: cell.effort }
            : old,
        ),
      ),
    };
  }
  return {
    ...policy,
    ...tables,
    ...(edit.ladder === undefined ? {} : { ladder: edit.ladder }),
    ...(edit.fallback === undefined ? {} : { fallback: edit.fallback }),
  };
}
