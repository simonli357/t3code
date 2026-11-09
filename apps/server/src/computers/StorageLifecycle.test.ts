import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  newLifecycleCache,
  readCapacityLayout,
  readLifecycle,
  readSharedLocations,
  sharedProtection,
} from "./StorageLifecycle.ts";
import { toJson, workenvConfig } from "./testSupport.ts";

/** The files the lifecycle tool installs, shaped as it writes them, in a temporary folder. */
const GiB = 2 ** 30;
const folder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lifecycle-" });
  return { fs, root };
});

it.layer(NodeServices.layer)("the lifecycle tool's installed files", (it) => {
  it.effect("reads job lifecycle records into states, expiry, holds and pending preservation", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* folder;
      yield* fs.makeDirectory(`${root}/expiry`);
      const write = (name: string, record: object) =>
        fs.writeFileString(`${root}/expiry/${name}.json`, toJson(record));
      yield* write("a", {
        job: "/jobs/active",
        observed_at: 1_792_000_000.5,
        status: "active",
        last_activity: 1_791_990_000.25,
        hold_reasons: [],
        allocation: { single_link_file_bytes: 99934208, basis: "Estimate only." },
      });
      yield* write("b", {
        job: "/jobs/held",
        observed_at: 1_792_000_000,
        status: "held",
        hold_reasons: [
          "Required independent backup is pending",
          "Required independent backup is pending",
        ],
        usage: {
          pending_keeps: [
            { reason: "Backup of /jobs/held/outputs is not confirmed", status: "published" },
          ],
          pending_handoffs: [{ id: "h" }],
        },
      });
      yield* write("c", {
        job: "/jobs/grace",
        observed_at: 1_792_000_000,
        status: "grace",
        grace_started: 1_791_900_000,
        expires_at: 1_792_100_000,
        hold_reasons: [],
      });
      yield* write("d", {
        job: "/jobs/gone",
        observed_at: 1_792_000_000,
        status: "removed",
        hold_reasons: [],
        recovery: [{ logical_bytes: 1000 }, { logical_bytes: 2000 }],
      });
      yield* write("e", {
        job: "/jobs/fixture",
        observed_at: 1,
        status: "active",
        fixture_only: true,
      });
      yield* fs.writeFileString(`${root}/expiry/broken.json`, "{not json");
      const records = yield* readLifecycle(root, newLifecycleCache());
      const by = Object.fromEntries(records.map((record) => [record.job, record]));
      expect(Object.keys(by).toSorted()).toEqual([
        "/jobs/active",
        "/jobs/gone",
        "/jobs/grace",
        "/jobs/held",
      ]);
      expect(by["/jobs/active"]).toMatchObject({
        status: "active",
        lastActivityAt: 1_791_990_000_250,
        allocatedBytes: 99934208,
        allocationBasis: "Estimate only.",
        expiresAt: null,
      });
      expect(by["/jobs/held"]).toMatchObject({
        // The same reason twice is one reason; keeps and handoffs the tool waits on are pending.
        holdReasons: ["Required independent backup is pending"],
        pending: [
          "Backup of /jobs/held/outputs is not confirmed",
          "A handoff is not delivered yet",
        ],
        allocatedBytes: null,
      });
      expect(by["/jobs/grace"]).toMatchObject({ status: "grace", expiresAt: 1_792_100_000_000 });
      expect(by["/jobs/gone"]).toMatchObject({
        status: "removed",
        recoveryRefs: 2,
        recoveryBytes: 3000,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reads the reserves and locations the capacity configuration declares for this computer",
    () =>
      Effect.gen(function* () {
        const { fs, root } = yield* folder;
        const file = `${root}/capacity.json`;
        yield* fs.writeFileString(
          file,
          toJson({
            hosts: [
              {
                name: "Laptop",
                jobs_roots: ["/home/user/jobs"],
                paths: {
                  jobs: { path: "/home/user/jobs", reserve_bytes: 100 * GiB },
                  library: { path: "/srv/library", reserve_bytes: 100 * GiB },
                  runtime: { path: "/opt/runtime", reserve_bytes: 20 * GiB },
                  broken: { error: "needs repair" },
                },
              },
              { name: "other", paths: { jobs: { path: "/x", reserve_bytes: 1 } } },
            ],
            library: { host: "laptop", path: "library" },
          }),
        );
        const config = { ...workenvConfig(root), capacity_config: file };
        const layout = yield* readCapacityLayout(config, "laptop.local");
        expect(layout.reserves).toEqual([
          { path: "/home/user/jobs", role: "agent-work", bytes: 100 * GiB },
          { path: "/srv/library", role: "library", bytes: 100 * GiB },
          { path: "/opt/runtime", role: "other", bytes: 20 * GiB },
        ]);
        expect(layout.runtimes).toEqual([{ key: "runtime", path: "/opt/runtime" }]);
        expect(layout.jobRoots).toEqual(["/home/user/jobs"]);
        expect(layout.source).toMatch(/capacity configuration/);
        // A computer the file does not name, a missing file and a missing setting declare nothing.
        expect((yield* readCapacityLayout(config, "stranger")).reserves).toEqual([]);
        expect((yield* readCapacityLayout(config, "stranger")).notices[0]).toMatch(
          /does not name stranger/,
        );
        expect(
          (yield* readCapacityLayout({ ...config, capacity_config: `${root}/none.json` }, "laptop"))
            .notices[0],
        ).toMatch(/could not be read/);
        expect((yield* readCapacityLayout(workenvConfig(root), "laptop")).reserves).toEqual([]);
        expect((yield* readCapacityLayout(null, "laptop")).source).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("reads the shared locations with what the tool does to each", () =>
    Effect.gen(function* () {
      const { fs, root } = yield* folder;
      yield* fs.makeDirectory(`${root}/.config/workenv`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/.config/workenv/linux-jobs.json`,
        toJson({
          shared_locations: [
            {
              name: "docker",
              path: "/var/lib/docker",
              policy: "docker",
              build_cache_cap_bytes: 5 * GiB,
              image_age_days: 14,
            },
            { name: "caches", path: "/home/user/.cache/x", policy: "cache", cap_bytes: 20 * GiB },
            {
              name: "rustup",
              path: "/home/user/.rustup",
              policy: "report",
              note: "Active Rust toolchains",
            },
            { name: "tmp", path: "/tmp", policy: "temp", age_days: 7 },
            { name: "pnpm", path: "/home/user/.pnpm", policy: "pnpm" },
          ],
        }),
      );
      const locations = yield* readSharedLocations("linux").pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: root }),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(locations.map((location) => location.name)).toEqual([
        "docker",
        "caches",
        "rustup",
        "tmp",
        "pnpm",
      ]);
      expect(locations.map(sharedProtection)).toEqual([
        "Container storage; build cache is capped at 5 GiB, unused images and finished containers older than 14 days are removed, volumes never",
        "Regenerable cache; its oldest entries are removed above 20 GiB",
        "Measured only, never removed automatically: Active Rust toolchains",
        "Temporary files; entries untouched for 7 days are removed",
        "Package store; pruned only when no install is running",
      ]);
      // A computer without the file lists none.
      const none = yield* readSharedLocations("win32").pipe(
        Effect.provideService(HostProcessEnvironment, { HOME: root, USERPROFILE: root }),
      );
      expect(none).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
