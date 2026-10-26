import type {
  AllocationInventory,
  AllocationPolicy,
  ComputerPlacement,
  ComputerPlacementHost,
  ComputerPlacementRequest,
} from "@t3tools/contracts";

const GIB = 2 ** 30;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;
const threads = (count: number) => `${count.toFixed(1)} thread${count === 1 ? "" : "s"}`;
const percent = (fraction: number) => `${Math.round(Math.max(0, fraction) * 100)}%`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const compare = <T extends number | string>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** How the computers are put in order. Shown to the agent, so it must match `rankOrder` below. */
const ORDER_NOTE =
  "Ordered by: reachable, below the active-session cap, compatible with the request, declared needs fit, reading recency, then the largest share left free on the tightest of memory and CPU (and disk when a disk need is declared); ties go to fewer running sessions and jobs, then name. Advice only: it never blocks a start, and an explicit computer, account or model stays exact.";

/** Lower is better for every field except `tightest`, where a larger free share is better. */
interface Standing {
  readonly offline: number;
  readonly compatibility: number;
  readonly capped: number;
  readonly fit: number;
  readonly reading: number;
  readonly tightest: number;
  readonly load: number;
}
const rankOrder = (a: Standing, b: Standing) =>
  compare(a.offline, b.offline) ||
  compare(a.capped, b.capped) ||
  compare(a.compatibility, b.compatibility) ||
  compare(a.fit, b.fit) ||
  compare(a.reading, b.reading) ||
  compare(b.tightest, a.tightest) ||
  compare(a.load, b.load);

interface Dimension {
  readonly name: string;
  readonly free: number | null;
  readonly total: number;
  readonly need: number | undefined;
  readonly show: (amount: number) => string;
}

/**
 * Orders every connected computer for new work from the inventories one placement read collected.
 * Nothing here removes a computer or refuses a start: shortfalls, stale readings and missing
 * checkouts rank a computer lower and are reported in words, and the master decides.
 */
export function recommendPlacement(input: {
  readonly at: string;
  readonly policy: Pick<AllocationPolicy, "maxReadingAgeMinutes">;
  readonly request: ComputerPlacementRequest;
  readonly inventories: readonly AllocationInventory[];
}): ComputerPlacement {
  const { at, policy, request, inventories } = input;
  const needs = request.needs;
  const needsDeclared =
    needs?.memoryBytes !== undefined ||
    needs?.cpuThreads !== undefined ||
    needs?.diskBytes !== undefined;
  const runtimeWanted =
    request.driver !== undefined || request.model !== undefined || request.instanceId !== undefined;
  // The same login on another computer is the same account, whatever its local alias.
  const wantedLogins = new Set(
    inventories
      .flatMap((inventory) => inventory.accounts)
      .flatMap((account) =>
        account.instanceId === request.instanceId && account.accountKey !== null
          ? [account.accountKey]
          : [],
      ),
  );

  const assessed = inventories.map((inventory) => {
    const label = inventory.environmentLabel ?? inventory.environmentId;
    const chosen =
      request.environmentId !== undefined &&
      (request.environmentId === inventory.environmentId ||
        request.environmentId.toLowerCase() === label.toLowerCase());
    const reasons: string[] = [];
    const warnings: string[] = [];
    const computer = inventory.complete ? (inventory.computer ?? null) : null;
    const age = computer
      ? Math.max(0, Math.round((Date.parse(inventory.observedAt) - computer.sampledAt) / 1000))
      : null;
    const ageSeconds = age !== null && Number.isFinite(age) ? age : null;
    const state: ComputerPlacementHost["state"] = !inventory.complete
      ? "offline"
      : ageSeconds === null
        ? "unknown"
        : ageSeconds > policy.maxReadingAgeMinutes * 60
          ? "stale"
          : "fresh";
    if (state === "offline") warnings.push("Not reachable for this read.", ...inventory.notices);
    if (state === "unknown")
      warnings.push(
        "No capacity reading: this computer's server predates it or could not take one.",
      );
    if (state === "stale")
      warnings.push(
        `Reading is ${Math.round(ageSeconds! / 60)} min old; the allocation policy allows ${policy.maxReadingAgeMinutes} min.`,
      );
    if (computer) warnings.push(...computer.notices);
    const sessions = inventory.complete
      ? inventory.demand.filter((session) => session.state === "running").length
      : null;
    const cap = inventory.maxActiveAgentSessions ?? 6;
    const capped = sessions !== null && sessions >= cap;
    if (sessions !== null) reasons.push(`${sessions} active agent sessions; advisory cap ${cap}.`);
    if (capped)
      warnings.push(
        `At or over the active agent session cap (${sessions}/${cap}); prefer a computer below its cap. Starts remain allowed.`,
      );

    let unmet = 0;
    let unverified = 0;
    // --- what is free now, and what the declared needs would leave ---
    let fit: ComputerPlacementHost["fit"] = needsDeclared ? "unknown" : "none";
    let tightest: { name: string; left: number } | null = null;
    if (computer) {
      const { resources } = computer;
      const idle =
        resources.cpuUtilization === null
          ? null
          : resources.cpuCount * (1 - resources.cpuUtilization);
      const disk = computer.disks.find((entry) => entry.path === computer.workDisk);
      const dimensions: Dimension[] = [
        {
          name: "memory",
          free: resources.availableMemoryBytes,
          total: resources.totalMemoryBytes,
          need: needs?.memoryBytes,
          show: gib,
        },
        {
          name: "CPU",
          free: idle,
          total: resources.cpuCount,
          need: needs?.cpuThreads,
          show: threads,
        },
        {
          name: "disk",
          free: disk?.availableBytes ?? null,
          total: disk?.totalBytes ?? 0,
          need: needs?.diskBytes,
          show: gib,
        },
      ];
      reasons.push(
        [
          [
            `Memory ${gib(resources.availableMemoryBytes)} of ${gib(resources.totalMemoryBytes)} available`,
            idle === null
              ? `CPU load unknown on ${plural(resources.cpuCount, "thread")}`
              : `CPU ${threads(idle)} of ${resources.cpuCount} idle`,
            disk
              ? `work disk ${disk.path} ${gib(disk.availableBytes)} of ${gib(disk.totalBytes)} free`
              : "work disk unknown",
          ].join("; "),
          ...(sessions === null ? [] : [plural(sessions, "agent session")]),
          ...(computer.jobs ? [`${plural(computer.jobs.running, "Workenv job")} running`] : []),
        ].join("; ") + ".",
      );
      const known = dimensions.filter(
        (dimension) => dimension.free !== null && dimension.total > 0,
      );
      for (const dimension of dimensions)
        if (
          dimension.need !== undefined &&
          known.includes(dimension) &&
          dimension.free! < dimension.need
        )
          warnings.push(
            `Needs ${dimension.show(dimension.need)} ${dimension.name} but only ${dimension.show(dimension.free!)} is available.`,
          );
      for (const dimension of dimensions)
        if (dimension.need !== undefined && !known.includes(dimension))
          warnings.push(
            dimension.name === "disk"
              ? "The disk that holds new work is unknown; the disk need was not compared."
              : `${dimension.name} could not be measured; its need was not compared.`,
          );
      if (needsDeclared) {
        const declared = dimensions.filter((dimension) => dimension.need !== undefined);
        fit = declared.some(
          (dimension) => known.includes(dimension) && dimension.free! < dimension.need!,
        )
          ? "short"
          : declared.every((dimension) => known.includes(dimension))
            ? "fits"
            : "unknown";
      }
      // Disk ranks only against a declared disk need: free space is not contention for it.
      for (const dimension of known) {
        if (dimension.name === "disk" && dimension.need === undefined) continue;
        const left = (dimension.free! - (dimension.need ?? 0)) / dimension.total;
        if (!tightest || left < tightest.left) tightest = { name: dimension.name, left };
      }
      if (tightest)
        reasons.push(
          `Tightest ${needsDeclared ? "after the task" : "now"}: ${tightest.name} with ${percent(tightest.left)} free.`,
        );
    }

    // --- compatibility: checkout, native operating system, provider runtime ---
    if (state !== "offline") {
      if (request.repositoryKey !== undefined) {
        if (inventory.projects === undefined) {
          unverified++;
          warnings.push("Checkouts were not reported: this computer's server predates the lookup.");
        } else if (inventory.projects.length === 0) {
          unmet++;
          warnings.push(
            "No checkout of this project here; a worker for it cannot start on this computer yet.",
          );
        } else
          reasons.push(
            `Checkout: ${inventory.projects.map((project) => `${project.title} (${project.id})`).join(", ")}.`,
          );
      }
      if (needs?.os !== undefined && needs.os !== "unknown") {
        if (computer === null) unverified++;
        else if (computer.os !== needs.os) {
          unmet++;
          warnings.push(`The task needs ${needs.os}; this computer runs ${computer.os}.`);
        }
      }
      if (runtimeWanted) {
        const matching = inventory.accounts.filter(
          (account) =>
            (request.driver === undefined || account.driver === request.driver) &&
            (request.model === undefined ||
              account.models.some((model) => model.slug === request.model)) &&
            (request.instanceId === undefined ||
              account.instanceId === request.instanceId ||
              (account.accountKey !== null && wantedLogins.has(account.accountKey))),
        );
        if (matching.length === 0) {
          unmet++;
          warnings.push("No matching provider account or model on this computer.");
        } else {
          reasons.push(`Provider runtime present: ${matching.map((a) => a.label).join(", ")}.`);
          // Sign-in and quota state are reported, never used to pick a computer.
          const first = matching[0]!;
          if (matching.every((account) => !account.available))
            warnings.push(
              `${first.label} is not ready here: ${first.unavailableReason ?? "unavailable"}`,
            );
        }
      }
    }

    const standing: Standing = {
      offline: state === "offline" ? 1 : 0,
      compatibility: unmet > 0 ? 2 : unverified > 0 ? 1 : 0,
      capped: capped ? 1 : 0,
      fit: fit === "short" ? 2 : fit === "unknown" ? 1 : 0,
      reading: state === "fresh" ? 0 : state === "stale" ? 1 : 2,
      tightest: tightest?.left ?? Number.NEGATIVE_INFINITY,
      load: (sessions ?? 0) + (computer?.jobs?.running ?? 0),
    };
    const host: Omit<ComputerPlacementHost, "rank"> = {
      environmentId: inventory.environmentId,
      label,
      state,
      ageSeconds,
      chosen,
      sessions,
      ...(inventory.projects === undefined ? {} : { projects: inventory.projects }),
      fit,
      computer,
      reasons,
      warnings,
    };
    return { standing, host };
  });

  const hosts = assessed
    .toSorted(
      (a, b) =>
        rankOrder(a.standing, b.standing) ||
        compare(a.host.label.toLowerCase(), b.host.label.toLowerCase()) ||
        compare(a.host.environmentId, b.host.environmentId),
    )
    .map((entry, index): ComputerPlacementHost => ({ ...entry.host, rank: index + 1 }));

  const best = hosts.find((host) => host.state !== "offline");
  const chosen = hosts.find((host) => host.chosen);
  // A computer the request named is the answer whatever its state, and nothing takes its place:
  // a better one is described in the reasons. A name that matches no connected computer leaves no
  // answer, because there is nothing to keep.
  const recommended = request.environmentId === undefined ? best : chosen;
  const reasons = [ORDER_NOTE];
  if (request.projectId !== undefined && request.repositoryKey === undefined)
    reasons.push(
      "The project has no repository identity (a Git remote or a projectKey in t3.json), so computers could not be matched by project.",
    );
  if (request.environmentId === undefined)
    reasons.push(
      best
        ? `${best.label} ranks first of ${hosts.length}.`
        : "No connected computer could be read. Starting a worker anywhere stays allowed.",
    );
  else if (!chosen)
    reasons.push(
      `The chosen computer ${request.environmentId} is not connected here; connected: ${hosts.map((host) => host.label).join(", ")}. No computer is recommended in its place.`,
    );
  else {
    const better = best && best !== chosen ? best : undefined;
    reasons.push(
      chosen.state === "offline"
        ? `Kept your choice ${chosen.label}, which is not reachable right now${better ? `; ${better.label} ranks first of the reachable ones` : ""}.`
        : better
          ? `Kept your choice ${chosen.label} (rank ${chosen.rank} of ${hosts.length}); ${better.label} ranks first.`
          : `${chosen.label} ranks first of ${hosts.length}.`,
    );
  }

  return {
    at,
    request,
    recommendedEnvironmentId: recommended?.environmentId ?? null,
    hosts,
    reasons,
  };
}
