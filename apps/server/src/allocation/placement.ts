import {
  DEFAULT_MEMORY_KILL_HOLD_MINUTES,
  DEFAULT_MIN_FREE_MEMORY_GIB,
  DEFAULT_SESSION_RESERVE_GIB,
  DEFAULT_START_SETTLE_MINUTES,
  DEFAULT_WORKER_MEMORY_GIB,
  type AllocationInventory,
  type AllocationPolicy,
  type ComputerNumbers,
  type ProjectId,
  type WorkerComputer,
} from "@t3tools/contracts";

const gib = (bytes: number) => Math.round((bytes / 2 ** 30) * 10) / 10;
const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * One computer's load as plain numbers, from the inventory a placement read collected. Nothing
 * is ranked here; `placeWorker` ranks.
 */
export function computerNumbers(inventory: AllocationInventory): ComputerNumbers {
  const computer = inventory.complete ? inventory.computer : undefined;
  const resources = computer?.resources;
  const disk = computer?.disks.find((entry) => entry.path === computer.workDisk);
  return {
    environmentId: inventory.environmentId,
    label: inventory.environmentLabel ?? inventory.environmentId,
    reachable: inventory.complete,
    cpuThreadsIdle:
      resources && resources.cpuUtilization !== null
        ? Math.round(resources.cpuCount * (1 - resources.cpuUtilization) * 10) / 10
        : null,
    cpuThreads: resources?.cpuCount ?? null,
    memoryFreeGiB: resources ? gib(resources.availableMemoryBytes) : null,
    memoryTotalGiB: resources ? gib(resources.totalMemoryBytes) : null,
    workDiskFreeGiB: disk ? gib(disk.availableBytes) : null,
    sessions: inventory.complete
      ? inventory.demand.filter((session) => session.state !== "uncertain" && !session.recent)
          .length
      : null,
    projectId: inventory.projects?.[0]?.id ?? null,
  };
}

/** A start whose worker may not show in its computer's numbers yet. */
export interface PlacedStart {
  readonly environmentId: string;
  readonly threadId: string;
  readonly at: string;
}

/** A choice of computer: the candidates best first, and a line for every computer. */
export interface ComputerPlacement {
  /** Computers the worker may start on, best first. Empty when none can be chosen. */
  readonly ranked: ReadonlyArray<WorkerComputer>;
  /** Why nothing is ranked. */
  readonly refusal?: string;
  readonly lines: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

/** The stored values behind the choice of computer. */
export const placementValues = (policy: AllocationPolicy) => ({
  workerMemoryGiB: policy.workerMemoryGiB ?? DEFAULT_WORKER_MEMORY_GIB,
  minFreeMemoryGiB: policy.minFreeMemoryGiB ?? DEFAULT_MIN_FREE_MEMORY_GIB,
  startSettleMinutes: policy.startSettleMinutes ?? DEFAULT_START_SETTLE_MINUTES,
  sessionReserveGiB: policy.sessionReserveGiB ?? DEFAULT_SESSION_RESERVE_GIB,
  memoryKillHoldMinutes: policy.memoryKillHoldMinutes ?? DEFAULT_MEMORY_KILL_HOLD_MINUTES,
});

/**
 * Ranks the computers a new worker may start on. A computer's room is its free memory less the
 * expected memory of every session that started there too recently to show it, less a reserve
 * for each session already working there: one reading of free memory does not show the builds
 * and dev servers those sessions start and stop. Computers with room above the minimum and an
 * idle CPU thread come first, then those with room but no idle CPU, then those under the
 * minimum, then those where the system killed a session for memory within the hold; inside
 * each group the most room wins, so a small computer is chosen only while it has as much room
 * as a large one. A computer that did not answer, was not measured or has no checkout of the
 * project is never ranked. A named computer is used as given.
 */
export function placeWorker(input: {
  readonly at: string;
  readonly policy: AllocationPolicy;
  readonly inventories: ReadonlyArray<AllocationInventory>;
  readonly localEnvironmentId: string;
  /** Starts decided here; their computers may not report them yet. */
  readonly placed?: ReadonlyArray<PlacedStart>;
  /** The master's project, and whether this computer knows it. Absent: any computer may run it. */
  readonly project?: { readonly id: ProjectId; readonly found: boolean };
  /** A computer's ID or label: it is used whatever its numbers. */
  readonly named?: string;
  /** Said instead of "named in the request". */
  readonly namedBecause?: string;
  /** The worker being placed, so a retry does not count its own first attempt. */
  readonly threadId?: string;
}): ComputerPlacement {
  const {
    workerMemoryGiB,
    minFreeMemoryGiB,
    startSettleMinutes,
    sessionReserveGiB,
    memoryKillHoldMinutes,
  } = placementValues(input.policy);
  const since = Date.parse(input.at) - startSettleMinutes * 60_000;
  const fresh = (start: { threadId: string; at: string }) =>
    start.threadId !== input.threadId && Date.parse(start.at) >= since;
  const computers = input.inventories.map((inventory) => {
    const numbers = computerNumbers(inventory);
    const local = inventory.environmentId === input.localEnvironmentId;
    const projectId = !input.project?.found
      ? null
      : local
        ? input.project.id
        : (inventory.projects?.[0]?.id ?? null);
    const starts =
      inventory.complete && inventory.recentStarts
        ? new Set([
            ...inventory.recentStarts.filter(fresh).map((start) => start.threadId),
            ...(input.placed ?? [])
              .filter((start) => start.environmentId === inventory.environmentId && fresh(start))
              .map((start) => start.threadId),
          ]).size
        : null;
    const sessions = numbers.sessions ?? 0;
    const room =
      numbers.memoryFreeGiB === null || starts === null
        ? null
        : tenth(numbers.memoryFreeGiB - starts * workerMemoryGiB - sessions * sessionReserveGiB);
    const killedMinutesAgo =
      inventory.complete && inventory.lastMemoryKillAt
        ? Math.max(
            0,
            Math.round((Date.parse(input.at) - Date.parse(inventory.lastMemoryKillAt)) / 60_000),
          )
        : null;
    const killed = killedMinutesAgo !== null && killedMinutesAgo < memoryKillHoldMinutes;
    // Each session that just started is expected to keep one thread busy.
    const idle =
      numbers.cpuThreadsIdle === null || starts === null
        ? null
        : tenth(numbers.cpuThreadsIdle - starts);
    const memory =
      room === null
        ? null
        : `${room} GiB room (${numbers.memoryFreeGiB} free of ${numbers.memoryTotalGiB}${
            starts ? `, less ${starts} just started at ${workerMemoryGiB} GiB each` : ""
          }${
            sessions && sessionReserveGiB
              ? `, less ${sessionReserveGiB} GiB for each working session`
              : ""
          })`;
    const cpu =
      numbers.cpuThreadsIdle === null
        ? "idle CPU not measured"
        : `${numbers.cpuThreadsIdle} of ${numbers.cpuThreads} CPU threads idle`;
    const measured = memory === null ? null : `${memory}, ${cpu}, ${numbers.sessions} sessions`;
    const skipped = !numbers.reachable
      ? "did not answer"
      : room === null
        ? numbers.memoryFreeGiB === null
          ? "not measured"
          : "its T3 version does not report recent starts"
        : input.project?.found && projectId === null
          ? "no checkout of the project"
          : null;
    const group =
      room === null || killed
        ? 3
        : room < minFreeMemoryGiB
          ? 2
          : idle !== null && idle >= 1
            ? 0
            : 1;
    return { numbers, projectId, room, idle, measured, skipped, group, killed, killedMinutesAgo };
  });
  const describe = (c: (typeof computers)[number]) => c.measured ?? c.skipped ?? "not measured";
  const lines = computers.map((c) => {
    const state =
      c.skipped ??
      (c.group === 3
        ? `a session was killed for memory ${c.killedMinutesAgo} min ago`
        : c.group === 2
          ? `under the ${minFreeMemoryGiB} GiB minimum`
          : c.group === 1
            ? "no idle CPU"
            : null);
    return `${c.numbers.label}: ${[c.measured, state].filter((part) => part !== null).join("; ")}`;
  });
  const notes = input.inventories.flatMap((i) => (i.complete ? [] : i.notices));
  const computer = (c: (typeof computers)[number], reason: string): WorkerComputer => ({
    environmentId: c.numbers.environmentId,
    label: c.numbers.label,
    projectId: c.projectId,
    reason,
  });
  const eligible = computers
    .filter((c) => c.skipped === null && c.room !== null)
    .toSorted(
      (a, b) =>
        a.group - b.group ||
        b.room! - a.room! ||
        (b.idle ?? -Infinity) - (a.idle ?? -Infinity) ||
        a.numbers.label.localeCompare(b.numbers.label),
    );
  if (input.named !== undefined) {
    const name = input.named.toLowerCase();
    const named = computers.find(
      (c) => c.numbers.environmentId === input.named || c.numbers.label.toLowerCase() === name,
    );
    const because = input.namedBecause ?? "named in the request";
    if (named && (named.killed || (named.room !== null && named.room < minFreeMemoryGiB))) {
      const pressure = named.killed
        ? `a session was killed for memory ${named.killedMinutesAgo} min ago`
        : `${named.room} GiB room is below the ${minFreeMemoryGiB} GiB minimum`;
      const alternative =
        input.project?.found === false ? undefined : eligible.find((c) => c.group < 2);
      notes.unshift(
        `${named.numbers.label} is short of memory (${pressure}). ` +
          (alternative
            ? `${alternative.numbers.label} has ${alternative.room} GiB room.`
            : "No other computer was confirmed to have room for this project."),
      );
    }
    return {
      ranked: [
        named
          ? {
              ...computer(named, `${named.numbers.label}: ${because}; ${describe(named)}.`),
              // A project ID this computer does not know is the named computer's own.
              projectId: named.projectId ?? input.project?.id ?? null,
            }
          : {
              environmentId: input.named,
              label: input.named,
              projectId: input.project?.id ?? null,
              reason: `${input.named}: ${because}; not among the linked computers that answered.`,
            },
      ],
      lines,
      notes,
    };
  }
  if (input.project && !input.project.found)
    return {
      ranked: [],
      refusal: `Project ${input.project.id} was not found on this computer. Give your own computer's projectId, or name the computer (environmentId) that has this project.`,
      lines,
      notes,
    };
  if (!eligible.length)
    return {
      ranked: [],
      refusal: `No computer could be chosen: ${lines.join(" | ")}. Name a computer (environmentId) to start there anyway.`,
      lines,
      notes,
    };
  const best = eligible[0]!;
  const others = eligible.length - 1;
  const lead =
    best.group === 3
      ? `every computer killed a session for memory within ${memoryKillHoldMinutes} minutes, and this one has the most room`
      : best.group === 2
        ? `every computer is under the ${minFreeMemoryGiB} GiB minimum, and this one has the most room`
        : others === 0
          ? "the only computer that can run this"
          : best.group === 1
            ? `most room of ${eligible.length} computers, with no idle CPU thread`
            : eligible.some((c) => c.room! > best.room!)
              ? `most room of the computers with an idle CPU thread, of ${eligible.length}`
              : `most room of ${eligible.length} computers`;
  return {
    ranked: eligible.map((c, index) =>
      computer(
        c,
        index === 0
          ? `${c.numbers.label}: ${lead}; ${describe(c)}.`
          : `${c.numbers.label}: ${describe(c)}.`,
      ),
    ),
    lines,
    notes,
  };
}
