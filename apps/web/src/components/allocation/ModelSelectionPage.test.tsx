// @vitest-environment jsdom
import { act, StrictMode } from "react";
import * as Cause from "effect/Cause";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
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
  start: vi.fn(),
  navigate: vi.fn(),
  phase: "connected",
  connectionListeners: new Set<() => void>(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/provider-allocation", () => ({
  createAllocationCommands: () => ({ execute: { label: "execute" }, start: { label: "start" } }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
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
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "project", title: "Project", environmentId: "host" }],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
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
  state.start.mockReset();
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
    if (input._tag === "modelSnapshot")
      return { _tag: "Success", value: { modelSnapshot: structuredClone(snapshot) } };
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function assess() {
  await open("Test an assignment");
  await change("Difficulty score", "0");
  await change("Stakes score", "0");
  await change("Difficulty reason", "Scoped reasoning");
  await change("Stakes reason", "Reversible failure");
}
const connect = (phase: string) =>
  act(async () => {
    state.phase = phase;
    state.connectionListeners.forEach((notify) => notify());
  });
const snapshotCalls = () =>
  state.execute.mock.calls.filter(([arg]) => arg.input._tag === "modelSnapshot");
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
  let resolveOld!: (value: unknown) => void;
  state.execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  await connect("connected");
  expect(snapshotCalls()).toHaveLength(2);
  expect(button("Save table").disabled).toBe(true);
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
  expect(button("Save table").disabled).toBe(true);
  await click("Keep my edits on version 4");
  expect(button("Save table").disabled).toBe(false);
  await click("Save table");
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
  await click("Save table");
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
  await click("Save table");
  const submitted = policyOf(saves()[0] as never);
  await pick(1, 1);
  await change("Reasoning", "high");
  expect(label(1, 1)).toContain("high, edited");
  snapshot = { ...snapshot, policy: { ...submitted, version: 4 } };
  await act(async () => complete({ _tag: "Success", value: { modelPolicy: snapshot.policy } }));
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high");
  expect(label(1, 1)).toContain("high, edited");
  expect(container.textContent).toContain("1 unsaved change");
  await click("Save table");
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
  expect(button("Save table").disabled).toBe(true);
  expect(container.textContent).toContain("No unsaved changes");
  await change("Reasoning", "xhigh");
  expect(label(7, 0)).toContain("gpt-6-astra / xhigh");
  expect(container.textContent).toContain("1 unsaved change");
  await pick(5, 2);
  await change("Model", "gpt-6-astra");
  expect(label(5, 2)).toContain("gpt-6-astra / high");
});
it("sets and clears one alternative without touching the choice, and offers no Luna", async () => {
  await pick(0, 0);
  const models = [...(control("Model") as HTMLSelectElement).options].map((o) => o.value);
  expect(models).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  await change("If unavailable", "gpt-6-astra\nhigh");
  expect(label(0, 0)).toBe(
    "Difficulty 0, stakes 0: gpt-6.1-sol / medium, with an alternative, edited",
  );
  await click("Save table");
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
  await click("Save table");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh");
  expect(container.textContent).toContain("Another editor saved version 4.");
  expect(container.textContent).toContain("Your changes are kept");
  expect(snapshotCalls()).toHaveLength(2);
  expect(container.textContent).toContain("Version 4 was saved while you were editing");
  expect(button("Save table").disabled).toBe(true);
  await click("Keep my edits on version 4");
  expect(label(2, 2)).toBe("Difficulty 2, stakes 2: gpt-6-astra / medium");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh");
  await click("Save table");
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
  expect(button("Save table").disabled).toBe(true);
  await pick(0, 0);
  await change("Reasoning", "high");
  expect(label(0, 0)).toContain("gpt-6.1-sol / high, edited");
  expect(container.textContent).toContain("Offline: choices come from the last known model list");
  expect(button("Save table").disabled).toBe(true);
  await connect("connected");
  expect(label(0, 0)).toContain("gpt-6.1-sol / high, edited");
  expect(button("Save table").disabled).toBe(false);
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
it.each(["codex", "claudeAgent"])(
  "edits only the %s override effort and exposes retained exact options",
  async (driver) => {
    const effortId = driver === "codex" ? "reasoningEffort" : "effort";
    const options = [
      { id: "serviceTier", value: "priority" },
      { id: effortId, value: "high" },
      { id: "speed", value: "fast" },
    ];
    snapshot = {
      ...snapshot,
      history: [
        {
          at: "2026-10-23T12:00:00.000Z",
          policyVersion: 3,
          revision: 0,
          selectedProfile: null,
          rule: "Exact user override",
          profiles: [],
          reasons: [],
          allocation: null,
          request: {
            selection: "automatic",
            assignmentId: "prior",
            environmentId: "host",
            threadId: ThreadId.make("prior"),
            allowedDrivers: [ProviderDriverKind.make(driver)],
            assessment: {
              difficulty: 7,
              stakes: 7,
              difficultyReason: "Interactions",
              stakesReason: "Consequential",
            },
            override: {
              driver: ProviderDriverKind.make(driver),
              model: driver === "codex" ? "gpt-6-astra" : "claude-opus-5-5",
              options,
              reason: "Preserve priority and speed",
            },
          },
        },
      ],
    };
    await remount();
    await open("Recent decisions (up to 50)");
    await click("Reassess as a new assignment");
    expect(control("Override effort").value).toBe("high");
    expect(container.textContent).toContain("serviceTier: priority");
    expect(container.textContent).toContain("speed: fast");
    await change("Override effort", "max");
    await change("Reassessment reason", "Substantive scope change requires more reasoning");
    await click("Preview exact selection");
    const call = state.execute.mock.calls.findLast(
      ([arg]) => arg.input._tag === "modelPreview",
    )![0];
    expect(call.input.request.override.options).toEqual(
      options.map((o) => (o.id === effortId ? { ...o, value: "max" } : o)),
    );
    expect(call.input.request.override.reason).toBe("Preserve priority and speed");
  },
);
it("tests an assignment against the edited table, and starts only from a saved one", async () => {
  await pick(0, 0);
  await change("Reasoning", "high");
  await assess();
  await change("Project", "project");
  await change("Assignment", "Scoped assignment");
  await click("Preview exact selection");
  const preview = state.execute.mock.calls.findLast(
    ([arg]) => arg.input._tag === "modelPreview",
  )![0];
  expect(modelCell(preview.input.policy, "codex", 0, 0).effort).toBe("high");
  expect(preview.input.request.policyVersion).toBe(3);
  expect(container.querySelector('[aria-label="Selection preview"]')).not.toBeNull();
  expect(button("Start assignment").disabled).toBe(true);
  await click("Save table");
  await click("Preview exact selection");
  expect(button("Start assignment").disabled).toBe(false);
});
it("renders eligibility with clear punctuation and one copy of the same reason", async () => {
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
        allocation: null,
        reasons: ["codex: table choice."],
        profiles: [
          {
            driver: "codex",
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "medium" }],
            profile: null,
            eligible: true,
            reason: "codex: table choice.",
          },
        ],
      },
    },
  }));
  await click("Preview exact selection");
  const text = container.querySelector('[aria-label="Selection preview"]')!.textContent!;
  expect(text).not.toContain("? eligible");
  expect(text.match(/codex: table choice\./g)).toHaveLength(1);
});
it("refuses a missing assessment, and reverts a saved version as a new version", async () => {
  await open("Test an assignment");
  await click("Preview exact selection");
  expect(container.textContent).toContain("Supply integer scores");
  await click("Claude");
  expect(label(0, 0)).toContain("claude-sonnet-5-5 / medium");
  await open("Policy settings, versions and raw JSON");
  await click("Revert version 2 as a new version");
  expect(snapshot.policy.version).toBe(4);
  expect(container.textContent).toContain("Saved version 4");
});
it("keeps the raw policy and reassessment limit in the advanced area, retaining edits", async () => {
  expect(container.querySelector("pre")).toBeNull();
  await open("Policy settings, versions and raw JSON");
  await change("Maximum explicit reassessments", "3");
  expect(container.textContent).toContain("1 unsaved change");
  expect(container.querySelector("pre")!.textContent).toContain('"maxReassessments": 3');
  // Reverting would silently drop unsaved edits, so it waits for a save or discard.
  expect(button("Revert version 2 as a new version").disabled).toBe(true);
  expect(container.textContent).toContain("save or discard your changes first");
  await click("Save table");
  expect(saves()[0]![0].input.policy.maxReassessments).toBe(3);
  expect(button("Revert version 2 as a new version").disabled).toBe(false);
});
it("retries an uncertain startup with its original table version and intent after refresh", async () => {
  await assess();
  await change("Project", "project");
  await change("Assignment", "Scoped assignment");
  await click("Preview exact selection");
  state.start.mockResolvedValue({ _tag: "Failure" });
  await click("Start assignment");
  const first = state.start.mock.calls[0]![0];
  expect(first.input.request.policyVersion).toBe(3);
  snapshot = { ...snapshot, policy: { ...snapshot.policy, version: 4 } };
  await open("Connection");
  await click("Refresh saved version");
  expect(button("Retry identical assignment").disabled).toBe(false);
  await click("Retry identical assignment");
  expect(state.start.mock.calls[1]![0]).toEqual(first);
  await change("Assignment", "Changed intent");
  expect(button("Retry identical assignment").disabled).toBe(true);
  await click("New assignment identity");
  expect(button("Start assignment").disabled).toBe(true);
});
it.each(["unavailable", "observation"])(
  "allows same-ID account choice after a confirmed %s response without a reservation",
  async (startupState) => {
    await assess();
    await change("Project", "project");
    await change("Assignment", "Scoped assignment");
    await click("Preview exact selection");
    state.start.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: { state: startupState, allocation: null, threadId: input.request.threadId },
    }));
    await click("Start assignment");
    const first = state.start.mock.calls[0]![0];
    expect(button("Retry identical assignment")).toBeUndefined();
    await change("Account constraint", "ad");
    await click("Preview exact selection");
    expect(button("Start assignment").disabled).toBe(false);
    await click("Start assignment");
    expect(state.start.mock.calls[1]![0].input.request).toEqual({
      ...first.input.request,
      explicitInstanceId: "ad",
    });
  },
);
