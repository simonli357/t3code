// @vitest-environment jsdom

import { act, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ManagedSessionRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  buildSessionHierarchy,
  expandSessionGroups,
  sessionKey,
  sessionListRoot,
  settledWorkerKeys,
  summarizeSessionWorkers,
} from "@t3tools/client-runtime/state/session-organization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./SessionOrganizationDialog", () => ({ openSessionOrganization: vi.fn() }));
vi.mock("../state/entities", () => ({ useThreadShell: () => null, useThreadShells: () => [] }));

import {
  EXPANDED_MASTERS_STORAGE_KEY,
  useSessionGroupExpansion,
} from "../hooks/useSessionGroupExpansion";
import { SessionGroupHeader } from "./SessionGroupHeader";
import { SessionRoleLabel } from "./SessionRoleLabel";

const alpha = EnvironmentId.make("alpha");
const connected = new Set<string>([alpha]);
function thread(
  id: string,
  owner: string | null = null,
  overrides: Partial<EnvironmentThreadShell> = {},
  workers: ManagedSessionRef[] = [],
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: alpha,
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pullRequests: [],
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    organization: {
      owner: owner ? { environmentId: null, threadId: ThreadId.make(owner) } : null,
      workers,
      revision: 0,
      assignmentState: null,
      reportOutcome: null,
      directInputAt: null,
    },
    ...overrides,
  };
}

const masterKey = sessionKey(thread("master"));

const isSettledThread = (t: EnvironmentThreadShell) => t.settledOverride === "settled";

/**
 * The sidebar's grouping, minus rows: the real hook, the settled rule, expansion
 * rules and header. Settled threads, workers included, have their own shelf.
 */
function GroupedList(props: { threads: EnvironmentThreadShell[]; selectedKey?: string | null }) {
  const { expanded, toggle } = useSessionGroupExpansion();
  const hierarchy = useMemo(() => buildSessionHierarchy(props.threads), [props.threads]);
  const settled = useMemo(() => settledWorkerKeys(hierarchy, isSettledThread), [hierarchy]);
  const topLevel = props.threads.filter(
    (t) => sessionListRoot(hierarchy, sessionKey(t), settled) === sessionKey(t),
  );
  const shelf = (name: string, roots: EnvironmentThreadShell[]) => (
    <ul data-shelf={name}>
      {expandSessionGroups({
        roots,
        hierarchy,
        expanded,
        finishedExpanded: new Set(),
        connected,
        selectedKey: props.selectedKey ?? null,
        settled,
      }).flatMap((row) => {
        const key = sessionKey(row);
        const summary =
          hierarchy.children.has(key) && !settled.has(key)
            ? summarizeSessionWorkers(hierarchy, key, connected, settled)
            : null;
        return [
          <li key={key} data-row={row.id}>
            {row.title}
          </li>,
          // Only a group with active workers gets a header.
          ...(summary && summary.total > 0 && sessionListRoot(hierarchy, key, settled) === key
            ? [
                <SessionGroupHeader
                  key={`${key}:header`}
                  title={row.title}
                  summary={summary}
                  expanded={expanded.has(key)}
                  onToggle={() => toggle(key)}
                />,
              ]
            : []),
        ];
      })}
    </ul>
  );
  return (
    <>
      {shelf(
        "active",
        topLevel.filter((t) => !isSettledThread(t)),
      )}
      {shelf("settled", topLevel.filter(isSettledThread))}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
const rows = (shelf?: "active" | "settled") =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      shelf === undefined ? "[data-row]" : `[data-shelf=${shelf}] [data-row]`,
    ),
  ).map((el) => el.dataset.row);
const header = () =>
  container.querySelector<HTMLButtonElement>("[data-testid=session-group-header] button")!;
const render = (node: ReactNode) => act(async () => root.render(node));

function groupOf(
  workerCount: number,
  overrides: Partial<EnvironmentThreadShell> = {},
  remoteWorkers: ManagedSessionRef[] = [],
) {
  const workerIds = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
  return [
    thread("master", null, {}, [
      ...workerIds.map((id) => ({ environmentId: null, threadId: ThreadId.make(id) })),
      ...remoteWorkers,
    ]),
    ...workerIds.map((id, i) => thread(id, "master", i === 0 ? overrides : {})),
  ];
}

beforeEach(() => {
  localStorage.clear();
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

describe("worker groups", () => {
  it("start collapsed and open only when the user opens them, then remember the choice", async () => {
    await render(<GroupedList threads={groupOf(3)} />);
    expect(rows()).toEqual(["master"]);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(header().getAttribute("aria-label")).toBe("Expand workers of master: 3 workers");

    await act(async () => header().click());
    expect(rows()).toEqual(["master", "worker-0", "worker-1", "worker-2"]);
    expect(header().getAttribute("aria-expanded")).toBe("true");
    expect(JSON.parse(localStorage.getItem(EXPANDED_MASTERS_STORAGE_KEY)!)).toEqual([masterKey]);

    // A fresh mount (a reload or another route) restores the open group.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(<GroupedList threads={groupOf(3)} />);
    expect(rows()).toEqual(["master", "worker-0", "worker-1", "worker-2"]);

    await act(async () => header().click());
    expect(rows()).toEqual(["master"]);
    expect(JSON.parse(localStorage.getItem(EXPANDED_MASTERS_STORAGE_KEY)!)).toEqual([]);
  });

  it("stay collapsed for users whose retired setting listed nothing, and never undo a later choice", async () => {
    // The retired list named the collapsed groups, so [] meant "everything open".
    localStorage.setItem("sidebar-collapsed-masters", "[]");
    await render(<GroupedList threads={groupOf(2)} />);
    expect(rows()).toEqual(["master"]);

    await act(async () => header().click());
    expect(rows()).toEqual(["master", "worker-0", "worker-1"]);
    // Re-rendering for unrelated reasons keeps the user's choice.
    await render(<GroupedList threads={groupOf(2)} />);
    await render(<GroupedList threads={[...groupOf(2)]} />);
    expect(rows()).toEqual(["master", "worker-0", "worker-1"]);
  });

  it("ignore what the retired setting says about collapsed groups", async () => {
    localStorage.setItem("sidebar-collapsed-masters", JSON.stringify([masterKey]));
    await render(<GroupedList threads={groupOf(2)} />);
    expect(rows()).toEqual(["master"]);
    await act(async () => header().click());
    expect(rows()).toEqual(["master", "worker-0", "worker-1"]);
  });

  it("stay as the user left them when workers arrive or change status, and say so honestly", async () => {
    await render(<GroupedList threads={groupOf(2)} />);
    const unseen = ThreadId.make("unseen");
    await render(
      <GroupedList
        threads={[
          ...groupOf(4, { hasPendingApprovals: true }, [
            { environmentId: "offline", threadId: unseen },
          ]),
          thread("unseen", null, {
            environmentId: EnvironmentId.make("offline"),
            organization: {
              ...thread("unused").organization!,
              owner: { environmentId: alpha, threadId: ThreadId.make("master") },
            },
          }),
        ]}
      />,
    );
    expect(rows()).toEqual(["master"]);
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(header().getAttribute("aria-label")).toBe(
      "Expand workers of master: 5 workers, 1 needs attention, 1 offline or unknown",
    );
    expect(container.querySelector("[data-testid=session-group-attention]")?.textContent).toContain(
      "1",
    );
    expect(container.querySelector("[data-testid=session-group-unavailable]")).not.toBeNull();
    // Nothing is known to be running, and the header does not claim zero running.
    expect(container.querySelector("[data-testid=session-group-running]")).toBeNull();

    await act(async () => header().click());
    await render(<GroupedList threads={[...groupOf(4), thread("worker-late", "master")]} />);
    expect(rows()).toEqual([
      "master",
      "worker-0",
      "worker-1",
      "worker-2",
      "worker-3",
      "worker-late",
    ]);
  });

  it("keep the open conversation visible without opening the group", async () => {
    const threads = groupOf(3);
    const selected = sessionKey(threads[2]!);
    await render(<GroupedList threads={threads} selectedKey={selected} />);
    expect(rows()).toEqual(["master", "worker-1"]);
    expect(header().getAttribute("aria-expanded")).toBe("false");

    await act(async () => header().click());
    expect(rows()).toEqual(["master", "worker-0", "worker-1", "worker-2"]);
    await act(async () => header().click());
    expect(rows()).toEqual(["master", "worker-1"]);
  });
});

describe("session role label", () => {
  const withRole = (overrides: Partial<EnvironmentThreadShell["organization"] & object>) => {
    const base = thread("t");
    return { ...base, organization: { ...base.organization!, ...overrides } };
  };
  const labelText = async (node: ReactNode) => {
    await render(node);
    return container.textContent;
  };

  it("marks masters, keeps a worker's role where no group header names it, and hides the default", async () => {
    const master = withRole({ workers: [{ environmentId: null, threadId: ThreadId.make("w") }] });
    const worker = withRole({ owner: { environmentId: null, threadId: ThreadId.make("m") } });
    expect(await labelText(<SessionRoleLabel thread={master} />)).toBe("Master");
    expect(await labelText(<SessionRoleLabel thread={worker} />)).toBe("Worker");
    expect(await labelText(<SessionRoleLabel thread={worker} nested />)).toBe("");
    expect(await labelText(<SessionRoleLabel thread={thread("solo")} />)).toBe("");
    // Direct input is information, not decoration: it survives the nested rule.
    const direct = withRole({
      owner: { environmentId: null, threadId: ThreadId.make("m") },
      directInputAt: "2026-10-23T01:00:00Z",
    });
    expect(await labelText(<SessionRoleLabel thread={direct} nested />)).toBe("Direct input");
    expect(await labelText(<SessionRoleLabel thread={direct} />)).toBe("Worker · Direct input");
  });
});

describe("settled workers", () => {
  const refs = (...ids: string[]) =>
    ids.map((id) => ({ environmentId: null, threadId: ThreadId.make(id) }));
  const blocked = {
    ...thread("unused").organization!,
    owner: { environmentId: null, threadId: ThreadId.make("master") },
    reportOutcome: "blocked" as const,
  };

  it("leave an open group and its count when settled, and return when un-settled", async () => {
    const group = (b: Partial<EnvironmentThreadShell> = {}) => [
      thread("master", null, {}, refs("a", "b", "c")),
      thread("a", "master"),
      thread("b", "master", b),
      thread("c", "master"),
    ];
    await render(<GroupedList threads={group()} />);
    await act(async () => header().click());
    expect(rows("active")).toEqual(["master", "a", "b", "c"]);
    expect(header().getAttribute("aria-label")).toBe("Collapse workers of master: 3 workers");

    // Settled elsewhere (another client, an auto rule): b gets its own row in Settled and
    // stops counting, while the group stays exactly as the user left it.
    await render(<GroupedList threads={group({ settledOverride: "settled" })} />);
    expect(rows("active")).toEqual(["master", "a", "c"]);
    expect(rows("settled")).toEqual(["b"]);
    expect(header().getAttribute("aria-label")).toBe("Collapse workers of master: 2 workers");

    // Resumed, it goes back to its group.
    await render(<GroupedList threads={group({ settledOverride: "active" })} />);
    expect(rows("active")).toEqual(["master", "a", "b", "c"]);
    expect(rows("settled")).toEqual([]);
    expect(header().getAttribute("aria-label")).toBe("Collapse workers of master: 3 workers");
  });

  it("leave no attention behind when settled with an old blocked report", async () => {
    const group = (settledOverride: "settled" | "active") => [
      thread("master", null, {}, refs("a", "b")),
      thread("a", "master"),
      thread("b", "master", { settledOverride, organization: blocked }),
    ];
    await render(<GroupedList threads={group("settled")} />);
    await act(async () => header().click());
    // Open, the group shows no ghost row for the settled worker, and nothing needs attention.
    expect(rows("active")).toEqual(["master", "a"]);
    expect(rows("settled")).toEqual(["b"]);
    expect(header().getAttribute("aria-label")).toBe("Collapse workers of master: 1 worker");
    expect(container.querySelector("[data-testid=session-group-attention]")).toBeNull();

    // The same report counts again the moment the worker is active.
    await render(<GroupedList threads={group("active")} />);
    expect(rows("active")).toEqual(["master", "a", "b"]);
    expect(header().getAttribute("aria-label")).toBe(
      "Collapse workers of master: 2 workers, 1 needs attention",
    );
    expect(container.querySelector("[data-testid=session-group-attention]")).not.toBeNull();
  });

  it("give a master with only settled workers no disclosure and keep a selected one in Settled", async () => {
    const threads = [
      thread("master", null, {}, refs("a", "b")),
      thread("a", "master", { settledOverride: "settled" }),
      thread("b", "master", { settledOverride: "settled" }),
    ];
    await render(<GroupedList threads={threads} selectedKey={sessionKey(threads[1]!)} />);
    expect(container.querySelector("[data-testid=session-group-header]")).toBeNull();
    expect(rows("active")).toEqual(["master"]);
    // The open conversation is reached through Settled, not re-inserted under its master.
    expect(rows("settled")).toEqual(["a", "b"]);
  });
});
