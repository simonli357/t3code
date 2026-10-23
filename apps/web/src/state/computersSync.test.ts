import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ComputerActivity,
  type ComputerFile,
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
const file = (path: string): ComputerFile => ({
  path,
  name: path.split("/").at(-1)!,
  project: "P",
  sizeBytes: 1,
  modifiedAt: 1,
  directory: false,
  backup: "not-verified",
  reference: null,
});
const transfer = (status: string): ComputerActivity => ({
  id: "keep-1",
  kind: "transfer",
  label: "Keep drawings",
  status,
  updatedAt: 5,
  detail: null,
  source: "/p",
  retryable: false,
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
  let clock = 1_000_000;
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
    now: () => clock,
  });
  const stop = sync.start();
  return {
    sync,
    stop,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    snapshot: () => sync.getState().snapshots[computer],
    fileReads: () => calls.filter((call) => call.section === "files").length,
  };
}

describe("keeping a computer's snapshot current", () => {
  it("reads a file index in pages until it has every file", async () => {
    const all = ["a", "b", "c", "d", "e"].map((name) => file(`/p/${name}`));
    const t = harness((input) => {
      if (input.section !== "files") return inspection();
      const offset = input.offset ?? 0;
      return inspection({ files: all.slice(offset, offset + 2), totalFiles: 5, indexedAt: 7 });
    });
    await t.sync.refresh([computer]);
    expect(t.snapshot()?.files?.files.map((item) => item.path)).toEqual(
      all.map((item) => item.path),
    );
    const pages = t.calls.filter((call) => call.section === "files");
    expect(pages.map((call) => call.offset ?? 0)).toEqual([0, 2, 4]);
    // Big pages keep a 100,000-file index to tens of requests rather than hundreds.
    expect(pages.every((call) => call.limit === 2000)).toBe(true);
  });

  it("keeps the last complete index while the computer reindexes, and says so", async () => {
    let reindexing = false;
    const t = harness((input) =>
      input.section !== "files"
        ? inspection()
        : reindexing
          ? inspection({ indexing: true, errors: ["still scanning"] })
          : inspection({ files: [file("/p/a")], totalFiles: 1, indexedAt: 1 }),
    );
    await t.sync.refresh([computer]);
    reindexing = true;
    await t.sync.refresh([computer], { force: true });
    expect(t.snapshot()?.files?.files.map((item) => item.path)).toEqual(["/p/a"]);
    expect(t.snapshot()?.files).toMatchObject({ indexing: true, errors: ["still scanning"] });

    // Once it finishes, the next ordinary refresh replaces the index without being forced.
    reindexing = false;
    await t.sync.refresh([computer]);
    expect(t.snapshot()?.files).toMatchObject({ indexing: false, errors: [] });
  });

  it("does not stitch pages from two different indexes together", async () => {
    let page = 0;
    const t = harness((input) => {
      if (input.section !== "files") return inspection();
      page += 1;
      return page === 1
        ? inspection({ files: [file("/p/a")], totalFiles: 2, indexedAt: 1 })
        : inspection({ files: [file("/p/z")], totalFiles: 2, indexedAt: 2 });
    });
    await t.sync.refresh([computer]);
    expect(t.snapshot()?.files?.files.map((item) => item.path)).toEqual(["/p/a"]);
    expect(t.snapshot()?.files?.indexing).toBe(true);
  });

  it("asks again after a file list that changed while it was being read", async () => {
    let page = 0;
    const t = harness((input) => {
      if (input.section !== "files") return inspection();
      page += 1;
      if (page === 1) return inspection({ files: [file("/p/a")], totalFiles: 2, indexedAt: 1 });
      if (page === 2) return inspection({ files: [file("/p/b")], totalFiles: 3, indexedAt: 1 });
      return inspection({ files: [file("/p/a")], totalFiles: 1, indexedAt: 1 });
    });
    await t.sync.refresh([computer]);
    expect(t.sync.getState().errors[computer]).toContain("changed while it was being read");
    expect(t.snapshot()?.files).toBeNull();

    await t.sync.refresh([computer]);
    expect(t.sync.getState().errors[computer]).toBeNull();
    expect(t.snapshot()?.files?.files.map((item) => item.path)).toEqual(["/p/a"]);
  });

  it("reads the index again after fifteen minutes on this browser's clock, not the computer's", async () => {
    // The computer's clock is hours behind, which must not make its index look stale.
    const t = harness((input) =>
      input.section === "files"
        ? inspection({ files: [file("/p/a")], totalFiles: 1, indexedAt: 1, sampledAt: 5 })
        : inspection(),
    );
    await t.sync.refresh([computer]);
    t.advance(14 * 60_000);
    await t.sync.refresh([computer]);
    expect(t.fileReads()).toBe(1);
    t.advance(2 * 60_000);
    await t.sync.refresh([computer]);
    expect(t.fileReads()).toBe(2);
  });

  it("reads the file list again when a transfer changes, since the kept archive may have", async () => {
    let activities: ComputerActivity[] = [];
    const t = harness((input) =>
      input.section === "activity"
        ? inspection({ activities })
        : input.section === "files"
          ? inspection({ files: [file("/p/a")], totalFiles: 1, indexedAt: 1 })
          : inspection(),
    );
    await t.sync.refresh([computer]);
    await t.sync.refresh([computer]);
    expect(t.fileReads()).toBe(1);

    activities = [transfer("copying")];
    await t.sync.refresh([computer]);
    activities = [transfer("published")];
    await t.sync.refresh([computer]);
    expect(t.fileReads()).toBe(3);
    await t.sync.refresh([computer]);
    expect(t.fileReads()).toBe(3);
  });

  it("waits for the saved copy before reading, so an old copy cannot replace a newer answer", async () => {
    const saved = deferred<ComputerCache | null>();
    const t = harness(() => inspection({ sampledAt: 2 }), { loadCache: () => saved.promise });
    const refreshing = t.sync.refresh([computer]);
    expect(t.calls).toEqual([]);
    saved.resolve({
      overview: inspection({ sampledAt: 1 }),
      files: null,
      activity: null,
      filesReadAt: null,
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

  it("stops paging a file index when stopped, without saving the part it had", async () => {
    let reads = 0;
    const t = harness((input) => {
      if (input.section !== "files") return inspection();
      reads += 1;
      if (reads === 2) t.stop();
      return inspection({ files: [file(`/p/${reads}`)], totalFiles: 3, indexedAt: 1 });
    });
    await t.sync.refresh([computer]);
    expect(reads).toBe(2);
    expect(t.snapshot()?.files).toBeNull();
  });
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
