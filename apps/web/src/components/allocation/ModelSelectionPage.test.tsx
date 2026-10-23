// @vitest-environment jsdom
import { act } from "react";
import * as Cause from "effect/Cause";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  defaultModelRoutingPolicy,
  AllocationError,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationOperation,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  phase: "connected",
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/provider-allocation", () => ({
  createAllocationCommands: () => ({ execute: { label: "execute" }, start: { label: "start" } }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.phase } }),
}));
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
const render = () =>
  act(async () => {
    root.render(<ModelSelectionPage environmentId={EnvironmentId.make("host")} />);
  });
beforeEach(async () => {
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
          {
            environmentId: "host",
            instanceId: ProviderInstanceId.make("ad"),
            driver: ProviderDriverKind.make("codex"),
            label: "AD",
            accountKey: "account",
            available: true,
            unavailableReason: null,
            limitedUntil: null,
            shortWindow: "unknown",
            windows: [],
            resetCredits: null,
            profileSamples: 0,
            profileUncertainty: 1,
            models: ["gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({
              slug,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    type: "select",
                    label: "Effort",
                    options: ["medium", "high", "max", "xhigh"].map((id) => ({ id, label: id })),
                  },
                ],
              },
            })),
          },
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
            selectedProfile: 1,
            revision: 0,
            rule: "Difficulty 0–3, stakes 0–3",
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
});
async function assess() {
  await change("Difficulty score", "0");
  await change("Stakes score", "0");
  await change("Difficulty reason", "Scoped reasoning");
  await change("Stakes reason", "Reversible failure");
}
it("edits vertical stakes entries and reusable profiles, invalidates previews, then saves exact values", async () => {
  await assess();
  await click("Preview exact selection");
  expect(container.querySelector('[aria-label="Selection preview"]')).not.toBeNull();
  await change("Difficulty row", "3");
  await change("Stakes 7", "6");
  expect(container.querySelector('[aria-label="Selection preview"]')).toBeNull();
  expect(button("Save new policy version").disabled).toBe(true);
  await change("Profile 1 effort", "high");
  await click("Preview exact selection");
  await click("Save new policy version");
  expect(snapshot.policy.codex.grid[3]![2]).toBe(6);
  expect(snapshot.policy.codex.profiles[0]!.effort).toBe("high");
  expect(snapshot.policy.claudeAgent).toEqual(defaultModelRoutingPolicy.claudeAgent);
  const rowField = control("Difficulty row").closest("fieldset")!;
  expect(rowField.querySelectorAll("select")).toHaveLength(7);
  expect(rowField.querySelector("table")).toBeNull();
  expect([...rowField.querySelectorAll("select")].every((s) => s.closest("label"))).toBe(true);
});
it("keeps a stale draft after save conflict and refresh, and requires a new preview before retry", async () => {
  await assess();
  await change("Profile 1 effort", "high");
  await click("Preview exact selection");
  state.execute.mockImplementationOnce(async () => ({
    _tag: "Failure",
    cause: Cause.fail(
      new AllocationError({ code: "conflict", detail: "Another editor saved version 4." }),
    ),
  }));
  await click("Save new policy version");
  expect(control("Profile 1 effort").value).toBe("high");
  expect(container.textContent).toContain("draft is retained");
  expect(container.textContent).toContain("Another editor saved version 4.");
  snapshot = { ...snapshot, policy: { ...snapshot.policy, version: 4 } };
  await click("Refresh saved version; keep draft");
  expect(control("Profile 1 effort").value).toBe("high");
  expect(button("Save new policy version").disabled).toBe(true);
  await click("Preview exact selection");
  await click("Save new policy version");
  expect(snapshot.policy.version).toBe(5);
  expect(snapshot.policy.codex.profiles[0]!.effort).toBe("high");
});
it("invalidates on assessment and connection changes; retains the draft while disconnected", async () => {
  await assess();
  await change("Profile 1 effort", "high");
  await click("Preview exact selection");
  await change("Stakes score", "8");
  expect(container.querySelector('[aria-label="Selection preview"]')).toBeNull();
  await click("Preview exact selection");
  state.phase = "offline";
  await render();
  expect(control("Profile 1 effort").value).toBe("high");
  expect(button("Preview exact selection").disabled).toBe(true);
  state.phase = "connected";
  await render();
  expect(container.querySelector('[aria-label="Selection preview"]')).toBeNull();
  await click("Restore defaults in draft");
  expect(control("Profile 1 effort").value).toBe("medium");
});
it("refuses missing assessment and exposes excluded Luna without enabling it", async () => {
  await click("Preview exact selection");
  expect(container.textContent).toContain("Supply integer scores");
  const luna = [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.includes("gpt-6-luna"))!
    .querySelector("input")!;
  expect(luna.disabled).toBe(true);
  expect(luna.checked).toBe(false);
  await click("Claude");
  expect(control("Profile 1 model").value).toBe("claude-sonnet-5-5");
  await click("Revert version 2 as a new version");
  expect(snapshot.policy.version).toBe(4);
});
it("retries an uncertain startup with its original policy and intent after refresh", async () => {
  await assess();
  await change("Project", "project");
  await change("Assignment", "Scoped assignment");
  await click("Preview exact selection");
  state.start.mockResolvedValue({ _tag: "Failure" });
  await click("Start with selected profile");
  const first = state.start.mock.calls[0]![0];
  expect(first.input.request.policyVersion).toBe(3);
  snapshot = { ...snapshot, policy: { ...snapshot.policy, version: 4 } };
  await click("Refresh saved version; keep draft");
  expect(button("Retry identical assignment").disabled).toBe(false);
  await click("Retry identical assignment");
  expect(state.start.mock.calls[1]![0]).toEqual(first);
  await change("Assignment", "Changed intent");
  expect(button("Retry identical assignment").disabled).toBe(true);
  await click("New assignment identity");
  expect(button("Start with selected profile").disabled).toBe(true);
});
