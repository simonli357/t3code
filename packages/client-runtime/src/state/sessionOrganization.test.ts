import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./models.ts";
import {
  buildSessionHierarchy,
  describeSessionOwner,
  describeSessionRole,
  describeSessionWorkers,
  expandSessionGroups,
  sessionGroupDepth,
  sessionKey,
  sessionListRoot,
  sessionOwnerChain,
  sessionRole,
  ownershipEditRequest,
  recoverOwnershipEdit,
  settledWorkerKeys,
  summarizeSessionWorkers,
  toggleSessionGroupKey,
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
// No settlement rule applies: what a server without the settlement capability sees.
const noneSettled: ReadonlySet<string> = new Set();
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
      expanded: new Set([sessionKey(master)]),
      finishedExpanded: new Set(),
      connected,
      selectedKey: null,
      settled: noneSettled,
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
    expect(summarizeSessionWorkers(hierarchy, sessionKey(master), connected, noneSettled)).toEqual({
      total: 3,
      running: 0,
      attention: 1,
      unknown: 1,
      finished: 1,
    });
    const input = {
      roots: [master],
      hierarchy,
      expanded: new Set<string>(),
      finishedExpanded: new Set<string>(),
      connected,
      selectedKey: null,
      settled: noneSettled,
    };
    expect(expandSessionGroups(input).map((t) => t.id)).toEqual(["master"]);
    expect(
      expandSessionGroups({ ...input, selectedKey: sessionKey(finished) }).map((t) => t.id),
    ).toEqual(["master", "finished"]);
    expect(
      expandSessionGroups({ ...input, expanded: new Set([sessionKey(master)]) }).map((t) => t.id),
    ).toEqual(["master", "approval", "offline"]);
  });
  it("opens only the groups the user opened, however many workers arrive or change status", () => {
    const masters = ["first", "second"].map((id) => thread(id));
    const workers = (count: number, overrides: Partial<EnvironmentThreadShell> = {}) =>
      Array.from({ length: count }, (_, index) =>
        thread(`worker-${index}`, "first", index === 0 ? overrides : {}),
      );
    const rows = (all: EnvironmentThreadShell[], expanded: ReadonlySet<string>) =>
      expandSessionGroups({
        roots: masters,
        hierarchy: buildSessionHierarchy(all),
        expanded,
        finishedExpanded: new Set(),
        connected,
        selectedKey: null,
        settled: noneSettled,
      }).map((t) => t.id);
    const none = new Set<string>();
    expect(rows([...masters, ...workers(3)], none)).toEqual(["first", "second"]);
    expect(rows([...masters, ...workers(5, { hasPendingApprovals: true })], none)).toEqual([
      "first",
      "second",
    ]);
    const firstOpen = new Set([sessionKey(masters[0]!)]);
    expect(rows([...masters, ...workers(2)], firstOpen)).toEqual([
      "first",
      "worker-0",
      "worker-1",
      "second",
    ]);
    // A late arrival joins the group the user opened and no other.
    expect(rows([...masters, ...workers(3), thread("late", "second")], firstOpen)).toEqual([
      "first",
      "worker-0",
      "worker-1",
      "worker-2",
      "second",
    ]);
  });
  it("shows only the selected worker in a collapsed group and leaves other groups alone", () => {
    const first = thread("first");
    const second = thread("second");
    const open = thread("open", "first");
    const sibling = thread("sibling", "first");
    const nested = thread("nested", "open");
    const elsewhere = thread("elsewhere", "second");
    const hierarchy = buildSessionHierarchy([first, second, open, sibling, nested, elsewhere]);
    const base = {
      roots: [first, second],
      hierarchy,
      expanded: new Set<string>(),
      finishedExpanded: new Set<string>(),
      connected,
      settled: noneSettled,
    };
    expect(
      expandSessionGroups({ ...base, selectedKey: sessionKey(open) }).map((t) => t.id),
    ).toEqual(["first", "open", "second"]);
    expect(
      expandSessionGroups({ ...base, selectedKey: sessionKey(nested) }).map((t) => t.id),
    ).toEqual(["first", "nested", "second"]);
    expect(
      expandSessionGroups({ ...base, selectedKey: sessionKey(first) }).map((t) => t.id),
    ).toEqual(["first", "second"]);
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
      summarizeSessionWorkers(hierarchy, sessionKey(master), new Set(["alpha"]), noneSettled),
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
      expanded: new Set(roots.map(sessionKey)),
      finishedExpanded: new Set(),
      connected,
      selectedKey: null,
      settled: noneSettled,
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
    const input = {
      roots: [master],
      hierarchy,
      expanded: new Set([sessionKey(master)]),
      finishedExpanded: new Set<string>(),
      connected,
      selectedKey: sessionKey(child),
      settled: noneSettled,
    };
    expect(expandSessionGroups(input).map((t) => t.id)).toEqual(["master", "grandchild", "child"]);
    expect(expandSessionGroups({ ...input, expanded: new Set() }).map((t) => t.id)).toEqual([
      "master",
      "child",
    ]);
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
        expanded: new Set([sessionKey(master)]),
        finishedExpanded: new Set(),
        connected,
        selectedKey: null,
        settled: noneSettled,
      }).map((t) => t.id),
    ).toEqual(["master", "pinned", "reopened"]);
    expect(
      summarizeSessionWorkers(hierarchy, sessionKey(master), connected, noneSettled).finished,
    ).toBe(1);
  });
  it("describes worker status without turning unknown workers into zero", () => {
    expect(
      describeSessionWorkers({ total: 13, running: 0, attention: 0, unknown: 0, finished: 4 }),
    ).toEqual({ total: "13 workers", parts: [], text: "13 workers" });
    const mixed = describeSessionWorkers({
      total: 13,
      running: 2,
      attention: 1,
      unknown: 6,
      finished: 0,
    });
    expect(mixed.parts).toEqual([
      { kind: "attention", count: 1, phrase: "needs attention" },
      { kind: "running", count: 2, phrase: "running" },
      { kind: "unavailable", count: 6, phrase: "offline or unknown" },
    ]);
    expect(mixed.text).toBe("13 workers, 1 needs attention, 2 running, 6 offline or unknown");
    // Unavailable workers are reported even when nothing known is running.
    const unseen = describeSessionWorkers({
      total: 4,
      running: 0,
      attention: 3,
      unknown: 1,
      finished: 0,
    });
    expect(unseen.text).toBe("4 workers, 3 need attention, 1 offline or unknown");
    expect(unseen.text).not.toContain("running");
    expect(
      describeSessionWorkers({ total: 1, running: 1, attention: 0, unknown: 0, finished: 0 }).text,
    ).toBe("1 worker, 1 running");
  });
  it("names an owner by title and computer and keeps an unavailable owner's identity out of the row", () => {
    const master = thread("master", null, { title: "Fleet master" });
    const worker = thread("worker", "master");
    const missingId = ThreadId.make("b100c296-4625-440b-a19e-cf296b1f4a77");
    const orphan = thread("orphan", null, {
      environmentId: EnvironmentId.make("beta"),
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: "gamma", threadId: missingId },
      },
    });
    const hierarchy = buildSessionHierarchy([master, worker, orphan]);
    const computers: Record<string, string> = { alpha: "myalien", gamma: "myacer" };
    const label = (environmentId: string) => computers[environmentId] ?? null;
    expect(
      describeSessionOwner(sessionOwnerChain(hierarchy, sessionKey(worker)), label),
    ).toMatchObject({
      available: true,
      text: "Master: Fleet master · myalien",
      ariaLabel: "Worker of Fleet master",
    });
    const unavailable = describeSessionOwner(
      sessionOwnerChain(hierarchy, sessionKey(orphan)),
      label,
    )!;
    expect(unavailable.available).toBe(false);
    // The caption names the gap once; it does not say "Master: Master unavailable".
    expect(unavailable.text).toBe("Master unavailable · myacer");
    expect(unavailable.ariaLabel).toBe("Worker, master unavailable");
    expect(unavailable.detail).toContain(missingId);
    expect(unavailable.detail).toContain("myacer");
    // An unknown computer is left out of the row, never replaced by an identifier.
    expect(
      describeSessionOwner(sessionOwnerChain(hierarchy, sessionKey(orphan)), () => null)!.text,
    ).toBe("Master unavailable");
    expect(
      describeSessionOwner(sessionOwnerChain(hierarchy, sessionKey(master)), label),
    ).toBeNull();
  });
  it("reports how deep a row sits below its group header and names archived owners honestly", () => {
    const master = thread("master");
    const worker = thread("worker", "master");
    const child = thread("child", "worker");
    const orphan = thread("orphan", "unloaded");
    const archivedMaster = thread("old-master", null, { archivedAt: "2026-10-23T01:00:00Z" });
    const released = thread("of-archived", "old-master");
    const hierarchy = buildSessionHierarchy([
      master,
      worker,
      child,
      orphan,
      archivedMaster,
      released,
    ]);
    expect(
      [master, worker, child, orphan, released].map((t) =>
        sessionGroupDepth(hierarchy, sessionKey(t), noneSettled),
      ),
    ).toEqual([0, 1, 2, 0, 0]);
    const nested = describeSessionOwner(
      sessionOwnerChain(hierarchy, sessionKey(child)),
      () => "myalien",
    )!;
    expect(nested.text).toBe("Master: worker · myalien");
    expect(nested.detail).toContain("master · myalien › worker · myalien");
    expect(
      describeSessionOwner(sessionOwnerChain(hierarchy, sessionKey(released)), () => null)!.text,
    ).toBe("Master: old-master (archived)");
  });
  it("names the role a row still needs to say and stays silent about the rest", () => {
    const withOrganization = (
      overrides: Partial<NonNullable<EnvironmentThreadShell["organization"]>>,
    ) => {
      const base = thread("t");
      return { organization: { ...base.organization!, ...overrides } };
    };
    const master = withOrganization({
      workers: [{ environmentId: null, threadId: ThreadId.make("w") }],
    });
    const worker = withOrganization({
      owner: { environmentId: null, threadId: ThreadId.make("m") },
    });
    const direct = withOrganization({
      owner: { environmentId: null, threadId: ThreadId.make("m") },
      directInputAt: "2026-10-23T01:00:00Z",
    });
    expect(describeSessionRole(master, { nested: false })).toMatchObject({
      text: "Master",
      master: true,
      ariaLabel: "Session role: Master",
    });
    expect(describeSessionRole(worker, { nested: false })?.text).toBe("Worker");
    // The group header already names a nested worker, and Independent is the default.
    expect(describeSessionRole(worker, { nested: true })).toBeNull();
    expect(describeSessionRole(thread("solo"), { nested: false })).toBeNull();
    expect(describeSessionRole({ organization: undefined }, { nested: false })).toBeNull();
    // Direct input survives the nested rule, and the accessible name keeps the real role.
    expect(describeSessionRole(direct, { nested: true })).toMatchObject({
      text: "Direct input",
      master: false,
      ariaLabel: "Session role: Worker, direct input",
    });
    expect(describeSessionRole(direct, { nested: false })?.text).toBe("Worker · Direct input");
  });
  it("toggles one group and leaves every other choice alone", () => {
    const open = ["alpha:first"];
    expect(toggleSessionGroupKey(open, "alpha:second")).toEqual(["alpha:first", "alpha:second"]);
    expect(toggleSessionGroupKey(["alpha:first", "alpha:second"], "alpha:first")).toEqual([
      "alpha:second",
    ]);
    expect(toggleSessionGroupKey([], "alpha:first")).toEqual(["alpha:first"]);
    expect(open).toEqual(["alpha:first"]);
  });
});

describe("settled workers", () => {
  const isSettled = (t: EnvironmentThreadShell) => t.settledOverride === "settled";
  const openGroup = (master: EnvironmentThreadShell, all: EnvironmentThreadShell[]) => {
    const hierarchy = buildSessionHierarchy(all);
    const settled = settledWorkerKeys(hierarchy, isSettled);
    return {
      hierarchy,
      settled,
      input: {
        roots: [master],
        hierarchy,
        expanded: new Set([sessionKey(master)]),
        finishedExpanded: new Set<string>(),
        connected,
        selectedKey: null,
        settled,
      },
      summary: summarizeSessionWorkers(hierarchy, sessionKey(master), connected, settled),
    };
  };
  const ids = (rows: ReadonlyArray<EnvironmentThreadShell>) => rows.map((t) => t.id);

  it("leave the group and its counts, stale state included, and return when un-settled", () => {
    const master = thread("master");
    const active = thread("active", "master");
    const settled = thread("settled", "master", { settledOverride: "settled" });
    // Settled long after a blocked report: the old report must not leave a ghost row or count.
    const blocked = {
      ...thread("unused").organization!,
      owner: { environmentId: null, threadId: master.id },
      reportOutcome: "blocked" as const,
    };
    const stale = thread("stale", "master", { settledOverride: "settled", organization: blocked });

    const parked = openGroup(master, [master, active, settled, stale]);
    expect([...parked.settled].sort()).toEqual([sessionKey(settled), sessionKey(stale)].sort());
    expect(ids(expandSessionGroups(parked.input))).toEqual(["master", "active"]);
    expect(parked.summary).toMatchObject({ total: 1, attention: 0, unknown: 0 });

    // Un-settled, the worker is active again and belongs to the group with its real state.
    const resumed = openGroup(master, [
      master,
      active,
      settled,
      { ...stale, settledOverride: "active" },
    ]);
    expect(ids(expandSessionGroups(resumed.input))).toEqual(["master", "active", "stale"]);
    expect(resumed.summary).toMatchObject({ total: 2, attention: 1 });
  });

  it("keep a selected settled worker out of its master's closed group", () => {
    const master = thread("master");
    const kept = thread("kept", "master");
    const done = thread("done", "master", { settledOverride: "settled" });
    const closed = openGroup(master, [master, kept, done]);
    const input = { ...closed.input, expanded: new Set<string>(), selectedKey: sessionKey(done) };

    // The open conversation is found in Settled, so the closed group reveals nothing for it.
    expect(sessionListRoot(closed.hierarchy, sessionKey(done), closed.settled)).toBe(
      sessionKey(done),
    );
    expect(ids(expandSessionGroups(input))).toEqual(["master"]);
    expect(ids(expandSessionGroups({ ...input, roots: [done] }))).toEqual(["done"]);
    // Opening the group does not bring it back either.
    expect(ids(expandSessionGroups({ ...closed.input, selectedKey: sessionKey(done) }))).toEqual([
      "master",
      "kept",
    ]);
    // An active selected worker keeps its narrow reveal.
    expect(ids(expandSessionGroups({ ...input, selectedKey: sessionKey(kept) }))).toEqual([
      "master",
      "kept",
    ]);
  });

  it("leave no trace of a selected settled worker beneath its master, folds included", () => {
    const master = thread("master");
    // Reported done and still unsettled: it waits in the group's Finished fold.
    const finishedMid = thread("mid", "master", {
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: null, threadId: master.id },
        reportOutcome: "done",
      },
    });
    const settledDeep = thread("deep", "mid", { settledOverride: "settled" });
    const parked = openGroup(master, [master, finishedMid, settledDeep]);
    // The open conversation is reached through Settled, so it opens no fold on the way.
    expect(
      ids(expandSessionGroups({ ...parked.input, selectedKey: sessionKey(settledDeep) })),
    ).toEqual(["master"]);

    // An active conversation in the same place does keep the fold on its path open.
    const activeDeep = thread("deep", "mid");
    const reached = openGroup(master, [master, finishedMid, activeDeep]);
    expect(
      ids(expandSessionGroups({ ...reached.input, selectedKey: sessionKey(activeDeep) })),
    ).toEqual(["master", "deep", "mid"]);
  });

  it("keep their active descendants in the group above without reassigning them", () => {
    const master = thread("master");
    const middle = thread("middle", "master", { settledOverride: "settled" });
    const leaf = thread("leaf", "middle");
    const group = openGroup(master, [master, middle, leaf]);
    const leafKey = sessionKey(leaf);

    expect(ids(expandSessionGroups(group.input))).toEqual(["master", "leaf"]);
    expect(group.summary).toMatchObject({ total: 1 });
    // The leaf's real owner is still the settled worker: it is named, not hidden or replaced.
    const chain = sessionOwnerChain(group.hierarchy, leafKey);
    expect(chain.map((owner) => owner.key)).toEqual([sessionKey(master), sessionKey(middle)]);
    expect(describeSessionOwner(chain, () => null)?.text).toBe("Master: middle");
    expect(sessionGroupDepth(group.hierarchy, leafKey, group.settled)).toBe(2);
    // The settled worker is its own row and heads no group, so nothing is listed twice.
    expect(sessionGroupDepth(group.hierarchy, sessionKey(middle), group.settled)).toBe(0);
    expect(
      ids(
        expandSessionGroups({
          ...group.input,
          roots: [middle],
          expanded: new Set([sessionKey(middle)]),
        }),
      ),
    ).toEqual(["middle"]);
    // Selecting the leaf reveals it through the closed group.
    expect(
      ids(expandSessionGroups({ ...group.input, expanded: new Set(), selectedKey: leafKey })),
    ).toEqual(["master", "leaf"]);
  });

  it("leave a master whose workers are all settled with nothing to count", () => {
    const master = thread("master");
    const group = openGroup(master, [
      master,
      thread("a", "master", { settledOverride: "settled" }),
      thread("b", "master", { settledOverride: "settled" }),
    ]);
    expect(group.summary).toMatchObject({ total: 0, running: 0, attention: 0, unknown: 0 });
    expect(ids(expandSessionGroups(group.input))).toEqual(["master"]);
  });

  it("follow the caller's own rule: roots, orphans and unsettleable remote workers stay put", () => {
    const remote = thread("remote", null, {
      environmentId: EnvironmentId.make("beta"),
      settledOverride: "settled",
      organization: {
        ...thread("unused").organization!,
        owner: { environmentId: "alpha", threadId: ThreadId.make("master") },
      },
    });
    const master = thread("master", null, {
      settledOverride: "settled",
      organization: {
        ...thread("unused").organization!,
        workers: [{ environmentId: "beta", threadId: remote.id }],
      },
    });
    const orphan = thread("orphan", "unloaded", { settledOverride: "settled" });
    const hierarchy = buildSessionHierarchy([master, remote, orphan]);
    const canSettle = (supported: string[]) => (t: EnvironmentThreadShell) =>
      supported.includes(t.environmentId) && t.settledOverride === "settled";

    // beta cannot un-settle (old server, or its descriptor has not loaded): its worker is not
    // "settled" there, so it stays under its master as a worker this client cannot see.
    const unsupported = settledWorkerKeys(hierarchy, canSettle(["alpha"]));
    expect([...unsupported]).toEqual([]);
    expect(
      summarizeSessionWorkers(hierarchy, sessionKey(master), new Set(["alpha"]), unsupported),
    ).toMatchObject({ total: 1, unknown: 1 });
    // A settled root and a worker whose owner is not loaded are already top-level rows.
    // Once beta supports settlement, only the remote worker leaves the group.
    const supported = settledWorkerKeys(hierarchy, canSettle(["alpha", "beta"]));
    expect([...supported]).toEqual([sessionKey(remote)]);
    expect(
      summarizeSessionWorkers(hierarchy, sessionKey(master), new Set(["alpha"]), supported).total,
    ).toBe(0);
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

it("gives a Base its own list root without changing its master, including offline remote metadata", () => {
  const master = thread("master");
  const base = thread("base", "master", { isBase: true });
  const remote = thread("remote", null, {
    isBase: true,
    environmentId: EnvironmentId.make("beta"),
    projectId: ProjectId.make("remote-project"),
  });
  const hierarchy = buildSessionHierarchy([master, base, remote]);
  expect(hierarchy.root(sessionKey(base))).toBe(sessionKey(base));
  expect(hierarchy.path(sessionKey(base))).toEqual([sessionKey(master)]);
  expect(sessionRole(base)).toBe("Worker");
  expect(describeSessionRole(base, { nested: false })?.text).toContain("Base");
  expect(hierarchy.byKey.get(sessionKey(remote))?.isBase).toBe(true);
  const rows = expandSessionGroups({
    roots: [master],
    hierarchy,
    expanded: new Set([sessionKey(master)]),
    finishedExpanded: new Set(),
    connected: new Set(["alpha"]),
    selectedKey: null,
    settled: new Set(),
  });
  expect(rows.map((row) => row.id)).toEqual(["master"]);
});
