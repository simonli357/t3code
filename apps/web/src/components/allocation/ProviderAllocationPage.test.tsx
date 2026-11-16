// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  AllocationError,
  defaultAllocationPolicy,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type AllocationSnapshot,
  type AllocationOperation,
} from "@t3tools/contracts";
const state = vi.hoisted(() => ({
  execute: vi.fn(),
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
  createAllocationCommands: () => ({ execute: { label: "execute" } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.execute }));
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
const field = (label: string) => named(label) as HTMLInputElement;
const section = (label: string) => container.querySelector(`section[aria-label="${label}"]`)!;
const open = (title: string) => act(() => button(title).click());
/** Lets `ms` pass, and the save that follows settle. */
const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
const leave = (label: string) =>
  act(() => void named(label).dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const saves = () =>
  state.execute.mock.calls
    .filter(([arg]) => arg.input._tag === "policy")
    .map(([arg]) => arg.input.input);
const refused = (code: "conflict" | "unavailable", detail: string) => ({
  _tag: "Failure",
  cause: Cause.fail(new AllocationError({ code, detail })),
});
async function change(label: string, value: string) {
  const control =
    container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`) ?? input(label);
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
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-23T12:04:00.000Z");
  state.phase = "connected";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.execute.mockReset();
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
  vi.useRealTimers();
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
/** Saves succeed unless a newer version is stored; later reads return what is stored. */
function savePolicies(base = snapshot) {
  const saved = { policy: base.policy };
  const previous = state.execute.getMockImplementation()!;
  state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
    if (arg.input._tag === "snapshot")
      return { _tag: "Success", value: { snapshot: { ...base, policy: saved.policy } } };
    if (arg.input._tag === "policy") {
      if (arg.input.input.expectedVersion !== saved.policy.version)
        return refused("conflict", "Allocation policy changed.");
      saved.policy = { ...arg.input.input.policy, version: saved.policy.version + 1 };
      return { _tag: "Success", value: { policy: saved.policy } };
    }
    return previous(arg);
  });
  return saved;
}
/** Reads answer with this snapshot from now on, and the page reads again. */
async function read(next: AllocationSnapshot) {
  const previous = state.execute.getMockImplementation()!;
  state.execute.mockImplementation(async (arg: { input: AllocationOperation }) =>
    arg.input._tag === "snapshot" ? { _tag: "Success", value: { snapshot: next } } : previous(arg),
  );
  await act(() => button("Refresh").click());
}
const host = snapshot.inventories[0]!;
/** The snapshot with its one account changed. */
const withAccount = (
  patch: Partial<(typeof host.accounts)[number]>,
  base = snapshot,
): AllocationSnapshot => ({
  ...base,
  inventories: [{ ...host, accounts: host.accounts.map((account) => ({ ...account, ...patch })) }],
});
const status = () => section("Accounts").querySelector('[role="status"]')?.textContent;
const alert = () => container.querySelector('[role="alert"]');

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
      expect(state.execute).toHaveBeenCalledTimes(phase === "offline" ? 0 : 3);
      await connect("connected");
      expect(readCalls("connections")).toHaveLength(1);
      expect(readCalls("snapshot").map(([arg]) => arg.input.part)).toEqual([
        "settings",
        "accounts",
      ]);
      expect(field("Close-call margin").value).toBe("10");
      await connect("connected");
      expect(state.execute).toHaveBeenCalledTimes(3);
    },
  );
  it("stores a typed number once the typing pauses, with no Save button", async () => {
    const saved = savePolicies();
    expect(button("Save settings")).toBeUndefined();
    expect(status()).toBe("Changes save automatically");
    await change("Close-call margin", "2");
    await change("Close-call margin", "20");
    expect(status()).toBe("Not saved yet");
    await pass(999);
    expect(saves()).toEqual([]);
    await pass(1);
    expect(saves()).toHaveLength(1);
    expect(saves()[0]).toMatchObject({ expectedVersion: 4, policy: { closeMarginPoints: 20 } });
    expect(saved.policy).toMatchObject({ version: 5, closeMarginPoints: 20, mode: "observation" });
    expect(status()).toBe("Saved");
    expect(field("Close-call margin").value).toBe("20");
  });
  it("stores a waiting number at once when its field is left", async () => {
    const saved = savePolicies();
    await change("Wait for a reset", "5.5");
    await leave("Wait for a reset");
    await pass();
    expect(saved.policy.longWaitHours).toBe(5.5);
  });
  it("stores the five numbers behind the choice of computer, and never one out of range", async () => {
    const saved = savePolicies();
    const values = {
      "Worker memory": ["workerMemoryGiB", "4.5"],
      "Start settle time": ["startSettleMinutes", "20"],
      "Session reserve": ["sessionReserveGiB", "0.5"],
      "Minimum free memory": ["minFreeMemoryGiB", "6"],
      "Memory kill hold": ["memoryKillHoldMinutes", "90"],
    } as const;
    expect(
      [...section("Computer for a new worker").querySelectorAll("h3")].map((h) => h.textContent),
    ).toEqual(Object.keys(values));
    for (const [name, [, value]] of Object.entries(values)) await change(name, value);
    await pass(1000);
    expect(saves()).toHaveLength(1);
    expect(saved.policy).toMatchObject({
      version: 5,
      workerMemoryGiB: 4.5,
      startSettleMinutes: 20,
      sessionReserveGiB: 0.5,
      minFreeMemoryGiB: 6,
      memoryKillHoldMinutes: 90,
    });
    await change("Session reserve", "17");
    await pass(1000);
    expect(alert()?.textContent).toContain("Session reserve must be a number from 0 to 16.");
    expect(section("Computer for a new worker").textContent).toContain("Not saved");
    expect(saved.policy).toMatchObject({ version: 5, sessionReserveGiB: 0.5 });
  });
  it("stores a move in the order at once and lists the accounts in that order", async () => {
    const saved = savePolicies(two);
    await act(() => button("Refresh").click());
    const order = () =>
      [...section("Accounts").querySelectorAll('[aria-label$=" workers allowed"]')].map((item) =>
        item.getAttribute("aria-label")?.replace(" workers allowed", ""),
      );
    expect(order()).toEqual(["AD", "SL"]);
    expect(named("Move AD up").hasAttribute("disabled")).toBe(true);
    await act(() => named("Move SL up").click());
    expect(order()).toEqual(["SL", "AD"]);
    await pass();
    const key = (login: string) => JSON.stringify(["codex", ["account", login]]);
    expect(saved.policy.accountOrder).toEqual([key("identity"), key("ad")]);
    expect(order()).toEqual(["SL", "AD"]);
    expect(
      [...section("Accounts").querySelectorAll("li")].map(
        (row) => row.textContent?.match(/\d+ running/)?.[0],
      ),
    ).toEqual(["1 running", "0 running"]);
  });
  it("stores a daily goal after a pause and an account's Fable mode at once", async () => {
    const claude = withAccount(
      { driver: ProviderDriverKind.make("claudeAgent") },
      { ...snapshot, runways: [] },
    );
    const saved = savePolicies(claude);
    await act(() => button("Refresh").click());
    const key = JSON.stringify(["claudeAgent", ["account", "identity"]]);
    await change("SL daily goal", "12.5");
    await pass(1000);
    expect(saved.policy.accountGoals).toEqual([{ key, percentPerDay: 12.5 }]);
    await act(() => named("SL Fable mode").click());
    await pass();
    expect(saved.policy.fableAccounts).toEqual([key]);
    expect(named("SL Fable mode").getAttribute("aria-checked")).toBe("true");
  });
  it("holds a hard cap until its field is left and never sends one out of range", async () => {
    const saved = savePolicies();
    expect(named("SL cap stops workers")).toBeNull();
    await change("SL weekly cap", "8");
    await pass(60_000);
    expect(saves()).toEqual([]);
    await change("SL weekly cap", "101");
    expect(field("SL weekly cap").getAttribute("aria-invalid")).toBe("true");
    await leave("SL weekly cap");
    await pass();
    expect(saves()).toEqual([]);
    expect(alert()?.textContent).toContain("A cap must be a number from 0 to 100");
    expect(section("Accounts").querySelector("li")?.textContent).toContain("Not saved");
    await change("SL weekly cap", "80");
    await leave("SL weekly cap");
    await pass();
    expect(saved.policy.accountCaps).toEqual([
      expect.objectContaining({
        weeklyPercent: 80,
        fiveHourPercent: null,
        stopWorkers: true,
        stopMasters: false,
      }),
    ]);
    expect(alert()).toBeNull();
    await act(() => named("SL cap stops workers").click());
    await pass();
    expect(saved.policy.accountCaps?.[0]).toMatchObject({ stopWorkers: false, stopMasters: false });
    expect(container.textContent).toContain("stops nobody: no effect");
    await act(() => named("SL cap stops masters").click());
    await pass();
    expect(saved.policy.accountCaps?.[0]).toMatchObject({ stopWorkers: false, stopMasters: true });
  });
  it("shows a refused save beside the value and keeps it marked until it is stored", async () => {
    await change("Close-call margin", "12");
    await pass(1000);
    expect(alert()?.textContent).toContain("Not saved");
    expect(alert()?.textContent).toContain("did not answer");
    expect(section("Rules").textContent).toContain("Not saved");
    expect(status()).toBe("Not saved");
    expect(field("Close-call margin").value).toBe("12");
    const saved = savePolicies();
    await act(() => button("Try again").click());
    await pass();
    expect(saved.policy.closeMarginPoints).toBe(12);
    expect(alert()).toBeNull();
    expect(section("Rules").textContent).not.toContain("Not saved");
  });
  it("shows the stored value again when a change that could not be stored is dropped", async () => {
    state.execute.mockImplementation(async (arg: { input: AllocationOperation }) =>
      arg.input._tag === "policy"
        ? refused("unavailable", "The settings computer is off.")
        : { _tag: "Success", value: { snapshot } },
    );
    await change("Close-call margin", "12");
    await pass(1000);
    expect(alert()?.textContent).toContain("The settings computer is off.");
    await act(() => button("Drop my change").click());
    expect(field("Close-call margin").value).toBe("10");
    expect(alert()).toBeNull();
  });
  it("applies a change on top of settings saved elsewhere instead of overwriting them", async () => {
    const saved = savePolicies();
    // Another computer stores a cap after this page loaded.
    const cap = {
      key: JSON.stringify(["codex", ["account", "identity"]]),
      weeklyPercent: 60,
      fiveHourPercent: null,
      stopWorkers: true,
      stopMasters: false,
    };
    saved.policy = { ...saved.policy, version: 5, accountCaps: [cap] };
    await change("Wait for a reset", "6");
    await pass(1000);
    expect(saves().map((save) => save.expectedVersion)).toEqual([4, 5]);
    expect(saved.policy).toMatchObject({ version: 6, longWaitHours: 6, accountCaps: [cap] });
    expect(field("SL weekly cap").value).toBe("60");
    expect(alert()).toBeNull();
  });
  it("asks before replacing a value that was also changed elsewhere", async () => {
    const saved = savePolicies();
    saved.policy = { ...saved.policy, version: 5, closeMarginPoints: 30 };
    await change("Close-call margin", "20");
    await pass(1000);
    expect(alert()?.textContent).toContain("Changed elsewhere");
    expect(section("Rules").textContent).toContain("Not saved");
    expect(saved.policy).toMatchObject({ version: 5, closeMarginPoints: 30 });
    await act(() => button("Use theirs").click());
    expect(field("Close-call margin").value).toBe("30");
    await pass(1000);
    expect(saved.policy.version).toBe(5);

    saved.policy = { ...saved.policy, version: 6, closeMarginPoints: 40 };
    await change("Close-call margin", "25");
    await pass(1000);
    await act(() => button("Keep mine").click());
    await pass();
    expect(saved.policy).toMatchObject({ version: 7, closeMarginPoints: 25 });
    expect(alert()).toBeNull();
  });
  it("keeps a typed value across reconnects and ignores a read that was overtaken", async () => {
    await change("SL weekly cap", "40");
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
    // The accounts wait for the held settings read.
    expect(readCalls("snapshot")).toHaveLength(3);
    expect(status()).toBe("Loading…");
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
    expect(readCalls("snapshot")).toHaveLength(5);
    expect(field("SL weekly cap").value).toBe("40");
    await act(async () => resolveOld({ _tag: "Success", value: { snapshot } }));
    await leave("SL weekly cap");
    await pass();
    expect(saves().at(-1)).toMatchObject({
      expectedVersion: 5,
      policy: { accountCaps: [expect.objectContaining({ weeklyPercent: 40 })] },
    });
  });
  it("says the settings computer needs an update before the order can be stored", async () => {
    await read({ ...two, accountOrderSupported: undefined });
    expect(container.textContent).toContain("needs an update before the order and rules");
    expect(named("Move SL up").hasAttribute("disabled")).toBe(true);
    expect(field("Close-call margin").disabled).toBe(true);
    expect(field("SL weekly cap").disabled).toBe(false);
  });
  it("turns workers off for an account on the computer that has it, and says when that fails", async () => {
    const previous = state.execute.getMockImplementation()!;
    const patches: unknown[] = [];
    let stores = true;
    state.execute.mockImplementation(async (arg) => {
      if (!("patch" in arg.input)) return previous(arg);
      patches.push(arg);
      return stores ? { _tag: "Success", value: {} } : { _tag: "Failure" };
    });
    expect(named("SL workers allowed").getAttribute("aria-checked")).toBe("true");
    await act(async () => named("SL workers allowed").click());
    expect(patches).toEqual([
      { environmentId: "host", input: { patch: { workerDisabledInstanceIds: ["sl"] } } },
    ]);
    expect(readCalls("policy")).toHaveLength(0);
    expect(section("Accounts").textContent).not.toContain("Not saved");
    stores = false;
    await act(async () => named("SL workers allowed").click());
    expect(section("Accounts").querySelector("li")?.textContent).toContain("Not saved");
  });
  it("shows each limit's use, reset and an old reading, and offers the 5-hour cap only for Claude", async () => {
    expect(named("SL 5-hour cap")).toBeNull();
    vi.setSystemTime("2026-10-23T12:14:00.000Z");
    await read(
      withAccount({
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
      }),
    );
    const row = section("Accounts").querySelector("li")!;
    expect(row.textContent).toContain("Weekly");
    expect(row.textContent).toContain("42%");
    expect(row.textContent).toContain("resets ");
    expect(row.textContent).toContain("read 14 min ago");
    expect(named("SL Weekly used").getAttribute("aria-valuenow")).toBe("42");
    expect(field("SL 5-hour cap").value).toBe("");
  });
  it("keeps an API-key account with cached windows under Other accounts, without caps", async () => {
    await read(
      withAccount({ available: false, usageLimitsUnavailableReason: "unsupported" as const }),
    );
    expect(named("SL workers allowed")).toBeNull();
    await open("Other accounts (1)");
    const other = section("Other accounts (1)");
    expect(other.textContent).toContain("No subscription limit");
    expect(named("SL weekly cap")).toBeNull();
    expect(other.contains(named("SL workers allowed"))).toBe(true);
  });
  it("lists a quota-less account with the rest once a cap is saved for it, unless its provider is off", async () => {
    const capped = (enabled: boolean) =>
      withAccount(
        { usageLimitsUnavailableReason: "unsupported" as const, enabled },
        {
          ...snapshot,
          policy: {
            ...snapshot.policy,
            accountCaps: [
              {
                key: JSON.stringify(["codex", ["account", "identity"]]),
                weeklyPercent: 80,
                fiveHourPercent: null,
                stopWorkers: true,
                stopMasters: false,
              },
            ],
          },
        },
      );
    await read(capped(true));
    expect(section("Accounts").contains(named("SL workers allowed"))).toBe(true);
    await read(capped(false));
    expect(named("SL workers allowed")).toBeNull();
    expect(button("Other accounts (1)")).toBeDefined();
  });
  it("does not offer subscription caps until quota provenance is verified", async () => {
    await read(withAccount({ usageLimitsUnavailableReason: "unverified" as const }));
    await open("Other accounts (1)");
    expect(named("SL weekly cap")).toBeNull();
    expect(section("Other accounts (1)").textContent).toContain("Usage not verified");
  });
  it("keeps cap controls available through a transient probe failure", async () => {
    await read(
      withAccount({
        available: false,
        windows: [],
        usageLimitsUnavailableReason: "probeFailed" as const,
      }),
    );
    expect(field("SL weekly cap").disabled).toBe(false);
    expect(container.textContent).toContain("Usage could not be read");
  });
  it("does not send an empty or out-of-range number, and keeps a typed one through a disconnect", async () => {
    const saved = savePolicies();
    await change("Close-call margin", "");
    expect(field("Close-call margin").getAttribute("aria-invalid")).toBe("true");
    await pass(1000);
    await change("Close-call margin", "51");
    await pass(1000);
    expect(saves()).toEqual([]);
    expect(alert()?.textContent).toContain("The margin must be a number from 0 to 50");
    await change("Close-call margin", "12");
    await connect("offline");
    expect(field("Close-call margin").disabled).toBe(true);
    expect(field("Close-call margin").value).toBe("12");
    expect(container.textContent).toContain("showing the last known settings");
    await connect("connected");
    await pass(1000);
    expect(saved.policy.closeMarginPoints).toBe(12);
    expect(status()).toBe("Saved");
  });
  it("chooses the settings computer by name and keeps a typed value when connecting fails", async () => {
    await open("Settings computer");
    const computer = input("Computer") as HTMLSelectElement;
    expect([...computer.options].map((o) => o.textContent)).toEqual([
      "Workstation (this computer)",
      "Build computer",
    ]);
    expect(section("Settings computer").textContent).toContain("Workstation keeps these settings");
    await change("SL weekly cap", "12");
    await change("Computer", "peer");
    await act(() => button("Use this computer").click());
    expect(state.execute.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "host",
      input: { _tag: "connect", coordinatorEnvironmentId: "peer" },
    });
    expect(input("Computer").value).toBe("peer");
    expect(field("SL weekly cap").value).toBe("12");
  });
  it("retains a disconnected saved settings computer when the settings scope changes", async () => {
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
    await act(() =>
      root.render(<ProviderAllocationPage environmentId={EnvironmentId.make("other")} />),
    );
    await open("Settings computer");
    expect(input("Computer").value).toBe("unlinked");
    expect((input("Computer") as HTMLSelectElement).selectedOptions[0]?.textContent).toContain(
      "not linked",
    );
    expect(section("Accounts").textContent).toContain("Claude");
    await act(() => button("Refresh").click());
    expect(input("Computer").value).toBe("unlinked");
    expect(state.execute.mock.calls.at(-1)?.[0].environmentId).toBe("other");
  });
  it("shows the saved settings before the accounts arrive, saying only that they are loading", async () => {
    await act(async () => root.unmount());
    const previous = state.execute.getMockImplementation()!;
    let release!: () => void;
    state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
      if (arg.input._tag !== "snapshot") return previous(arg);
      if (arg.input.part === "accounts") await new Promise<void>((resolve) => (release = resolve));
      return {
        _tag: "Success",
        value: {
          snapshot:
            arg.input.part === "settings"
              ? { ...snapshot, inventories: [], runways: [] }
              : { ...snapshot, notices: ["Laptop: load unavailable for this decision: offline"] },
        },
      };
    });
    root = createRoot(container);
    await act(() =>
      root.render(<ProviderAllocationPage environmentId={EnvironmentId.make("host")} />),
    );
    expect(field("Close-call margin").value).toBe("10");
    expect(field("Close-call margin").disabled).toBe(false);
    expect(container.textContent).toContain("Loading accounts…");
    for (const claim of ["Not connected", "not loaded"])
      expect(container.textContent).not.toContain(claim);
    expect(named("SL workers allowed")).toBeNull();
    await act(async () => release());
    expect(container.textContent).not.toContain("Loading accounts…");
    expect(named("SL workers allowed")).not.toBeNull();
    // A computer that could not be read is a plain note beside the accounts.
    expect(container.textContent).toContain("Laptop: load unavailable for this decision: offline");
  });
  it.each(["connecting", "offline"])(
    "while %s, says loading or not connected, never both",
    async (phase) => {
      await act(async () => root.unmount());
      state.phase = phase;
      root = createRoot(container);
      await act(() =>
        root.render(<ProviderAllocationPage environmentId={EnvironmentId.make("host")} />),
      );
      const text = container.textContent!;
      if (phase === "connecting") {
        expect(status()).toBe("Loading…");
        expect(text).toContain("Loading accounts…");
        expect(text).not.toContain("Not connected");
      } else {
        expect(status()).toBe("Not connected");
        expect(text).not.toContain("Loading");
      }
    },
  );
  it("keeps the rest behind closed sections, without draft buttons or internal wording", async () => {
    expect(
      [...container.querySelectorAll("button[aria-expanded]")].map((fold) => fold.textContent),
    ).toEqual(["Learned numbers", "Settings computer"]);
    for (const removed of [
      "Save settings",
      "Reset to defaults",
      "Reload saved settings",
      "Preview account",
      "Decision history",
      "Reservations",
      "diagnostics",
    ])
      expect(container.textContent).not.toContain(removed);
    expect(container.textContent).not.toMatch(/coordinator|policy|authority/i);
  });
});

it("keeps hard caps read-only when the settings computer cannot store them", async () => {
  await read({ ...snapshot, accountCapsSupported: undefined });
  expect(field("SL weekly cap").disabled).toBe(true);
  expect(container.textContent).toContain("needs an update before caps can be edited");
});
