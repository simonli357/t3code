// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
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
  accountCapsSupported: true,
  accountOrderSupported: true,
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
  reasons: ["SL has the most room"],
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
const named = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
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
/** The snapshot with a second login, one managed worker on SL and one human session. */
const two: AllocationSnapshot = {
  ...snapshot,
  inventories: snapshot.inventories.map((host) => ({
    ...host,
    accounts: [
      ...host.accounts,
      {
        ...host.accounts[0]!,
        instanceId: ProviderInstanceId.make("ad"),
        label: "AD",
        accountKey: "ad",
      },
    ],
    demand: [true, false].map((worker) => ({
      environmentId: "host",
      threadId: ThreadId.make(`thread-${worker}`),
      instanceId: ProviderInstanceId.make("sl"),
      accountKey: "identity",
      model: "astra",
      options: [],
      state: "running" as const,
      worker,
    })),
  })),
};
/** Saves succeed and later reads return what was saved. */
function savePolicies(base = snapshot) {
  const saved = { policy: base.policy };
  const previous = state.execute.getMockImplementation()!;
  state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
    if (arg.input._tag === "snapshot")
      return { _tag: "Success", value: { snapshot: { ...base, policy: saved.policy } } };
    if (arg.input._tag === "policy") {
      saved.policy = { ...arg.input.input.policy, version: saved.policy.version + 1 };
      return { _tag: "Success", value: { policy: saved.policy } };
    }
    return previous(arg);
  });
  return saved;
}
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
    await change("Closeness margin", "40");
    await change("Model", "astra");
    await act(async () => button("Preview account").click());
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
    expect(button("Preview account").disabled).toBe(true);
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
    expect(input("Closeness margin").value).toBe("40");
    expect(container.textContent).toContain("policy 5");
    await act(async () => resolveOld({ _tag: "Success", value: { snapshot } }));
    expect(container.textContent).toContain("policy 5");
    expect(button("Save settings").disabled).toBe(true);
    await act(async () => button("Preview account").click());
    expect(button("Save settings").disabled).toBe(true);
    await act(async () => button("Reload saved settings").click());
    expect(input("Closeness margin").value).toBe("10");
    expect(button("Save settings").disabled).toBe(false);
  });
  it("saves the closeness margin and long wait, and resets them, without an assignment preview", async () => {
    const saved = savePolicies();
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Accounts");
    expect(input("Coordinator").closest("details")?.open).toBe(false);
    expect(input("Closeness margin").value).toBe("10");
    expect(input("Long wait").value).toBe("3");
    await change("Closeness margin", "20");
    await change("Long wait", "5.5");
    await act(() => button("Save settings").click());
    expect(readCalls("preview")).toHaveLength(0);
    expect(saved.policy).toMatchObject({ version: 5, closeMarginPoints: 20, longWaitHours: 5.5 });
    expect(input("Closeness margin").value).toBe("20");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Settings saved");
    await act(() => button("Reset to defaults").click());
    expect(input("Closeness margin").value).toBe("10");
    expect(saved.policy.closeMarginPoints).toBe(20);
    await act(() => button("Save settings").click());
    expect(saved.policy).toMatchObject({ closeMarginPoints: 10, longWaitHours: 3 });
    expect(saved.policy.mode).toBe("observation");
    expect(state.start).not.toHaveBeenCalled();
  });
  it("moves an account up the preference order, saves it, and shows workers now", async () => {
    const saved = savePolicies(two);
    await act(() => button("Reload saved settings").click());
    const order = () =>
      [...container.querySelectorAll('[aria-label="Preference order"] li')].map((item) =>
        item.textContent?.replace(/^\d+\. /, ""),
      );
    expect(order()).toEqual(["ADCodex", "SLCodex"]);
    expect(named("Move AD up").hasAttribute("disabled")).toBe(true);
    await act(() => named("Move SL up").click());
    expect(order()).toEqual(["SLCodex", "ADCodex"]);
    await act(() => button("Save settings").click());
    const key = (login: string) => JSON.stringify(["codex", ["account", login]]);
    expect(saved.policy.accountOrder).toEqual([key("identity"), key("ad")]);
    expect(order()).toEqual(["SLCodex", "ADCodex"]);
    const rows = [...container.querySelectorAll('[aria-label="Accounts"] tbody tr')];
    expect(rows.map((row) => row.textContent?.match(/\d+ now/)?.[0])).toEqual(["0 now", "1 now"]);
  });
  it("says the coordinator must be updated before the order can be saved", async () => {
    const previous = state.execute.getMockImplementation()!;
    state.execute.mockImplementation(async (arg) =>
      arg.input._tag === "snapshot"
        ? {
            _tag: "Success",
            value: { snapshot: { ...two, accountOrderSupported: undefined } },
          }
        : previous(arg),
    );
    await act(() => button("Refresh").click());
    expect(container.textContent).toContain("Update the coordinator before the order");
    expect(named("Move SL up").hasAttribute("disabled")).toBe(true);
    expect(input("Closeness margin").disabled).toBe(true);
    expect(input("SL weekly cap").disabled).toBe(false);
  });
  it("turns workers off for an account on the computer that has it", async () => {
    const previous = state.execute.getMockImplementation()!;
    const patches: unknown[] = [];
    state.execute.mockImplementation(async (arg) => {
      if (!("patch" in arg.input)) return previous(arg);
      patches.push(arg);
      return { _tag: "Success", value: {} };
    });
    expect(named("SL workers allowed").getAttribute("aria-checked")).toBe("true");
    await act(async () => named("SL workers allowed").click());
    expect(patches).toEqual([
      { environmentId: "host", input: { patch: { workerDisabledInstanceIds: ["sl"] } } },
    ]);
    expect(readCalls("snapshot")).toHaveLength(2);
    expect(readCalls("policy")).toHaveLength(0);
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
    expect(named("SL cap stops workers")).toBeNull();
    await change("SL weekly cap", "101");
    expect(input("SL weekly cap").getAttribute("aria-invalid")).toBe("true");
    expect(button("Save settings").disabled).toBe(true);
    await change("SL weekly cap", "80");
    expect(named("SL cap stops workers").getAttribute("aria-checked")).toBe("true");
    expect(named("SL cap stops masters").getAttribute("aria-checked")).toBe("false");
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps).toHaveLength(1);
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      weeklyPercent: 80,
      fiveHourPercent: null,
      stopWorkers: true,
      stopMasters: false,
    });

    await act(() => named("SL cap stops workers").click());
    expect(button("Save settings").disabled).toBe(false);
    expect(container.textContent).toContain("stops nothing: inactive");
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      stopWorkers: false,
      stopMasters: false,
    });
    await act(() => named("SL cap stops masters").click());
    await act(() => button("Save settings").click());
    expect(savedPolicy.accountCaps?.[0]).toMatchObject({
      stopWorkers: false,
      stopMasters: true,
    });
  });
  it("offers the 5-hour cap only for Claude and shows each window's usage, reset and reading age", async () => {
    expect(container.querySelector('[aria-label="Accounts"]')?.textContent).not.toContain("5h");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-23T12:04:00.000Z"));
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
    const accounts = container.querySelector('[aria-label="Accounts"]')!;
    expect(accounts.textContent).toContain("Weekly 42%");
    expect(accounts.textContent).toContain("resets ");
    expect(accounts.textContent).toContain("read 4 min ago");
    expect(input("SL 5-hour cap").value).toBe("");
    clock.mockRestore();
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
    const other = [...container.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.startsWith("Other accounts (1)"),
    )!;
    expect(other.open).toBe(false);
    expect(other.textContent).toContain("No subscription quota");
    expect(other.textContent).not.toContain("SL weekly cap");
    expect(named("SL workers allowed").closest("details")).toBe(other);
  });
  it("lists a quota-less account with the rest once a cap is saved for it, unless its provider is off", async () => {
    const previous = state.execute.getMockImplementation()!;
    const host = snapshot.inventories[0]!;
    const account = {
      ...host.accounts[0]!,
      usageLimitsUnavailableReason: "unsupported" as const,
    };
    const key = JSON.stringify(["codex", ["account", "identity"]]);
    const read = (enabled: boolean) =>
      state.execute.mockImplementation(async (arg) =>
        arg.input._tag === "snapshot"
          ? {
              _tag: "Success",
              value: {
                snapshot: {
                  ...snapshot,
                  policy: {
                    ...snapshot.policy,
                    accountCaps: [
                      {
                        key,
                        weeklyPercent: 80,
                        fiveHourPercent: null,
                        stopWorkers: true,
                        stopMasters: false,
                      },
                    ],
                  },
                  inventories: [{ ...host, accounts: [{ ...account, enabled }] }],
                },
              },
            }
          : previous(arg),
      );
    read(true);
    await act(() => button("Reload saved settings").click());
    expect(named("SL workers allowed").closest("details")).toBeNull();
    read(false);
    await act(() => button("Reload saved settings").click());
    expect(named("SL workers allowed").closest("details")?.textContent).toContain(
      "Other accounts (1)",
    );
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
    const accounts = container.querySelector('[aria-label="Accounts"]')!;
    expect(accounts.textContent).not.toContain("SL weekly cap");
    expect(accounts.textContent).toContain("Quota unverified");
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
    expect(container.textContent).toContain("Quota read failed");
  });
  it("rejects empty or out-of-range numbers and retains offline last-known drafts", async () => {
    await change("Closeness margin", "");
    expect(button("Save settings").disabled).toBe(true);
    expect(input("Closeness margin").getAttribute("aria-invalid")).toBe("true");
    await change("Closeness margin", "51");
    expect(button("Save settings").disabled).toBe(true);
    await change("Closeness margin", "12");
    await connect("offline");
    expect(input("Closeness margin").disabled).toBe(true);
    expect(input("Closeness margin").value).toBe("12");
    expect(button("Save settings").disabled).toBe(true);
    expect(container.textContent).toContain("last-known settings are read-only");
    await connect("connected");
    expect(input("Closeness margin").value).toBe("12");
    expect(button("Save settings").disabled).toBe(false);
  });
  it("chooses a named linked coordinator without exposing IDs and preserves edits when connection fails", async () => {
    const coordinator = input("Coordinator") as HTMLSelectElement;
    expect([...coordinator.options].map((o) => o.textContent)).toEqual([
      "Workstation (this environment)",
      "Build computer",
    ]);
    expect(container.textContent).toContain("Workstation");
    await change("Closeness margin", "12");
    await change("Coordinator", "peer");
    await act(() => button("Connect coordinator").click());
    expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "host",
      input: { _tag: "connect", coordinatorEnvironmentId: "peer" },
    });
    expect(input("Coordinator").value).toBe("peer");
    expect(input("Closeness margin").value).toBe("12");
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
    expect(container.querySelector('[aria-label="Accounts"]')?.textContent).toContain("Claude");
    await act(() => button("Refresh").click());
    expect(input("Coordinator").value).toBe("unlinked");
    expect(state.execute.mock.calls.at(-1)?.[0].environmentId).toBe("other");
  });
  it("saves against the draft version and preserves edits on a stale save", async () => {
    expect(button("Save settings").disabled).toBe(false);
    await change("Model", "astra");
    await act(() => button("Preview account").click());
    expect(button("Save settings").disabled).toBe(false);
    await change("Closeness margin", "12");
    expect(button("Save settings").disabled).toBe(false);
    await act(() => button("Preview account").click());
    await act(() => button("Save settings").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("newer policy");
    expect(input("Closeness margin").value).toBe("12");
    const save = state.execute.mock.calls.find(([call]) => call.input._tag === "policy")![0];
    expect(save.input.input.expectedVersion).toBe(4);
    expect(save.input.input.policy.closeMarginPoints).toBe(12);
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

it("shows the choice, its reason and one line per account, and starts the chosen profile", async () => {
  const previous = state.execute.getMockImplementation()!;
  const line = "SL: 58 points left, resets in 30 h, 0 workers";
  state.execute.mockImplementation(async (arg) => {
    const result = await previous(arg);
    if (arg.input._tag !== "preview") return result;
    return {
      _tag: "Success",
      value: {
        result: {
          mode: "observation",
          reservation: null,
          decision: {
            ...decision(arg.input.request),
            candidates: [
              {
                environmentId: "host",
                instanceId: "sl",
                accountKey: "identity",
                label: "SL",
                eligible: true,
                reasons: [],
                roomPoints: 58,
                resetInHours: 30,
                workers: 0,
                line,
                behindPoints: 0,
                confidence: "medium",
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
  await act(() => button("Preview account").click());
  expect(container.textContent).toContain("SL has the most room");
  expect(container.textContent).toContain(line);
  expect(container.textContent).not.toContain("confidence");
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
