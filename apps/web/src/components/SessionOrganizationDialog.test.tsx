// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({
    title: "Acceptance session",
    organization: { owner: null, workers: [] },
  }),
  useThreadShells: () => [],
  useProjects: () => [],
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
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
