import {
  defaultModelRoutingPolicy,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationOperation,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  phase: "connected",
}));

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }) as never);
vi.mock(
  "@t3tools/client-runtime/state/provider-allocation",
  () =>
    ({
      createAllocationCommands: () => ({
        execute: { label: "execute" },
        start: { label: "start" },
      }),
    }) as never,
);
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start" ? state.start : state.execute,
}));
vi.mock(
  "../../state/environments",
  () =>
    ({
      useEnvironment: () => ({ connection: { phase: state.phase } }),
    }) as never,
);
vi.mock(
  "../../state/entities",
  () =>
    ({
      useProjects: () => [{ id: "project", title: "Project", environmentId: "host" }],
    }) as never,
);
import { ModelSelectionPage } from "./ModelSelectionPage";

const model = (slug: string, efforts: string[]) => ({
  slug,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select" as const,
        label: "Effort",
        options: efforts.map((id) => ({ id, label: id })),
      },
    ],
  },
});
const initialSnapshot: ModelRoutingSnapshot = {
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
          accountKey: "ad",
          available: true,
          unavailableReason: null,
          limitedUntil: null,
          shortWindow: "unknown",
          windows: [],
          resetCredits: null,
          profileSamples: 0,
          profileUncertainty: 1,
          models: [
            model("gpt-6.1-sol", ["medium", "high", "max", "xhigh"]),
            model("gpt-6-astra", ["medium", "high", "xhigh"]),
          ],
        },
      ],
    },
  ],
};
let activeSnapshot: ModelRoutingSnapshot;

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === text)!;
const cell = (container: HTMLElement, difficulty: number, stakes: number) =>
  container.querySelector<HTMLButtonElement>(`[data-cell="${difficulty}-${stakes}"]`)!;
const control = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("label")]
    .find((element) => element.textContent?.startsWith(label))!
    .querySelector("input,select,textarea") as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement;

async function change(container: HTMLElement, label: string, value: string) {
  await act(async () => {
    const input = control(container, label);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function openPage() {
  state.phase = "connected";
  state.execute.mockReset();
  state.start.mockReset();
  activeSnapshot = structuredClone(initialSnapshot);
  state.execute.mockImplementation(async ({ input }: { input: AllocationOperation }) => {
    if (input._tag === "modelSnapshot") {
      return { _tag: "Success", value: { modelSnapshot: structuredClone(activeSnapshot) } };
    }
    if (input._tag === "modelPolicy") {
      const policy: ModelRoutingPolicy = {
        ...input.policy,
        version: input.expectedVersion + 1,
      };
      activeSnapshot = { ...activeSnapshot, policy };
      return { _tag: "Success", value: { modelPolicy: policy } };
    }
    return { _tag: "Success", value: {} };
  });
  return render(<ModelSelectionPage environmentId={EnvironmentId.make("host")} />);
}

it("renders every difficulty and stakes pair from the saved table", async () => {
  await using screen = await openPage();

  expect(screen.container.querySelectorAll("table button")).toHaveLength(121);
  expect(cell(screen.container, 7, 8).getAttribute("aria-label")).toBe(
    "Difficulty 7, stakes 8: gpt-6-astra / high",
  );
  expect(screen.container.textContent).toContain("Saved version 3");
});

it("edits one routing cell and saves the exact model and effort", async () => {
  await using screen = await openPage();
  await act(async () => {
    cell(screen.container, 7, 8).click();
  });
  await change(screen.container, "Reasoning", "xhigh");
  await act(async () => {
    button(screen.container, "Save table").click();
  });

  const save = state.execute.mock.calls.find(([arg]) => arg.input._tag === "modelPolicy");
  expect(save?.[0].input.policy.codex.cells[7]?.[8]).toEqual({
    model: "gpt-6-astra",
    effort: "xhigh",
  });
});
