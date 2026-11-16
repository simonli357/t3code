// @vitest-environment jsdom
import { act, StrictMode } from "react";
import * as Cause from "effect/Cause";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  defaultModelLadder,
  defaultModelRoutingPolicy,
  AllocationError,
  EnvironmentId,
  MODEL_SCORES,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AllocationOperation,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
import { modelCell, setModelCell } from "@t3tools/client-runtime/state/model-routing";
const state = vi.hoisted(() => ({
  execute: vi.fn(),
  phase: "connected",
  connectionListeners: new Set<() => void>(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/provider-allocation", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/provider-allocation")>()),
  createAllocationCommands: () => ({ execute: { label: "execute" } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.execute }));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironment: () => ({
      connection: {
        phase: useSyncExternalStore(
          (notify) => {
            state.connectionListeners.add(notify);
            return () => state.connectionListeners.delete(notify);
          },
          () => state.phase,
        ),
      },
    }),
  };
});
import { ModelSelectionPage } from "./ModelSelectionPage";

let snapshot: ModelRoutingSnapshot;
let container: HTMLDivElement;
let root: Root;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
const control = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("input,select,textarea") as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
async function change(label: string, value: string) {
  await act(async () => {
    const element = control(label);
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
const named = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
const click = (label: string) =>
  act(async () => {
    button(label).click();
  });
const open = (title: string) =>
  act(async () => {
    [...container.querySelectorAll("summary")].find((s) => s.textContent === title)!.click();
  });
const cell = (difficulty: number, stakes: number) =>
  container.querySelector<HTMLButtonElement>(`[data-cell="${difficulty}-${stakes}"]`)!;
const label = (difficulty: number, stakes: number) =>
  cell(difficulty, stakes).getAttribute("aria-label")!;
const pick = (difficulty: number, stakes: number) =>
  act(async () => {
    cell(difficulty, stakes).click();
  });
const render = () =>
  act(async () => {
    root.render(<ModelSelectionPage environmentId={EnvironmentId.make("host")} />);
  });
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
};
const model = (slug: string, driver: string, efforts: string[]) => ({
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: driver === "codex" ? "reasoningEffort" : "effort",
        type: "select" as const,
        label: "Effort",
        options: efforts.map((id) => ({ id, label: id })),
      },
    ],
  },
});
const account = (id: string, driver: string, models: ReturnType<typeof model>[]) => ({
  environmentId: "host",
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  label: id.toUpperCase(),
  accountKey: id,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  shortWindow: "unknown" as const,
  windows: [],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  models,
});
const withCell = (
  policy: ModelRoutingPolicy,
  driver: "codex" | "claudeAgent",
  difficulty: number,
  stakes: number,
  next: { model: string; effort: string },
) => setModelCell(policy, driver, difficulty, stakes, next);
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.phase = "connected";
  state.execute.mockReset();
  snapshot = {
    policy: { ...defaultModelRoutingPolicy, version: 3 },
    policies: [{ ...defaultModelRoutingPolicy, version: 2 }],
    history: [],
    authorityAvailable: true,
    inventories: [
      {
        environmentId: "host",
        observedAt: "2026-10-23T12:00:00.000Z",
        complete: true,
        notices: [],
        demand: [],
        accounts: [
          account("ad", "codex", [
            model("gpt-6.1-sol", "codex", ["medium", "high", "max", "xhigh"]),
            model("gpt-6-astra", "codex", ["medium", "high", "xhigh"]),
            model("gpt-6-luna", "codex", ["medium"]),
          ]),
          account("sl", "claudeAgent", [
            model("claude-sonnet-5-5", "claudeAgent", ["medium", "high", "max"]),
            model("claude-opus-5-5", "claudeAgent", ["medium", "high", "xhigh"]),
          ]),
        ],
      },
    ],
  };
  state.execute.mockImplementation(async ({ input }: { input: AllocationOperation }) => {
    if (input._tag === "modelSnapshot") {
      // Each half carries only its own fields, as the server sends them.
      const whole = structuredClone(snapshot);
      return {
        _tag: "Success",
        value: {
          modelSnapshot:
            input.part === "settings"
              ? { ...whole, inventories: [] }
              : input.part === "accounts"
                ? { ...whole, policies: [], history: [] }
                : whole,
        },
      };
    }
    if (input._tag === "modelPreview")
      return {
        _tag: "Success",
        value: {
          selection: {
            at: "2026-10-23T12:00:00.000Z",
            request: input.request,
            policyVersion: input.policy?.version ?? 3,
            selectedProfile: null,
            revision: 0,
            rule: "Difficulty 0, stakes 0",
            reasons: ["Exact table choice"],
            allocation: null,
          },
        },
      };
    if (input._tag === "modelPolicy") {
      snapshot = { ...snapshot, policy: { ...input.policy, version: input.expectedVersion + 1 } };
      return { _tag: "Success", value: { modelPolicy: snapshot.policy } };
    }
    if (input._tag === "modelRevert") {
      snapshot = {
        ...snapshot,
        policy: { ...defaultModelRoutingPolicy, version: input.expectedVersion + 1 },
      };
      return { _tag: "Success", value: { modelPolicy: snapshot.policy } };
    }
    throw new Error("Unexpected operation");
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
  // The page opens on Claude; most cases below edit the Codex table.
  await click("Codex");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function assess() {
  await open("Try a task");
  await change("Difficulty", "0");
  await change("Stakes", "0");
}
const connect = (phase: string) =>
  act(async () => {
    state.phase = phase;
    state.connectionListeners.forEach((notify) => notify());
  });
/** Reads of the saved table; each comes with its own read of the accounts. */
const snapshotCalls = () =>
  state.execute.mock.calls.filter(
    ([arg]) => arg.input._tag === "modelSnapshot" && arg.input.part === "settings",
  );
/** Holds the next read of one half of the snapshot until the returned function is called. */
function hold(part: "settings" | "accounts") {
  const previous = state.execute.getMockImplementation()!;
  let release!: (value?: unknown) => void;
  let held = false;
  state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
    if (held || arg.input._tag !== "modelSnapshot" || arg.input.part !== part) return previous(arg);
    held = true;
    const result = await new Promise((resolve) => (release = resolve));
    return result ?? previous(arg);
  });
  return (value?: unknown) => release(value);
}
const saves = () => state.execute.mock.calls.filter(([arg]) => arg.input._tag === "modelPolicy");
const policyOf = (call: [{ input: { policy: ModelRoutingPolicy } }]) => call[0].input.policy;

it("shows an explicit 0 to 10 table with one labelled button per score pair", () => {
  const headers = [...container.querySelectorAll("thead tr")].map((row) =>
    [...row.querySelectorAll("th")].map((th) => th.textContent),
  );
  expect(headers).toEqual([
    ["Stakes by difficulty", "Difficulty →"],
    ["Stakes ↓", ...MODEL_SCORES.map((n) => `Difficulty ${n}`)],
  ]);
  expect(container.querySelectorAll("tbody th")).toHaveLength(11);
  expect(container.querySelectorAll("table button")).toHaveLength(121);
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / high");
  expect(container.textContent).toContain(
    "Example: difficulty 7 with stakes 8 gets Astra 6 · high",
  );
  expect(container.textContent).not.toContain("0–3");
  expect(container.textContent).toContain("No unsaved changes");
});
it.each(["offline", "connected"])(
  "hydrates a cold %s editor once on connection, including StrictMode replay",
  async (phase) => {
    await act(async () => root.unmount());
    state.execute.mockClear();
    state.phase = phase;
    root = createRoot(container);
    await act(async () =>
      root.render(
        <StrictMode>
          <ModelSelectionPage environmentId={EnvironmentId.make("host")} />
        </StrictMode>,
      ),
    );
    expect(snapshotCalls()).toHaveLength(phase === "offline" ? 0 : 1);
    if (phase === "offline") expect(container.querySelector("table")).toBeNull();
    await connect("connected");
    expect(snapshotCalls()).toHaveLength(1);
    expect(container.textContent).toContain("Saved version 3");
    expect(container.textContent).toContain("Coordinator connected");
    await pick(7, 8);
    await change("Reasoning", "xhigh");
    await connect("connected");
    expect(snapshotCalls()).toHaveLength(1);
    expect(state.execute.mock.calls.every(([arg]) => arg.input._tag === "modelSnapshot")).toBe(
      true,
    );
  },
);
it("keeps edits across reconnects, ignores obsolete snapshots and flags a newer saved version", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / xhigh, edited");
  await connect("offline");
  const resolveOld = hold("settings");
  await connect("connected");
  expect(snapshotCalls()).toHaveLength(2);
  expect(button("Save changes").disabled).toBe(true);
  await connect("offline");
  snapshot = { ...snapshot, policy: { ...snapshot.policy, version: 4 } };
  await connect("connected");
  expect(snapshotCalls()).toHaveLength(3);
  expect(container.textContent).toContain("Saved version 4");
  expect(container.textContent).toContain("Version 4 was saved while you were editing");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh");
  await act(async () =>
    resolveOld({ _tag: "Failure", cause: Cause.fail(new Error("obsolete connection")) }),
  );
  expect(container.textContent).toContain("Coordinator connected");
  expect(container.textContent).not.toContain("coordinator unavailable");
  expect(button("Save changes").disabled).toBe(true);
  await click("Keep my edits on version 4");
  expect(button("Save changes").disabled).toBe(false);
  await click("Save changes");
  expect(saves()).toHaveLength(1);
  expect(saves()[0]![0].input.expectedVersion).toBe(4);
  expect(modelCell(policyOf(saves()[0] as never), "codex", 7, 8).effort).toBe("xhigh");
});
it("edits exactly one cell, even where scores used to share a band, and saves the exact table", async () => {
  const neighbours = [
    [4, 2],
    [6, 2],
    [5, 1],
    [5, 3],
  ] as const;
  const before = neighbours.map(([d, s]) => label(d, s));
  await pick(5, 2);
  expect(label(5, 2)).toContain("gpt-6.1-sol / high");
  expect(cell(5, 2).getAttribute("aria-pressed")).toBe("true");
  await change("Model", "gpt-6-astra");
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high, edited");
  expect(neighbours.map(([d, s]) => label(d, s))).toEqual(before);
  expect(container.textContent).toContain("1 unsaved change");
  expect(button("Codex (1 edited)")).toBeDefined();
  await click("Save changes");
  const [saved] = saves();
  expect(saved![0].input.expectedVersion).toBe(3);
  const policy = policyOf(saved as never);
  expect(policy.codex.cells[5]![2]).toEqual({ model: "gpt-6-astra", effort: "high" });
  expect(policy.codex).toEqual(
    withCell(defaultModelRoutingPolicy, "codex", 5, 2, policy.codex.cells[5]![2]!).codex,
  );
  expect(policy.claudeAgent).toEqual(defaultModelRoutingPolicy.claudeAgent);
  expect(container.textContent).toContain("Saved as version 4");
  expect(container.textContent).toContain("No unsaved changes");
});
it("keeps cell edits made while a save is awaiting its receipt", async () => {
  await pick(5, 2);
  await change("Model", "gpt-6-astra");
  let complete!: (value: unknown) => void;
  state.execute.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
  await click("Save changes");
  const submitted = policyOf(saves()[0] as never);
  await pick(1, 1);
  await change("Reasoning", "high");
  expect(label(1, 1)).toContain("high, edited");
  snapshot = { ...snapshot, policy: { ...submitted, version: 4 } };
  await act(async () => complete({ _tag: "Success", value: { modelPolicy: snapshot.policy } }));
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high");
  expect(label(1, 1)).toContain("high, edited");
  expect(container.textContent).toContain("1 unsaved change");
  await click("Save changes");
  expect(saves()[1]![0].input.expectedVersion).toBe(4);
  expect(snapshot.policy.codex.cells[1]![1]!.effort).toBe("high");
});
it("never changes reasoning silently when the chosen model cannot offer it", async () => {
  await pick(7, 0);
  expect(label(7, 0)).toContain("gpt-6.1-sol / max");
  await change("Model", "gpt-6-astra");
  expect(label(7, 0)).toContain("gpt-6.1-sol / max");
  expect(container.textContent).toContain("Astra 6 does not offer max");
  expect(control("Reasoning").value).toBe("");
  expect(button("Save changes").disabled).toBe(true);
  expect(container.textContent).toContain("No unsaved changes");
  await change("Reasoning", "xhigh");
  expect(label(7, 0)).toContain("gpt-6-astra / xhigh");
  expect(container.textContent).toContain("1 unsaved change");
  await pick(5, 2);
  await change("Model", "gpt-6-astra");
  expect(label(5, 2)).toContain("gpt-6-astra / high");
});
it("sets and clears one alternative without touching the choice, offering every advertised model", async () => {
  await pick(0, 0);
  const models = [...(control("Model") as HTMLSelectElement).options].map((o) => o.value);
  expect(models).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
  await change("If unavailable", "gpt-6-astra\nhigh");
  expect(label(0, 0)).toBe(
    "Difficulty 0, stakes 0: gpt-6.1-sol / medium, with an alternative, edited",
  );
  await click("Save changes");
  expect(modelCell(policyOf(saves()[0] as never), "codex", 0, 0)).toEqual({
    model: "gpt-6.1-sol",
    effort: "medium",
    alternatives: [{ model: "gpt-6-astra", effort: "high" }],
  });
  await change("If unavailable", "");
  expect(label(0, 0)).toContain("edited");
  await click("Undo this cell");
  expect(label(0, 0)).toBe("Difficulty 0, stakes 0: gpt-6.1-sol / medium, with an alternative");
});
it("resets one provider to its defaults in the draft, and discards unsaved edits", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  expect(button("Codex (1 edited)")).toBeDefined();
  await click("Claude");
  await pick(1, 1);
  await change("Reasoning", "max");
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / max, edited");
  expect(container.textContent).toContain("2 unsaved changes");
  await click("Reset Claude to defaults");
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / medium");
  expect(container.textContent).toContain("1 unsaved change");
  expect(button("Reset Claude to defaults").disabled).toBe(true);
  expect(state.execute.mock.calls.every(([arg]) => arg.input._tag === "modelSnapshot")).toBe(true);
  await click("Discard changes");
  await click("Codex");
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / high");
  expect(container.textContent).toContain("No unsaved changes");
});
it("keeps edits after a save conflict, reloads the newer version, then saves on top of it", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  // Another editor saves version 4 while this page is open.
  snapshot = {
    ...snapshot,
    policy: {
      ...withCell(snapshot.policy, "codex", 2, 2, { model: "gpt-6-astra", effort: "medium" }),
      version: 4,
    },
  };
  state.execute.mockImplementationOnce(async () => ({
    _tag: "Failure",
    cause: Cause.fail(
      new AllocationError({ code: "conflict", detail: "Another editor saved version 4." }),
    ),
  }));
  await click("Save changes");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh");
  expect(container.textContent).toContain("Another editor saved version 4.");
  expect(container.textContent).toContain("Your changes are kept");
  expect(snapshotCalls()).toHaveLength(2);
  expect(container.textContent).toContain("Version 4 was saved while you were editing");
  expect(button("Save changes").disabled).toBe(true);
  await click("Keep my edits on version 4");
  expect(label(2, 2)).toBe("Difficulty 2, stakes 2: gpt-6-astra / medium");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh");
  await click("Save changes");
  expect(snapshot.policy.version).toBe(5);
  expect(snapshot.policy.codex.cells[2]![2]).toEqual({ model: "gpt-6-astra", effort: "medium" });
  expect(snapshot.policy.codex.cells[7]![8]).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
});
it("flags what the connected catalog cannot offer and keeps editing from the last known list offline", async () => {
  snapshot = {
    ...snapshot,
    inventories: snapshot.inventories.map((inventory) => ({
      ...inventory,
      accounts: inventory.accounts.map((a) =>
        a.driver === "codex"
          ? { ...a, models: a.models.filter((m) => m.slug !== "gpt-6-astra") }
          : a,
      ),
    })),
  };
  await remount();
  await click("Codex");
  expect(label(7, 8)).toBe(
    "Difficulty 7, stakes 8: gpt-6-astra / high, not offered by connected accounts",
  );
  expect(label(0, 0)).not.toContain("not offered");
  await pick(7, 8);
  const select = control("Model") as HTMLSelectElement;
  expect(select.value).toBe("gpt-6-astra");
  expect([...select.options].find((o) => o.value === "gpt-6-astra")!.textContent).toContain(
    "not offered",
  );
  await connect("offline");
  expect(container.textContent).toContain("showing the last known table");
  expect(button("Save changes").disabled).toBe(true);
  await pick(0, 0);
  await change("Reasoning", "high");
  expect(label(0, 0)).toContain("gpt-6.1-sol / high, edited");
  expect(container.textContent).toContain("Offline: choices come from the last known model list");
  expect(button("Save changes").disabled).toBe(true);
  await connect("connected");
  expect(label(0, 0)).toContain("gpt-6.1-sol / high, edited");
  expect(button("Save changes").disabled).toBe(false);
});
it("brings the editor into view when a cell far below it is picked", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  try {
    await pick(10, 10);
    const editor = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(editor.contains(container.querySelector("h2"))).toBe(true);
    expect(editor.contains(cell(10, 10))).toBe(false);
  } finally {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});
it("moves between cells with the arrow keys and keeps one tab stop", async () => {
  const press = (target: HTMLElement, key: string) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  expect(container.querySelectorAll("table button[tabindex='0']")).toHaveLength(1);
  act(() => cell(0, 0).focus());
  await press(cell(0, 0), "ArrowRight");
  expect(document.activeElement).toBe(cell(1, 0));
  await press(cell(1, 0), "ArrowDown");
  expect(document.activeElement).toBe(cell(1, 1));
  await press(cell(1, 1), "End");
  expect(document.activeElement).toBe(cell(10, 1));
  await press(cell(10, 1), "ArrowRight");
  expect(document.activeElement).toBe(cell(10, 1));
  await press(cell(10, 1), "Home");
  expect(document.activeElement).toBe(cell(0, 1));
  expect(cell(0, 1).tabIndex).toBe(0);
  expect(container.querySelectorAll("table button[tabindex='0']")).toHaveLength(1);
  expect(cell(0, 1).getAttribute("aria-pressed")).toBe("false");
});
it("tries a task against the edited table as an agent's start would, on the table shown", async () => {
  await pick(0, 0);
  await change("Reasoning", "high");
  await assess();
  await change("Job length", "3");
  await click("Try");
  const tried = state.execute.mock.calls.findLast(([arg]) => arg.input._tag === "modelPreview")![0];
  expect(modelCell(tried.input.policy, "codex", 0, 0).effort).toBe("high");
  expect(tried.input.request).toMatchObject({
    selection: "automatic",
    environmentId: "host",
    allowedDrivers: ["codex"],
    assessment: { difficulty: 0, stakes: 0 },
    expectedHours: 3,
  });
  expect(tried.input.request.override).toBeUndefined();
  expect(tried.input.request.explicitInstanceId).toBeUndefined();
  expect(container.querySelector('[aria-label="Task result"]')).not.toBeNull();
  // Nothing on the page starts a session.
  expect(button("Start assignment")).toBeUndefined();
  await click("Claude");
  expect(container.querySelector('[aria-label="Task result"]')).toBeNull();
  await click("Try");
  expect(
    state.execute.mock.calls.findLast(([arg]) => arg.input._tag === "modelPreview")![0].input
      .request.allowedDrivers,
  ).toEqual(["claudeAgent"]);
});
it("shows the task's account, model and effort with its one reason line", async () => {
  await assess();
  const reason = "claude-opus-5-5 is drained on every account; using the closest model with room.";
  const line = "SL: 40 points left, resets in 2.0 h, 0 workers";
  state.execute.mockImplementationOnce(async ({ input }) => ({
    _tag: "Success",
    value: {
      selection: {
        at: "2026-10-23T12:00:00.000Z",
        request: input.request,
        policyVersion: 3,
        selectedProfile: null,
        revision: 0,
        rule: "Rule",
        profiles: [],
        reasons: [reason],
        wanted: {
          driver: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
        accounts: [line],
        allocation: {
          mode: "automatic",
          reservation: null,
          decision: {
            at: "2026-10-23T12:00:00.000Z",
            policyVersion: 3,
            request: {
              assignmentId: input.request.assignmentId,
              environmentId: "host",
              threadId: input.request.threadId,
              driver: "claudeAgent",
              model: "claude-sonnet-5-5",
              options: [{ id: "effort", value: "max" }],
            },
            outcome: "selected",
            selectedInstanceId: "sl",
            candidates: [],
            reasons: [],
            confidence: "medium",
            waitUntil: null,
          },
        },
      },
    },
  }));
  await click("Try");
  const lines = [...container.querySelectorAll('[aria-label="Task result"] p')].map(
    (p) => p.textContent,
  );
  expect(lines).toEqual(["SL · claude-sonnet-5-5 / max", reason]);
});
it("says until when everything is drained", async () => {
  await assess();
  state.execute.mockImplementationOnce(async ({ input }) => ({
    _tag: "Success",
    value: {
      selection: {
        at: "2026-10-23T12:00:00.000Z",
        request: input.request,
        policyVersion: 3,
        selectedProfile: null,
        revision: 0,
        rule: "Rule",
        profiles: [],
        reasons: ["Every Claude model is drained."],
        drainedUntil: "2026-10-23T15:00:00.000Z",
        accounts: [],
        allocation: null,
      },
    },
  }));
  await click("Try");
  const text = container.querySelector('[aria-label="Task result"]')!.textContent!;
  expect(text).toContain(`Drained until ${new Date("2026-10-23T15:00:00.000Z").toLocaleString()}`);
  expect(text).toContain("Every Claude model is drained.");
});
it("edits the ladder: moves, removes and adds a rung, saved with the policy", async () => {
  const rung = (place: number) =>
    container.querySelector(`[aria-label="Model ladder"] li:nth-child(${place})`)!.textContent!;
  expect(rung(1)).toContain("1. claude-haiku-5-5 / max");
  expect(rung(1)).toContain("not offered by a connected account");
  expect(rung(3)).toBe("3. claude-opus-5-5 / medium");
  expect(named("Move rung 1 up").hasAttribute("disabled")).toBe(true);
  await act(async () => named("Move rung 2 up").click());
  expect(rung(1)).toBe("1. claude-sonnet-5-5 / high");
  expect(container.textContent).toContain("1 unsaved change");
  await act(async () => named("Remove rung 2").click());
  expect(rung(2)).toBe("2. claude-opus-5-5 / medium");
  expect(button("Add strongest rung").disabled).toBe(true);
  await change("Rung model", "typed-model");
  await change("Rung effort", "high");
  await click("Add strongest rung");
  await click("Save changes");
  expect(policyOf(saves()[0] as never).ladder).toEqual([
    ...defaultModelLadder.slice(1),
    { model: "typed-model", effort: "high" },
  ]);
  expect(container.textContent).toContain("No unsaved changes");
});
it("turns the fallback off and on, and saves its model, effort and threshold", async () => {
  expect(named("Fallback model").getAttribute("aria-checked")).toBe("true");
  expect(control("Fallback model ID").value).toBe("deepseek-flash");
  await act(async () => named("Fallback model").click());
  expect(named("Fallback model").getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("1 unsaved change");
  await click("Save changes");
  expect(policyOf(saves()[0] as never).fallback).toBeNull();
  await act(async () => named("Fallback model").click());
  await change("Fallback model ID", "other-model");
  await change("Fallback effort", "");
  expect(button("Save changes").disabled).toBe(true);
  await change("Fallback effort", "high");
  await change("Used below rung", "claude-opus-5-5\nhigh");
  await click("Save changes");
  expect(policyOf(saves()[1] as never).fallback).toEqual({
    model: "other-model",
    effort: "high",
    below: { model: "claude-opus-5-5", effort: "high" },
  });
});
it("accepts any typed model ID, marks one no account offers, and shows the save's warnings", async () => {
  const previous = state.execute.getMockImplementation()!;
  const warning = "codex table: no connected account offers typed-model.";
  state.execute.mockImplementation(async (arg) => {
    const result = await previous(arg);
    return arg.input._tag === "modelPolicy"
      ? { ...result, value: { ...result.value, warnings: [warning] } }
      : result;
  });
  await change("Add a model", "typed-model");
  await click("Add model");
  const list = container.querySelector('[aria-label="Codex models"]')!;
  expect(list.textContent).toContain("typed-model· not offered by a connected account");
  expect(list.textContent).not.toContain("gpt-6-astra·");
  await pick(0, 0);
  await change("Model", "typed-model");
  expect(label(0, 0)).toBe(
    "Difficulty 0, stakes 0: typed-model / medium, edited, not offered by connected accounts",
  );
  await click("Save changes");
  const policy = policyOf(saves()[0] as never);
  expect(policy.codex.allowedModels).toEqual(["gpt-6.1-sol", "gpt-6-astra", "typed-model"]);
  expect(modelCell(policy, "codex", 0, 0)).toEqual({ model: "typed-model", effort: "medium" });
  expect(container.textContent).toContain("Saved with warnings");
  expect(container.textContent).toContain(warning);
  await act(async () => named("Remove typed-model").click());
  expect(list.textContent).not.toContain("typed-model");
});
it("refuses a missing score, and reverts to an earlier version once edits are saved", async () => {
  await open("Try a task");
  await click("Try");
  expect(container.textContent).toContain("Give difficulty and stakes as whole numbers");
  expect(state.execute.mock.calls.some(([arg]) => arg.input._tag === "modelPreview")).toBe(false);
  await click("Claude");
  expect(label(0, 0)).toContain("claude-sonnet-5-5 / medium");
  await open("Earlier versions");
  expect(container.textContent).not.toContain("Revert to version 3");
  await pick(1, 1);
  await change("Reasoning", "max");
  // Reverting would silently drop unsaved edits, so it waits for a save or discard.
  expect(button("Revert to version 2").disabled).toBe(true);
  expect(container.textContent).toContain("save or discard your changes first");
  await click("Discard changes");
  await click("Revert to version 2");
  expect(snapshot.policy.version).toBe(4);
  expect(container.textContent).toContain("Saved version 4");
  expect(container.querySelector("pre")).toBeNull();
  expect(container.textContent).not.toContain("reassessments");
});
it("opens on the Claude table", async () => {
  await remount();
  expect(named("Claude table")).not.toBeNull();
  expect(button("Claude").getAttribute("aria-selected")).toBe("true");
  expect(button("Codex").getAttribute("aria-selected")).toBe("false");
});
it("shows the saved table before the accounts arrive, saying only that they are loading", async () => {
  await act(async () => root.unmount());
  const release = hold("accounts");
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Saved version 3");
  expect(container.textContent).toContain("Coordinator connected");
  expect(container.textContent).toContain("Loading accounts…");
  expect(container.querySelectorAll("table button")).toHaveLength(121);
  await pick(7, 8);
  expect(named("Claude table").textContent).toContain("Loading accounts…");
  for (const claim of ["not connected", "Not connected", "Connect to", "not loaded", "Reconnect"])
    expect(container.textContent).not.toContain(claim);
  // Nothing is flagged as unoffered before the accounts are known.
  const ladder = () => named("Model ladder").textContent!;
  expect(ladder()).not.toContain("not offered");
  await act(async () => release());
  expect(container.textContent).not.toContain("Loading accounts…");
  expect(ladder()).toContain("not offered by a connected account");
});
it.each(["connecting", "offline"])(
  "while %s, says loading or not connected, never both",
  async (phase) => {
    await act(async () => root.unmount());
    state.phase = phase;
    root = createRoot(container);
    await render();
    const text = container.textContent!;
    if (phase === "connecting") {
      expect(text).toContain("Loading the saved table…");
      expect(text).not.toContain("Not connected");
      expect(text).not.toContain("Connect to this environment");
    } else {
      expect(text).toContain("Not connected");
      expect(text).toContain("Connect to this environment to view and edit it.");
      expect(text).not.toContain("Loading");
    }
  },
);
it("lists recent starts read-only: time, scores, the chosen account, model and effort, and reasons", async () => {
  const at = "2026-10-23T12:00:00.000Z";
  snapshot = {
    ...snapshot,
    history: [
      {
        at,
        policyVersion: 3,
        revision: 0,
        selectedProfile: null,
        rule: "Difficulty 6, stakes 4",
        profiles: [],
        reasons: ["Table choice for difficulty 6, stakes 4.", "SL has the most room."],
        request: {
          selection: "automatic",
          assignmentId: "started",
          environmentId: "host",
          threadId: ThreadId.make("started"),
          allowedDrivers: [ProviderDriverKind.make("claudeAgent")],
          assessment: { difficulty: 6, stakes: 4 },
        },
        allocation: {
          mode: "automatic",
          reservation: null,
          decision: {
            at,
            policyVersion: 3,
            request: {
              assignmentId: "started",
              environmentId: "host",
              threadId: ThreadId.make("started"),
              driver: ProviderDriverKind.make("claudeAgent"),
              model: "claude-opus-5-5",
              options: [{ id: "effort", value: "high" }],
            },
            outcome: "selected",
            selectedInstanceId: ProviderInstanceId.make("sl"),
            candidates: [],
            reasons: [],
            confidence: "medium",
            waitUntil: null,
          },
        },
      },
    ],
  };
  await remount();
  await open("Recent decisions");
  const item = [...container.querySelectorAll("details")]
    .find((d) => d.querySelector("summary")!.textContent === "Recent decisions")!
    .querySelector("li")!;
  expect([...item.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    `${new Date(at).toLocaleString()} · difficulty 6 · stakes 4`,
    "SL · claude-opus-5-5 / high",
    "Table choice for difficulty 6, stakes 4.",
    "SL has the most room.",
  ]);
  expect(item.querySelector("button,details")).toBeNull();
});
