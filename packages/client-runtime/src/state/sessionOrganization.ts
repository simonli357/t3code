/* oxlint-disable unicorn/no-array-reverse -- Hermes needs copied arrays and reverse(). */
import {
  EnvironmentId,
  type ManagedSessionRef,
  type ScopedThreadRef,
  type SessionOwnershipResult,
  type SessionOwnershipInput,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { sortActiveThreadsByOrderKey, sortPinnedThreadsByOrderKey } from "./threadSort.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export const sessionKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
export const resolveManagedSessionRef = (
  environmentId: EnvironmentId,
  ref: ManagedSessionRef,
): ScopedThreadRef =>
  scopeThreadRef(
    ref.environmentId === null ? environmentId : EnvironmentId.make(ref.environmentId),
    ref.threadId,
  );

export function sessionRole(thread: Pick<EnvironmentThreadShell, "organization">) {
  if (thread.organization === undefined) return null;
  if (thread.organization.owner !== null) return "Worker";
  return thread.organization.workers.length ? "Master" : "Independent";
}

export function sessionWorkerState(thread: EnvironmentThreadShell, connected: boolean) {
  const attention =
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.organization?.reportOutcome === "blocked" ||
    ["error", "interrupted"].includes(thread.organization?.assignmentState ?? "") ||
    thread.session?.status === "error" ||
    thread.latestTurn?.state === "error";
  const running =
    thread.backgroundLiveness === "working" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.organization?.assignmentState === "queued";
  return {
    attention,
    running: connected && running,
    unknown: !connected,
    finished:
      !attention &&
      !running &&
      (thread.settledOverride === "settled" ||
        (thread.settledOverride !== "active" &&
          thread.pinnedAt == null &&
          thread.organization?.reportOutcome === "done")),
  };
}

/** Scoped identities keep identical thread IDs on different hosts separate. */
export function buildSessionHierarchy(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const byKey = new Map(threads.map((thread) => [sessionKey(thread), thread]));
  const parentByKey = new Map<string, string>();
  const references = new Map<string, ScopedThreadRef>();
  const revisions = new Map<string, number>();
  for (const thread of threads) {
    if (thread.organization?.authorityEnvironmentId)
      revisions.set(sessionKey(thread), thread.organization.revision);
    const owner = thread.organization?.owner;
    if (owner) {
      const ref = resolveManagedSessionRef(thread.environmentId, owner);
      const master = byKey.get(scopedThreadKey(ref));
      // A connected authority can release/transfer a worker while the execution
      // host is offline. Its complete child list outranks that host's saved owner.
      const authoritativeRelease =
        !thread.organization?.authorityEnvironmentId &&
        ref.environmentId !== thread.environmentId &&
        master?.organization !== undefined &&
        !master.organization.workers.some(
          (worker) =>
            scopedThreadKey(resolveManagedSessionRef(master.environmentId, worker)) ===
            sessionKey(thread),
        );
      if (!authoritativeRelease) parentByKey.set(sessionKey(thread), scopedThreadKey(ref));
      references.set(scopedThreadKey(ref), ref);
    }
  }
  // Versioned proxies carry the canonical worker revision. Older disconnected
  // mirrors cannot override a newer execution shell or a newer parent's proxy.
  for (const thread of threads)
    for (const worker of thread.organization?.workers ?? []) {
      const ref = resolveManagedSessionRef(thread.environmentId, worker);
      const key = scopedThreadKey(ref);
      references.set(key, ref);
      if (worker.revision !== undefined) {
        const currentRevision = revisions.get(key) ?? -1;
        if (
          worker.revision > currentRevision ||
          (worker.revision === currentRevision && !byKey.has(key))
        ) {
          parentByKey.set(key, sessionKey(thread));
          revisions.set(key, worker.revision);
        }
      } else if (
        !revisions.has(key) &&
        (ref.environmentId !== thread.environmentId || !byKey.has(key))
      )
        parentByKey.set(key, sessionKey(thread));
    }
  // Tolerate incomplete/older snapshots without dropping rows or looping.
  for (const key of parentByKey.keys()) {
    const seen = new Set([key]);
    let next = parentByKey.get(key);
    while (next !== undefined) {
      if (seen.has(next)) {
        parentByKey.delete(key);
        break;
      }
      seen.add(next);
      next = parentByKey.get(next);
    }
  }
  // Normalize only the view. The next shell event replaces it; no relationship
  // is persisted in client state or inferred from conversation titles.
  for (const [key, thread] of byKey) {
    if (!thread.organization) continue;
    const parent = parentByKey.get(key);
    const savedOwner = thread.organization.owner;
    const savedKey = savedOwner
      ? scopedThreadKey(resolveManagedSessionRef(thread.environmentId, savedOwner))
      : undefined;
    if (parent === savedKey) continue;
    const ownerThread = parent ? byKey.get(parent) : undefined;
    const ownerRef = ownerThread
      ? { environmentId: ownerThread.environmentId, threadId: ownerThread.id }
      : parent
        ? references.get(parent)
        : null;
    byKey.set(key, {
      ...thread,
      organization: {
        ...thread.organization,
        authorityEnvironmentId:
          ownerRef?.environmentId ??
          savedOwner?.environmentId ??
          thread.organization.authorityEnvironmentId,
        owner: ownerRef ?? null,
      },
    });
  }
  const children = new Map<string, string[]>();
  for (const [key, parent] of parentByKey) {
    const list = children.get(parent) ?? [];
    list.push(key);
    children.set(parent, list);
  }
  const path = (key: string) => {
    const result: string[] = [];
    let parent = parentByKey.get(key);
    while (parent !== undefined) {
      result.unshift(parent);
      parent = parentByKey.get(parent);
    }
    return result;
  };
  const descendants = (key: string): string[] => {
    const result: string[] = [];
    const pending = [...(children.get(key) ?? [])].reverse();
    while (pending.length) {
      const child = pending.pop()!;
      result.push(child);
      pending.push(...[...(children.get(child) ?? [])].reverse());
    }
    return result;
  };
  const root = (key: string) =>
    byKey.get(key)?.isBase
      ? key
      : (path(key).findLast(
          (parent) => byKey.get(parent)?.isBase && byKey.get(parent)?.archivedAt === null,
        ) ??
        path(key).find((parent) => byKey.get(parent)?.archivedAt === null) ??
        key);
  return { byKey, parentByKey, references, children, path, descendants, root };
}
export type SessionHierarchy = ReturnType<typeof buildSessionHierarchy>;

/**
 * Settled workers leave their master's group. The sidebar lists them in Settled
 * like any other settled thread, so they neither show beneath the master nor
 * count in its summary. Ownership is untouched, and a settled worker's active
 * descendants stay with the nearest group above it. `isSettled` is the caller's
 * own Settled rule, so a group can never disagree with the shelf. A root keeps
 * its own group whatever its settlement.
 */
export function settledWorkerKeys(
  hierarchy: SessionHierarchy,
  isSettled: (thread: EnvironmentThreadShell) => boolean,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [key, thread] of hierarchy.byKey) {
    if (thread.archivedAt === null && hierarchy.root(key) !== key && isSettled(thread)) {
      keys.add(key);
    }
  }
  return keys;
}

/** The top-level row a thread is listed under: itself when it is a settled worker,
 * otherwise the head of its group. */
export function sessionListRoot(
  hierarchy: SessionHierarchy,
  key: string,
  settled: ReadonlySet<string>,
) {
  return settled.has(key) ? key : hierarchy.root(key);
}

export function summarizeSessionWorkers(
  hierarchy: SessionHierarchy,
  key: string,
  connected: ReadonlySet<string>,
  settled: ReadonlySet<string>,
) {
  const workers = hierarchy.descendants(key).filter((workerKey) => !settled.has(workerKey));
  const summary = { total: workers.length, running: 0, attention: 0, unknown: 0, finished: 0 };
  for (const workerKey of workers) {
    const worker = hierarchy.byKey.get(workerKey);
    if (!worker) {
      summary.unknown++;
      continue;
    }
    const state = sessionWorkerState(worker, connected.has(worker.environmentId));
    if (state.running) summary.running++;
    if (state.attention) summary.attention++;
    if (state.unknown) summary.unknown++;
    if (state.finished) summary.finished++;
  }
  return summary;
}
export type SessionWorkerSummary = ReturnType<typeof summarizeSessionWorkers>;

/**
 * One-line worker status for a group header. A part appears only when its count
 * is known and non-zero; unknown workers always get their own part, so a missing
 * "running" part never hides workers whose state this client cannot see.
 */
export function describeSessionWorkers(summary: SessionWorkerSummary) {
  const parts: Array<{
    kind: "attention" | "running" | "unavailable";
    count: number;
    /** What the count says, for example "needs attention"; the count itself is separate. */
    phrase: string;
  }> = [];
  if (summary.attention > 0)
    parts.push({
      kind: "attention",
      count: summary.attention,
      phrase: summary.attention === 1 ? "needs attention" : "need attention",
    });
  if (summary.running > 0)
    parts.push({ kind: "running", count: summary.running, phrase: "running" });
  if (summary.unknown > 0)
    parts.push({ kind: "unavailable", count: summary.unknown, phrase: "offline or unknown" });
  const total = `${summary.total} ${summary.total === 1 ? "worker" : "workers"}`;
  return {
    total,
    parts,
    text: [total, ...parts.map((part) => `${part.count} ${part.phrase}`)].join(", "),
  };
}

export type SessionOwner =
  | {
      readonly state: "available";
      readonly key: string;
      readonly title: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ScopedThreadRef["threadId"];
      readonly archived: boolean;
    }
  | {
      readonly state: "unavailable";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ScopedThreadRef["threadId"];
    };

/** Owners from the top of the hierarchy to the direct owner. An owner this client
 * has not loaded keeps the identity its worker recorded; nothing is invented. */
export function sessionOwnerChain(hierarchy: SessionHierarchy, key: string): SessionOwner[] {
  return hierarchy.path(key).flatMap((ownerKey): SessionOwner[] => {
    const owner = hierarchy.byKey.get(ownerKey);
    if (owner)
      return [
        {
          state: "available",
          key: ownerKey,
          title: owner.title,
          environmentId: owner.environmentId,
          threadId: owner.id,
          archived: owner.archivedAt !== null,
        },
      ];
    const ref = hierarchy.references.get(ownerKey) ?? parseScopedThreadKey(ownerKey);
    return ref
      ? [
          {
            state: "unavailable",
            key: ownerKey,
            environmentId: ref.environmentId,
            threadId: ref.threadId,
          },
        ]
      : [];
  });
}

/**
 * The owner caption for a row: "Master: <title> · <computer>". An unavailable
 * owner reads "Master unavailable · <computer>" and keeps its full identity in
 * `detail`, which belongs in a tooltip or an accessibility description rather
 * than in the row.
 */
export function describeSessionOwner(
  chain: ReadonlyArray<SessionOwner>,
  computerLabel: (environmentId: EnvironmentId) => string | null,
) {
  const owner = chain.at(-1);
  if (owner === undefined) return null;
  const computer = computerLabel(owner.environmentId);
  const withComputer = (name: string) => (computer ? `${name} · ${computer}` : name);
  const identity = (item: SessionOwner) =>
    item.state === "available"
      ? [item.title, computerLabel(item.environmentId)].filter(Boolean).join(" · ")
      : `session ${item.threadId} on ${computerLabel(item.environmentId) ?? item.environmentId}`;
  return {
    available: owner.state === "available",
    text:
      owner.state === "unavailable"
        ? withComputer("Master unavailable")
        : withComputer(`Master: ${owner.archived ? `${owner.title} (archived)` : owner.title}`),
    detail:
      owner.state === "unavailable"
        ? `Master unavailable: ${identity(owner)} is not loaded on this client. Its computer may be offline or disconnected.`
        : chain.length > 1
          ? `Master: ${identity(owner)}. Owner chain: ${chain.map(identity).join(" › ")}.`
          : `Master: ${identity(owner)}.`,
    ariaLabel:
      owner.state === "available" ? `Worker of ${owner.title}` : "Worker, master unavailable",
  };
}

/** How far below its visible group header a row sits: 0 for top-level rows, 1 for
 * workers directly under the header's master, 2+ for workers of workers. Depth
 * counts real owners, so an active worker under a settled one still reads 2 and
 * keeps naming that owner. */
export function sessionGroupDepth(
  hierarchy: SessionHierarchy,
  key: string,
  settled: ReadonlySet<string>,
) {
  if (settled.has(key)) return 0;
  const root = hierarchy.root(key);
  if (root === key) return 0;
  const path = hierarchy.path(key);
  return path.length - path.indexOf(root);
}

/**
 * The role words a row shows. Independent is the default, and a worker nested
 * under its group header is already named by that header, so neither repeats on
 * every row; a worker outside a header (search, unavailable master) keeps its
 * role. Direct input is information, not decoration, and always shows.
 */
export function describeSessionRole(
  thread: Pick<EnvironmentThreadShell, "organization" | "isBase">,
  options: { readonly nested: boolean },
) {
  const role = sessionRole(thread);
  if (role === null && !thread.isBase) return null;
  const directInput = thread.organization?.directInputAt ? "Direct input" : null;
  const named = role === "Master" || (role === "Worker" && !options.nested) ? role : null;
  const text = [thread.isBase ? "Base" : null, named, directInput]
    .filter((part) => part !== null)
    .join(" · ");
  if (text.length === 0) return null;
  return {
    text,
    master: named === "Master",
    ariaLabel: `Session role: ${thread.isBase ? "Base, " : ""}${role ?? "Independent"}${directInput ? ", direct input" : ""}`,
  };
}

/** Opens a closed group or closes an open one, keeping every other choice. */
export function toggleSessionGroupKey(keys: ReadonlyArray<string>, key: string) {
  return keys.includes(key) ? keys.filter((existing) => existing !== key) : [...keys, key];
}

/**
 * Flatten only for presentation; grandchildren keep their real owner and path.
 * Groups are collapsed until their master is in `expanded`. A collapsed group
 * still lists the selected worker, and only that worker, so the open
 * conversation always has a row to highlight without opening the whole group.
 *
 * Workers in `settled` (see `settledWorkerKeys`) are never listed beneath a
 * master: they have their own row in Settled, which also keeps a selected one
 * reachable. Their active descendants are still listed, in the group above.
 */
export function expandSessionGroups(input: {
  roots: ReadonlyArray<EnvironmentThreadShell>;
  hierarchy: SessionHierarchy;
  expanded: ReadonlySet<string>;
  finishedExpanded: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  selectedKey: string | null;
  settled: ReadonlySet<string>;
}) {
  const result: EnvironmentThreadShell[] = [];
  const selectedPath =
    input.selectedKey === null || input.settled.has(input.selectedKey)
      ? []
      : input.hierarchy.path(input.selectedKey);
  for (const root of input.roots) {
    const key = sessionKey(root);
    result.push(input.hierarchy.byKey.get(key) ?? root);
    // A settled worker listed on its own heads no group: its active descendants
    // belong to the group above, and listing them twice would duplicate rows.
    if (input.settled.has(key)) continue;
    const open = input.expanded.has(key);
    if (!open && !selectedPath.includes(key)) continue;
    const sortChildren = (parent: string): string[] => {
      const keys = input.hierarchy.children.get(parent) ?? [];
      const children = keys.flatMap((child) => {
        const thread = input.hierarchy.byKey.get(child);
        return thread ? [thread] : [];
      });
      return [
        ...sortPinnedThreadsByOrderKey(children.filter((thread) => thread.pinnedAt != null)),
        ...sortActiveThreadsByOrderKey(children.filter((thread) => thread.pinnedAt == null)),
      ]
        .map(sessionKey)
        .concat(keys.filter((child) => !input.hierarchy.byKey.has(child)));
    };
    const children: EnvironmentThreadShell[] = [];
    const pending = sortChildren(key).reverse();
    while (pending.length) {
      const childKey = pending.pop()!;
      const child = input.hierarchy.byKey.get(childKey);
      if (child?.isBase) continue;
      if (child?.archivedAt === null && !input.settled.has(childKey)) children.push(child);
      pending.push(...sortChildren(childKey).reverse());
    }
    if (!open) {
      const selected = children.find((thread) => sessionKey(thread) === input.selectedKey);
      if (selected) result.push(selected);
      continue;
    }
    const finished = (thread: EnvironmentThreadShell) =>
      sessionWorkerState(thread, input.connected.has(thread.environmentId)).finished;
    result.push(...children.filter((thread) => !finished(thread)));
    result.push(
      ...children.filter(
        (thread) =>
          finished(thread) &&
          (input.finishedExpanded.has(key) ||
            sessionKey(thread) === input.selectedKey ||
            selectedPath.includes(sessionKey(thread))),
      ),
    );
  }
  return result;
}

/** A confirmed refusal can refresh the editor; an uncertain response must keep
 * the original request ID and destination until the same request is resolved. */
export async function recoverOwnershipEdit(
  error: unknown,
  read: () => Promise<SessionOwnershipResult | null>,
): Promise<{ confirmed: boolean; relationship: SessionOwnershipResult | null }> {
  const confirmed =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "conflict" || error.code === "rejected");
  return { confirmed, relationship: confirmed ? await read() : null };
}

export function ownershipEditRequest(
  pending: SessionOwnershipInput | null,
  relationship: SessionOwnershipResult,
  owner: ManagedSessionRef | null,
  clientRequestId: string,
): SessionOwnershipInput {
  return (
    pending ?? {
      clientRequestId,
      threadId: relationship.threadId,
      ownerThreadId: owner?.threadId ?? null,
      ownerEnvironmentId: owner?.environmentId ?? null,
      expectedOwnerThreadId: relationship.ownerThreadId,
      expectedOwnerEnvironmentId: relationship.ownerEnvironmentId,
      expectedRevision: relationship.revision,
    }
  );
}
