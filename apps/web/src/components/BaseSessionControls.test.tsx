// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { retainBaseSubmission } from "@t3tools/client-runtime/state/base-sessions";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  start: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  configuration: vi.fn(),
  projects: [{ id: "project", environmentId: "remote", basePrompt: "Learn conventions" }],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_: unknown, options: { label: string }) => options,
  squashAtomCommandFailure: (result: { cause: Error }) => result.cause,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../state/threads", () => ({
  threadEnvironment: { startTurn: { label: "start" }, updateMetadata: { label: "metadata" } },
}));
vi.mock("../state/projects", () => ({ projectEnvironment: { update: { label: "project" } } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "start"
      ? mocks.start
      : command.label === "base-sessions:create"
        ? mocks.create
        : mocks.configuration,
}));
import { BaseSessionControls } from "./BaseSessionControls";

const thread = {
  id: ThreadId.make("base"),
  projectId: ProjectId.make("project"),
  environmentId: EnvironmentId.make("remote"),
  isBase: true,
  modelSelection: { instanceId: ProviderInstanceId.make("account"), model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
} as EnvironmentThreadShell;
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () =>
    root.render(<BaseSessionControls thread={thread} onNavigate={mocks.close} />),
  );
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects[0]!.basePrompt = "Learn conventions";
  localStorage.clear();
  mocks.configuration.mockResolvedValue({ _tag: "Success", value: { candidates: [] } });
  mocks.navigate
    .mockRejectedValueOnce(new Error("Route could not load"))
    .mockResolvedValue(undefined);
  mocks.start.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { threadId: input.initializeBase ? input.threadId : ThreadId.make("fork") },
  }));
  mocks.create.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { threadId: input.threadId },
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it.each([
  ["Create and initialize new Base", "remote:project:create-base", "create"],
  ["Initialize / refresh Base", "t3code:base-initialize:remote:base", "start"],
] as const)(
  "opens the confirmed destination after a failed route for %s, including remount",
  async (label, key, rpc) => {
    await render();
    await click(label);
    expect(mocks[rpc]).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Base request completed");
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved.confirmedThreadId).toBeTruthy();
    mocks.projects[0]!.basePrompt = "Changed after confirmation";
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await click(label);
    expect(mocks[rpc]).toHaveBeenCalledTimes(1);
    expect(mocks.navigate.mock.calls[1]![0].params.threadId).toBe(saved.confirmedThreadId);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBeNull();
  },
);
it("checks a prior task once and subsequently opens its confirmed fork without sending", async () => {
  const key = "t3code:base-submission:remote:base";
  await retainBaseSubmission(
    {
      read: async () => localStorage.getItem(key),
      write: async (value) => {
        localStorage.setItem(key, value);
      },
      clear: async () => {
        localStorage.removeItem(key);
      },
    },
    {
      commandId: CommandId.make("task"),
      createdAt: "2026-10-24T12:00:00Z",
      threadId: thread.id,
      message: {
        messageId: MessageId.make("task"),
        role: "user",
        text: "Implement this",
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    },
  );
  await render();
  await click("Check previous task");
  expect(container.textContent).toContain("Base request completed");
  expect(mocks.close).not.toHaveBeenCalled();
  await click("Check previous task");
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledTimes(2);
  expect(JSON.parse(localStorage.getItem(key)!).confirmedThreadId).toBe("fork");
});
