// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  defaultModelFallback,
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
// The settings layout reads the settings search and scope; here it is only a frame.
vi.mock("../settings/settingsLayout", () => ({
  SettingsSection: (props: { title: string; headerAction?: ReactNode; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.headerAction}
      {props.children}
    </section>
  ),
}));
vi.mock("../settings/FoldedSettingsSection", async () => {
  const { useState } = await import("react");
  return {
    FoldedSettingsSection: (props: { title: string; summary?: string; children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return (
        <section aria-label={props.title}>
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {props.title}
          </button>
          <span>{props.summary}</span>
          {open && props.children}
        </section>
      );
    },
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
const section = (title: string) => container.querySelector(`section[aria-label="${title}"]`)!;
const toggle = (name: string) =>
  container.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`)!;
const click = (label: string) =>
  act(async () => {
    button(label).click();
  });
/** Opens a folded section; closed, its content is not rendered. */
const open = click;
/** Lets `ms` pass, and the save that follows settle. */
const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const leave = (label: string) =>
  act(() => void control(label).dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const status = () =>
  section("Model by difficulty and stakes").querySelector('[role="status"]')?.textContent;
const alert = () => container.querySelector('[role="alert"]');
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
  difficulty: number,
  stakes: number,
  next: { model: string; effort: string },
) => setModelCell(policy, "codex", difficulty, stakes, next);
/** Stores a table as the next version, as this page or anything else that saves does. */
function store(policy: ModelRoutingPolicy) {
  const next = { ...policy, version: snapshot.policy.version + 1 };
  snapshot = { ...snapshot, policy: next, policies: [next, ...snapshot.policies] };
  return next;
}
const refused = (code: "conflict" | "unavailable", detail: string) => ({
  _tag: "Failure",
  cause: Cause.fail(new AllocationError({ code, detail })),
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.phase = "connected";
  state.execute.mockReset();
  const saved = { ...defaultModelRoutingPolicy, version: 3 };
  snapshot = {
    policy: saved,
    policies: [saved, { ...defaultModelRoutingPolicy, version: 2 }],
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
    // A disconnected computer answers nothing.
    if (state.phase !== "connected")
      return { _tag: "Failure", cause: Cause.fail(new Error("not connected")) };
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
    // As the server does, a save or a way back is refused once a newer version is stored.
    if (input._tag === "modelPolicy" || input._tag === "modelRevert") {
      if (input.expectedVersion !== snapshot.policy.version)
        return refused("conflict", "The model table changed.");
      const policy =
        input._tag === "modelPolicy"
          ? input.policy
          : snapshot.policies.find((p) => p.version === input.version)!;
      return { _tag: "Success", value: { modelPolicy: store(policy) } };
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
  vi.useRealTimers();
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
const saves = () =>
  state.execute.mock.calls
    .filter(([arg]) => arg.input._tag === "modelPolicy")
    .map(([arg]) => arg.input as { expectedVersion: number; policy: ModelRoutingPolicy });

it("shows an explicit 0 to 10 table with one labelled button per score pair, and no Save button", () => {
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
  expect(status()).toBe("Changes save automatically");
  for (const gone of ["Save changes", "Discard changes", "Undo this cell"])
    expect(button(gone)).toBeUndefined();
});
it.each(["offline", "connected"])(
  "reads a cold %s page once on connection, including StrictMode replay",
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
    if (phase === "offline") {
      expect(container.querySelector("table")).toBeNull();
      expect(status()).toBe("Not connected");
    }
    await connect("connected");
    expect(snapshotCalls()).toHaveLength(1);
    expect(status()).toBe("Changes save automatically");
    expect(container.querySelectorAll("table button")).toHaveLength(121);
    await connect("connected");
    expect(snapshotCalls()).toHaveLength(1);
    expect(state.execute.mock.calls.every(([arg]) => arg.input._tag === "modelSnapshot")).toBe(
      true,
    );
  },
);
it("stores cell changes once they pause, as one version and exactly the cells changed", async () => {
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
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high, not saved yet");
  expect(neighbours.map(([d, s]) => label(d, s))).toEqual(before);
  expect(status()).toBe("Not saved yet");
  await pass(600);
  await pick(1, 1);
  await change("Reasoning", "high");
  await pass(1199);
  expect(saves()).toEqual([]);
  await pass(1);
  expect(saves()).toHaveLength(1);
  const [saved] = saves();
  expect(saved!.expectedVersion).toBe(3);
  expect(saved!.policy.codex).toEqual(
    withCell(
      withCell(defaultModelRoutingPolicy, 5, 2, { model: "gpt-6-astra", effort: "high" }),
      1,
      1,
      { ...modelCell(defaultModelRoutingPolicy, "codex", 1, 1), effort: "high" },
    ).codex,
  );
  expect(saved!.policy.claudeAgent).toEqual(defaultModelRoutingPolicy.claudeAgent);
  expect(snapshot.policy.version).toBe(4);
  expect(status()).toBe("Saved");
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high");
});
it("stores a waiting change when the page is left", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  await act(async () => root.unmount());
  await pass();
  root = createRoot(container);
  expect(modelCell(snapshot.policy, "codex", 7, 8).effort).toBe("xhigh");
});
it("keeps a change made while a save is on its way, and stores it next", async () => {
  await pick(5, 2);
  await change("Model", "gpt-6-astra");
  const previous = state.execute.getMockImplementation()!;
  let complete!: () => void;
  state.execute.mockImplementationOnce(async (arg) => {
    await new Promise<void>((resolve) => (complete = resolve));
    return previous(arg);
  });
  await pass(1200);
  expect(status()).toBe("Saving…");
  await pick(1, 1);
  await change("Reasoning", "high");
  expect(label(1, 1)).toContain("high, not saved yet");
  await act(async () => complete());
  expect(label(5, 2)).toBe("Difficulty 5, stakes 2: gpt-6-astra / high");
  expect(label(1, 1)).toContain("high, not saved yet");
  expect(status()).toBe("Not saved yet");
  await pass(1200);
  expect(saves().map((save) => save.expectedVersion)).toEqual([3, 4]);
  expect(modelCell(snapshot.policy, "codex", 1, 1).effort).toBe("high");
  expect(modelCell(snapshot.policy, "codex", 5, 2).model).toBe("gpt-6-astra");
  expect(status()).toBe("Saved");
});
it("shows a refused save, keeps the change marked, and stores it on a retry", async () => {
  state.execute.mockImplementationOnce(async () =>
    refused("unavailable", "The settings computer is off."),
  );
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  await pass(1200);
  expect(alert()?.textContent).toContain("Not saved");
  expect(alert()?.textContent).toContain("The settings computer is off.");
  expect(status()).toBe("Not saved");
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / xhigh, not saved yet");
  expect(button("Codex (1 not saved)")).toBeDefined();
  expect(snapshot.policy.version).toBe(3);
  await click("Try again");
  await pass();
  expect(modelCell(snapshot.policy, "codex", 7, 8).effort).toBe("xhigh");
  expect(alert()).toBeNull();
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / xhigh");
  expect(button("Codex")).toBeDefined();
});
it("shows the stored table again when a change that could not be stored is dropped", async () => {
  state.execute.mockImplementationOnce(async () => ({ _tag: "Failure" }));
  await pick(0, 0);
  await change("Reasoning", "high");
  await pass(1200);
  expect(alert()?.textContent).toContain("did not answer");
  await click("Drop my change");
  expect(label(0, 0)).toBe("Difficulty 0, stakes 0: gpt-6.1-sol / medium");
  expect(alert()).toBeNull();
  expect(status()).toBe("Changes save automatically");
  await pass(1200);
  expect(snapshot.policy.version).toBe(3);
});
it("applies a change on top of a table saved elsewhere instead of overwriting it", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  // Another computer stores version 4 while this page is open.
  store(withCell(snapshot.policy, 2, 2, { model: "gpt-6-astra", effort: "xhigh" }));
  await pass(1200);
  expect(saves().map((save) => save.expectedVersion)).toEqual([3, 4]);
  expect(snapshot.policy.version).toBe(5);
  expect(modelCell(snapshot.policy, "codex", 2, 2)).toEqual({
    model: "gpt-6-astra",
    effort: "xhigh",
  });
  expect(modelCell(snapshot.policy, "codex", 7, 8).effort).toBe("xhigh");
  expect(label(2, 2)).toBe("Difficulty 2, stakes 2: gpt-6-astra / xhigh");
  expect(alert()).toBeNull();
  expect(status()).toBe("Saved");
});
it("asks before replacing a cell that was also changed elsewhere", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  store(withCell(snapshot.policy, 7, 8, { model: "gpt-6.1-sol", effort: "max" }));
  await pass(1200);
  expect(alert()?.textContent).toContain("Changed elsewhere");
  expect(status()).toBe("Not saved");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh, not saved yet");
  expect(snapshot.policy.version).toBe(4);
  await click("Use theirs");
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6.1-sol / max");
  expect(alert()).toBeNull();
  await pass(1200);
  expect(snapshot.policy.version).toBe(4);

  store(withCell(snapshot.policy, 7, 8, { model: "gpt-6-astra", effort: "medium" }));
  await change("Reasoning", "high");
  await pass(1200);
  await click("Keep mine");
  await pass();
  expect(snapshot.policy.version).toBe(6);
  expect(modelCell(snapshot.policy, "codex", 7, 8)).toEqual({
    model: "gpt-6.1-sol",
    effort: "high",
  });
  expect(alert()).toBeNull();
});
it("keeps a change across reconnects, ignores an overtaken read and stores on the newest version", async () => {
  await pick(7, 8);
  await change("Reasoning", "xhigh");
  await connect("offline");
  await pass(1200);
  // The save could not reach the computer: the change is still marked, and nothing is stored.
  expect(alert()?.textContent).toContain("did not answer");
  expect(status()).toBe("Not connected");
  expect(label(7, 8)).toContain("gpt-6-astra / xhigh, not saved yet");
  const resolveOld = hold("settings");
  await connect("connected");
  expect(snapshotCalls()).toHaveLength(2);
  expect(status()).toBe("Loading…");
  await connect("offline");
  store(snapshot.policy);
  await connect("connected");
  await pass();
  expect(snapshotCalls()).toHaveLength(3);
  expect(saves().at(-1)!.expectedVersion).toBe(4);
  expect(snapshot.policy.version).toBe(5);
  expect(modelCell(snapshot.policy, "codex", 7, 8).effort).toBe("xhigh");
  expect(status()).toBe("Saved");
  await act(async () =>
    resolveOld({ _tag: "Failure", cause: Cause.fail(new Error("obsolete connection")) }),
  );
  expect(alert()).toBeNull();
  expect(label(7, 8)).toBe("Difficulty 7, stakes 8: gpt-6-astra / xhigh");
});
it("never changes reasoning silently when the chosen model cannot offer it", async () => {
  await pick(7, 0);
  expect(label(7, 0)).toContain("gpt-6.1-sol / max");
  await change("Model", "gpt-6-astra");
  expect(label(7, 0)).toBe("Difficulty 7, stakes 0: gpt-6.1-sol / max");
  expect(container.textContent).toContain("Astra 6 does not offer max");
  expect(control("Reasoning").value).toBe("");
  await pass(1200);
  expect(saves()).toEqual([]);
  expect(status()).toBe("Changes save automatically");
  await change("Reasoning", "xhigh");
  expect(label(7, 0)).toContain("gpt-6-astra / xhigh, not saved yet");
  await pass(1200);
  expect(modelCell(snapshot.policy, "codex", 7, 0)).toMatchObject({
    model: "gpt-6-astra",
    effort: "xhigh",
  });
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
    "Difficulty 0, stakes 0: gpt-6.1-sol / medium, with an alternative, not saved yet",
  );
  await pass(1200);
  expect(modelCell(snapshot.policy, "codex", 0, 0)).toEqual({
    model: "gpt-6.1-sol",
    effort: "medium",
    alternatives: [{ model: "gpt-6-astra", effort: "high" }],
  });
  expect(label(0, 0)).toBe("Difficulty 0, stakes 0: gpt-6.1-sol / medium, with an alternative");
  await change("If unavailable", "");
  await pass(1200);
  expect(modelCell(snapshot.policy, "codex", 0, 0)).toEqual({
    model: "gpt-6.1-sol",
    effort: "medium",
  });
  expect(snapshot.policy.version).toBe(5);
});
it("flags what the connected catalog cannot offer, and stores a change made offline on reconnecting", async () => {
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
  await pick(0, 0);
  await change("Reasoning", "high");
  expect(container.textContent).toContain("a change is saved once this computer reconnects");
  await pass(1200);
  expect(label(0, 0)).toBe("Difficulty 0, stakes 0: gpt-6.1-sol / high, not saved yet");
  expect(snapshot.policy.version).toBe(3);
  await connect("connected");
  await pass();
  expect(snapshot.policy.version).toBe(4);
  expect(label(0, 0)).toBe("Difficulty 0, stakes 0: gpt-6.1-sol / high");
  expect(alert()).toBeNull();
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
    expect(editor.contains(container.querySelector("h3"))).toBe(true);
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
it("tries a task as an agent's start would, on the table shown", async () => {
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
it("refuses to try a task without its scores", async () => {
  await open("Try a task");
  await click("Try");
  expect(container.textContent).toContain("Give difficulty and stakes as whole numbers");
  expect(state.execute.mock.calls.some(([arg]) => arg.input._tag === "modelPreview")).toBe(false);
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
it("says until when every account is used up", async () => {
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
  expect(text).toContain(`Used up until ${new Date("2026-10-23T15:00:00.000Z").toLocaleString()}`);
  expect(text).toContain("Every Claude model is drained.");
});
it("stores each ladder change at once: a move, a removal and a new rung", async () => {
  const rung = (place: number) =>
    container.querySelector(`[aria-label="Model ladder"] li:nth-child(${place})`)!.textContent!;
  expect(rung(1)).toContain("1. claude-haiku-5-5 / max");
  expect(rung(1)).toContain("not offered by a connected account");
  expect(rung(3)).toBe("3. claude-opus-5-5 / medium");
  expect(named("Move rung 1 up").hasAttribute("disabled")).toBe(true);
  await act(async () => named("Move rung 2 up").click());
  await pass();
  expect(rung(1)).toBe("1. claude-sonnet-5-5 / high");
  expect(snapshot.policy.version).toBe(4);
  await act(async () => named("Remove rung 2").click());
  await pass();
  expect(rung(2)).toBe("2. claude-opus-5-5 / medium");
  expect(button("Add strongest rung").disabled).toBe(true);
  await change("Rung model", "typed-model");
  await change("Rung effort", "high");
  await pass(5000);
  expect(snapshot.policy.version).toBe(5);
  await click("Add strongest rung");
  await pass();
  expect(snapshot.policy.ladder).toEqual([
    ...defaultModelLadder.slice(1),
    { model: "typed-model", effort: "high" },
  ]);
  expect(snapshot.policy.version).toBe(6);
  expect(status()).toBe("Saved");
});
it("stores the fallback switch at once, and a typed model or effort only when its field is left", async () => {
  expect(toggle("Fallback model").getAttribute("aria-checked")).toBe("true");
  expect(control("Fallback model ID").value).toBe("deepseek-flash");
  await act(async () => toggle("Fallback model").click());
  await pass();
  expect(toggle("Fallback model").getAttribute("aria-checked")).toBe("false");
  expect(snapshot.policy.fallback).toBeNull();
  await act(async () => toggle("Fallback model").click());
  await pass();
  expect(snapshot.policy.fallback).toEqual(defaultModelFallback);
  // A half-typed model ID would become the fallback of running work.
  await change("Fallback model ID", "other");
  await change("Fallback model ID", "other-model");
  await pass(5000);
  expect(snapshot.policy.version).toBe(5);
  expect(status()).toBe("Not saved yet");
  await change("Fallback effort", "");
  await leave("Fallback effort");
  await pass();
  expect(alert()?.textContent).toContain("The fallback needs a model and an effort.");
  expect(snapshot.policy.version).toBe(5);
  await change("Fallback effort", "high");
  await leave("Fallback effort");
  await pass();
  expect(alert()).toBeNull();
  await change("Used below rung", "claude-opus-5-5\nhigh");
  await pass();
  expect(snapshot.policy.fallback).toEqual({
    model: "other-model",
    effort: "high",
    below: { model: "claude-opus-5-5", effort: "high" },
  });
  expect(snapshot.policy.version).toBe(7);
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
  await open("Other model IDs");
  await change("Add a model", "typed-model");
  await click("Add model");
  await pass();
  const list = container.querySelector('[aria-label="Codex models"]')!;
  expect(list.textContent).toContain("typed-model· not offered by a connected account");
  expect(list.textContent).not.toContain("gpt-6-astra·");
  expect(snapshot.policy.codex.allowedModels).toEqual([
    "gpt-6.1-sol",
    "gpt-6-astra",
    "typed-model",
  ]);
  expect(container.textContent).toContain("Saved with warnings");
  expect(container.textContent).toContain(warning);
  await pick(0, 0);
  await change("Model", "typed-model");
  expect(label(0, 0)).toBe(
    "Difficulty 0, stakes 0: typed-model / medium, not saved yet, not offered by connected accounts",
  );
  await pass(1200);
  expect(modelCell(snapshot.policy, "codex", 0, 0)).toEqual({
    model: "typed-model",
    effort: "medium",
  });
  await pick(0, 0);
  await change("Model", "gpt-6.1-sol");
  await act(async () => named("Remove typed-model").click());
  await pass(1200);
  expect(list.textContent).not.toContain("typed-model");
  expect(snapshot.policy.codex.allowedModels).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
});
it("goes back to an earlier version once changes are stored, and to the built-in table", async () => {
  await click("Claude");
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / medium");
  await open("Earlier versions");
  expect(button("Go back to version 3")).toBeUndefined();
  expect(button("Reset the Claude table to the built-in one").disabled).toBe(true);
  await pick(1, 1);
  await change("Reasoning", "max");
  // Going back now would drop the change that is still on its way.
  expect(button("Go back to version 2").disabled).toBe(true);
  await pass(1200);
  expect(snapshot.policy.version).toBe(4);
  expect(section("Earlier versions").textContent).toContain("1 cell differs from now");
  await click("Go back to version 3");
  expect(state.execute.mock.calls.at(-1)![0].input).toEqual({
    _tag: "modelRevert",
    expectedVersion: 4,
    version: 3,
  });
  expect(snapshot.policy.version).toBe(5);
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / medium");
  expect(status()).toBe("Changes save automatically");
  await click("Go back to version 4");
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / max");
  await click("Reset the Claude table to the built-in one");
  await pass();
  expect(snapshot.policy.version).toBe(7);
  expect(snapshot.policy.claudeAgent).toEqual(defaultModelRoutingPolicy.claudeAgent);
  expect(label(1, 1)).toBe("Difficulty 1, stakes 1: claude-sonnet-5-5 / medium");
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
  expect(status()).toBe("Changes save automatically");
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
      expect(status()).toBe("Loading…");
      expect(text).not.toContain("Not connected");
    } else {
      expect(status()).toBe("Not connected");
      expect(text).toContain("The table appears once this computer connects.");
      expect(text).not.toContain("Loading");
    }
  },
);
it("says when the saved table could not be read", async () => {
  await act(async () => root.unmount());
  state.execute.mockImplementation(async () => ({ _tag: "Failure" }));
  root = createRoot(container);
  await render();
  expect(alert()?.textContent).toBe("The saved table could not be read. Refresh to try again.");
  expect(container.querySelector("table")).toBeNull();
  expect(status()).toBe("Changes save automatically");
});
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
  const item = section("Recent decisions").querySelector("li")!;
  expect([...item.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    `${new Date(at).toLocaleString()} · difficulty 6 · stakes 4`,
    "SL · claude-opus-5-5 / high",
    "Table choice for difficulty 6, stakes 4.",
    "SL has the most room.",
  ]);
  expect(item.querySelector("button,details")).toBeNull();
});
it("keeps the rest behind closed sections, without draft buttons or internal wording", () => {
  expect(
    [...container.querySelectorAll("button[aria-expanded]")].map((fold) => fold.textContent),
  ).toEqual(["Other model IDs", "Try a task", "Earlier versions", "Recent decisions"]);
  for (const removed of [
    "Save changes",
    "Discard changes",
    "Reset Codex to defaults",
    "Start assignment",
    "Draft",
    "reassessments",
    // Names, values and controls only: no sentence explains a section.
    "A worker gets the model",
    "Weakest first.",
    "When no ladder rung",
    "Models the",
  ])
    expect(container.textContent).not.toContain(removed);
  expect(container.querySelector("pre")).toBeNull();
  expect(container.textContent).not.toMatch(/coordinator|policy|authority|unsaved/i);
});
