// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SessionOwnershipResult,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type TestThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "title" | "archivedAt" | "organization"
>;
const mocks = vi.hoisted(() => ({
  thread: null as TestThread | null,
  threads: [] as TestThread[],
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
  }>,
  read: vi.fn(),
  change: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map(
      mocks.environments.map((e) => [
        e.environmentId,
        {
          environment: { capabilities: { sessionOrganization: true } },
        },
      ]),
    ),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { label: string }) => options,
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "session-ownership:read" ? mocks.read : mocks.change,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => mocks.thread,
  useThreadShells: () => mocks.threads,
  useProjects: () => [
    { id: "accept-project", environmentId: "accept-environment", title: "Hierarchy acceptance" },
  ],
}));

import {
  SessionOrganizationDialogHost,
  openSessionOrganization,
} from "./SessionOrganizationDialog";
import { ChatSessionRole } from "./SessionRoleLabel";

const threadRef = {
  environmentId: EnvironmentId.make("accept-environment"),
  threadId: ThreadId.make("accept-session"),
};
let root: Root;
let container: HTMLDivElement;

function makeThread(id: string, title: string, ownerThreadId: string | null = null): TestThread {
  return {
    id: ThreadId.make(id),
    environmentId: threadRef.environmentId,
    projectId: ProjectId.make("accept-project"),
    title,
    archivedAt: null,
    organization: {
      owner: ownerThreadId
        ? { environmentId: threadRef.environmentId, threadId: ThreadId.make(ownerThreadId) }
        : null,
      workers: [],
      revision: 0,
      assignmentState: null,
      reportOutcome: null,
      directInputAt: null,
    },
  };
}

function relationship(ownerThreadId: string | null, revision = 1): SessionOwnershipResult {
  return {
    threadId: threadRef.threadId,
    ownerThreadId: ownerThreadId ? ThreadId.make(ownerThreadId) : null,
    ownerEnvironmentId: ownerThreadId ? threadRef.environmentId : null,
    previousOwnerThreadId: null,
    revision,
  };
}

function dialogButton(label: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ).find((element) => element.textContent === label);
  if (!button) throw new Error(`Missing dialog button: ${label}`);
  return button;
}

function selectedLabel() {
  return document.querySelector("#session-master")?.textContent;
}

async function chooseMaster(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>("#session-master");
  if (!trigger) throw new Error("Missing master selector");
  await act(async () => trigger.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (element) => element.textContent === label,
  );
  if (!option) throw new Error(`Missing master option: ${label}`);
  await act(async () => option.click());
}

beforeEach(() => {
  mocks.thread = makeThread("accept-session", "Acceptance session");
  mocks.threads = [];
  mocks.environments = [];
  mocks.read.mockReset();
  mocks.change.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (document.querySelector('[role="dialog"]'))
    await act(async () => dialogButton("Close").click());
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens from the header, closes, and reopens through the thread action command", async () => {
  await act(async () => {
    root.render(
      <>
        <ChatSessionRole threadRef={threadRef} />
        <SessionOrganizationDialogHost />
      </>,
    );
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Session organization: Independent"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Acceptance session");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "owning computer is offline",
  );
  expect(selectedLabel()).toBe("Independent");

  const close = () => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((element) => element.textContent === "Close");
    expect(button).toBeDefined();
    button!.click();
  };
  await act(async () => close());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => openSessionOrganization(threadRef));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Acceptance session");
  await act(async () => close());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("shows readable labels on open, selection, save and reopen while submitting scoped IDs", async () => {
  const source = makeThread("accept-session", "Acceptance session", "accept-master-a");
  mocks.thread = source;
  mocks.threads = [
    source,
    makeThread("accept-master-a", "Master Alpha"),
    makeThread("accept-master-b", "Master Beta"),
  ];
  mocks.environments = [
    {
      environmentId: threadRef.environmentId,
      label: "myalien",
      connection: { phase: "connected" },
    },
  ];
  mocks.read.mockResolvedValue({ _tag: "Success", value: relationship("accept-master-a") });
  mocks.change.mockResolvedValueOnce({
    _tag: "Success",
    value: relationship("accept-master-b", 2),
  });
  await act(async () => root.render(<SessionOrganizationDialogHost />));
  await act(async () => openSessionOrganization(threadRef));
  expect(selectedLabel()).toBe("Master Alpha · Hierarchy acceptance · myalien");
  await chooseMaster("Master Beta · Hierarchy acceptance · myalien");
  expect(selectedLabel()).toBe("Master Beta · Hierarchy acceptance · myalien");
  await act(async () => dialogButton("Save relationship").click());
  expect(mocks.change).toHaveBeenLastCalledWith(
    expect.objectContaining({
      environmentId: threadRef.environmentId,
      input: expect.objectContaining({
        ownerThreadId: "accept-master-b",
        ownerEnvironmentId: threadRef.environmentId,
      }),
    }),
  );
  expect(selectedLabel()).toBe("Master Beta · Hierarchy acceptance · myalien");
  await act(async () => dialogButton("Close").click());
  mocks.read.mockResolvedValue({ _tag: "Success", value: relationship("accept-master-b", 2) });
  mocks.change.mockResolvedValueOnce({ _tag: "Success", value: relationship(null, 3) });
  await act(async () => openSessionOrganization(threadRef));
  expect(selectedLabel()).toBe("Master Beta · Hierarchy acceptance · myalien");
  await chooseMaster("Independent");
  expect(selectedLabel()).toBe("Independent");
  await act(async () => dialogButton("Save relationship").click());
  expect(mocks.change).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ ownerThreadId: null }) }),
  );
  expect(selectedLabel()).toBe("Independent");
});

it.each([
  { cached: true, knownComputer: true, expected: "Master Alpha · Hierarchy acceptance · myalien" },
  { cached: false, knownComputer: true, expected: "Current master unavailable · myalien" },
  {
    cached: false,
    knownComputer: false,
    expected: "Current master unavailable · Computer unavailable",
  },
])("uses a readable offline selection: $expected", async ({ cached, knownComputer, expected }) => {
  const source = makeThread("accept-session", "Acceptance session", "accept-master-a");
  mocks.thread = source;
  mocks.threads = cached ? [source, makeThread("accept-master-a", "Master Alpha")] : [source];
  mocks.environments = knownComputer
    ? [
        {
          environmentId: threadRef.environmentId,
          label: "myalien",
          connection: { phase: "disconnected" },
        },
      ]
    : [];
  await act(async () => root.render(<SessionOrganizationDialogHost />));
  await act(async () => openSessionOrganization(threadRef));
  expect(selectedLabel()).toBe(expected);
  expect(dialogButton("Save relationship").disabled).toBe(true);
  expect(mocks.read).not.toHaveBeenCalled();
});
