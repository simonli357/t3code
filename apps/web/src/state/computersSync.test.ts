import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ComputerInspection,
  type ComputerInspectInput,
} from "@t3tools/contracts";
import type { ComputerCache } from "./computersCache";
import { createComputersSync } from "./computersSync";

const computer = EnvironmentId.make("computer-a");

const inspection = (overrides: Partial<ComputerInspection> = {}): ComputerInspection => ({
  sampledAt: 1000,
  resources: null,
  history: [],
  disks: [],
  files: [],
  totalFiles: 0,
  indexedAt: null,
  indexing: false,
  projects: [],
  processes: [],
  activities: [],
  errors: [],
  ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A computer that answers from `respond`, and a clock the test moves by hand. */
function harness(
  respond: (
    input: ComputerInspectInput,
  ) => ComputerInspection | Error | Promise<ComputerInspection>,
  options: {
    loadCache?: () => Promise<ComputerCache | null>;
    saveFails?: boolean;
  } = {},
) {
  const calls: ComputerInspectInput[] = [];
  const sync = createComputersSync({
    read: async (_environmentId, input) => {
      calls.push(input);
      const result = await respond(input);
      if (result instanceof Error) throw result;
      return result;
    },
    loadCache: options.loadCache ?? (async () => null),
    saveCache: async () => {
      if (options.saveFails) throw new Error("quota exceeded");
    },
  });
  const stop = sync.start();
  return {
    sync,
    stop,
    calls,
    snapshot: () => sync.getState().snapshots[computer],
    fileReads: () => calls.filter((call) => call.section === "files").length,
  };
}

describe("keeping a computer's snapshot current", () => {
  it("polls small snapshots without ever reading files, across repeated refreshes", async () => {
    const t = harness(() => inspection());
    await t.sync.refresh([computer]);
    await t.sync.refresh([computer], { queue: true });
    expect(t.fileReads()).toBe(0);
    expect(t.calls.filter((call) => call.section === "overview")).toHaveLength(2);
    expect(t.calls.filter((call) => call.section === "activity")).toHaveLength(2);
  });

  it("waits for the saved copy before reading, so an old copy cannot replace a newer answer", async () => {
    const saved = deferred<ComputerCache | null>();
    const t = harness(() => inspection({ sampledAt: 2 }), { loadCache: () => saved.promise });
    const refreshing = t.sync.refresh([computer]);
    expect(t.calls).toEqual([]);
    saved.resolve({
      overview: inspection({ sampledAt: 1 }),
      activity: null,
    });
    await refreshing;
    expect(t.snapshot()?.overview?.sampledAt).toBe(2);
  });

  it("reports a failed read without losing the rest or the last good data", async () => {
    let failing = false;
    const t = harness((input) =>
      failing && input.section === "overview"
        ? new Error("Connection refused")
        : inspection({ sampledAt: failing ? 2 : 1 }),
    );
    await t.sync.refresh([computer]);
    failing = true;
    await t.sync.refresh([computer]);
    expect(t.sync.getState().errors[computer]).toBe("Connection refused");
    expect(t.snapshot()?.overview?.sampledAt).toBe(1);
    expect(t.snapshot()?.activity?.sampledAt).toBe(2);

    failing = false;
    await t.sync.refresh([computer]);
    expect(t.sync.getState().errors[computer]).toBeNull();
  });

  it("shows data it could not save for offline use, and says so", async () => {
    const t = harness(() => inspection({ sampledAt: 3 }), { saveFails: true });
    await t.sync.refresh([computer]);
    expect(t.snapshot()?.overview?.sampledAt).toBe(3);
    expect(t.sync.getState().cacheErrors[computer]).toBe(
      "Could not save offline data: quota exceeded",
    );
  });

  it("shows a saved copy that cannot be read as an error, not as an empty computer", async () => {
    const t = harness(() => inspection(), {
      loadCache: () => Promise.reject(new Error("Database blocked")),
    });
    await t.sync.loadOffline([computer]);
    expect(t.sync.getState().cacheErrors[computer]).toBe(
      "Could not read offline data: Database blocked",
    );
    // Fresh data written afterwards replaces the unreadable copy, so the error no longer applies.
    await t.sync.refresh([computer]);
    expect(t.sync.getState().cacheErrors[computer]).toBeNull();
  });

  it("reads a computer one at a time, and once more when asked after something happened", async () => {
    const gate = deferred<void>();
    let overviews = 0;
    const t = harness(async (input) => {
      if (input.section === "overview") {
        overviews += 1;
        if (overviews === 1) await gate.promise;
      }
      return inspection();
    });
    const first = t.sync.refresh([computer]);
    const poll = t.sync.refresh([computer]);
    const afterAction = t.sync.refresh([computer], { queue: true });
    gate.resolve();
    await Promise.all([first, poll, afterAction]);
    expect(overviews).toBe(2);
  });

  it.each(["activity"] as const)(
    "publishes advancing telemetry while a %s read is still pending",
    async (section) => {
      const detailStarted = deferred<void>();
      const detail = deferred<ComputerInspection>();
      const firstOverview = deferred<void>();
      const secondOverview = deferred<void>();
      let measurement = 0;
      const t = harness((input) => {
        if (input.section === section) {
          detailStarted.resolve();
          return detail.promise;
        }
        return inspection({ sampledAt: input.section === "overview" ? ++measurement : 0 });
      });
      const unsubscribe = t.sync.subscribe(() => {
        if (t.snapshot()?.overview?.sampledAt === 1) firstOverview.resolve();
        if (t.snapshot()?.overview?.sampledAt === 2) secondOverview.resolve();
      });
      const first = t.sync.refresh([computer]);
      await detailStarted.promise;
      await firstOverview.promise;
      // Let the completed telemetry cache write drain while the detail request stays held.
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- The cache write is scheduled from a promise the test cannot observe; one macrotask is the only boundary that lets it settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const poll = t.sync.refresh([computer]);
      await secondOverview.promise;
      expect(t.snapshot()?.overview?.sampledAt).toBe(2);
      expect(t.calls.filter((input) => input.section === section)).toHaveLength(1);
      detail.resolve(inspection());
      await Promise.all([first, poll]);
      unsubscribe();
    },
  );
});

describe("page lifetimes sharing offline storage", () => {
  it("cannot let a closed page overwrite the newer page's saved readings", async () => {
    const oldResponse = deferred<ComputerInspection>();
    const reading = deferred<void>();
    let saved: Partial<ComputerCache> = {};
    const storage = {
      loadCache: async () => null,
      saveCache: async (_id: string, patch: Partial<ComputerCache>) => {
        saved = { ...saved, ...patch };
      },
    };
    const old = createComputersSync({
      ...storage,
      read: async () => {
        reading.resolve();
        return oldResponse.promise;
      },
    });
    const stop = old.start();
    const pending = old.refresh([computer]);
    await reading.promise;
    stop();
    const fresh = createComputersSync({
      ...storage,
      read: async () => inspection({ sampledAt: 2 }),
    });
    fresh.start();
    await fresh.refresh([computer]);
    oldResponse.resolve(inspection({ sampledAt: 1 }));
    await pending;
    expect(saved.overview?.sampledAt).toBe(2);
    expect(saved.activity?.sampledAt).toBe(2);
    expect(old.getState().snapshots).toEqual({});
  });

  it("invalidates requests across stop/start of the same store", async () => {
    const oldResponse = deferred<ComputerInspection>();
    const reading = deferred<void>();
    let first = true;
    const t = harness(async () => {
      if (first) {
        reading.resolve();
        return oldResponse.promise;
      }
      return inspection({ sampledAt: 2 });
    });
    const pending = t.sync.refresh([computer]);
    await reading.promise;
    t.stop();
    first = false;
    t.sync.start();
    await t.sync.refresh([computer]);
    oldResponse.resolve(inspection({ sampledAt: 1 }));
    await pending;
    expect(t.snapshot()?.overview?.sampledAt).toBe(2);
  });

  it("cancels a cache write already waiting for its database to open", async () => {
    const writing = deferred<AbortSignal>();
    const openDatabase = deferred<void>();
    let saved = false;
    const sync = createComputersSync({
      read: async () => inspection(),
      loadCache: async () => null,
      saveCache: async (_id, _patch, signal) => {
        writing.resolve(signal);
        await openDatabase.promise;
        if (!signal.aborted) saved = true;
      },
    });
    const stop = sync.start();
    const pending = sync.refresh([computer]);
    const signal = await writing.promise;
    stop();
    expect(signal.aborted).toBe(true);
    openDatabase.resolve();
    await pending;
    expect(saved).toBe(false);
  });
});
