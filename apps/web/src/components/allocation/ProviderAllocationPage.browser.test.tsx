import {
  defaultAllocationPolicy,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationOperation,
  type AllocationRequest,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  phase: "connected",
}));

vi.mock(
  "../../state/environments",
  () =>
    ({
      useEnvironment: () => ({ connection: { phase: state.phase } }),
    }) as never,
);
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }) as never);
vi.mock(
  "../../state/server",
  () =>
    ({
      serverEnvironment: { updateSettings: { label: "updateSettings" } },
    }) as never,
);
vi.mock("@t3tools/client-runtime/state/provider-allocation", async (original) => {
  const actual =
    await original<typeof import("@t3tools/client-runtime/state/provider-allocation")>();
  return {
    ...actual,
    createAllocationCommands: () => ({
      execute: { label: "execute" },
      start: { label: "start" },
    }),
  } as never;
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
vi.mock(
  "../../state/entities",
  () =>
    ({
      useProjects: () => [{ id: "project", title: "Project", environmentId: "host" }],
    }) as never,
);
import { ProviderAllocationPage } from "./ProviderAllocationPage";

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
const initialSnapshot: AllocationSnapshot = {
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
let activeSnapshot: AllocationSnapshot;

const control = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("label")]
    .find((element) => element.textContent?.startsWith(label))!
    .querySelector("input,select,textarea") as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === text)!;

async function change(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    const input = control(container, label);
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function openPage() {
  state.phase = "connected";
  state.execute.mockReset();
  state.start.mockReset();
  activeSnapshot = structuredClone(initialSnapshot);
  state.execute.mockImplementation(async ({ input }: { input: AllocationOperation }) => {
    if (input._tag === "snapshot") {
      return { _tag: "Success", value: { snapshot: structuredClone(activeSnapshot) } };
    }
    if (input._tag === "connections") {
      return {
        _tag: "Success",
        value: {
          connections: {
            coordinatorEnvironmentId: "host",
            environments: [{ environmentId: "host", label: "Workstation" }],
          },
        },
      };
    }
    if (input._tag === "preview") {
      return {
        _tag: "Success",
        value: {
          result: { decision: decision(input.request), reservation: null, mode: "observation" },
        },
      };
    }
    if (input._tag === "policy") {
      activeSnapshot = { ...activeSnapshot, policy: input.input.policy };
      return { _tag: "Success", value: { policy: input.input.policy } };
    }
    return { _tag: "Failure" };
  });
  return render(<ProviderAllocationPage environmentId={EnvironmentId.make("host")} />);
}

it("shows the coordinator snapshot and saves edited numeric policy without a preview", async () => {
  await using screen = await openPage();

  expect(screen.container.textContent).toContain("policy 4");
  await change(screen.container, "Claude Daily usage budget", "40");
  await act(async () => {
    button(screen.container, "Save settings").click();
  });

  const save = state.execute.mock.calls.find(([arg]) => arg.input._tag === "policy");
  expect(save?.[0].input.input.policy.claude.dailyPoints).toBe(40);
  expect(state.execute.mock.calls.some(([arg]) => arg.input._tag === "preview")).toBe(false);
});
