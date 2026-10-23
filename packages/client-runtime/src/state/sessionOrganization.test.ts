import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  buildSessionHierarchy,
  expandSessionGroups,
  sessionKey,
  sessionRole,
  ownershipEditRequest,
  recoverOwnershipEdit,
  summarizeSessionWorkers,
} from "./sessionOrganization.ts";

const thread = (
  id: string,
  owner: string | null = null,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make("alpha"),
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
    workers: [],
    revision: 0,
    assignmentState: null,
    reportOutcome: null,
    directInputAt: null,
  },
  ...overrides,
});
const connected = new Set(["alpha", "beta"]);
describe("managed session navigation", () => {
  it("groups a cross-project worker once while retaining actual project and nested owner path", () => {
    const master = thread("master");
    const worker = thread("worker", "master", { projectId: ProjectId.make("another-project") });
    const child = thread("child", "worker");
    const independent = thread("independent");
    const hierarchy = buildSessionHierarchy([master, worker, child, independent]);
    expect(hierarchy.path(sessionKey(child))).toEqual([sessionKey(master), sessionKey(worker)]);
    const rows = expandSessionGroups({
      roots: [master, independent],
      hierarchy,
      collapsed: new Set(),
      finishedExpanded: new Set(),
      connected,
      selectedKey: null,
    });
    expect(rows.map((t) => t.id)).toEqual(["master", "worker", "child", "independent"]);
    expect(rows[1]).toBe(worker);
    expect(rows[1]?.projectId).toBe("another-project");
    expect(sessionRole(child)).toBe("Worker");
  });
  it("keeps attention and unavailable counts on collapsed groups and reveals a selected finished worker", () => {
    const master = thread("master");
    const approval = thread("approval", "master", {
      hasPendingApprovals: true,
      settledOverride: "settled",
    });
    const finished = thread("finished", "master", { settledOverride: "settled" });
    const offline = thread("offline", null, {
      environmentId: EnvironmentId.make("offline-host"),
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: "alpha", threadId: master.id },
      },
    });
    const hierarchy = buildSessionHierarchy([
      {
        ...master,
        organization: {
          ...master.organization!,
          workers: [{ environmentId: "offline-host", threadId: offline.id }],
        },
      },
      approval,
      finished,
      offline,
    ]);
    expect(summarizeSessionWorkers(hierarchy, sessionKey(master), connected)).toEqual({
      total: 3,
      running: 0,
      attention: 1,
      unknown: 1,
      finished: 1,
    });
    const input = {
      roots: [master],
      hierarchy,
      collapsed: new Set([sessionKey(master)]),
      finishedExpanded: new Set<string>(),
      connected,
      selectedKey: null,
    };
    expect(expandSessionGroups(input).map((t) => t.id)).toEqual(["master"]);
    expect(
      expandSessionGroups({ ...input, selectedKey: sessionKey(finished) }).map((t) => t.id),
    ).toEqual(["master", "approval", "offline", "finished"]);
    expect(expandSessionGroups({ ...input, collapsed: new Set() }).map((t) => t.id)).toEqual([
      "master",
      "approval",
      "offline",
    ]);
  });
  it("uses the remote master's authority and retains unknown workers without inventing idle state", () => {
    const worker = thread("same-id", "old-master", { environmentId: EnvironmentId.make("beta") });
    const master = thread("master", null, {
      organization: {
        ...thread("unused").organization!,
        workers: [
          { environmentId: "beta", threadId: worker.id },
          { environmentId: "missing-host", threadId: ThreadId.make("unavailable") },
        ],
      },
    });
    const duplicateId = thread("same-id");
    const hierarchy = buildSessionHierarchy([master, worker, duplicateId]);
    expect(hierarchy.root(sessionKey(worker))).toBe(sessionKey(master));
    expect(hierarchy.root(sessionKey(duplicateId))).toBe(sessionKey(duplicateId));
    expect(
      summarizeSessionWorkers(hierarchy, sessionKey(master), new Set(["alpha"])),
    ).toMatchObject({ total: 2, running: 0, unknown: 2 });
    expect(sessionRole(master)).toBe("Master");
  });
  it("keeps malformed legacy cycles and workers with unavailable parents navigable", () => {
    const a = thread("a", "b");
    const b = thread("b", "a");
    const orphan = thread("orphan", "unloaded");
    const hierarchy = buildSessionHierarchy([a, b, orphan]);
    const roots = [a, b, orphan].filter((t) => hierarchy.root(sessionKey(t)) === sessionKey(t));
    const rows = expandSessionGroups({
      roots,
      hierarchy,
      collapsed: new Set(),
      finishedExpanded: new Set(),
      connected,
      selectedKey: null,
    });
    expect(new Set(rows.map(sessionKey)).size).toBe(3);
    expect(hierarchy.root(sessionKey(orphan))).toBe(sessionKey(orphan));
  });
  it("reveals descendants through missing and archived intermediate conversations", () => {
    const master = thread("master", null, {
      organization: {
        ...thread("unused").organization!,
        workers: [{ environmentId: "beta", threadId: ThreadId.make("missing") }],
      },
    });
    const child = thread("child", null, {
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: "beta", threadId: ThreadId.make("missing") },
      },
    });
    const archived = thread("archived", "master", { archivedAt: "2026-10-23T01:00:00Z" });
    const grandchild = thread("grandchild", "archived");
    const hierarchy = buildSessionHierarchy([master, child, archived, grandchild]);
    expect(
      expandSessionGroups({
        roots: [master],
        hierarchy,
        collapsed: new Set(),
        finishedExpanded: new Set(),
        connected,
        selectedKey: sessionKey(child),
      }).map((t) => t.id),
    ).toEqual(["master", "grandchild", "child"]);
    const orphanHierarchy = buildSessionHierarchy([archived, grandchild]);
    expect(orphanHierarchy.root(sessionKey(grandchild))).toBe(sessionKey(grandchild));
  });

  it("shows an offline worker as independent immediately when its authority releases it", () => {
    const master = thread("master");
    const worker = thread("worker", null, {
      environmentId: EnvironmentId.make("beta"),
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: "alpha", threadId: master.id },
      },
    });
    const hierarchy = buildSessionHierarchy([master, worker]);
    expect(hierarchy.root(sessionKey(worker))).toBe(sessionKey(worker));
    const view = hierarchy.byKey.get(sessionKey(worker))!;
    expect(sessionRole(view)).toBe("Independent");
    expect(view.organization?.authorityEnvironmentId).toBe("alpha");
    expect(worker.organization?.owner?.threadId).toBe(master.id);
  });
  it("keeps pinned and explicitly reopened completed workers visible", () => {
    const master = thread("master");
    const done = {
      ...thread("unused").organization!,
      owner: { environmentId: null, threadId: master.id },
      reportOutcome: "done" as const,
    };
    const pinned = thread("pinned", "master", {
      pinnedAt: "2026-10-23T00:00:00Z",
      organization: done,
    });
    const reopened = thread("reopened", "master", {
      settledOverride: "active",
      organization: done,
    });
    const finished = thread("finished", "master", { organization: done });
    const hierarchy = buildSessionHierarchy([master, pinned, reopened, finished]);
    expect(
      expandSessionGroups({
        roots: [master],
        hierarchy,
        collapsed: new Set(),
        finishedExpanded: new Set(),
        connected,
        selectedKey: null,
      }).map((t) => t.id),
    ).toEqual(["master", "pinned", "reopened"]);
    expect(summarizeSessionWorkers(hierarchy, sessionKey(master), connected).finished).toBe(1);
  });
});

it("refreshes a confirmed ownership conflict and retries with the canonical revision in the open editor", async () => {
  const initial = {
    threadId: ThreadId.make("worker"),
    ownerThreadId: ThreadId.make("master"),
    ownerEnvironmentId: "alpha",
    previousOwnerThreadId: null,
    revision: 1,
  };
  const destination = { environmentId: "gamma", threadId: ThreadId.make("master") };
  const original = ownershipEditRequest(null, initial, destination, "original");
  const canonical = { ...initial, ownerEnvironmentId: "beta", revision: 2 };
  let reads = 0;
  const recovered = await recoverOwnershipEdit({ code: "conflict" }, async () => {
    reads++;
    return canonical;
  });
  expect(reads).toBe(1);
  expect(recovered.confirmed).toBe(true);
  const retried = ownershipEditRequest(null, recovered.relationship!, destination, "retry");
  expect(retried).toMatchObject({
    clientRequestId: "retry",
    ownerEnvironmentId: "gamma",
    expectedOwnerEnvironmentId: "beta",
    expectedRevision: 2,
  });
  expect(original.expectedRevision).toBe(1);
});

it("keeps the exact request and scoped destination after an uncertain outcome on either client", async () => {
  const relationship = {
    threadId: ThreadId.make("worker"),
    ownerThreadId: null,
    previousOwnerThreadId: null,
    revision: 0,
  };
  const pending = ownershipEditRequest(
    null,
    relationship,
    { environmentId: "beta", threadId: ThreadId.make("same-id") },
    "stable",
  );
  const recovery = await recoverOwnershipEdit(new Error("connection interrupted"), async () => {
    throw new Error("must not discard an uncertain commit by reading a stale relationship");
  });
  expect(recovery.confirmed).toBe(false);
  expect(
    ownershipEditRequest(
      pending,
      relationship,
      { environmentId: "gamma", threadId: ThreadId.make("same-id") },
      "new",
    ),
  ).toBe(pending);
  expect(ownershipEditRequest(pending, relationship, null, "release")).toBe(pending);
});

it("uses canonical relationship revisions when disconnected master mirrors disagree", () => {
  const oldMaster = thread("master", null, {
    environmentId: EnvironmentId.make("alpha"),
    organization: {
      ...thread("empty").organization!,
      workers: [{ environmentId: "beta", threadId: ThreadId.make("worker"), revision: 1 }],
    },
  });
  const currentMaster = thread("master", null, {
    environmentId: EnvironmentId.make("gamma"),
    organization: {
      ...thread("empty").organization!,
      workers: [{ environmentId: "beta", threadId: ThreadId.make("worker"), revision: 2 }],
    },
  });
  const worker = thread("worker", null, {
    environmentId: EnvironmentId.make("beta"),
    organization: {
      ...thread("empty").organization!,
      authorityEnvironmentId: "beta",
      revision: 1,
      owner: { environmentId: "alpha", threadId: oldMaster.id },
    },
  });
  for (const masters of [
    [oldMaster, currentMaster],
    [currentMaster, oldMaster],
  ]) {
    const hierarchy = buildSessionHierarchy([worker, ...masters]);
    expect(hierarchy.path(sessionKey(worker))).toEqual([sessionKey(currentMaster)]);
  }
  const released = {
    ...worker,
    organization: { ...worker.organization!, owner: null, revision: 3 },
  };
  const hierarchy = buildSessionHierarchy([released, currentMaster, oldMaster]);
  expect(hierarchy.path(sessionKey(released))).toEqual([]);
  expect(sessionRole(hierarchy.byKey.get(sessionKey(released))!)).toBe("Independent");
});
