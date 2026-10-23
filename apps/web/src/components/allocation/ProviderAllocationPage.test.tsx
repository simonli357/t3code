// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type AllocationSnapshot,
  type AllocationOperation,
  type AllocationRequest,
} from "@t3tools/contracts";
const state = vi.hoisted(() => ({ execute: vi.fn(), start: vi.fn(), navigate: vi.fn() }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/provider-allocation", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/provider-allocation")>()),
  createAllocationCommands: () => ({ execute: { label: "execute" }, start: { label: "start" } }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "project", title: "Project", environmentId: "host" }],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { ProviderAllocationPage } from "./ProviderAllocationPage";

const snapshot: AllocationSnapshot = {
  policy: { ...defaultAllocationPolicy, version: 4, coordinatorEnvironmentId: "host" },
  authorityAvailable: true,
  reservations: [],
  history: [],
  notices: [],
  inventories: [
    {
      environmentId: "host",
      coordinatorEnvironmentId: "host",
      observedAt: "2026-10-23T12:00:00.000Z",
      complete: true,
      notices: [],
      demand: [],
      accounts: [
        {
          environmentId: "host",
          instanceId: ProviderInstanceId.make("sl"),
          driver: ProviderDriverKind.make("codex"),
          label: "SL",
          accountKey: "identity",
          available: true,
          unavailableReason: null,
          limitedUntil: null,
          shortWindow: "reported",
          windows: [],
          resetCredits: null,
          profileSamples: 0,
          profileUncertainty: 1,
          models: [
            {
              slug: "astra",
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};
const decision = (request: AllocationRequest) => ({
  at: "2026-10-23T12:00:00.000Z",
  policyVersion: 4,
  request,
  outcome: "selected",
  selectedInstanceId: "sl",
  candidates: [],
  reasons: ["Safe headroom"],
  confidence: "low",
  waitUntil: null,
});
let container: HTMLDivElement;
let root: Root;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
const input = (text: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(text))!
    .querySelector("select,input,textarea") as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
async function change(label: string, value: string) {
  const control = input(label);
  await act(() => {
    const proto =
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.execute.mockReset();
  state.start.mockReset();
  state.navigate.mockReset();
  state.execute.mockImplementation(async ({ input }: { input: AllocationOperation }) => {
    if (input._tag === "snapshot") return { _tag: "Success", value: { snapshot } };
    if (input._tag === "connections")
      return {
        _tag: "Success",
        value: {
          connections: {
            coordinatorEnvironmentId: "host",
            environments: [
              { environmentId: "host", label: "Workstation" },
              { environmentId: "peer", label: "Build computer" },
            ],
          },
        },
      };
    if (input._tag === "preview")
      return {
        _tag: "Success",
        value: {
          result: { decision: decision(input.request), reservation: null, mode: "observation" },
        },
      };
    return { _tag: "Failure" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(<ProviderAllocationPage environmentId={EnvironmentId.make("host")} />),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("Provider allocation editor", () => {
  it("chooses a named linked coordinator without exposing IDs and preserves edits when connection fails", async () => {
    const coordinator = input("Coordinator") as HTMLSelectElement;
    expect([...coordinator.options].map((o) => o.textContent)).toEqual([
      "Workstation (this environment)",
      "Build computer",
    ]);
    expect(container.querySelector("h3")?.textContent).toContain("Workstation");
    expect(container.querySelector("h4")?.textContent).toContain("SL · Codex");
    const identity = [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("Account identity: identity"),
    );
    expect(identity?.closest("details")?.open).toBe(false);
    await change("Reserve points", "12");
    await change("Coordinator", "peer");
    await act(() => button("Connect coordinator").click());
    expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "host",
      input: { _tag: "connect", coordinatorEnvironmentId: "peer" },
    });
    expect(input("Coordinator").value).toBe("peer");
    expect(input("Reserve points").value).toBe("12");
  });
  it("retains a disconnected saved coordinator and resets the assignment when settings scope changes", async () => {
    state.execute.mockImplementation(
      async ({ input: operation }: { input: AllocationOperation }) => {
        if (operation._tag === "connections")
          return {
            _tag: "Success",
            value: {
              connections: {
                coordinatorEnvironmentId: "unlinked",
                environments: [{ environmentId: "other", label: "Laptop" }],
              },
            },
          };
        if (operation._tag === "snapshot")
          return {
            _tag: "Success",
            value: {
              snapshot: {
                ...snapshot,
                inventories: snapshot.inventories.map((i) => ({
                  ...i,
                  environmentId: "other",
                  accounts: i.accounts.map((a) => ({
                    ...a,
                    environmentId: "other",
                    driver: ProviderDriverKind.make("claudeAgent"),
                  })),
                })),
              },
            },
          };
        return { _tag: "Failure" };
      },
    );
    await change("Model", "astra");
    await change("Effort", "high");
    await act(() =>
      root.render(<ProviderAllocationPage environmentId={EnvironmentId.make("other")} />),
    );
    expect(input("Coordinator").value).toBe("unlinked");
    expect((input("Coordinator") as HTMLSelectElement).selectedOptions[0]?.textContent).toContain(
      "not linked",
    );
    expect(input("Model").value).toBe("");
    expect(container.querySelector("h4")?.textContent).toContain("Claude");
    await act(() => button("Refresh").click());
    expect(input("Coordinator").value).toBe("unlinked");
    expect(state.execute.mock.calls.at(-1)?.[0].environmentId).toBe("other");
  });
  it("requires a preview of the exact edited policy and preserves edits on a stale save", async () => {
    expect(button("Save previewed policy").disabled).toBe(true);
    await change("Model", "astra");
    await act(() => button("Preview assignment and policy").click());
    expect(button("Save previewed policy").disabled).toBe(false);
    await change("Reserve points", "12");
    expect(button("Save previewed policy").disabled).toBe(true);
    await act(() => button("Preview assignment and policy").click());
    await act(() => button("Save previewed policy").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("newer policy");
    expect(input("Reserve points").value).toBe("12");
    const save = state.execute.mock.calls.find(([call]) => call.input._tag === "policy")![0];
    expect(save.input.input.expectedVersion).toBe(4);
    expect(save.input.input.policy.claude.reservePoints).toBe(12);
  });
  it("submits the exact model and effort and keeps observation from navigating to a fabricated session", async () => {
    await change("Model", "astra");
    await change("Effort", "high");
    await change("Project", "project");
    await change("Task", "Do this task");
    state.start.mockImplementation(async ({ input: startInput }) => ({
      _tag: "Success",
      value: {
        state: "observation",
        threadId: startInput.request.threadId,
        allocation: {
          decision: decision(startInput.request),
          reservation: null,
          mode: "observation",
        },
      },
    }));
    await act(() => button("Request allocation and start").click());
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start.mock.calls[0]![0].input.request).toMatchObject({
      environmentId: "host",
      model: "astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "No session was started",
    );
    expect(state.navigate).not.toHaveBeenCalled();
  });
});
