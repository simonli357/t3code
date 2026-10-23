import type { ComputerInspection, ComputerInspectInput, EnvironmentId } from "@t3tools/contracts";
import type { ComputerCache } from "./computersCache";
import { failure } from "./computersView";

/** A saved file index older than this is read again. Reindexing on the computer is its own, bigger cost. */
const FILE_INDEX_MAX_AGE_MS = 15 * 60_000;

/** Rows per request when reading the whole index; the computer caps a page at 5000. */
const FILE_PAGE_LIMIT = 2000;

const empty: ComputerCache = { overview: null, files: null, activity: null, filesReadAt: null };

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
  readonly now?: () => number;
}

export interface RefreshOptions {
  /** Ask the computer to rebuild its file index rather than serve the one it has. */
  readonly force?: boolean;
  /** Run once more after a refresh already in flight, so something that just happened is seen. */
  readonly queue?: boolean;
}

/** Whether a computer's transfers, backups or restores changed, which is when its kept archive may have too. */
const archiveSignature = (snapshot: ComputerInspection | null | undefined) =>
  snapshot
    ? snapshot.activities
        .filter((activity) => activity.kind !== "job")
        .map((activity) => `${activity.id}:${activity.status}`)
        .sort()
        .join("|")
    : null;

/**
 * Keeps one snapshot per computer fresh and saved for offline use. It is the page's only owner of
 * network and IndexedDB work: React subscribes to `getState`, so nothing here sets React state.
 *
 * Each computer has one telemetry read and one detail refresh at a time, so slow activity or file
 * reads cannot stall telemetry. Its saved copy is loaded before the first read so an old
 * copy can never replace a newer answer, and a file index is replaced only by a complete one: while
 * the computer is reindexing, the last complete index stays and is marked as indexing.
 */
export function createComputersSync({
  read,
  loadCache,
  saveCache,
  now = Date.now,
}: ComputersSyncDeps) {
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
  const filesDue = new Set<string>();

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

  async function syncFiles(
    id: EnvironmentId,
    previous: ComputerInspection | null,
    force: boolean,
    signal: AbortSignal,
  ) {
    let page = await read(id, {
      section: "files",
      limit: FILE_PAGE_LIMIT,
      ...(force ? { refresh: true } : {}),
    });
    const files = [...page.files];
    while (!signal.aborted && !page.indexing && files.length < page.totalFiles) {
      const next = await read(id, {
        section: "files",
        offset: files.length,
        limit: FILE_PAGE_LIMIT,
      });
      if (next.indexedAt !== page.indexedAt || next.indexing) {
        page = { ...next, indexing: true };
        break;
      }
      if (next.files.length === 0 || next.totalFiles !== page.totalFiles)
        throw new Error("The file list changed while it was being read; it will be read again.");
      files.push(...next.files);
    }
    if (signal.aborted) return;
    await save(
      id,
      page.indexing && previous
        ? { files: { ...previous, indexing: true, errors: page.errors } }
        : { files: { ...page, files }, filesReadAt: now() },
      signal,
    );
    // An index that is still being built is read again next time, whatever its age.
    if (!signal.aborted && !page.indexing) filesDue.delete(id);
  }

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

  async function syncOnce(id: EnvironmentId, force: boolean, signal: AbortSignal) {
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
    const before = archiveSignature(state.snapshots[id]?.activity);
    if (before !== null && patch.activity && before !== archiveSignature(patch.activity))
      filesDue.add(id);
    await save(id, patch, signal);
    if (signal.aborted) return;
    const previous = state.snapshots[id]?.files ?? null;
    const readAt = state.snapshots[id]?.filesReadAt ?? null;
    if (
      force ||
      filesDue.has(id) ||
      !previous ||
      previous.indexing ||
      readAt === null ||
      now() - readAt > FILE_INDEX_MAX_AGE_MS
    ) {
      filesDue.add(id);
      try {
        await syncFiles(id, previous, force, signal);
      } catch (error) {
        failures.push(failure(error));
      }
    }
    if (signal.aborted) return;
    noteReadError(id, detailErrors, failures.join("; ") || null);
  }

  function refreshOne(id: EnvironmentId, options: RefreshOptions) {
    const { signal } = controller;
    if (signal.aborted) return Promise.resolve();
    const flight = flights.get(id);
    if (flight) {
      if (options.force || options.queue)
        queued.set(id, queued.get(id) === true || options.force === true);
      return Promise.all([flight, refreshOverview(id, signal)]).then(() => undefined);
    }
    const started = (async () => {
      let force: boolean | undefined = options.force === true;
      while (force !== undefined && !signal.aborted) {
        await syncOnce(id, force, signal);
        if (signal.aborted) return;
        force = queued.get(id);
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
    /** Allows work to proceed; the returned function stops it, including a file index being paged in. */
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
