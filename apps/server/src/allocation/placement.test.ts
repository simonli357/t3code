import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  defaultAllocationPolicy,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AllocationInventory,
  type AllocationPolicy,
} from "@t3tools/contracts";
import { placeWorker, type PlacedStart } from "./placement.ts";

const at = "2026-11-15T12:00:00.000Z";
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) - minutes * 60_000));
const GIB = 2 ** 30;
const computer = (
  id: string,
  totalGiB: number,
  freeGiB: number,
  idleThreads: number,
  threads: number,
  extra: Partial<AllocationInventory> = {},
): AllocationInventory => ({
  environmentId: id,
  environmentLabel: id,
  observedAt: at,
  accounts: [],
  demand: [],
  complete: true,
  notices: [],
  computer: {
    sampledAt: Date.parse(at),
    os: "linux",
    resources: {
      sampledAt: Date.parse(at),
      cpuUtilization: 1 - idleThreads / threads,
      cpuCount: threads,
      availableMemoryBytes: freeGiB * GIB,
      totalMemoryBytes: totalGiB * GIB,
    },
    disks: [],
    workDisk: null,
    jobs: null,
    notices: [],
  },
  recentStarts: [],
  projects: [{ id: ProjectId.make(`${id}-project`), title: "t3code" }],
  ...extra,
});
/** `count` sessions at work on a computer. */
const working = (id: string, count: number): AllocationInventory["demand"] =>
  Array.from({ length: count }, (_, index) => ({
    environmentId: id,
    threadId: ThreadId.make(`${id}-session-${index}`),
    instanceId: ProviderInstanceId.make("claude"),
    accountKey: null,
    model: "model",
    options: [],
    state: "running" as const,
  }));
// The three computers of the report: a small busy one, a large idle one, and a large one whose
// builds keep every CPU thread busy.
const myacer = computer("myacer", 15, 7, 4, 8);
const myalien = computer("myalien", 31, 22, 20, 24);
const sliara = computer("sliara", 31, 18, 0, 16);
const three = [myacer, myalien, sliara];
const project = { id: ProjectId.make("myacer-project"), found: true };
const place = (
  inventories: ReadonlyArray<AllocationInventory>,
  extra: Partial<Parameters<typeof placeWorker>[0]> = {},
) =>
  placeWorker({
    at,
    policy: defaultAllocationPolicy,
    inventories,
    localEnvironmentId: "myacer",
    project,
    ...extra,
  });
const order = (placement: ReturnType<typeof placeWorker>) =>
  placement.ranked.map((c) => c.environmentId);

describe("placeWorker", () => {
  it("chooses the computer with the most room, idle CPU first, and says why with the numbers", () => {
    const placement = place(three);
    expect(order(placement)).toEqual(["myalien", "myacer", "sliara"]);
    expect(placement.ranked[0]).toEqual({
      environmentId: "myalien",
      label: "myalien",
      projectId: "myalien-project",
      reason:
        "myalien: most room of 3 computers; 22 GiB room (22 free of 31), 20 of 24 CPU threads idle, 0 sessions.",
    });
    expect(placement.lines).toEqual([
      "myacer: 7 GiB room (7 free of 15), 4 of 8 CPU threads idle, 0 sessions",
      "myalien: 22 GiB room (22 free of 31), 20 of 24 CPU threads idle, 0 sessions",
      "sliara: 18 GiB room (18 free of 31), 0 of 16 CPU threads idle, 0 sessions; no idle CPU",
    ]);
    // The master's own project ID stands for this computer; the others carry their own.
    expect(placement.ranked[1]!.projectId).toBe("myacer-project");
    // A computer with more room but no idle CPU thread is still behind one that has both.
    expect(order(place([myacer, sliara]))).toEqual(["myacer", "sliara"]);
    expect(place([myacer, sliara]).ranked[0]!.reason).toContain(
      "most room of the computers with an idle CPU thread, of 2",
    );
  });

  it("spreads several starts in a row, though every reading still shows the same free memory", () => {
    const placed: PlacedStart[] = [];
    const chosen: string[] = [];
    for (let n = 0; n < 15; n++) {
      const placement = place(three, { placed });
      const best = placement.ranked[0]!;
      chosen.push(best.environmentId);
      placed.push({ environmentId: best.environmentId, threadId: `worker-${n}`, at });
    }
    expect(chosen).toEqual([
      // 22 GiB of room, 3 less with each start, down to the small computer's 7.
      "myalien",
      "myalien",
      "myalien",
      "myalien",
      "myalien",
      "myalien",
      // Both at the 4 GiB minimum or just above: they take turns until neither has room.
      "myacer",
      "myalien",
      "myacer",
      // Only the computer with no idle CPU has room left.
      "sliara",
      "sliara",
      "sliara",
      "sliara",
      "sliara",
      // Every computer is under the minimum: the most room still takes the start.
      "sliara",
    ]);
    const last = place(three, { placed: placed.slice(0, 14) }).ranked[0]!;
    expect(last.reason).toBe(
      "sliara: every computer is under the 4 GiB minimum, and this one has the most room; 3 GiB room (18 free of 31, less 5 just started at 3 GiB each), 0 of 16 CPU threads idle, 0 sessions.",
    );
  });

  it("fills a small computer before a large one overflows, and never past its minimum", () => {
    // The large computer is nearly full; the small one has room for one more worker.
    const large = computer("large", 31, 5, 10, 16);
    const small = computer("small", 15, 6, 4, 8);
    const placed: PlacedStart[] = [];
    const chosen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const best = place([large, small], { placed }).ranked[0]!;
      chosen.push(best.environmentId);
      placed.push({ environmentId: best.environmentId, threadId: `worker-${n}`, at });
    }
    // small (6) then large (5); the third start finds both under the minimum (3 and 2).
    expect(chosen).toEqual(["small", "large", "small"]);
    expect(place([large, small], { placed: placed.slice(0, 2) }).lines).toEqual([
      "large: 2 GiB room (5 free of 31, less 1 just started at 3 GiB each), 10 of 16 CPU threads idle, 0 sessions; under the 4 GiB minimum",
      "small: 3 GiB room (6 free of 15, less 1 just started at 3 GiB each), 4 of 8 CPU threads idle, 0 sessions; under the 4 GiB minimum",
    ]);
  });

  it("counts sessions a computer reports as just started, once each, and not the worker being retried", () => {
    const busy = computer("myalien", 31, 22, 20, 24, {
      recentStarts: [
        { threadId: ThreadId.make("a"), at: minutesAgo(2) },
        { threadId: ThreadId.make("b"), at: minutesAgo(14) },
        // Old enough to show its memory already.
        { threadId: ThreadId.make("c"), at: minutesAgo(16) },
      ],
    });
    const placed = [
      // Already reported by the computer: counted once.
      { environmentId: "myalien", threadId: "a", at: minutesAgo(2) },
      { environmentId: "myalien", threadId: "retry", at: minutesAgo(1) },
    ];
    expect(place([busy], { placed }).lines).toEqual([
      "myalien: 13 GiB room (22 free of 31, less 3 just started at 3 GiB each), 20 of 24 CPU threads idle, 0 sessions",
    ]);
    expect(place([busy], { placed, threadId: "retry" }).lines[0]).toContain(
      "16 GiB room (22 free of 31, less 2 just started",
    );
  });

  it("still starts when every computer is under the minimum, on the one with the most room", () => {
    const placement = place([
      computer("myacer", 15, 1.5, 4, 8),
      computer("myalien", 31, 3.5, 20, 24),
      computer("sliara", 31, 2, 0, 16),
    ]);
    expect(order(placement)).toEqual(["myalien", "sliara", "myacer"]);
    expect(placement.refusal).toBeUndefined();
    expect(placement.ranked[0]!.reason).toBe(
      "myalien: every computer is under the 4 GiB minimum, and this one has the most room; 3.5 GiB room (3.5 free of 31), 20 of 24 CPU threads idle, 0 sessions.",
    );
  });

  it("never treats an unreachable or unmeasured computer as empty", () => {
    const down: AllocationInventory = {
      ...computer("down", 64, 60, 32, 32),
      complete: false,
      notices: ["down: load unavailable for this decision: offline"],
    };
    const { computer: _capacity, ...unmeasured } = computer("unmeasured", 64, 60, 32, 32);
    const { recentStarts: _starts, ...older } = computer("older", 64, 60, 32, 32);
    const full = computer("myacer", 15, 1, 4, 8);
    const placement = place([full, down, unmeasured, older]);
    // The only measured computer is under the minimum and still the only choice.
    expect(order(placement)).toEqual(["myacer"]);
    expect(placement.lines.slice(1)).toEqual([
      "down: did not answer",
      "unmeasured: not measured",
      "older: its T3 version does not report recent starts",
    ]);
    expect(placement.notes).toEqual(["down: load unavailable for this decision: offline"]);

    const none = place([down, unmeasured]);
    expect(none.ranked).toEqual([]);
    expect(none.refusal).toBe(
      "No computer could be chosen: down: did not answer | unmeasured: not measured. Name a computer (environmentId) to start there anyway.",
    );
  });

  it("uses a named computer as given, by ID or label, whatever its numbers", () => {
    const full = computer("sliara", 31, 0.5, 0, 16, { environmentLabel: "Sliara" });
    const placement = place([myacer, myalien, full], { named: "sliara" });
    expect(placement.ranked).toEqual([
      {
        environmentId: "sliara",
        label: "Sliara",
        projectId: "sliara-project",
        reason:
          "Sliara: named in the request; 0.5 GiB room (0.5 free of 31), 0 of 16 CPU threads idle, 0 sessions.",
      },
    ]);
    // Every computer is still listed.
    expect(placement.lines).toHaveLength(3);
    expect(order(place([myacer, myalien, full], { named: "SLIARA" }))).toEqual(["sliara"]);
    // A computer that did not answer is still the one that was named.
    const down = { ...myalien, complete: false };
    expect(place([myacer, down], { named: "myalien" }).ranked[0]).toMatchObject({
      environmentId: "myalien",
      reason: "myalien: named in the request; did not answer.",
    });
    // A name no read knows goes through unchanged, with the project ID as given.
    expect(
      place(three, { named: "elsewhere", project: { id: ProjectId.make("theirs"), found: false } })
        .ranked,
    ).toEqual([
      {
        environmentId: "elsewhere",
        label: "elsewhere",
        projectId: "theirs",
        reason: "elsewhere: named in the request; not among the linked computers that answered.",
      },
    ]);
    // A named computer's own project ID, as masters gave it before, is passed on.
    expect(
      place(three, { named: "myalien", project: { id: ProjectId.make("theirs"), found: false } })
        .ranked[0]!.projectId,
    ).toBe("theirs");
  });

  it("skips a computer with no checkout of the project", () => {
    const { projects: _none, ...noCheckout } = myalien;
    const placement = place([myacer, { ...noCheckout, projects: [] }, sliara]);
    expect(order(placement)).toEqual(["myacer", "sliara"]);
    expect(placement.lines[1]).toBe(
      "myalien: 22 GiB room (22 free of 31), 20 of 24 CPU threads idle, 0 sessions; no checkout of the project",
    );
    // A project without a repository identity is matched nowhere else: only this computer has it.
    const loose = ([myacer, noCheckout, sliara] as AllocationInventory[]).map(
      ({ projects: _projects, ...rest }) => rest,
    );
    expect(order(place(loose))).toEqual(["myacer"]);
    expect(place(loose).ranked[0]!.reason).toContain("the only computer that can run this");
    // Without a project every measured computer may run the worker, and no project ID is given.
    const any = placeWorker({
      at,
      policy: defaultAllocationPolicy,
      inventories: loose,
      localEnvironmentId: "myacer",
    });
    expect(order(any)).toEqual(["myalien", "myacer", "sliara"]);
    expect(any.ranked[0]!.projectId).toBeNull();
    // A project this computer does not know cannot be matched anywhere.
    const unknown = place(three, { project: { id: ProjectId.make("theirs"), found: false } });
    expect(unknown.ranked).toEqual([]);
    expect(unknown.refusal).toContain("Project theirs was not found on this computer.");
  });

  it("follows the stored values", () => {
    const policy = (values: Partial<AllocationPolicy>): AllocationPolicy => ({
      ...defaultAllocationPolicy,
      ...values,
    });
    const started = (minutes: number) => [
      { environmentId: "myalien", threadId: "one", at: minutesAgo(minutes) },
      { environmentId: "myalien", threadId: "two", at: minutesAgo(minutes) },
    ];
    const rooms = (values: Partial<AllocationPolicy>, minutes = 1) =>
      place([myacer, myalien], { policy: policy(values), placed: started(minutes) }).lines;
    // Two workers just started on myalien: 22 - 2 x 3.
    expect(rooms({})[1]).toContain("myalien: 16 GiB room");
    // A heavier worker takes the large computer below the small one.
    expect(rooms({ workerMemoryGiB: 8 })[1]).toContain("myalien: 6 GiB room");
    expect(
      order(
        place([myacer, myalien], { policy: policy({ workerMemoryGiB: 8 }), placed: started(1) }),
      ),
    ).toEqual(["myacer", "myalien"]);
    // A higher minimum takes the small computer out while the large one has room.
    expect(rooms({ minFreeMemoryGiB: 8 })[0]).toContain("under the 8 GiB minimum");
    // A shorter settle time stops counting starts sooner.
    expect(rooms({ startSettleMinutes: 5 }, 10)[1]).toContain("myalien: 22 GiB room");
    expect(rooms({ startSettleMinutes: 30 }, 10)[1]).toContain("myalien: 16 GiB room");
  });

  it("replays the evening two workers were killed for memory, and never adds to that computer", () => {
    const day = (clock: string) =>
      `2026-11-${clock.startsWith("23") ? "14" : "15"}T${clock}:00.000Z`;
    // Readings as `t3_recommend_computer` gave them: free GiB, idle threads, working sessions.
    const readings = [
      { from: "23:48", sliara: [9.7, 0, 3], myalien: [2.5, 9.9, 0], myacer: [6.9, 12.8, 15] },
      { from: "00:11", sliara: [5.5, 0, 4], myalien: [6.8, 12.3, 0], myacer: [6.2, 11.7, 19] },
      { from: "00:30", sliara: [11.4, 0.5, 4], myalien: [8.3, 11.9, 1], myacer: [3.3, 9.2, 10] },
    ] as const;
    // The kernel killed a worker session on myacer at 00:28 and another at 00:49.
    const kills = ["00:28", "00:49"].map(day);
    const placed: PlacedStart[] = [];
    const start = (clock: string) => {
      const at = day(clock);
      const reading = readings.findLast((r) => day(r.from) <= at)!;
      const read = (id: "sliara" | "myalien" | "myacer", totalGiB: number, threads: number) => {
        const [free, idle, sessions] = reading[id];
        return computer(id, totalGiB, free, idle, threads, {
          observedAt: at,
          demand: working(id, sessions),
          lastMemoryKillAt: id === "myacer" ? (kills.findLast((kill) => kill <= at) ?? null) : null,
        });
      };
      const placement = placeWorker({
        at,
        policy: defaultAllocationPolicy,
        inventories: [read("sliara", 31, 16), read("myalien", 31.7, 20), read("myacer", 15, 16)],
        localEnvironmentId: "myacer",
        project,
        placed,
      });
      const best = placement.ranked[0]!;
      placed.push({ environmentId: best.environmentId, threadId: `worker-${clock}`, at });
      return { chosen: best.environmentId, placement };
    };
    // 23:48: myacer shows 6.9 GiB free, but 15 sessions work there. sliara is slow, not full.
    const first = start("23:48");
    expect(first.chosen).toBe("sliara");
    expect(first.placement.lines).toEqual([
      "sliara: 9 GiB room (9.7 free of 31, less 0.25 GiB for each working session), 0 of 16 CPU threads idle, 3 sessions; no idle CPU",
      "myalien: 2.5 GiB room (2.5 free of 31.7), 9.9 of 20 CPU threads idle, 0 sessions; under the 4 GiB minimum",
      "myacer: 3.2 GiB room (6.9 free of 15, less 0.25 GiB for each working session), 12.8 of 16 CPU threads idle, 15 sessions; under the 4 GiB minimum",
    ]);
    expect(start("00:12").chosen).toBe("myalien");
    // 00:20, the start that went to myacer: myalien just took a worker, myacer has 19 sessions.
    const third = start("00:20");
    expect(third.chosen).toBe("sliara");
    expect(third.placement.ranked[0]!.reason).toBe(
      "sliara: most room of 3 computers, with no idle CPU thread; 4.5 GiB room (5.5 free of 31, less 0.25 GiB for each working session), 0 of 16 CPU threads idle, 4 sessions.",
    );
    // After each kill myacer is last, whatever it shows, until an hour has passed.
    const after = ["00:30", "00:50", "01:20", "01:48"].map(start);
    expect(after.map((s) => s.chosen)).toEqual(["myalien", "myalien", "myalien", "myalien"]);
    expect(after[0]!.placement.lines[2]).toBe(
      "myacer: 0.8 GiB room (3.3 free of 15, less 0.25 GiB for each working session), 9.2 of 16 CPU threads idle, 10 sessions; a session was killed for memory 2 min ago",
    );
    expect(after.map((s) => s.placement.ranked.at(-1)!.environmentId)).toEqual(
      after.map(() => "myacer"),
    );
    // Past the hold it is judged by its room again, which is still under the minimum.
    expect(start("01:50").placement.lines[2]).toContain("under the 4 GiB minimum");
  });

  it("puts a computer that killed a session for memory after every other one", () => {
    const killed = (id: string, freeGiB: number, minutes: number) =>
      computer(id, 31, freeGiB, 10, 16, { lastMemoryKillAt: minutesAgo(minutes) });
    const tight = computer("tight", 15, 2, 4, 8);
    // 20 GiB free two minutes after a kill is behind a computer under the minimum.
    expect(order(place([killed("roomy", 20, 2), tight]))).toEqual(["tight", "roomy"]);
    // An hour later the kill no longer counts.
    expect(order(place([killed("roomy", 20, 61), tight]))).toEqual(["roomy", "tight"]);
    expect(
      order(
        place([killed("roomy", 20, 30), tight], {
          policy: { ...defaultAllocationPolicy, memoryKillHoldMinutes: 20 },
        }),
      ),
    ).toEqual(["roomy", "tight"]);
    // When every computer killed one, the start still happens where the most room is.
    const all = place([killed("roomy", 20, 2), killed("other", 9, 5)]);
    expect(order(all)).toEqual(["roomy", "other"]);
    expect(all.ranked[0]!.reason).toContain(
      "roomy: every computer killed a session for memory within 60 minutes, and this one has the most room;",
    );
    // The reserve per working session is a stored value too.
    const crowded = computer("crowded", 15, 7, 4, 8, { demand: working("crowded", 12) });
    expect(place([crowded]).lines[0]).toContain("crowded: 4 GiB room (7 free of 15, less 0.25 GiB");
    expect(
      place([crowded], { policy: { ...defaultAllocationPolicy, sessionReserveGiB: 0.5 } }).lines[0],
    ).toContain("crowded: 1 GiB room (7 free of 15, less 0.5 GiB for each working session)");
    expect(
      place([crowded], { policy: { ...defaultAllocationPolicy, sessionReserveGiB: 0 } }).lines[0],
    ).toContain("crowded: 7 GiB room (7 free of 15)");
  });
});
