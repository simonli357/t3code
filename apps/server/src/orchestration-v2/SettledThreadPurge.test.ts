import { assert, it } from "@effect/vitest";

import { type PurgeGraph, selectThreadsToPurge } from "./SettledThreadPurge.ts";

interface Fixture extends Partial<Omit<PurgeGraph, "candidates" | "liveThreadIds">> {
  /** Candidate thread ids, each with the reason that blocks it on its own, if any. */
  readonly candidates: Readonly<Record<string, string | null>>;
  /** Threads that exist and stay, besides the candidates. */
  readonly kept?: ReadonlyArray<string>;
}

const select = ({ candidates, kept = [], ...rest }: Fixture) =>
  selectThreadsToPurge({
    workers: [],
    activeJobs: [],
    handoffs: [],
    planLinks: [],
    forks: [],
    subagents: [],
    sessionKeys: [],
    sessionAncestors: [],
    ...rest,
    candidates: Object.entries(candidates).map(([threadId, blocked]) => ({ threadId, blocked })),
    liveThreadIds: new Set([...Object.keys(candidates), ...kept]),
  });

const purged = (result: ReturnType<typeof select>) => [...result.purge].toSorted();

it("purges a settled thread that nothing depends on", () => {
  const result = select({ candidates: { old: null }, kept: ["other"] });
  assert.deepEqual(purged(result), ["old"]);
  assert.strictEqual(result.skipped.size, 0);
});

it("keeps a candidate that is blocked on its own, with the reason", () => {
  const result = select({
    candidates: {
      pinned: "pinned",
      live: "a run, request or background task is still active",
      moving: "session move in progress, or a parked copy kept for a return move",
      free: null,
    },
  });
  assert.deepEqual(purged(result), ["free"]);
  assert.strictEqual(result.skipped.get("pinned"), "pinned");
  assert.include(result.skipped.get("live")!, "still active");
  assert.include(result.skipped.get("moving")!, "session move");
});

it("keeps the master of a worker that stays, and of a remote worker", () => {
  const result = select({
    candidates: { masterOfKept: null, masterOfRemote: null, masterOfGone: null, goneWorker: null },
    kept: ["keptWorker"],
    workers: [
      { threadId: "keptWorker", ownerId: "masterOfKept", remote: false },
      { threadId: "peer-worker", ownerId: "masterOfRemote", remote: true },
      { threadId: "goneWorker", ownerId: "masterOfGone", remote: false },
    ],
  });
  assert.deepEqual(purged(result), ["goneWorker", "masterOfGone"]);
  assert.include(result.skipped.get("masterOfKept")!, "owns worker keptWorker, which is kept");
  assert.include(result.skipped.get("masterOfRemote")!, "owns worker peer-worker");
});

it("keeps both ends of a pending worker job that touches a kept thread", () => {
  const result = select({
    candidates: { sender: null, receiver: null, quiet: null, stuck: null },
    kept: ["keptTarget", "keptWorker"],
    activeJobs: [
      { id: "job-1", workerId: "sender", targetId: "keptTarget", state: "queued" },
      { id: "job-2", workerId: "keptWorker", targetId: "receiver", state: "submitted" },
      // An interrupted job on the worker itself will never resume.
      { id: "job-3", workerId: "quiet", targetId: "quiet", state: "interrupted" },
      { id: "job-4", workerId: "stuck", targetId: "stuck", state: "queued" },
    ],
  });
  assert.deepEqual(purged(result), ["quiet"]);
  assert.include(result.skipped.get("receiver")!, "worker job job-2 from keptWorker is submitted");
  assert.include(result.skipped.get("sender")!, "worker job job-1 for keptTarget is queued");
  assert.include(result.skipped.get("stuck")!, "worker job job-4 is queued");
});

it("keeps the sides of an orchestrator handoff while the other stays", () => {
  const result = select({
    candidates: { successorOfKept: null, ownerOfKept: null, pair1: null, pair2: null },
    kept: ["owner", "successor"],
    handoffs: [
      { threadId: "successorOfKept", ownerId: "owner" },
      { threadId: "successor", ownerId: "ownerOfKept" },
      { threadId: "pair2", ownerId: "pair1" },
    ],
  });
  assert.deepEqual(purged(result), ["pair1", "pair2"]);
  assert.include(result.skipped.get("successorOfKept")!, "took over from owner, which is kept");
  assert.include(result.skipped.get("ownerOfKept")!, "handed off to successor, which is kept");
});

it("keeps a thread that shares a proposed plan with a kept one, in either direction", () => {
  const result = select({
    candidates: { planThread: null, implementation: null, loner: null },
    kept: ["keptImplementation", "keptPlan"],
    planLinks: [
      { threadId: "keptImplementation", linkedThreadId: "planThread" },
      { threadId: "implementation", linkedThreadId: "keptPlan" },
    ],
  });
  assert.deepEqual(purged(result), ["loner"]);
  assert.include(
    result.skipped.get("planThread")!,
    "shares a proposed plan with keptImplementation",
  );
  assert.include(result.skipped.get("implementation")!, "shares a proposed plan with keptPlan");
});

it("keeps the parent of a fork that stays, because the fork reads its history", () => {
  const result = select({
    candidates: { parent: null, goneParent: null, goneFork: null },
    kept: ["keptFork"],
    forks: [
      { threadId: "keptFork", parentId: "parent" },
      { threadId: "goneFork", parentId: "goneParent" },
    ],
  });
  assert.deepEqual(purged(result), ["goneFork", "goneParent"]);
  assert.include(result.skipped.get("parent")!, "is the history source of keptFork");
});

it("keeps a thread whose provider session another thread that stays also uses", () => {
  const result = select({
    candidates: { shared: null, ancestor: null, own: null },
    kept: ["twin", "forked"],
    sessionKeys: [
      { threadId: "shared", key: "codex:one" },
      { threadId: "twin", key: "codex:one" },
      { threadId: "ancestor", key: "deepseekHarness:parent" },
      { threadId: "own", key: "claudeAgent:own" },
    ],
    sessionAncestors: [{ threadId: "forked", key: "deepseekHarness:parent" }],
  });
  assert.deepEqual(purged(result), ["own"]);
  assert.include(result.skipped.get("shared")!, "shares its provider session with twin");
  assert.include(result.skipped.get("ancestor")!, "fork ancestor of forked");
});

it("lets two purged threads share a provider session, and follows kept status through chains", () => {
  const result = select({
    candidates: { a: null, b: null, c: null, d: null, e: null },
    kept: ["keptSession"],
    sessionKeys: [
      { threadId: "a", key: "codex:both" },
      { threadId: "b", key: "codex:both" },
      // c shares with a kept thread, c owns worker d, and d's master e depends on d.
      { threadId: "c", key: "codex:kept" },
      { threadId: "keptSession", key: "codex:kept" },
    ],
    workers: [
      { threadId: "c", ownerId: "d", remote: false },
      { threadId: "d", ownerId: "e", remote: false },
    ],
  });
  // c stays, so its master d stays, so d's master e stays.
  assert.deepEqual(purged(result), ["a", "b"]);
  assert.include(result.skipped.get("d")!, "owns worker c, which is kept");
  assert.include(result.skipped.get("e")!, "owns worker d, which is kept");
});

it("takes subagent threads along with their parent, and keeps a parent whose subagent is busy", () => {
  const result = select({
    candidates: { parent: null, busyParent: null },
    subagents: [
      { threadId: "child", parentId: "parent", blocked: null },
      { threadId: "grandchild", parentId: "child", blocked: null },
      { threadId: "busyChild", parentId: "busyParent", blocked: "a run is still active" },
    ],
  });
  assert.deepEqual(purged(result), ["parent"]);
  assert.deepEqual([...result.cascade].toSorted(), ["child", "grandchild"]);
  assert.include(result.skipped.get("busyParent")!, "its subagent busyChild is kept");
});
