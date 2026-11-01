import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { relativeTime } from "../../lib/time";
import {
  buildSessionHierarchy,
  sessionKey,
  sessionListRoot,
  settledWorkerKeys,
  expandSessionGroups,
  summarizeSessionWorkers,
  describeSessionWorkers,
  describeSessionOwner,
  sessionOwnerChain,
  sessionGroupDepth,
  describeSessionRole,
} from "@t3tools/client-runtime/state/session-organization";
import { useSessionGroups } from "./useSessionGroups";
import { useEnvironments } from "../../state/environments";
import type { ThreadListV2ListItem } from "./threadListV2";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListInboxReturns,
} from "./threadListV2";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

/**
 * Home's and the thread sidebar's thread list. Its result is one value a screen only reads:
 * built inline, the list's inputs stayed open to mutation across the screen's other hooks, so
 * the React Compiler cached none of it and every render of the screen re-rendered every row.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly shelfPreferencesLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
}) {
  const { threads, workingShelfEnabled } = input;
  // A thread can stop working when the threads change, or when its exit grace expires.
  const inboxVersion = useSyncExternalStore(
    threadListInboxReturns.subscribe,
    threadListInboxReturns.getSnapshot,
  );
  const inbox = useMemo(
    () => threadListInboxReturns.observe(workingShelfEnabled ? threads : null),
    // oxlint-disable-next-line react/memo-dependencies -- the version signals an expired grace
    [threads, workingShelfEnabled, inboxVersion],
  );
  // Up/down menu availability for every card, computed once per section per
  // rebuild (see computeThreadMoveAvailability): per-thread planner calls made
  // list construction quadratic, and this list rebuilds on every minute tick.
  const sectionAvailability = (section: "pinned" | "active") =>
    computeThreadMoveAvailability({
      allThreads: threads,
      section,
      pendingOrder: input.pendingOrder,
      reorderableEnvironmentIds:
        section === "pinned" ? input.pinReorderEnvironmentIds : input.activeReorderEnvironmentIds,
      ordered: getThreadListV2OrderedSection({
        threads,
        section,
        pendingOrder: input.pendingOrder,
        now: input.now,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
      }),
    });
  const moveAvailability = new Map([
    ...sectionAvailability("pinned"),
    ...(workingShelfEnabled ? [] : sectionAvailability("active")),
  ]);
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const scopes = olderSettledScopes(input);
  const olderSettledShelf = useOlderSettledShelf({
    scopes,
    expanded: input.settledShelfExpanded,
    // A search lists only matches, so the shelf would page forever; loaded pages stay.
    visibleCount: input.searchQuery.trim().length === 0 ? input.settledLimit : 0,
  });
  const groups = useSessionGroups();
  const { environments } = useEnvironments();
  const connected = new Set(
    environments.filter((e) => e.connection.phase === "connected").map((e) => e.environmentId),
  );
  const hierarchy = buildSessionHierarchy(
    threads.filter(
      (thread) =>
        (input.environmentId === null || thread.environmentId === input.environmentId) &&
        (input.projectRefs == null ||
          input.projectRefs.some(
            (ref) =>
              ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
          )),
    ),
  );
  const settled = settledWorkerKeys(
    hierarchy,
    (thread) =>
      input.settlementEnvironmentIds.has(thread.environmentId) &&
      thread.settledOverride === "settled" &&
      !input.queuedThreadKeys.has(sessionKey(thread)) &&
      !effectiveSnoozed(thread, { now: input.now }),
  );
  const searching = input.searchQuery.trim().length > 0;
  const bases = threads.filter(
    (thread) =>
      thread.isBase &&
      thread.archivedAt === null &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (input.projectRefs == null ||
        input.projectRefs.some(
          (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
        )),
  );
  const layout = buildThreadListV2Items({
    pendingOrder: input.pendingOrder,
    threads: threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (searching ||
          (!thread.isBase &&
            sessionListRoot(hierarchy, sessionKey(thread), settled) === sessionKey(thread))),
    ),
    environmentId: input.environmentId,
    projectRefs: input.projectRefs,
    searchQuery: input.searchQuery,
    matchedThreadKeys: new Set(input.searchMatches.keys()),
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    settledLimit: input.settledLimit,
    now: input.now,
    workingShelfEnabled,
    workingShelfExpanded: input.workingShelfExpanded,
    inboxReturnAt: inbox.returnedAt,
    isWorking: inbox.isWorking,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    settledShelfExpanded: input.settledShelfExpanded,
    selectedThreadKey:
      input.selectedThreadKey === null
        ? null
        : sessionListRoot(hierarchy, input.selectedThreadKey, settled),
    isListedSettled: olderSettledShelf.isListed,
    unloadedSettledCount: olderSettledShelf.unloadedCount(
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          scopes.some(
            (scope) =>
              scope.environmentId === thread.environmentId &&
              (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
          ),
      ),
    ),
  });
  useOlderSettledShelfGrowth(olderSettledShelf, layout.listedSettledThreads);
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const scopedProjectKeys =
    input.projectRefs == null
      ? null
      : new Set(input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)));
  const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
  const pendingTasks = input.pendingTasks.filter(
    (pendingTask) =>
      (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(
          scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
        )) &&
      (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
  );
  const items = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    workingCount: layout.workingCount,
    workingShelfExpanded: input.workingShelfExpanded,
    workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfExpanded: input.settledShelfExpanded,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    moveAvailability,
    shelfPreferencesLoading: !input.shelfPreferencesLoaded,
  });
  const organized: ThreadListV2ListItem[] = [];
  const caption = (thread: (typeof threads)[number]) => {
    const depth = sessionGroupDepth(hierarchy, sessionKey(thread), settled);
    const owner = describeSessionOwner(
      sessionOwnerChain(hierarchy, sessionKey(thread)),
      (id) => environments.find((e) => e.environmentId === id)?.label ?? null,
    );
    return {
      organizationDepth: depth,
      organizationCaption: [describeSessionRole(thread, { nested: depth > 0 })?.text, owner?.text]
        .filter(Boolean)
        .join(" · "),
    };
  };
  for (const item of items) {
    if (item.type !== "v2-thread" || searching) {
      organized.push(item.type === "v2-thread" ? { ...item, ...caption(item.item.thread) } : item);
      continue;
    }
    const root = item.item.thread;
    const key = sessionKey(root);
    const rows = expandSessionGroups({
      roots: [root],
      hierarchy,
      expanded: groups.expanded,
      finishedExpanded: groups.finished,
      connected,
      selectedKey: input.selectedThreadKey ?? null,
      settled,
    });
    organized.push({
      ...item,
      item: { ...item.item, thread: hierarchy.byKey.get(key) ?? root },
      ...caption(root),
    });
    const appendGroup = (thread: typeof root) => {
      const groupKey = sessionKey(thread);
      const summary = summarizeSessionWorkers(hierarchy, groupKey, connected, settled);
      if (!settled.has(groupKey) && summary.total)
        organized.push({
          type: "v2-session-group",
          key: `group:${groupKey}`,
          groupKey,
          title: `Workers of ${thread.title}`,
          summary: describeSessionWorkers(summary).text,
          expanded: groups.expanded.has(groupKey),
          finished: summary.finished,
          finishedExpanded: groups.finished.has(groupKey),
        });
    };
    appendGroup(root);
    for (const thread of rows.slice(1)) {
      organized.push({
        ...item,
        key: sessionKey(thread),
        item: {
          ...item.item,
          thread,
          isLast: false,
          pinned: thread.pinnedAt != null,
          wokeAt: null,
        },
        hasQueuedMessages: input.queuedThreadKeys.has(sessionKey(thread)),
        canMoveUp: moveAvailability.get(`${thread.environmentId}:${thread.id}`)?.canMoveUp === true,
        canMoveDown:
          moveAvailability.get(`${thread.environmentId}:${thread.id}`)?.canMoveDown === true,
        timeLabel: relativeTime(thread.updatedAt),
        ...caption(thread),
      });
      appendGroup(thread);
    }
  }
  if (!searching && bases.length) {
    const baseRoots = bases.filter(
      (thread) =>
        groups.expanded.has("base-sessions") ||
        sessionListRoot(hierarchy, input.selectedThreadKey ?? "", settled) === sessionKey(thread),
    );
    const baseItems: ThreadListV2ListItem[] = expandSessionGroups({
      roots: baseRoots,
      hierarchy,
      expanded: groups.expanded,
      finishedExpanded: groups.finished,
      connected,
      selectedKey: input.selectedThreadKey,
      settled,
    }).map((thread) => ({
      type: "v2-thread" as const,
      key: sessionKey(thread),
      item: {
        thread,
        variant: "card" as const,
        snoozed: false,
        pinned: false,
        wokeAt: null,
        isLast: false,
      },
      snoozeWakeLabelText: undefined,
      timeLabel: relativeTime(thread.updatedAt),
      snoozePresetMinute: undefined,
      showTrailingDivider: false,
      hasQueuedMessages: false,
      canMoveUp: false,
      canMoveDown: false,
      ...caption(thread),
    }));
    for (let i = baseItems.length - 1; i >= 0; i--) {
      const row = baseItems[i];
      if (row?.type !== "v2-thread") continue;
      const thread = row.item.thread;
      const key = sessionKey(thread);
      const summary = summarizeSessionWorkers(hierarchy, key, connected, settled);
      if (!settled.has(key) && summary.total)
        baseItems.splice(i + 1, 0, {
          type: "v2-session-group",
          key: `group:${key}`,
          groupKey: key,
          title: `Workers of ${thread.title}`,
          summary: describeSessionWorkers(summary).text,
          expanded: groups.expanded.has(key),
          finished: summary.finished,
          finishedExpanded: groups.finished.has(key),
        });
    }
    organized.unshift(
      {
        type: "v2-session-group",
        key: "base-sessions",
        groupKey: "base-sessions",
        title: "Bases",
        summary: `${bases.length} prepared bases`,
        expanded: groups.expanded.has("base-sessions"),
        finished: 0,
        finishedExpanded: false,
      },
      ...baseItems,
    );
  }
  return { layout, items: organized, contentOnlyThreadKeys, olderSettledShelf };
}

/** The list's scope per environment: its projects there, or every project. */
function olderSettledScopes(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<OlderSettledScope> {
  const environmentIds =
    input.environmentId === null ? [...input.settlementEnvironmentIds] : [input.environmentId];
  return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
    if (input.projectRefs == null) return [{ environmentId, projectIds: null }];
    const projectIds = input.projectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
