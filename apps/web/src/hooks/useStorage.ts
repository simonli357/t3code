import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import type { ComputerInspectInput, StorageDetail, StorageGroupId } from "@t3tools/contracts";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError } from "../state/query";
import { readComputerCache, writeComputerCache } from "../state/computersCache";
import { connected, failure } from "../state/computersView";
import {
  detailKey,
  disksModel,
  holdingsModel,
  loadedGroups,
  mergeHoldings,
  noStorageData,
  storageSupport,
  type ComputerStorageData,
} from "../state/storageView";
import type { Loadable } from "../components/computers/computersViewModel";
import type {
  ComputersViewId,
  DisksViewModel,
  HoldingsViewModel,
  StorageActions,
} from "../components/computers/storageViewModel";

/** Disks change slowly and are measured on the computer at most every 30 s. */
const DISKS_POLL_MS = 30_000;
/** Holdings are cached on the computer; the list is read often only while sizes are still arriving. */
const HOLDINGS_POLL_MS = 15_000;
const MEASURING_POLL_MS = 8_000;
/** What this browser keeps of a computer for when it is offline is rewritten at most this often. */
const SAVE_EVERY_MS = 60_000;
/** Entries asked of each computer per open group, and how many more each "load more" asks for. */
const ENTRY_PAGE = 400;
const ENTRY_LIMIT_MAX = 5_000;

/**
 * The data of the two storage views: each connected computer's disks and holdings, read only while
 * a storage view is open, kept for offline computers, and the lazily read parts of the entries a
 * person opens. A computer that reports nothing, cannot report it, or is offline is said to be.
 */
export function useStorage(view: ComputersViewId): {
  disks: DisksViewModel;
  holdings: HoldingsViewModel;
  actions: StorageActions;
  refreshing: boolean;
} {
  const { environments: connections, isReady } = useEnvironments();
  const environments = useMemo(
    () =>
      [...connections].sort(
        (a, b) => a.label.localeCompare(b.label) || a.environmentId.localeCompare(b.environmentId),
      ),
    [connections],
  );
  const readCommand = useAtomCommand(serverEnvironment.computerRead, { reportFailure: false });
  const read = useCallback(
    async (environmentId: string, input: ComputerInspectInput) => {
      const result = await readCommand({ environmentId: EnvironmentId.make(environmentId), input });
      if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      return result.value;
    },
    [readCommand],
  );

  const [data, setData] = useState<Readonly<Record<string, ComputerStorageData>>>({});
  const [details, setDetails] = useState<Readonly<Record<string, Loadable<StorageDetail>>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<StorageGroupId>>(new Set());
  // The groups to ask for, read by requests that outlive a render; `onToggleGroup` is its only writer.
  const openRef = useRef(open);
  const limitRef = useRef(ENTRY_PAGE);
  const inFlight = useRef(new Set<string>());
  const saved = useRef(new Set<string>());
  const savedAt = useRef(new Map<string, number>());
  const patch = (id: string, change: Partial<ComputerStorageData>) =>
    setData((old) => ({ ...old, [id]: { ...(old[id] ?? noStorageData), ...change } }));

  const active = view !== "overview";
  const onlineIds = useMemo(
    () =>
      environments
        .filter((env) => connected(env) && storageSupport(env) === true)
        .map((env) => env.environmentId),
    [environments],
  );
  const onlineKey = onlineIds.join(",");
  const knownKey = environments.map((env) => env.environmentId).join(",");

  // What this browser saved of each computer is shown at once, until the computer answers.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    for (const id of knownKey.split(",").filter(Boolean)) {
      if (saved.current.has(id)) continue;
      saved.current.add(id);
      void readComputerCache(id)
        .then((cache) => {
          if (cancelled || !cache) return;
          setData((old) => {
            const mine = old[id] ?? noStorageData;
            return {
              ...old,
              [id]: {
                ...mine,
                disks: mine.disks ?? cache.storageDisks ?? null,
                holdings: mine.holdings ?? cache.storageHoldings ?? null,
                loaded: mine.holdings
                  ? mine.loaded
                  : cache.storageHoldings
                    ? loadedGroups(cache.storageHoldings)
                    : [],
                readAt: mine.readAt ?? cache.storageReadAt ?? null,
              },
            };
          });
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [active, knownKey]);

  const load = useEffectEvent(
    async (id: string, section: "disks" | "holdings", refresh: boolean) => {
      const flight = `${id}:${section}`;
      if (inFlight.current.has(flight)) return;
      inFlight.current.add(flight);
      const groups = [...openRef.current];
      try {
        const result = await read(id, {
          section,
          ...(section === "holdings" ? { groups, limit: limitRef.current } : {}),
          ...(refresh ? { refresh: true } : {}),
        });
        const at = Date.now();
        const mayWrite = at - (savedAt.current.get(id) ?? 0) > SAVE_EVERY_MS;
        if (section === "disks" && result.storageDisks) {
          patch(id, { disks: result.storageDisks, error: null, readAt: at });
          if (mayWrite) {
            savedAt.current.set(id, at);
            void writeComputerCache(id, {
              storageDisks: result.storageDisks,
              storageReadAt: at,
            }).catch(() => undefined);
          }
        } else if (section === "holdings" && result.storageHoldings) {
          const incoming = result.storageHoldings;
          setData((old) => ({
            ...old,
            [id]: {
              ...(old[id] ?? noStorageData),
              ...mergeHoldings(old[id] ?? noStorageData, incoming, groups),
              error: null,
              readAt: at,
            },
          }));
          if (mayWrite) {
            savedAt.current.set(id, at);
            void writeComputerCache(id, {
              storageHoldings: incoming,
              storageReadAt: at,
            }).catch(() => undefined);
          }
        } else {
          patch(id, {
            error: "This computer answered without storage data. Update its T3 server.",
          });
        }
      } catch (error) {
        patch(id, { error: failure(error) });
      } finally {
        inFlight.current.delete(flight);
      }
    },
  );
  const measuringAnywhere = Object.values(data).some((mine) => mine.holdings?.measuring === true);
  const section = view === "disks" ? "disks" : view === "workspaces" ? "holdings" : null;
  const interval =
    section === "disks" ? DISKS_POLL_MS : measuringAnywhere ? MEASURING_POLL_MS : HOLDINGS_POLL_MS;
  useEffect(() => {
    if (!section) return;
    const ids = onlineKey.split(",").filter(Boolean);
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      for (const id of ids) void load(id, section, false);
    };
    tick();
    const timer = window.setInterval(tick, interval);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [section, onlineKey, interval]);

  const actions: StorageActions = {
    onToggleGroup: (group, opened) => {
      const next = new Set(openRef.current);
      if (opened) next.add(group);
      else next.delete(group);
      openRef.current = next;
      setOpen(next);
      // A group that has just opened is read now, not at the next poll.
      if (opened) for (const id of onlineIds) void load(id, "holdings", false);
    },
    onLoadMore: () => {
      limitRef.current = Math.min(ENTRY_LIMIT_MAX, limitRef.current + ENTRY_PAGE);
      for (const id of onlineIds) void load(id, "holdings", false);
    },
    onRefresh: () => {
      if (!section) return;
      setRefreshing(true);
      void Promise.all(onlineIds.map((id) => load(id, section, true))).finally(() =>
        setRefreshing(false),
      );
    },
    onExpandEntry: (computerId, entryId) => {
      const key = detailKey(computerId, entryId);
      setDetails((old) =>
        old[key]?.status === "loading" ? old : { ...old, [key]: { status: "loading" } },
      );
      read(computerId, { section: "holding", entry: entryId })
        .then((result) =>
          setDetails((old) => ({
            ...old,
            [key]: result.storageDetail
              ? { status: "ready", data: result.storageDetail }
              : {
                  status: "error",
                  message: "This entry is no longer listed. Refresh the view.",
                },
          })),
        )
        .catch((error) =>
          setDetails((old) => ({ ...old, [key]: { status: "error", message: failure(error) } })),
        );
    },
  };

  return {
    disks: useMemo(() => disksModel(environments, data, isReady), [environments, data, isReady]),
    holdings: useMemo(
      () => holdingsModel(environments, data, details, isReady, open),
      [environments, data, details, isReady, open],
    ),
    actions,
    refreshing,
  };
}
