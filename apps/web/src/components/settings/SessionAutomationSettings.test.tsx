// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  projectUpdate: vi.fn(),
  projects: [{ id: "project", environmentId: "remote", basePrompt: "Understand project" }],
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.projectUpdate }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: ["remote"] },
    connectedEnvironments: [{}],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
import { ProjectBasePromptSettings } from "./ProjectBasePromptSettings";
import { SessionRenewalSettings } from "./SessionRenewalSettings";

let root: Root;
let container: HTMLDivElement;
const members = [{ id: ProjectId.make("project"), environmentId: EnvironmentId.make("remote") }];
const change = async (element: HTMLInputElement | HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("changes only the selected limit and clears a hard limit without changing the soft one", async () => {
  await act(async () => root.render(<SessionRenewalSettings />));
  const hard = container.querySelector<HTMLInputElement>(
    'input[aria-label="Master automatic renewal (hours)"]',
  )!;
  await change(hard, "4.25");
  await act(async () => hard.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.update).toHaveBeenLastCalledWith({ workerRenewal: { masterHardHours: 4.25 } });
  const warning = container.querySelector<HTMLInputElement>(
    'input[aria-label="Worker warning (hours)"]',
  )!;
  await change(warning, "-1");
  await act(async () => warning.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("valid value");
});

it("keeps edits made during Save and sends the prompt only to the selected project", async () => {
  let resolve!: (value: { _tag: "Success" }) => void;
  mocks.projectUpdate.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<ProjectBasePromptSettings members={members} />));
  const textarea = container.querySelector("textarea")!;
  await change(textarea, "Learn architecture and test conventions.");
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.projectUpdate).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { projectId: "project", basePrompt: "Learn architecture and test conventions." },
  });
  await change(textarea, "Newer draft while saving");
  await act(async () => resolve({ _tag: "Success" }));
  expect(textarea.value).toBe("Newer draft while saving");
});

it("saves communication duration edits immediately and accepts zero without a reload", async () => {
  const { WorkerCommunicationSettings } = await import("./WorkerCommunicationSettings");
  await act(async () => root.render(<WorkerCommunicationSettings />));
  let input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Worker communication window (minutes)"]',
  )!;
  expect(input.value).toBe("15");
  await change(input, "7.5");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.update).toHaveBeenLastCalledWith({ workerCommunicationWindowMinutes: 7.5 });
  input = container.querySelector("input")!;
  await change(input, "0");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.update).toHaveBeenLastCalledWith({ workerCommunicationWindowMinutes: 0 });
  await change(input, "-1");
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("positive");
});
