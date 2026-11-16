import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createAutosave, sameStoredValue, type AutosaveResult } from "./autosave.ts";

interface Doc {
  readonly version: number;
  readonly cap: number;
  readonly goal: number;
}
const fields = ["cap", "goal"] as const;
const v1: Doc = { version: 1, cap: 10, goal: 5 };

/** A store with one stored document that refuses a save based on an older version. */
function setup(stored: Doc = v1) {
  const server = {
    stored,
    fail: null as string | null,
    saves: [] as Doc[],
    /** A save waits here while set, as a slow connection would hold it. */
    gate: null as Promise<void> | null,
  };
  const autosave = createAutosave<Doc>({
    save: async (policy, baseline): Promise<AutosaveResult<Doc>> => {
      server.saves.push(policy);
      await server.gate;
      if (server.fail) return { error: server.fail };
      if (baseline.version !== server.stored.version) return { conflict: true };
      server.stored = { ...policy, version: server.stored.version + 1 };
      return { saved: server.stored };
    },
    read: async () => server.stored,
    dirty: (baseline, policy) => fields.some((field) => baseline[field] !== policy[field]),
    rebase: (base, mine, theirs) => {
      const edited = fields.filter((field) => mine[field] !== base[field]);
      return {
        policy: { ...theirs, ...Object.fromEntries(edited.map((field) => [field, mine[field]])) },
        collides: edited.some(
          (field) => theirs[field] !== base[field] && theirs[field] !== mine[field],
        ),
      };
    },
    invalid: (policy) => (policy.cap > 100 ? "A cap is at most 100." : null),
  });
  autosave.receive(server.stored);
  return { autosave, server };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("stores an edit by itself, once the typing pauses", async () => {
  const { autosave, server } = setup();
  autosave.edit((doc) => ({ ...doc, cap: 2 }), 800);
  autosave.edit((doc) => ({ ...doc, cap: 20 }), 800);
  expect(autosave.getState()).toMatchObject({ phase: "editing", policy: { cap: 20 } });
  await vi.advanceTimersByTimeAsync(799);
  expect(server.saves).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(server.saves).toEqual([{ version: 1, cap: 20, goal: 5 }]);
  expect(autosave.getState()).toMatchObject({
    phase: "saved",
    saved: { version: 2, cap: 20 },
    baseline: { version: 2 },
  });
});

it("stores a waiting edit at once when the field is left", async () => {
  const { autosave, server } = setup();
  autosave.edit((doc) => ({ ...doc, goal: 7 }), 800);
  autosave.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(server.stored).toMatchObject({ version: 2, goal: 7 });
});

it("holds a value that must not be stored half typed until its field is left", async () => {
  const { autosave, server } = setup();
  autosave.edit((doc) => ({ ...doc, cap: 8 }), null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(server.saves).toEqual([]);
  expect(autosave.getState().phase).toBe("editing");
  autosave.edit((doc) => ({ ...doc, cap: 80 }), null);
  autosave.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(server.saves).toEqual([{ version: 1, cap: 80, goal: 5 }]);
  expect(autosave.getState().phase).toBe("saved");
});

it("reports a failed save and never shows the value as stored", async () => {
  const { autosave, server } = setup();
  server.fail = "This computer is offline.";
  autosave.edit((doc) => ({ ...doc, cap: 30 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(autosave.getState()).toMatchObject({
    phase: "failed",
    error: "This computer is offline.",
    policy: { cap: 30 },
    saved: { version: 1, cap: 10 },
  });
  server.fail = null;
  autosave.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(autosave.getState()).toMatchObject({ phase: "saved", saved: { version: 2, cap: 30 } });
});

it("does not send a value that cannot be stored", async () => {
  const { autosave, server } = setup();
  autosave.edit((doc) => ({ ...doc, cap: 500 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(server.saves).toEqual([]);
  expect(autosave.getState()).toMatchObject({ phase: "failed", error: "A cap is at most 100." });
});

it("applies an edit on top of a version saved elsewhere instead of overwriting it", async () => {
  const { autosave, server } = setup();
  server.stored = { version: 2, cap: 10, goal: 9 };
  autosave.edit((doc) => ({ ...doc, cap: 40 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(server.saves).toEqual([
    { version: 1, cap: 40, goal: 5 },
    { version: 2, cap: 40, goal: 9 },
  ]);
  expect(server.stored).toEqual({ version: 3, cap: 40, goal: 9 });
  expect(autosave.getState()).toMatchObject({ phase: "saved", policy: { cap: 40, goal: 9 } });
});

it("asks before replacing a value that was also changed elsewhere", async () => {
  const { autosave, server } = setup();
  server.stored = { version: 2, cap: 70, goal: 5 };
  autosave.edit((doc) => ({ ...doc, cap: 40 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(autosave.getState()).toMatchObject({ phase: "conflict", saved: { cap: 70 } });
  expect(server.stored).toEqual({ version: 2, cap: 70, goal: 5 });

  autosave.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(server.stored).toEqual({ version: 3, cap: 40, goal: 5 });
  expect(autosave.getState().phase).toBe("saved");
});

it("drops the edit for the newer value when asked to", async () => {
  const { autosave, server } = setup();
  server.stored = { version: 2, cap: 70, goal: 5 };
  autosave.edit((doc) => ({ ...doc, cap: 40 }));
  await vi.advanceTimersByTimeAsync(0);
  autosave.resolve(false);
  expect(autosave.getState()).toMatchObject({ phase: "idle", policy: { version: 2, cap: 70 } });
  expect(server.stored.cap).toBe(70);
});

it("keeps an edit made while a save is in flight and stores it next", async () => {
  const { autosave, server } = setup();
  autosave.edit((doc) => ({ ...doc, cap: 20 }));
  vi.advanceTimersByTime(0);
  autosave.edit((doc) => ({ ...doc, goal: 8 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(server.saves).toEqual([
    { version: 1, cap: 20, goal: 5 },
    { version: 2, cap: 20, goal: 8 },
  ]);
  expect(autosave.getState()).toMatchObject({ phase: "saved", saved: { version: 3 } });
});

it("stores an edit whose pause ended while a save was in flight", async () => {
  const { autosave, server } = setup();
  let open = () => {};
  server.gate = new Promise<void>((resolve) => (open = resolve));
  autosave.edit((doc) => ({ ...doc, cap: 20 }));
  await vi.advanceTimersByTimeAsync(0);
  autosave.edit((doc) => ({ ...doc, goal: 8 }), 800);
  await vi.advanceTimersByTimeAsync(800);
  expect(server.saves).toHaveLength(1);
  server.gate = null;
  open();
  await vi.advanceTimersByTimeAsync(0);
  expect(server.stored).toEqual({ version: 3, cap: 20, goal: 8 });
  expect(autosave.getState().phase).toBe("saved");
});

it("follows a newer stored value while untouched and keeps edits when not", async () => {
  const { autosave } = setup();
  autosave.receive({ version: 2, cap: 11, goal: 5 });
  expect(autosave.getState().policy).toEqual({ version: 2, cap: 11, goal: 5 });
  autosave.edit((doc) => ({ ...doc, goal: 6 }), 800);
  autosave.receive({ version: 3, cap: 12, goal: 5 });
  expect(autosave.getState()).toMatchObject({ policy: { cap: 11, goal: 6 }, saved: { cap: 12 } });
});

it("compares stored values whatever the order of their keys", () => {
  expect(sameStoredValue({ key: "a", weekly: 5, off: undefined }, { weekly: 5, key: "a" })).toBe(
    true,
  );
  expect(sameStoredValue([{ a: 1 }, 2], [{ a: 1 }, 2])).toBe(true);
  expect(sameStoredValue([1, 2], [2, 1])).toBe(false);
  expect(sameStoredValue({ a: null }, {})).toBe(false);
});
