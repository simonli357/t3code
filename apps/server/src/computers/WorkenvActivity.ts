import type { ComputerActivity } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  decodeHandoff,
  decodeJob,
  messageOf,
  type HandoffReceipt,
  type WorkenvConfig,
} from "./WorkenvConfig.ts";
import { readLaunched, runningJobs } from "./WorkenvProcesses.ts";
import { samePath } from "./paths.ts";

const Observation = Schema.fromJsonString(Schema.Struct({ observed_at: Schema.Number }));
const decodeObservation = Schema.decodeUnknownEffect(Observation);
const JOB_KEY = /-([0-9a-f]{24})(?:-r\d+)?$/;
const basename = (value: string) => value.split(/[\\/]/).findLast(Boolean) ?? value;

/** Every folder a workenv job can live in: the global one and per-project overrides. */
const jobRoots = (config: WorkenvConfig) => [
  ...new Set(
    [
      config.jobs_root,
      ...Object.values(config.projects).map((project) => project.jobs_root),
    ].filter((root): root is string => Boolean(root)),
  ),
];

/**
 * Workenv jobs, from each job's own `.workenv.json` (the same record on Linux and Windows). The
 * `sessions` folder next to workenv's state holds observation files for the same jobs, which say
 * when the agent last started or used a tool there; a record alone only says a job exists.
 */
export const readJobs = Effect.fn("Workenv.readJobs")(function* (
  config: WorkenvConfig,
  procRoot = "/proc",
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcessPlatform;
  const errors: string[] = [];
  const activities: ComputerActivity[] = [];
  const workRoots: { path: string; project: string; area: "work" }[] = [];
  const observed = Effect.fn(function* (name: string, suffix: string) {
    const key = JOB_KEY.exec(name)?.[1];
    if (!key) return 0;
    return yield* fs
      .readFileString(path.join(config.state, "sessions", `${key}.${suffix}.json`))
      .pipe(
        Effect.flatMap(decodeObservation),
        Effect.map((value) => value.observed_at * 1000),
        Effect.orElseSucceed(() => 0),
      );
  });
  for (const root of jobRoots(config)) {
    const canonicalRoot = yield* fs.realPath(root).pipe(Effect.option);
    const names = yield* fs.readDirectory(root).pipe(
      Effect.catch((cause) => {
        errors.push(`Cannot read the workenv jobs folder ${root}: ${messageOf(cause)}`);
        return Effect.succeed([] as string[]);
      }),
    );
    yield* Effect.forEach(
      names.slice(0, 5000),
      (name) =>
        Effect.gen(function* () {
          const job = yield* fs
            .readFileString(path.join(root, name, ".workenv.json"))
            .pipe(Effect.flatMap(decodeJob), Effect.option);
          if (job._tag === "None") return;
          const folder = path.join(root, name);
          const canonicalJob = yield* fs.realPath(folder).pipe(Effect.option);
          if (
            canonicalRoot._tag === "Some" &&
            canonicalJob._tag === "Some" &&
            samePath(platform, path.normalize(job.value.root), path.normalize(folder)) &&
            samePath(platform, canonicalJob.value, path.join(canonicalRoot.value, name))
          ) {
            for (const area of ["outputs", "evidence", "inputs"]) {
              const candidate = path.join(folder, area);
              const actual = yield* fs.realPath(candidate).pipe(Effect.option);
              if (
                actual._tag === "Some" &&
                samePath(platform, actual.value, path.join(canonicalJob.value, area)) &&
                (yield* fs.stat(candidate).pipe(Effect.option)).pipe(
                  (info) => info._tag === "Some" && info.value.type === "Directory",
                )
              )
                workRoots.push({ path: candidate, project: job.value.project, area: "work" });
            }
          }
          const active = job.value.status === "active";
          const lastSeen = active
            ? Math.max(yield* observed(name, "last-start"), yield* observed(name, "tools"))
            : 0;
          activities.push({
            id: `job:${name}`,
            kind: "job",
            label: job.value.project,
            status: job.value.status,
            updatedAt: Math.max(lastSeen, (job.value.created_at ?? 0) * 1000),
            source: job.value.root,
            detail: `Workenv job record${job.value.mode ? ` (${job.value.mode})` : ""}; its status does not mean a process is running.`,
            retryable: false,
          });
        }),
      { concurrency: 8, discard: true },
    );
  }
  // A job runs while a process workenv recorded for it is alive; otherwise it keeps its own
  // state, because an active job says nothing about processes. Only Linux records are usable.
  const launched =
    platform === "linux"
      ? yield* readLaunched(
          activities.flatMap((job) => (job.source ? [{ id: job.id, root: job.source }] : [])),
        )
      : [];
  const running = yield* runningJobs(launched, procRoot);
  return {
    activities: activities.map((job) =>
      running.has(job.id)
        ? {
            ...job,
            status: "running",
            detail: "A process workenv launched for this job is running.",
          }
        : ["creating", "copying", "verifying", "inspecting"].includes(job.status)
          ? {
              ...job,
              status: "stalled",
              detail: `Last recorded: ${job.status}; its process was not found.`,
            }
          : job,
    ),
    launched,
    workRoots,
    errors,
  };
});

/** One handoff receipt as an activity; sender and receiver receipts share a folder. */
export function handoffActivity(
  key: string,
  handoff: HandoffReceipt,
  details: { modifiedAt: number | null; sourceExists: boolean },
): ComputerActivity {
  const receiver = handoff.role === "receiver";
  const delivered = handoff.status === "delivered";
  const cancelled = handoff.status === "cancelled";
  const status = delivered
    ? "completed"
    : cancelled
      ? "cancelled"
      : handoff.error
        ? "failed"
        : "pending";
  const target = `${handoff.destination.host}:${handoff.destination.path}`;
  const retryable =
    !receiver && !delivered && !cancelled && handoff.version === 2 && details.sourceExists;
  return {
    id: `handoff:${key}`,
    kind: "transfer",
    label: receiver
      ? `Incoming input ${basename(handoff.destination.path)}`
      : `Handoff to ${handoff.destination.host}: ${basename(handoff.destination.path)}`,
    status,
    updatedAt: handoff.source_verified_at
      ? handoff.source_verified_at * 1000
      : (details.modifiedAt ?? 0),
    detail: delivered
      ? `Delivered to ${handoff.reference ?? target}.`
      : cancelled
        ? (handoff.cancel_reason ?? "Cancelled.")
        : [
            handoff.error ??
              (receiver ? "Waiting for the sender to finish." : `Waiting to deliver to ${target}.`),
            !receiver && !details.sourceExists
              ? "The source no longer exists, so this handoff cannot be retried."
              : null,
            !receiver && handoff.version !== 2
              ? "Only handoffs recorded by the current workenv can be retried."
              : null,
          ]
            .filter(Boolean)
            .join(" "),
    source: handoff.source,
    retryable,
  };
}

export const readHandoffs = Effect.fn("Workenv.readHandoffs")(function* (config: WorkenvConfig) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const directory = path.join(config.state, "handoffs");
  const receipts: { key: string; handoff: HandoffReceipt }[] = [];
  const activities: ComputerActivity[] = [];
  const errors: string[] = [];
  if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false))))
    return { activities, receipts, errors };
  const names = (yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed(() => [] as string[])))
    .filter((name) => name.endsWith(".json"))
    .slice(0, 5000);
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.gen(function* () {
        const file = path.join(directory, name);
        const handoff = yield* fs.readFileString(file).pipe(
          Effect.flatMap(decodeHandoff),
          Effect.catch((cause) => {
            errors.push(`Cannot read handoff receipt ${name}: ${messageOf(cause)}`);
            return Effect.succeed(null);
          }),
        );
        if (!handoff) return;
        const info = yield* fs.stat(file).pipe(Effect.option);
        const key = name.slice(0, -5);
        receipts.push({ key, handoff });
        activities.push(
          handoffActivity(key, handoff, {
            modifiedAt:
              info._tag === "Some" && info.value.mtime._tag === "Some"
                ? info.value.mtime.value.getTime()
                : null,
            sourceExists:
              handoff.role === "receiver"
                ? false
                : yield* fs.exists(handoff.source).pipe(Effect.orElseSucceed(() => false)),
          }),
        );
      }),
    { concurrency: 8, discard: true },
  );
  return { activities, receipts, errors };
});
