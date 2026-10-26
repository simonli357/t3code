import type { ComputerInspection, ComputerInspectInput, EnvironmentId } from "@t3tools/contracts";
import type { ComputerCache } from "./computersCache";
import { failure } from "./computersView";

const empty: ComputerCache = { overview: null, activity: null };

export interface ComputersSyncState {
  readonly snapshots: Readonly<Record<string, ComputerCache>>;
  /** Why the latest refresh of a computer failed, until one succeeds. */
  readonly errors: Readonly<Record<string, string | null>>;
  /** Why this browser's saved copy of a computer could not be read or written. */
  readonly cacheErrors: Readonly<Record<string, string | null>>;
}

export interface ComputersSyncDeps {
  readonly read: (
    environmentId: EnvironmentId,
    input: ComputerInspectInput,
  ) => Promise<ComputerInspection>;
  readonly loadCache: (environmentId: string) => Promise<ComputerCache | null>;
  readonly saveCache: (
    environmentId: string,
    patch: Partial<ComputerCache>,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface RefreshOptions {
  /** Run once more after a refresh already in flight, so something that just happened is seen. */
  readonly queue?: boolean;
}

/** Keeps small telemetry and activity snapshots fresh and saved for offline use. */
export function createComputersSync({ read, loadCache, saveCache }: ComputersSyncDeps) {
  let state: ComputersSyncState = { snapshots: {}, errors: {}, cacheErrors: {} };
  let controller = new AbortController();
  controller.abort();
  const listeners = new Set<() => void>();
  const cacheLoads = new Map<string, Promise<void>>();
  const flights = new Map<string, Promise<void>>();
  const queued = new Map<string, boolean>();
  const overviewFlights = new Map<string, Promise<void>>();
  const overviewErrors = new Map<string, string>();
  const detailErrors = new Map<string, string>();

  const update = (next: ComputersSyncState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const remember = (id: string, patch: Partial<ComputerCache>) =>
    update({
      ...state,
      snapshots: { ...state.snapshots, [id]: { ...(state.snapshots[id] ?? empty), ...patch } },
    });
  const note = (field: "errors" | "cacheErrors", id: string, message: string | null) => {
    if ((state[field][id] ?? null) === message) return;
    update({ ...state, [field]: { ...state[field], [id]: message } });
  };
  const save = async (id: string, patch: Partial<ComputerCache>, signal: AbortSignal) => {
    if (signal.aborted) return;
    remember(id, patch);
    try {
      await saveCache(id, patch, signal);
      if (signal.aborted) return;
      note("cacheErrors", id, null);
    } catch (error) {
      if (signal.aborted) return;
      note("cacheErrors", id, `Could not save offline data: ${failure(error)}`);
    }
  };

  const loadOffline = (id: string, signal: AbortSignal) => {
    if (signal.aborted) return Promise.resolve();
    let loading = cacheLoads.get(id);
    if (!loading) {
      loading = loadCache(id)
        .then((cache) => {
          if (!signal.aborted && cache && !state.snapshots[id]) remember(id, cache);
        })
        .catch((error) => {
          if (!signal.aborted)
            note("cacheErrors", id, `Could not read offline data: ${failure(error)}`);
        });
      cacheLoads.set(id, loading);
    }
    return loading;
  };

  function noteReadError(id: string, lane: Map<string, string>, message: string | null) {
    if (message) lane.set(id, message);
    else lane.delete(id);
    note(
      "errors",
      id,
      [overviewErrors.get(id), detailErrors.get(id)].filter(Boolean).join("; ") || null,
    );
  }

  function refreshOverview(id: EnvironmentId, signal: AbortSignal): Promise<void> {
    const pending = overviewFlights.get(id);
    if (pending) return pending;
    const started = (async () => {
      await loadOffline(id, signal);
      if (signal.aborted) return;
      try {
        const overview = await read(id, { section: "overview" });
        if (signal.aborted) return;
        await save(id, { overview }, signal);
        if (!signal.aborted) noteReadError(id, overviewErrors, null);
      } catch (error) {
        if (!signal.aborted) noteReadError(id, overviewErrors, failure(error));
      }
    })().finally(() => {
      if (overviewFlights.get(id) === started) overviewFlights.delete(id);
    });
    overviewFlights.set(id, started);
    return started;
  }

  async function syncOnce(id: EnvironmentId, signal: AbortSignal) {
    await loadOffline(id, signal);
    if (signal.aborted) return;
    const [, activity] = await Promise.allSettled([
      refreshOverview(id, signal),
      read(id, { section: "activity" }),
    ]);
    if (signal.aborted) return;
    const patch: { -readonly [K in keyof ComputerCache]?: ComputerCache[K] } = {};
    const failures: string[] = [];
    if (activity.status === "fulfilled") patch.activity = activity.value;
    else failures.push(failure(activity.reason));
    await save(id, patch, signal);
    if (signal.aborted) return;
    noteReadError(id, detailErrors, failures.join("; ") || null);
  }

  function refreshOne(id: EnvironmentId, options: RefreshOptions) {
    const { signal } = controller;
    if (signal.aborted) return Promise.resolve();
    const flight = flights.get(id);
    if (flight) {
      if (options.queue) queued.set(id, true);
      return Promise.all([flight, refreshOverview(id, signal)]).then(() => undefined);
    }
    const started = (async () => {
      let again = true;
      while (again && !signal.aborted) {
        await syncOnce(id, signal);
        if (signal.aborted) return;
        again = queued.get(id) === true;
        queued.delete(id);
      }
    })().finally(() => {
      if (flights.get(id) === started) {
        flights.delete(id);
        queued.delete(id);
      }
    });
    flights.set(id, started);
    return started;
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Allows work to proceed; the returned function stops it, including pending reads. */
    start: () => {
      controller.abort();
      controller = new AbortController();
      const current = controller;
      cacheLoads.clear();
      flights.clear();
      overviewFlights.clear();
      overviewErrors.clear();
      detailErrors.clear();
      queued.clear();
      return () => current.abort();
    },
    /** Shows each computer's saved copy as soon as it is read from this browser. */
    loadOffline: async (ids: readonly string[]) => {
      await Promise.all(ids.map((id) => loadOffline(id, controller.signal)));
    },
    refresh: async (ids: readonly EnvironmentId[], options: RefreshOptions = {}) => {
      await Promise.all(ids.map((id) => refreshOne(id, options)));
    },
  };
}

export type ComputersSync = ReturnType<typeof createComputersSync>;
