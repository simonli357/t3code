/* oxlint-disable unicorn/no-array-reverse -- Hermes needs copied arrays and reverse(). */
import { EnvironmentId, type ManagedSessionRef, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
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
  for (const thread of threads) {
    const owner = thread.organization?.owner;
    if (owner) {
      const ref = resolveManagedSessionRef(thread.environmentId, owner);
      const master = byKey.get(scopedThreadKey(ref));
      // A connected authority can release/transfer a worker while the execution
      // host is offline. Its complete child list outranks that host's saved owner.
      const authoritativeRelease =
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
  // The master's proxy is authoritative for workers on another computer. Its
  // shell survives disconnection; the execution host may still have an older owner.
  for (const thread of threads)
    for (const worker of thread.organization?.workers ?? []) {
      const ref = resolveManagedSessionRef(thread.environmentId, worker);
      const key = scopedThreadKey(ref);
      references.set(key, ref);
      if (ref.environmentId !== thread.environmentId || !byKey.has(key))
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
    path(key).find((parent) => byKey.get(parent)?.archivedAt === null) ?? key;
  return { byKey, parentByKey, references, children, path, descendants, root };
}
export type SessionHierarchy = ReturnType<typeof buildSessionHierarchy>;

export function summarizeSessionWorkers(
  hierarchy: SessionHierarchy,
  key: string,
  connected: ReadonlySet<string>,
) {
  const workers = hierarchy.descendants(key);
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

/** Flatten only for presentation; grandchildren keep their real owner and path. */
export function expandSessionGroups(input: {
  roots: ReadonlyArray<EnvironmentThreadShell>;
  hierarchy: SessionHierarchy;
  collapsed: ReadonlySet<string>;
  finishedExpanded: ReadonlySet<string>;
  connected: ReadonlySet<string>;
  selectedKey: string | null;
}) {
  const result: EnvironmentThreadShell[] = [];
  const selectedPath = input.selectedKey === null ? [] : input.hierarchy.path(input.selectedKey);
  for (const root of input.roots) {
    const key = sessionKey(root);
    result.push(input.hierarchy.byKey.get(key) ?? root);
    const reveal = selectedPath.includes(key);
    if (input.collapsed.has(key) && !reveal) continue;
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
      if (child?.archivedAt === null) children.push(child);
      pending.push(...sortChildren(childKey).reverse());
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
