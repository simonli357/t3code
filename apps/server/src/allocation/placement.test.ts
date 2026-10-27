import { describe, expect, it } from "@effect/vitest";
import {
  ComputerPlacement,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AllocationAccount,
  type AllocationInventory,
  type ComputerCapacity,
  type ComputerPlacementRequest,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { recommendPlacement } from "./placement.ts";

const decodePlacement = Schema.decodeUnknownSync(ComputerPlacement);

const GIB = 2 ** 30;
const at = "2026-10-26T12:00:00.000Z";
const now = Date.parse(at);

/** Free amounts are given in GiB and idle CPU as a fraction, as an agent reads them. */
const computer = (
  patch: {
    memory?: [free: number, total: number];
    idle?: number | null;
    threads?: number;
    disk?: [free: number, total: number] | null;
    running?: number | null;
    os?: ComputerCapacity["os"];
    sampledAt?: number;
    notices?: string[];
  } = {},
): ComputerCapacity => {
  const [free, total] = patch.memory ?? [8, 16];
  const disk = patch.disk === undefined ? ([100, 500] as [number, number]) : patch.disk;
  const sampledAt = patch.sampledAt ?? now - 2_000;
  const idle = patch.idle === undefined ? 0.5 : patch.idle;
  return {
    sampledAt,
    os: patch.os ?? "linux",
    resources: {
      sampledAt,
      cpuUtilization: idle === null ? null : 1 - idle,
      cpuCount: patch.threads ?? 8,
      availableMemoryBytes: free * GIB,
      totalMemoryBytes: total * GIB,
    },
    disks: disk
      ? [
          {
            path: "/work",
            label: "work",
            totalBytes: disk[1] * GIB,
            availableBytes: disk[0] * GIB,
            freeBytes: disk[0] * GIB,
          },
        ]
      : [],
    workDisk: disk ? "/work" : null,
    jobs:
      patch.running === null
        ? null
        : { active: (patch.running ?? 0) + 1, running: patch.running ?? 0 },
    notices: patch.notices ?? [],
  };
};
const account = (
  id: string,
  patch: Partial<AllocationAccount> & { environmentId?: string } = {},
): AllocationAccount => ({
  environmentId: patch.environmentId ?? "host",
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  accountKey: id,
  label: id,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  models: [{ slug: "astra", capabilities: null }],
  shortWindow: "unknown",
  windows: [],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  ...patch,
});
const host = (
  id: string,
  patch: Partial<AllocationInventory> & { sessions?: number } = {},
): AllocationInventory => {
  const { sessions = 0, ...rest } = patch;
  return {
    environmentId: id,
    environmentLabel: id,
    observedAt: at,
    accounts: [],
    demand: Array.from({ length: sessions }, (_, index) => ({
      environmentId: id,
      threadId: `${id}-${index}` as never,
      instanceId: ProviderInstanceId.make("any"),
      accountKey: null,
      model: "astra",
      options: [],
      state: "running" as const,
    })),
    complete: true,
    notices: [],
    computer: computer(),
    ...rest,
  };
};
const offline = (id: string): AllocationInventory => ({
  ...host(id),
  complete: false,
  accounts: [],
  notices: [`${id}: load unavailable for this decision.`],
  computer: undefined,
});
const place = (
  inventories: AllocationInventory[],
  request: ComputerPlacementRequest = {},
  maxReadingAgeMinutes = 10,
) => recommendPlacement({ at, policy: { maxReadingAgeMinutes }, request, inventories });
const order = (result: ReturnType<typeof place>) => result.hosts.map((entry) => entry.label);

describe("computer placement", () => {
  it("lists every computer, ordered by the share left free on the tightest resource", () => {
    const result = place([
      host("busy", { computer: computer({ memory: [2, 16], idle: 0.9 }) }),
      host("roomy", { computer: computer({ memory: [14, 16], idle: 0.8 }) }),
      host("loaded-cpu", { computer: computer({ memory: [12, 16], idle: 0.1 }) }),
    ]);
    expect(order(result)).toEqual(["roomy", "busy", "loaded-cpu"]);
    expect(result.hosts.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(result.recommendedEnvironmentId).toBe("roomy");
    expect(result.hosts[0]!.reasons.join(" ")).toContain("Tightest now: CPU with 80% free");
    expect(result.hosts[0]!.reasons.join(" ")).toContain("Memory 14.0 GiB of 16.0 GiB available");
    expect(result.hosts[2]!.reasons.join(" ")).toContain("Tightest now: CPU with 10% free");
    expect(result.reasons.at(-1)).toBe("roomy ranks first of 3.");
  });

  it("breaks exact ties by fewer running sessions and jobs, then by name, whatever the input order", () => {
    const inventories = [
      host("beta", { sessions: 1 }),
      host("alpha", { sessions: 1 }),
      host("gamma", { sessions: 0, computer: computer({ running: 3 }) }),
      host("delta", { sessions: 0 }),
    ];
    const expected = ["delta", "alpha", "beta", "gamma"];
    expect(order(place(inventories))).toEqual(expected);
    expect(order(place(inventories.toReversed()))).toEqual(expected);
    expect(place(inventories)).toEqual(place(inventories.toReversed()));
  });

  it("compares declared needs, keeps a short computer listed, and says by how much", () => {
    const result = place(
      [
        host("small", { computer: computer({ memory: [3, 16], idle: 0.9, threads: 16 }) }),
        host("large", { computer: computer({ memory: [12, 32], idle: 0.5, threads: 16 }) }),
      ],
      { needs: { memoryBytes: 4 * GIB, cpuThreads: 3, diskBytes: 10 * GIB } },
    );
    expect(order(result)).toEqual(["large", "small"]);
    const [large, small] = result.hosts;
    expect(large!.fit).toBe("fits");
    expect(small!.fit).toBe("short");
    expect(small!.warnings).toContain("Needs 4.0 GiB memory but only 3.0 GiB is available.");
    // The shortfall ranks it lower; it is still listed and still a valid place to start.
    expect(result.hosts).toHaveLength(2);
    expect(large!.reasons.join(" ")).toContain("Tightest after the task: ");
    // When nothing fits, the best computer is still recommended with the shortfall spelled out.
    const hopeless = place([host("only", { computer: computer({ memory: [3, 16] }) })], {
      needs: { memoryBytes: 64 * GIB },
    });
    expect(hopeless.hosts[0]!.fit).toBe("short");
    expect(hopeless.recommendedEnvironmentId).toBe("only");
    expect(hopeless.hosts[0]!.reasons).toContain("Tightest after the task: memory with 0% free.");
  });

  it("says so when a declared need could not be compared", () => {
    const result = place([host("blind", { computer: computer({ idle: null }) })], {
      needs: { cpuThreads: 2 },
    });
    expect(result.hosts[0]!.fit).toBe("unknown");
    expect(result.hosts[0]!.warnings).toEqual([
      "CPU could not be measured; its need was not compared.",
    ]);
    expect(result.hosts[0]!.reasons.join(" ")).toContain("CPU load unknown on 8 threads");
  });

  it("ranks by what a declared disk need would leave on the disk that holds new work", () => {
    const result = place(
      [
        host("tight-disk", { computer: computer({ disk: [12, 500] }) }),
        host("big-disk", { computer: computer({ disk: [300, 500] }) }),
        host("no-work-disk", { computer: computer({ disk: null }) }),
      ],
      { needs: { diskBytes: 10 * GIB } },
    );
    expect(order(result)).toEqual(["big-disk", "tight-disk", "no-work-disk"]);
    expect(result.hosts.map((entry) => entry.fit)).toEqual(["fits", "fits", "unknown"]);
    expect(result.hosts[2]!.warnings).toContain(
      "The disk that holds new work is unknown; the disk need was not compared.",
    );
    // Without a disk need, free disk is shown but is not contention, so it does not rank.
    expect(
      order(place([host("a", { computer: computer({ disk: [1, 500] }) }), host("b")])),
    ).toEqual(["a", "b"]);
  });

  it("reports offline, unmeasured and stale computers instead of treating them as zero or idle", () => {
    const stale = host("stale", { computer: computer({ sampledAt: now - 11 * 60_000 }) });
    const result = place([
      offline("down"),
      host("older-server", { computer: undefined }),
      stale,
      host("fresh", { computer: computer({ memory: [1, 16], idle: 0.2 }) }),
    ]);
    expect(order(result)).toEqual(["fresh", "stale", "older-server", "down"]);
    expect(result.hosts.map((entry) => entry.state)).toEqual([
      "fresh",
      "stale",
      "unknown",
      "offline",
    ]);
    expect(result.hosts.map((entry) => entry.ageSeconds)).toEqual([2, 660, null, null]);
    expect(result.hosts[1]!.warnings[0]).toBe(
      "Reading is 11 min old; the allocation policy allows 10 min.",
    );
    expect(result.hosts[2]!.warnings[0]).toContain("No capacity reading");
    expect(result.hosts[3]!.warnings).toEqual([
      "Not reachable for this read.",
      "down: load unavailable for this decision.",
    ]);
    expect(result.hosts[3]!.computer).toBeNull();
    expect(result.hosts[3]!.sessions).toBeNull();
    // The reading age is judged against the live allocation setting, not a fixed limit.
    expect(place([stale], {}, 15).hosts[0]!.state).toBe("fresh");
    expect(place([stale], {}, 5).hosts[0]!.state).toBe("stale");
    // A needs comparison against a computer that was not measured stays unknown.
    expect(
      place([host("older-server", { computer: undefined })], { needs: { memoryBytes: GIB } })
        .hosts[0]!.fit,
    ).toBe("unknown");
  });

  it("puts computers without the project, the native OS or the provider runtime below ones that have them", () => {
    const projects = [{ id: ProjectId.make("project-1"), title: "scratch" }];
    const roomy: { memory: [number, number]; idle: number } = { memory: [15, 16], idle: 0.95 };
    const runtime = (id: string) => [account("codex-a", { environmentId: id })];
    const result = place(
      [
        host("windows-box", {
          projects,
          accounts: runtime("windows-box"),
          computer: computer({ ...roomy, os: "windows" }),
        }),
        host("no-checkout", {
          projects: [],
          accounts: runtime("no-checkout"),
          computer: computer(roomy),
        }),
        host("no-runtime", { projects, computer: computer(roomy) }),
        host("older-server", { accounts: runtime("older-server"), computer: computer(roomy) }),
        host("ready", {
          projects,
          accounts: runtime("ready"),
          computer: computer({ memory: [4, 16], idle: 0.3 }),
        }),
      ],
      {
        repositoryKey: "repo:example",
        needs: { os: "linux" },
        driver: ProviderDriverKind.make("codex"),
        model: "astra",
      },
    );
    // Compatible first, then unverified (the server could not say), then each unmet requirement.
    expect(order(result)).toEqual([
      "ready",
      "older-server",
      "no-checkout",
      "no-runtime",
      "windows-box",
    ]);
    const byLabel = Object.fromEntries(result.hosts.map((entry) => [entry.label, entry]));
    expect(byLabel["older-server"]!.warnings.join(" ")).toContain("Checkouts were not reported");
    expect(byLabel["windows-box"]!.warnings).toContain(
      "The task needs linux; this computer runs windows.",
    );
    expect(byLabel["no-checkout"]!.warnings.join(" ")).toContain(
      "No checkout of this project here",
    );
    expect(byLabel["no-runtime"]!.warnings).toContain(
      "No matching provider account or model on this computer.",
    );
    expect(byLabel["ready"]!.reasons.join(" ")).toContain("Checkout: scratch (project-1).");
    expect(byLabel["ready"]!.reasons.join(" ")).toContain("Provider runtime present: codex-a.");
    expect(byLabel["ready"]!.projects).toEqual(projects);
    expect(byLabel["older-server"]!.projects).toBeUndefined();
    // Every one stays listed and the best is still recommended, so nothing blocks a start.
    expect(result.hosts).toHaveLength(5);
    expect(result.recommendedEnvironmentId).toBe("ready");
  });

  it("matches a requested account by its login on another computer, and never ranks by quota or sign-in", () => {
    const shared = "login-hash";
    const result = place(
      [
        host("home", {
          accounts: [
            account("codex-es", {
              environmentId: "home",
              accountKey: shared,
              available: false,
              unavailableReason: "Provider rejected a prior session for quota/auth.",
              limitedUntil: "2026-10-27T00:00:00.000Z",
            }),
          ],
          computer: computer({ memory: [14, 16], idle: 0.9 }),
        }),
        host("away", {
          accounts: [
            account("codex-alias", { environmentId: "away", accountKey: shared }),
            account("codex-other", { environmentId: "away", accountKey: "someone-else" }),
          ],
          computer: computer({ memory: [6, 16], idle: 0.6 }),
        }),
        host("elsewhere", {
          accounts: [
            account("codex-other", { environmentId: "elsewhere", accountKey: "someone-else" }),
          ],
          computer: computer({ memory: [15, 16], idle: 0.99 }),
        }),
      ],
      { instanceId: ProviderInstanceId.make("codex-es"), driver: ProviderDriverKind.make("codex") },
    );
    const byLabel = Object.fromEntries(result.hosts.map((entry) => [entry.label, entry]));
    // `home` has the account but it is rejected there: a warning, not a lower rank.
    expect(order(result)).toEqual(["home", "away", "elsewhere"]);
    expect(byLabel["home"]!.warnings.join(" ")).toContain("codex-es is not ready here");
    expect(byLabel["away"]!.reasons.join(" ")).toContain("Provider runtime present: codex-alias.");
    expect(byLabel["away"]!.reasons.join(" ")).not.toContain("codex-other");
    expect(byLabel["elsewhere"]!.warnings).toContain(
      "No matching provider account or model on this computer.",
    );
  });

  describe("a computer the user named", () => {
    const big = host("big", { computer: computer({ memory: [14, 16], idle: 0.9 }) });
    const small = host("small", { computer: computer({ memory: [2, 16], idle: 0.2 }) });

    it("stays the answer when it is reachable, even when another ranks higher", () => {
      const kept = place([big, small], { environmentId: "small" });
      expect(kept.recommendedEnvironmentId).toBe("small");
      expect(order(kept)).toEqual(["big", "small"]);
      expect(kept.hosts.map((entry) => entry.chosen)).toEqual([false, true]);
      expect(kept.reasons.at(-1)).toBe("Kept your choice small (rank 2 of 2); big ranks first.");
      // The label works as well as the environment ID, case-insensitively.
      expect(place([big, small], { environmentId: "SMALL" }).recommendedEnvironmentId).toBe(
        "small",
      );
      // Unpinned, the same computers recommend the best one.
      expect(place([big, small]).recommendedEnvironmentId).toBe("big");
    });

    it("stays the answer when it is offline, and the better computer is only described", () => {
      const down = place([big, offline("alix")], { environmentId: "alix" });
      expect(down.recommendedEnvironmentId).toBe("alix");
      expect(down.hosts.find((entry) => entry.chosen)).toMatchObject({
        label: "alix",
        state: "offline",
      });
      expect(down.reasons.at(-1)).toBe(
        "Kept your choice alix, which is not reachable right now; big ranks first of the reachable ones.",
      );
      // Nothing else is reachable either: still the named one, with nothing to suggest instead.
      const alone = place([offline("alix"), offline("beta")], { environmentId: "alix" });
      expect(alone.recommendedEnvironmentId).toBe("alix");
      expect(alone.reasons.at(-1)).toBe("Kept your choice alix, which is not reachable right now.");
    });

    it("leaves no answer when it is not connected, and says what is", () => {
      const missing = place([big, small], { environmentId: "nowhere" });
      expect(missing.recommendedEnvironmentId).toBeNull();
      expect(missing.hosts.some((entry) => entry.chosen)).toBe(false);
      expect(missing.reasons.at(-1)).toBe(
        "The chosen computer nowhere is not connected here; connected: big, small. No computer is recommended in its place.",
      );
      // The same when nothing at all is connected.
      expect(place([], { environmentId: "nowhere" }).recommendedEnvironmentId).toBeNull();
    });

    it("stays the answer when it is short of the declared needs", () => {
      const short = place([big, small], {
        environmentId: "small",
        needs: { memoryBytes: 8 * GIB },
      });
      expect(short.recommendedEnvironmentId).toBe("small");
      expect(short.hosts.find((entry) => entry.chosen)).toMatchObject({ fit: "short" });
      expect(short.hosts.find((entry) => entry.chosen)!.warnings).toContain(
        "Needs 8.0 GiB memory but only 2.0 GiB is available.",
      );
    });

    it("stays the answer when it lacks the project, the OS or the provider runtime", () => {
      const projects = [{ id: ProjectId.make("project-1"), title: "scratch" }];
      const has = host("has", {
        projects,
        accounts: [account("codex-a", { environmentId: "has" })],
      });
      const lacks = host("lacks", { projects: [], computer: computer({ os: "windows" }) });
      const result = place([has, lacks], {
        environmentId: "lacks",
        repositoryKey: "repo:example",
        needs: { os: "linux" },
        driver: ProviderDriverKind.make("codex"),
      });
      expect(result.recommendedEnvironmentId).toBe("lacks");
      expect(order(result)).toEqual(["has", "lacks"]);
      expect(result.hosts.find((entry) => entry.chosen)!.warnings).toEqual([
        "No checkout of this project here; a worker for it cannot start on this computer yet.",
        "The task needs linux; this computer runs windows.",
        "No matching provider account or model on this computer.",
      ]);
      expect(result.reasons.at(-1)).toBe("Kept your choice lacks (rank 2 of 2); has ranks first.");
    });

    it("keeps an explicit account and model as constraints, never swapping them", () => {
      const result = place(
        [
          host("has", { accounts: [account("codex-a", { environmentId: "has" })] }),
          host("lacks", { computer: computer({ memory: [15, 16], idle: 0.99 }) }),
        ],
        {
          environmentId: "lacks",
          driver: ProviderDriverKind.make("codex"),
          model: "astra",
          instanceId: ProviderInstanceId.make("codex-a"),
        },
      );
      expect(result.request).toMatchObject({ model: "astra", instanceId: "codex-a" });
      expect(result.recommendedEnvironmentId).toBe("lacks");
      expect(result.hosts.find((entry) => entry.chosen)!.warnings).toContain(
        "No matching provider account or model on this computer.",
      );
    });
  });

  it("recommends nothing, and blocks nothing, when no computer could be read", () => {
    const result = place([offline("a"), offline("b")]);
    expect(result.recommendedEnvironmentId).toBeNull();
    expect(result.hosts).toHaveLength(2);
    expect(result.reasons.at(-1)).toBe(
      "No connected computer could be read. Starting a worker anywhere stays allowed.",
    );
  });

  it("explains a project that cannot be matched across computers", () => {
    const result = place([host("a")], { projectId: ProjectId.make("local-project") });
    expect(result.reasons.join(" ")).toContain("The project has no repository identity");
  });

  it("states the order it used and that it is advice, and produces a valid wire value", () => {
    const result = place(
      [
        host("a", { projects: [] }),
        host("b", { projects: [{ id: ProjectId.make("p"), title: "t" }] }),
      ],
      { repositoryKey: "repo:x", needs: { memoryBytes: GIB, cpuThreads: 1.5, diskBytes: GIB } },
    );
    expect(result.reasons[0]).toContain("Advice only: it never blocks a start");
    expect(decodePlacement(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
});

describe("active session caps", () => {
  it("ranks a computer at its default cap below a busier computer under its own cap", () => {
    const result = place([
      host("roomy", { sessions: 6, computer: computer({ memory: [15, 16], idle: 0.9 }) }),
      host("available", { sessions: 7, maxActiveAgentSessions: 8 }),
    ]);
    expect(order(result)).toEqual(["available", "roomy"]);
    expect(result.recommendedEnvironmentId).toBe("available");
    expect(result.hosts[1]?.warnings.join(" ")).toContain("6/6");
  });

  it("applies a changed cap on the next advice read and keeps explicit placement advisory", () => {
    const roomy = host("roomy", {
      sessions: 6,
      computer: computer({ memory: [15, 16], idle: 0.9 }),
    });
    const other = host("other");
    expect(place([roomy, other]).recommendedEnvironmentId).toBe("other");
    expect(place([{ ...roomy, maxActiveAgentSessions: 7 }, other]).recommendedEnvironmentId).toBe(
      "roomy",
    );
    expect(place([roomy, other], { environmentId: "roomy" }).recommendedEnvironmentId).toBe(
      "roomy",
    );
  });

  it("counts running agents rather than queued assignments and leaves offline counts unknown", () => {
    const queued = host("queued", { sessions: 9 });
    const result = place([
      { ...queued, demand: queued.demand.map((d) => ({ ...d, state: "pending" })) },
      offline("offline"),
    ]);
    expect(result.hosts[0]?.sessions).toBe(0);
    expect(result.hosts[1]?.sessions).toBeNull();
  });
});

it("reports disabled worker accounts in placement and prefers an enabled peer", () => {
  const result = place(
    [
      host("disabled", {
        accounts: [account("chosen", { environmentId: "disabled", availableForWorkers: false })],
      }),
      host("enabled", { accounts: [account("chosen", { environmentId: "enabled" })] }),
    ],
    { driver: ProviderDriverKind.make("codex") },
  );
  expect(result.recommendedEnvironmentId).toBe("enabled");
  expect(result.hosts.find((h) => h.environmentId === "disabled")?.warnings).toContain(
    "Turned off for workers in Provider allocation settings",
  );
});
