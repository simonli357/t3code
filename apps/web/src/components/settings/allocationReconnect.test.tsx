// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  defaultModelRoutingPolicy,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationOperation,
  type AllocationPolicy,
  type AllocationSnapshot,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
import { modelCell, setModelCell } from "@t3tools/client-runtime/state/model-routing";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  listeners: new Set<() => void>(),
  environments: [] as {
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: { settings: unknown } | null;
  }[],
  files: new Map(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/provider-allocation", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/provider-allocation")>()),
  createAllocationCommands: () => ({ execute: { label: "execute" } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.execute }));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const useEnvironments = () => ({
    environments: useSyncExternalStore(
      (notify) => {
        state.listeners.add(notify);
        return () => state.listeners.delete(notify);
      },
      () => state.environments,
    ),
  });
  return {
    useEnvironments,
    usePrimaryEnvironmentId: () => "host",
    useEnvironment: (id: string) =>
      useEnvironments().environments.find((e) => e.environmentId === id),
  };
});
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.files }));
vi.mock("../files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: vi.fn(),
  optimisticFileAtom: vi.fn(),
}));
// Keep the production scope provider, boundary, keyed layout, leaf routes and editors.
// Only unrelated settings chrome and external transport/catalog sources are replaced.
vi.mock("./SettingsPanels", () => ({ useSettingsRestore: vi.fn() }));
vi.mock("./SettingsBreadcrumb", () => ({ SettingsBreadcrumb: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("../sidebar/mainAppLocation", () => ({ useNavigateToMainApp: () => vi.fn() }));
vi.mock("../../hooks/useNavigateBack", () => ({ useEscapeToGoBack: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: { label: "updateSettings" } },
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsSection: (props: { title: string; headerAction?: ReactNode; children: ReactNode }) => (
    <section aria-label={props.title}>
      {props.headerAction}
      {props.children}
    </section>
  ),
}));
vi.mock("./FoldedSettingsSection", () => ({
  FoldedSettingsSection: (props: { title: string }) => <section aria-label={props.title} />,
}));

import { Route as Settings } from "../../routes/settings";
import { Route as Allocation } from "../../routes/settings.allocation";
import { Route as Models } from "../../routes/settings.model-selection";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

const efforts = (ids: string[]) => ({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      type: "select" as const,
      label: "Effort",
      options: ids.map((id) => ({ id, label: id })),
    },
  ],
});
const inventory = {
  environmentId: "host",
  observedAt: "2026-10-23T12:00:00Z",
  complete: true,
  notices: [],
  demand: [],
  accounts: [
    {
      environmentId: "host",
      instanceId: ProviderInstanceId.make("ad"),
      driver: ProviderDriverKind.make("codex"),
      label: "AD",
      accountKey: "ad",
      available: true,
      unavailableReason: null,
      limitedUntil: null,
      shortWindow: "unknown" as const,
      windows: [],
      resetCredits: null,
      profileSamples: 0,
      profileUncertainty: 1,
      models: [
        { slug: "gpt-6.2-astra", capabilities: efforts(["medium", "high", "xhigh"]) },
        { slug: "gpt-6.2-sol", capabilities: efforts(["medium", "high", "max", "xhigh"]) },
      ],
    },
  ],
};
const allocationSnapshot: AllocationSnapshot = {
  accountOrderSupported: true,
  policy: { ...defaultAllocationPolicy, version: 1 },
  inventories: [inventory],
  runways: [],
  authorityAvailable: true,
  history: [],
  reservations: [],
  notices: [],
};
const modelSnapshot: ModelRoutingSnapshot = {
  policy: { ...defaultModelRoutingPolicy, version: 1 },
  inventories: [inventory],
  authorityAvailable: true,
  history: [],
  policies: [],
};
/** What each computer has stored. The peer's values differ from the host's, and from the defaults. */
let stored: Record<string, { allocation: AllocationPolicy; model: ModelRoutingPolicy }>;
let container: HTMLDivElement;
let root: Root;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
const named = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
const toggle = (name: string) =>
  container.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`)!;
const control = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("input,select") as HTMLInputElement | HTMLSelectElement;
async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
const click = (element: HTMLElement) => act(async () => element.click());
/** Lets `ms` pass, and the save that follows settle. */
const pass = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
/** The page's own word on how far the latest change got. */
const status = () => container.querySelector('span[role="status"]')?.textContent;
const alert = () => container.querySelector('[role="alert"]');
const saves = () =>
  state.execute.mock.calls
    .map(([arg]) => arg as { environmentId: string; input: AllocationOperation })
    .filter(({ input }) => input._tag === "policy" || input._tag === "modelPolicy");
const connect = (id: string, connected: boolean) =>
  act(async () => {
    state.environments = state.environments.map((e) =>
      e.environmentId === id
        ? {
            ...e,
            connection: { phase: connected ? "connected" : "offline" },
            serverConfig: connected ? { settings: DEFAULT_SERVER_SETTINGS } : null,
          }
        : e,
    );
    state.listeners.forEach((notify) => notify());
  });
/** Holds the next read of the stored settings until the returned function is called. */
function holdRead() {
  const previous = state.execute.getMockImplementation()!;
  let release!: () => void;
  let held = false;
  state.execute.mockImplementation(async (arg: { input: AllocationOperation }) => {
    if (!held && (arg.input._tag === "snapshot" || arg.input._tag === "modelSnapshot")) {
      held = true;
      await new Promise<void>((resolve) => (release = resolve));
    }
    return previous(arg);
  });
  return () => release();
}
// Each route's component is its own lazily loaded chunk. Loading them here keeps that out of a
// case's time: on a busy computer the first load alone can take longer than a case may.
beforeAll(
  () =>
    Promise.all(
      [Settings, Allocation, Models].map((route) => route.options.component?.preload?.()),
    ),
  180_000,
);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  state.environments = ["host", "peer"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  }));
  stored = {
    host: { allocation: allocationSnapshot.policy, model: modelSnapshot.policy },
    peer: {
      allocation: { ...allocationSnapshot.policy, version: 8, closeMarginPoints: 25 },
      model: {
        ...setModelCell(modelSnapshot.policy, "codex", 7, 8, {
          model: "gpt-6.2-sol",
          effort: "max",
        }),
        version: 8,
      },
    },
  };
  state.execute.mockReset();
  state.execute.mockImplementation(
    async ({ environmentId, input }: { environmentId: string; input: AllocationOperation }) => {
      const here = stored[environmentId];
      // A disconnected computer answers nothing.
      if (
        !here ||
        state.environments.find((e) => e.environmentId === environmentId)?.connection.phase !==
          "connected"
      )
        return { _tag: "Failure" };
      const inventories = environmentId === "host" ? [inventory] : [];
      if (input._tag === "connections")
        return {
          _tag: "Success",
          value: {
            connections: {
              coordinatorEnvironmentId: environmentId,
              environments: state.environments,
            },
          },
        };
      if (input._tag === "snapshot")
        return {
          _tag: "Success",
          value: { snapshot: { ...allocationSnapshot, inventories, policy: here.allocation } },
        };
      if (input._tag === "modelSnapshot")
        return {
          _tag: "Success",
          value: { modelSnapshot: { ...modelSnapshot, inventories, policy: here.model } },
        };
      if (input._tag === "policy" && input.input.expectedVersion === here.allocation.version) {
        here.allocation = { ...input.input.policy, version: here.allocation.version + 1 };
        return { _tag: "Success", value: { policy: here.allocation } };
      }
      if (input._tag === "modelPolicy" && input.expectedVersion === here.model.version) {
        here.model = { ...input.policy, version: here.model.version + 1 };
        return { _tag: "Success", value: { modelPolicy: here.model } };
      }
      throw new Error(`Unexpected ${input._tag}`);
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
/** A case renders the whole Settings shell and router three times: slow on a busy computer. */
const WHOLE_SHELL_MS = 90_000;
/** The page inside the real Settings scope boundary; returns how to change the computer in scope. */
async function mount(page: "allocation" | "model-selection") {
  const path = `/settings/${page}` as const;
  const rootRoute = createRootRoute({ component: Outlet });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    component: Settings.options.component!,
  });
  const allocation = createRoute({
    getParentRoute: () => settings,
    path: "allocation",
    component: Allocation.options.component!,
  });
  const models = createRoute({
    getParentRoute: () => settings,
    path: "model-selection",
    component: Models.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settings.addChildren([allocation, models])]),
    history: createMemoryHistory({ initialEntries: [`${path}?machine=host`] }),
    defaultPendingMinMs: 0,
  });
  // The router loads on real timers; only the pages' own pauses are stepped through.
  const pauses = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    await router.load();
    root.render(<RouterProvider router={router} />);
  });
  pauses();
  return async (machine: string) => {
    vi.useRealTimers();
    await act(async () => {
      await router.navigate({ to: path, search: { machine } });
    });
    pauses();
  };
}

it(
  "allocation: a typed number and a switch survive a disconnect and reconnect, and stay with their computer",
  async () => {
    const scope = await mount("allocation");
    const margin = () => named("Close-call margin") as HTMLInputElement;
    const fable = () => toggle("Fable workers").getAttribute("aria-checked");
    const marked = () =>
      [...container.querySelectorAll("h3")]
        .filter((title) => title.parentElement!.parentElement!.textContent!.includes("Not saved"))
        .map((title) => title.textContent);
    const original = margin();
    expect([original.value, fable()]).toEqual(["10", "true"]);
    await type(original, "40");
    await click(toggle("Fable workers"));
    expect(status()).toBe("Not saved yet");
    await connect("host", false);
    await pass(1000);
    // The save could not reach the computer: both values stay as typed, marked as not stored.
    expect(margin()).toBe(original);
    expect([margin().value, fable()]).toEqual(["40", "false"]);
    expect(status()).toBe("Not connected");
    expect(alert()?.textContent).toContain("Not saved");
    expect(marked()).toEqual(["Close-call margin", "Fable workers"]);
    expect(stored.host!.allocation.version).toBe(1);

    const release = holdRead();
    await connect("host", true);
    expect(margin()).toBe(original);
    expect([margin().value, fable()]).toEqual(["40", "false"]);
    expect(status()).toBe("Loading…");
    expect(marked()).toEqual(["Close-call margin", "Fable workers"]);
    await act(async () => release());
    await pass();
    expect(stored.host!.allocation).toMatchObject({
      version: 2,
      closeMarginPoints: 40,
      fableWorkers: false,
    });
    expect([margin().value, fable()]).toEqual(["40", "false"]);
    expect(status()).toBe("Saved");
    expect(alert()).toBeNull();
    expect(marked()).toEqual([]);

    // Another computer shows its own stored values; a change still waiting here goes to this one.
    await type(margin(), "45");
    await scope("peer");
    expect(margin()).not.toBe(original);
    expect([margin().value, fable()]).toEqual(["25", "true"]);
    await pass(1000);
    expect(stored.host!.allocation).toMatchObject({ version: 3, closeMarginPoints: 45 });
    expect(stored.peer!.allocation).toMatchObject({ version: 8, closeMarginPoints: 25 });
    expect(saves().every((save) => save.environmentId === "host")).toBe(true);
    expect(status()).toBe("Changes save automatically");
    await scope("missing");
    expect(named("Close-call margin")).toBeNull();
    expect(container.textContent).toContain("This environment is no longer available.");
  },
  WHOLE_SHELL_MS,
);

it(
  "model selection: a changed cell and a switch survive a disconnect and reconnect, and stay with their computer",
  async () => {
    const scope = await mount("model-selection");
    const cell = (difficulty: number, stakes: number) =>
      container.querySelector<HTMLButtonElement>(`[data-cell="${difficulty}-${stakes}"]`)!;
    const label = (difficulty: number, stakes: number) =>
      cell(difficulty, stakes).getAttribute("aria-label");
    const fallback = () => toggle("Fallback model").getAttribute("aria-checked");
    await click(button("Codex"));
    expect([label(7, 8), fallback()]).toEqual([
      "Difficulty 7, stakes 8: gpt-6.2-astra / high",
      "true",
    ]);
    await click(cell(7, 8));
    await type(control("Reasoning"), "xhigh");
    await click(toggle("Fallback model"));
    const edited = ["Difficulty 7, stakes 8: gpt-6.2-astra / xhigh, not saved yet", "false"];
    expect(status()).toBe("Not saved yet");
    await connect("host", false);
    await pass(1200);
    // The save could not reach the computer: the cell stays changed, marked as not stored.
    expect([label(7, 8), fallback()]).toEqual(edited);
    expect(status()).toBe("Not connected");
    expect(alert()?.textContent).toContain("Not saved");
    expect(stored.host!.model.version).toBe(1);

    const release = holdRead();
    await connect("host", true);
    expect([label(7, 8), fallback()]).toEqual(edited);
    expect(status()).toBe("Loading…");
    await act(async () => release());
    await pass();
    expect(stored.host!.model).toMatchObject({ version: 2, fallback: null });
    expect(modelCell(stored.host!.model, "codex", 7, 8).effort).toBe("xhigh");
    expect([label(7, 8), fallback()]).toEqual([
      "Difficulty 7, stakes 8: gpt-6.2-astra / xhigh",
      "false",
    ]);
    expect(status()).toBe("Saved");
    expect(alert()).toBeNull();

    // Another computer shows its own stored table; a change still waiting here goes to this one.
    await click(cell(0, 0));
    await type(control("Reasoning"), "high");
    await scope("peer");
    await click(button("Codex"));
    expect([label(7, 8), label(0, 0), fallback()]).toEqual([
      "Difficulty 7, stakes 8: gpt-6.2-sol / max",
      "Difficulty 0, stakes 0: gpt-6.2-sol / medium",
      "true",
    ]);
    await pass(1200);
    expect(stored.host!.model.version).toBe(3);
    expect(modelCell(stored.host!.model, "codex", 0, 0).effort).toBe("high");
    expect(stored.peer!.model.version).toBe(8);
    expect(saves().every((save) => save.environmentId === "host")).toBe(true);
    expect(status()).toBe("Changes save automatically");
    await scope("missing");
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("This environment is no longer available.");
  },
  WHOLE_SHELL_MS,
);
