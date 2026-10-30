// @vitest-environment jsdom
import { act, StrictMode } from "react";
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
const state = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  navigate: vi.fn(),
  phase: "connected",
  connectionListeners: new Set<() => void>(),
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
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: { label: "updateSettings" } },
}));
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
  accountWeightsSupported: true,
  accountCapsSupported: true,
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
  state.phase = "connected";
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
  const connect = (phase: string) =>
    act(async () => {
      state.phase = phase;
      state.connectionListeners.forEach((notify) => notify());
    });
  const readCalls = (tag: string) =>
    state.execute.mock.calls.filter(([arg]) => arg.input._tag === tag);
  it.each(["offline", "connected"])(
    "hydrates cold %s connection once without disconnected or duplicate StrictMode reads",
    async (phase) => {
      await act(async () => root.unmount());
      state.execute.mockClear();
      state.phase = phase;
      root = createRoot(container);
      await act(async () =>
        root.render(
          <StrictMode>
            <ProviderAllocationPage environmentId={EnvironmentId.make("host")} />
          </StrictMode>,
        ),
      );
      expect(state.execute).toHaveBeenCalledTimes(phase === "offline" ? 0 : 2);
      await connect("connected");
      expect(readCalls("connections")).toHaveLength(1);
      expect(readCalls("snapshot")).toHaveLength(1);
      expect(container.textContent).toContain("policy 4");
      await connect("connected");
      expect(state.execute).toHaveBeenCalledTimes(2);
    },
  );
  it("refreshes reconnect snapshots while retaining drafts and rejecting obsolete reads", async () => {
    await change("Codex Daily usage budget", "40");
    await change("Temporary overrides (JSON)", "[ ]");
    await change("Model", "astra");
    await act(async () => button("Preview assignment and policy").click());
    expect(button("Save settings").disabled).toBe(false);
    await connect("offline");
    let resolveOld!: (value: unknown) => void;
    const implementation = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(({ input: operation }: { input: AllocationOperation }) =>
      operation._tag === "snapshot"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : implementation({ input: operation }),
    );
    await connect("connected");
    expect(readCalls("snapshot")).toHaveLength(2);
    expect(button("Preview assignment and policy").disabled).toBe(true);
    expect(button("Save settings").disabled).toBe(true);
    await connect("offline");
    state.execute.mockImplementation(({ input: operation }: { input: AllocationOperation }) =>
      operation._tag === "snapshot"
        ? Promise.resolve({
            _tag: "Success",
            value: { snapshot: { ...snapshot, policy: { ...snapshot.policy, version: 5 } } },
          })
        : implementation({ input: operation }),
    );
    await connect("connected");
    expect(readCalls("snapshot")).toHaveLength(3);
    expect(input("Codex Daily usage budget").value).toBe("40");
    expect(input("Temporary overrides (JSON)").value).toBe("[ ]");
    expect(container.textContent).toContain("policy 5");
    await act(async () => resolveOld({ _tag: "Success", value: { snapshot } }));
    expect(container.textContent).toContain("policy 5");
    expect(button("Save settings").disabled).toBe(true);
    await act(async () => button("Preview assignment and policy").click());
    expect(button("Save settings").disabled).toBe(true);
    await act(async () => button("Reload saved settings").click());
    expect(input("Codex Daily usage budget").value).toBe("10");
    expect(button("Save settings").disabled).toBe(false);
  });
  it("shows primary numeric defaults first and saves edits, weights and resets without an assignment preview", async () => {
    let savedPolicy = snapshot.policy;
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
      if (arg.input._tag === "snapshot")
        return { _tag: "Success", value: { snapshot: { ...snapshot, policy: savedPolicy } } };
      if (arg.input._tag === "policy") {
        savedPolicy = { ...arg.input.input.policy, version: savedPolicy.version + 1 };
        return { _tag: "Success", value: { policy: savedPolicy } };
      }
      return previous(arg);
    });
    expect(input("Codex Initial weekly budget").value).toBe("30");
    expect(input("Claude Initial weekly budget").value).toBe("0");
    expect(input("Codex Daily usage budget").value).toBe("10");
    expect(input("Claude Daily usage budget").value).toBe("17");
    const budgets = container.querySelector('[aria-label="Usage budgets"]')!;
    expect(budgets.textContent).toContain("points / 24h · Default 17");
    expect(budgets.closest("details")).toBeNull();
    expect(input("Coordinator").closest("details")?.open).toBe(false);
    expect(input("Model").closest("details")?.open).toBe(false);
    await change("Claude Daily usage budget", "40");
    await change("SL preference weight", "0");
    await act(() => button("Save settings").click());
    expect(readCalls("preview")).toHaveLength(0);
    expect(savedPolicy.claude.dailyPoints).toBe(40);
    expect(savedPolicy.claude.preset).toBe("custom");
    expect(savedPolicy.accountWeights?.[0]?.weight).toBe(0);
    expect(input("Claude Daily usage budget").value).toBe("40");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Settings saved");
    await act(() => button("Reset to defaults").click());
    expect(input("Claude Daily usage budget").value).toBe("17");
    expect(input("SL preference weight").value).toBe("50");
    expect(savedPolicy.claude.dailyPoints).toBe(40);
    await act(() => button("Save settings").click());
    expect(savedPolicy.claude.dailyPoints).toBe(17);
    expect(savedPolicy.codex.burstPoints).toBe(30);
    expect(savedPolicy.mode).toBe("observation");
    await act(() => button("Reload saved settings").click());
    expect(input("Claude Daily usage budget").value).toBe("17");
    expect(state.start).not.toHaveBeenCalled();
  });
  it("keeps legacy cycle policies unchanged until an explicit edit or reset", async () => {
    const previous = state.execute.getMockImplementation()!;
    const legacy = {
      ...snapshot.policy,
      claude: { ...snapshot.policy.claude, preset: "sustainable" as const, dailyPoints: 100 / 7 },
    };
    state.execute.mockImplementation(async (arg) =>
      arg.input._tag === "snapshot"
        ? { _tag: "Success", value: { snapshot: { ...snapshot, policy: legacy } } }
        : previous(arg),
    );
    await act(() => button("Reload saved settings").click());
    expect(input("Claude Daily usage budget").value).toBe("Derived from each cycle");
    expect(input("Claude Daily usage budget").disabled).toBe(true);
    expect(readCalls("policy")).toHaveLength(0);
    await act(() => button("Use saved numeric budgets for Claude").click());
    expect(Number(input("Claude Daily usage budget").value)).toBeCloseTo(100 / 7);
    await change("Claude Daily usage budget", "22");
    await act(() => button("Save settings").click());
    const save = readCalls("policy").at(-1)![0].input.input.policy;
    expect(save.claude).toMatchObject({ preset: "custom", dailyPoints: 22 });
  });
  it("saves optional hard caps with independent worker and master stop actions", async () => {
    let savedPolicy = snapshot.policy;
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
      if (arg.input._tag === "snapshot")
        return { _tag: "Success", value: { snapshot: { ...snapshot, policy: savedPolicy } } };
      if (arg.input._tag === "policy") {
        savedPolicy = { ...arg.input.input.policy, version: savedPolicy.version + 1 };
        return { _tag: "Success", value: { policy: savedPolicy } };
      }
      return previous(arg);
    });

    expect(savedPolicy.accountCaps).toEqual([]);
    expect(input("SL weekly cap").value).toBe("");
    expect(input("Stop workers").disabled).toBe(true);
    await change("SL weekly cap", "101");
    expect(input("SL weekly cap").getAttribute("aria-invalid")).toBe("true");
    expect(button("Save settings").disabled).toBe(true);
    await change("SL weekly cap", "80");
    expect((input("Stop workers") as HTMLInputElement).checked).toBe(true);
    expect((input("Stop masters") as HTMLInputElement).checked).toBe(false);
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps).toHaveLength(1);
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      weeklyPercent: 80,
      fiveHourPercent: null,
      stopWorkers: true,
      stopMasters: false,
    });

    await act(() => input("Stop workers").click());
    expect(button("Save settings").disabled).toBe(false);
    expect(container.textContent).toContain("saved but inactive");
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      stopWorkers: false,
      stopMasters: false,
    });
    await act(() => input("Stop masters").click());
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      stopWorkers: false,
      stopMasters: true,
    });
  });
  it("shows the Claude 5-hour cap only for Claude and reports missing telemetry", async () => {
    const previous = state.execute.getMockImplementation()!;
    const host = snapshot.inventories[0]!;
    state.execute.mockImplementation(async (arg) => {
      if (arg.input._tag !== "snapshot") return previous(arg);
      return {
        _tag: "Success",
        value: {
          snapshot: {
            ...snapshot,
            inventories: [
              {
                ...host,
                accounts: host.accounts.map((account) => ({
                  ...account,
                  driver: ProviderDriverKind.make("claudeAgent"),
                  windows: [
                    {
                      id: "seven_day",
                      label: "Weekly",
                      kind: "weekly" as const,
                      usedPoints: 42,
                      checkedAt: host.observedAt,
                      resetsAt: "2099-10-30T12:00:00.000Z",
                      cycleStartedAt: "2026-10-23T12:00:00.000Z",
                      durationHours: 168,
                      ratePointsPerHour: null,
                      samples: 0,
                      rateAgeMinutes: null,
                    },
                  ],
                })),
              },
            ],
          },
        },
      };
    });
    await act(() => button("Refresh").click());
    expect(container.textContent).toContain("Claude 5-hour cap");
    expect(container.textContent).toContain("Provider did not report this window.");
    expect(container.textContent).toContain("Last read");
    expect(input("SL Claude 5-hour cap").value).toBe("");
  });
  it("does not offer subscription caps for an API-key account with cached windows", async () => {
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg) => {
      if (arg.input._tag !== "snapshot") return previous(arg);
      const host = snapshot.inventories[0]!;
      return {
        _tag: "Success",
        value: {
          snapshot: {
            ...snapshot,
            inventories: [
              {
                ...host,
                accounts: host.accounts.map((account, index) =>
                  index === 0
                    ? {
                        ...account,
                        available: false,
                        usageLimitsUnavailableReason: "unsupported" as const,
                      }
                    : account,
                ),
              },
            ],
          },
        },
      };
    });
    await act(() => button("Refresh").click());
    expect(container.querySelector('[aria-label="SL weekly cap"]')).toBeNull();
    expect(container.textContent).toContain("Subscription quota is unsupported for this account.");
  });
  it("does not offer subscription caps until quota provenance is verified", async () => {
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg) => {
      if (arg.input._tag !== "snapshot") return previous(arg);
      const host = snapshot.inventories[0]!;
      return {
        _tag: "Success",
        value: {
          snapshot: {
            ...snapshot,
            inventories: [
              {
                ...host,
                accounts: host.accounts.map((account, index) =>
                  index === 0
                    ? { ...account, usageLimitsUnavailableReason: "unverified" as const }
                    : account,
                ),
              },
            ],
          },
        },
      };
    });
    await act(() => button("Refresh").click());
    expect(container.querySelector('[aria-label="SL weekly cap"]')).toBeNull();
    expect(container.textContent).toContain(
      "The subscription quota source is not verified right now.",
    );
  });
  it("keeps cap controls available through a transient probe failure", async () => {
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg) => {
      if (arg.input._tag !== "snapshot") return previous(arg);
      const host = snapshot.inventories[0]!;
      return {
        _tag: "Success",
        value: {
          snapshot: {
            ...snapshot,
            inventories: [
              {
                ...host,
                accounts: host.accounts.map((account, index) =>
                  index === 0
                    ? {
                        ...account,
                        available: false,
                        windows: [],
                        usageLimitsUnavailableReason: "probeFailed" as const,
                      }
                    : account,
                ),
              },
            ],
          },
        },
      };
    });
    await act(() => button("Refresh").click());
    const weekly = input("SL weekly cap") as HTMLInputElement;
    expect(weekly).not.toBeNull();
    expect(weekly.disabled).toBe(false);
    expect(container.textContent).toContain(
      "An existing reached cap stays enforced until reset or a configuration change",
    );
  });
  it("rejects empty or out-of-range numbers and retains offline last-known drafts", async () => {
    await change("Codex Daily usage budget", "");
    expect(button("Save settings").disabled).toBe(true);
    expect(input("Codex Daily usage budget").getAttribute("aria-invalid")).toBe("true");
    await change("Codex Daily usage budget", "101");
    expect(button("Save settings").disabled).toBe(true);
    await change("Codex Daily usage budget", "12");
    await connect("offline");
    expect(input("Codex Daily usage budget").disabled).toBe(true);
    expect(input("Codex Daily usage budget").value).toBe("12");
    expect(button("Save settings").disabled).toBe(true);
    expect(container.textContent).toContain("last-known settings are read-only");
    await connect("connected");
    expect(input("Codex Daily usage budget").value).toBe("12");
    expect(button("Save settings").disabled).toBe(false);
  });
  it("chooses a named linked coordinator without exposing IDs and preserves edits when connection fails", async () => {
    const coordinator = input("Coordinator") as HTMLSelectElement;
    expect([...coordinator.options].map((o) => o.textContent)).toEqual([
      "Workstation (this environment)",
      "Build computer",
    ]);
    expect(container.textContent).toContain("Workstation");
    expect(container.querySelector("h4")?.textContent).toContain("SL · Codex");
    const identity = [...container.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("Account identity: identity"),
    );
    expect(identity?.closest("details")?.open).toBe(false);
    await change("Codex Target reserve", "12");
    await change("Coordinator", "peer");
    await act(() => button("Connect coordinator").click());
    expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "host",
      input: { _tag: "connect", coordinatorEnvironmentId: "peer" },
    });
    expect(input("Coordinator").value).toBe("peer");
    expect(input("Codex Target reserve").value).toBe("12");
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
  it("saves against the draft version and preserves edits on a stale save", async () => {
    expect(button("Save settings").disabled).toBe(false);
    await change("Model", "astra");
    await act(() => button("Preview assignment and policy").click());
    expect(button("Save settings").disabled).toBe(false);
    await change("Codex Target reserve", "12");
    expect(button("Save settings").disabled).toBe(false);
    await act(() => button("Preview assignment and policy").click());
    await act(() => button("Save settings").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("newer policy");
    expect(input("Codex Target reserve").value).toBe("12");
    const save = state.execute.mock.calls.find(([call]) => call.input._tag === "policy")![0];
    expect(save.input.input.expectedVersion).toBe(4);
    expect(save.input.input.policy.codex.reservePoints).toBe(12);
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

it("shows compatible choices and advisory warnings while allowing the chosen exact profile to start", async () => {
  const previous = state.execute.getMockImplementation()!;
  const warning = "Weekly: Projected consumption exceeds the target plus bounded borrowing.";
  state.execute.mockImplementation(async (arg) => {
    const result = await previous(arg);
    if (arg.input._tag !== "preview") return result;
    const d = decision(arg.input.request);
    return {
      _tag: "Success",
      value: {
        result: {
          mode: "observation",
          reservation: null,
          decision: {
            ...d,
            reasons: [warning],
            candidates: [
              {
                environmentId: "host",
                instanceId: "sl",
                accountKey: "identity",
                eligible: true,
                reasons: [],
                warnings: [warning],
                behindPoints: 0,
                resetInHours: null,
                confidence: "low",
                windows: [],
              },
            ],
          },
        },
      },
    };
  });
  await change("Model", "astra");
  await change("Effort", "high");
  await change("Explicit account", "sl");
  await act(() => button("Preview assignment and policy").click());
  expect(container.textContent).toContain("1 compatible / 0 outside constraints");
  expect(container.textContent).toContain(`Warnings: ${warning}`);
  expect(container.textContent).toContain("never prevent an explicit Start");
  expect(container.textContent).not.toContain("Automatic mode starts");
  await change("Project", "project");
  await change("Task", "Perform the chosen task");
  state.start.mockImplementation(async ({ input: startInput }) => ({
    _tag: "Success",
    value: {
      state: "submitted",
      threadId: startInput.request.threadId,
      allocation: {
        decision: decision(startInput.request),
        mode: "observation",
        reservation: null,
      },
    },
  }));
  expect(button("Request allocation and start").disabled).toBe(false);
  await act(() => button("Request allocation and start").click());
  expect(state.start.mock.calls[0]![0].input.request).toMatchObject({
    explicitInstanceId: "sl",
    environmentId: "host",
    model: "astra",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  expect(state.navigate).toHaveBeenCalledTimes(1);
});

it("labels unknown model quota rates honestly and displays measured account burn separately", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-23T12:00:00.000Z"));
  const previous = state.execute.getMockImplementation()!;
  const host = snapshot.inventories[0]!;
  const account = host.accounts[0]!;
  state.execute.mockImplementation(async (arg) =>
    arg.input._tag === "snapshot"
      ? {
          _tag: "Success",
          value: {
            snapshot: {
              ...snapshot,
              inventories: [
                {
                  ...host,
                  accounts: [
                    {
                      ...account,
                      windows: [
                        {
                          id: "week",
                          label: "Weekly",
                          kind: "weekly",
                          usedPoints: 33,
                          checkedAt: host.observedAt,
                          resetsAt: "2026-10-29T12:00:00.000Z",
                          cycleStartedAt: "2026-10-22T12:00:00.000Z",
                          durationHours: 168,
                          ratePointsPerHour: 2.5,
                          samples: 8,
                          rateAgeMinutes: 2,
                        },
                      ],
                      usageProfiles: [
                        {
                          model: "astra",
                          effort: "high",
                          contextBand: "under32k",
                          samples: 6,
                          observedAt: host.observedAt,
                          outputTokensPerHour: 1000,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        }
      : previous(arg),
  );
  await act(() => button("Refresh").click());
  const analytics = container.querySelector('[aria-label="Usage analytics"]')!;
  expect(analytics.textContent).toContain("Measured burn: 2.5 allowance points / hour");
  expect(analytics.textContent).toContain("8 samples");
  expect(analytics.textContent).toContain("Medium confidence");
  expect(analytics.textContent).toContain("Allowance points/hour: Not enough data");
  expect(analytics.textContent).toContain("6 token samples");
  expect(analytics.textContent).toContain("1000 tokens / turn-hour");
  clock.mockRestore();
});

it("keeps account weights read-only when the coordinator cannot persist them", async () => {
  const previous = state.execute.getMockImplementation()!;
  state.execute.mockImplementation(async (arg) =>
    arg.input._tag === "snapshot"
      ? {
          _tag: "Success",
          value: { snapshot: { ...snapshot, accountWeightsSupported: undefined } },
        }
      : previous(arg),
  );
  await act(() => button("Refresh").click());
  expect(input("SL preference weight").disabled).toBe(true);
  expect(input("Claude Daily usage budget").disabled).toBe(false);
  expect(container.textContent).toContain(
    "Update the coordinator to edit account preference weights",
  );
});

it("keeps hard caps read-only when the coordinator cannot persist them", async () => {
  const previous = state.execute.getMockImplementation()!;
  state.execute.mockImplementation(async (arg) =>
    arg.input._tag === "snapshot"
      ? {
          _tag: "Success",
          value: { snapshot: { ...snapshot, accountCapsSupported: undefined } },
        }
      : previous(arg),
  );
  await act(() => button("Refresh").click());
  expect(input("SL weekly cap").disabled).toBe(true);
  expect(container.textContent).toContain("Update the coordinator to edit hard caps.");
});
