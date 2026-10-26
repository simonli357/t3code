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
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  defaultAllocationPolicy,
  defaultModelRoutingPolicy,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationOperation,
  type AllocationSnapshot,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
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
  createAllocationCommands: () => ({ execute: { label: "execute" }, start: { label: "start" } }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
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
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

import { Route as Settings } from "../../routes/settings";
import { Route as Allocation } from "../../routes/settings.allocation";
import { Route as Models } from "../../routes/settings.model-selection";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

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
      models: [{ slug: "gpt-6-astra", capabilities: { optionDescriptors: [] } }],
    },
  ],
};
const reservedRequest = {
  assignmentId: "reserved",
  environmentId: "host",
  threadId: ThreadId.make("reserved"),
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-6-astra",
  options: [],
};
const allocationSnapshot: AllocationSnapshot = {
  policy: { ...defaultAllocationPolicy, version: 1 },
  inventories: [inventory],
  authorityAvailable: true,
  history: [],
  reservations: [
    {
      assignmentId: "reserved",
      request: reservedRequest,
      accountKey: "ad",
      instanceId: ProviderInstanceId.make("ad"),
      createdAt: inventory.observedAt,
      expiresAt: "2026-10-23T13:00:00Z",
      state: "reserved",
      decision: {
        at: inventory.observedAt,
        policyVersion: 1,
        request: reservedRequest,
        outcome: "selected",
        selectedInstanceId: ProviderInstanceId.make("ad"),
        candidates: [],
        reasons: [],
        confidence: "low",
        waitUntil: null,
      },
    },
  ],
  notices: [],
};
const modelSnapshot: ModelRoutingSnapshot = {
  policy: { ...defaultModelRoutingPolicy, version: 1 },
  inventories: [inventory],
  authorityAvailable: true,
  history: [],
  policies: [defaultModelRoutingPolicy],
};
let container: HTMLDivElement;
let root: Root;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
const control = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))
    ?.querySelector("input,select,textarea") as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | undefined;
async function change(label: string, value: string) {
  await act(async () => {
    const element = control(label)!;
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
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  state.environments = ["host", "peer"].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
  }));
  state.execute.mockReset();
  state.start.mockReset();
  state.execute.mockImplementation(
    async ({ environmentId, input }: { environmentId: string; input: AllocationOperation }) => {
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
          value: {
            snapshot:
              environmentId === "host"
                ? allocationSnapshot
                : {
                    ...allocationSnapshot,
                    reservations: [],
                    inventories: [],
                    policy: {
                      ...allocationSnapshot.policy,
                      version: 8,
                      claude: {
                        ...allocationSnapshot.policy.claude,
                        preset: "custom",
                        dailyPoints: 17,
                      },
                    },
                  },
          },
        };
      if (input._tag === "modelSnapshot")
        return {
          _tag: "Success",
          value: {
            modelSnapshot:
              environmentId === "host"
                ? modelSnapshot
                : {
                    ...modelSnapshot,
                    inventories: [],
                    policy: { ...modelSnapshot.policy, version: 8, maxReassessments: 1 },
                  },
          },
        };
      if (input._tag === "preview")
        return {
          _tag: "Success",
          value: {
            result: {
              decision: { request: input.request, candidates: [], reasons: [], policyVersion: 1 },
              mode: "observation",
              reservation: null,
            },
          },
        };
      if (input._tag === "modelPreview")
        return {
          _tag: "Success",
          value: {
            selection: {
              request: input.request,
              rule: "Rule",
              selectedProfile: 1,
              policyVersion: 1,
              profiles: [],
              reasons: [],
              allocation: null,
            },
          },
        };
      throw new Error(`Unexpected mutation ${input._tag}`);
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
});

it.each(["allocation", "model-selection"] as const)(
  "retains %s drafts through the real Settings boundary and isolates explicit scope changes",
  async (page) => {
    const path = `/settings/${page}` as const;
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <button onClick={() => void router.navigate({ to: path, search: { machine: "peer" } })}>
            Switch to peer
          </button>
          <button
            onClick={() => void router.navigate({ to: path, search: { machine: "missing" } })}
          >
            Switch to missing
          </button>
          <Outlet />
        </>
      ),
    });
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
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    const isAllocation = page === "allocation";
    const preview = isAllocation ? "Preview assignment and policy" : "Preview exact selection";
    const save = isAllocation ? "Save settings" : "Save table";
    const summary = (title: string) =>
      act(async () => {
        [...container.querySelectorAll("summary")].find((s) => s.textContent === title)!.click();
      });
    const edited = isAllocation ? "Codex Daily usage budget" : "Maximum explicit reassessments";
    if (isAllocation) {
      await change(edited, "40");
      await act(async () => {
        for (const title of [
          "Temporary targets and reset plans",
          "Advanced override values and removal",
        ])
          [...container.querySelectorAll("summary")]
            .find((summary) => summary.textContent === title)!
            .click();
      });
      await change("Temporary overrides (JSON)", "[\n  \n]");
      await change("Model", "gpt-6-astra");
    } else {
      await summary("Test an assignment");
      await summary("Policy settings, versions and raw JSON");
      await change(edited, "3");
      await change("Difficulty score", "3");
      await change("Stakes score", "3");
      await change("Difficulty reason", "Scoped reasoning");
      await change("Stakes reason", "Reversible failure");
    }
    await act(async () => button(preview).click());
    expect(button(save).disabled).toBe(false);
    const original = control(edited);
    await connect("host", false);
    expect(control(edited)).toBe(original);
    expect(control(edited)?.value).toBe(isAllocation ? "40" : "3");
    expect(button(preview).disabled).toBe(true);
    expect(button(save).disabled).toBe(true);
    if (isAllocation) {
      expect(control("Temporary overrides (JSON)")?.value).toBe("[\n  \n]");
      expect(control("Temporary overrides (JSON)")?.closest("details")?.open).toBe(true);
      expect(button("Connect coordinator").disabled).toBe(true);
      await act(async () => button("Connect coordinator").click());
      expect(button("Cancel unused reservation").disabled).toBe(true);
      await act(async () => button("Cancel unused reservation").click());
    } else {
      expect(button("Revert version 0 as a new version").disabled).toBe(true);
      await act(async () => button("Revert version 0 as a new version").click());
    }
    const implementation = state.execute.getMockImplementation()!;
    let resolveSnapshot!: (value: unknown) => void;
    state.execute.mockImplementation((arg) =>
      arg.input._tag === (isAllocation ? "snapshot" : "modelSnapshot")
        ? new Promise((resolve) => {
            resolveSnapshot = resolve;
          })
        : implementation(arg),
    );
    await connect("host", true);
    expect(control(edited)).toBe(original);
    expect(button(preview).disabled).toBe(true);
    expect(button(save).disabled).toBe(true);
    await act(async () =>
      resolveSnapshot({
        _tag: "Success",
        value: isAllocation ? { snapshot: allocationSnapshot } : { modelSnapshot },
      }),
    );
    expect(control(edited)?.value).toBe(isAllocation ? "40" : "3");
    expect(button(preview).disabled).toBe(false);
    // Neither settings page requires a preview to save the retained edit.
    expect(button(save).disabled).toBe(false);
    await act(async () => button(preview).click());
    expect(button(save).disabled).toBe(false);
    state.execute.mockImplementation(implementation);
    await connect("host", false);
    await connect("peer", false);
    await act(async () => {
      button("Switch to peer").click();
      await router.load();
    });
    expect(control(edited)).not.toBe(original);
    // A cold offline model editor shows no table, so its advanced controls are absent.
    expect(control(edited)?.value).toBe(isAllocation ? "10" : undefined);
    if (isAllocation) expect(control("Temporary overrides (JSON)")?.value).toBe("[]");
    expect(button(preview)?.disabled).toBe(isAllocation ? true : undefined);
    expect(button(save)?.disabled).toBe(isAllocation ? true : undefined);
    state.execute.mockClear();
    await connect("peer", true);
    if (!isAllocation) await summary("Policy settings, versions and raw JSON");
    expect(control(edited)?.value).toBe(isAllocation ? "10" : "1");
    expect(state.execute.mock.calls.every(([arg]) => arg.environmentId === "peer")).toBe(true);
    await act(async () => {
      button("Switch to missing").click();
      await router.load();
    });
    expect(control(edited)).toBeUndefined();
    expect(container.textContent).toContain("This environment is no longer available.");
    expect(state.start).not.toHaveBeenCalled();
    expect(
      state.execute.mock.calls.some(([arg]) =>
        ["connect", "policy", "modelPolicy", "modelRevert", "lifecycle"].includes(arg.input._tag),
      ),
    ).toBe(false);
  },
);
