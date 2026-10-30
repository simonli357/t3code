// @effect-diagnostics effectFnOpportunity:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Which processes belong to which workenv job: a process counts only while its live identity
 * equals an identity workenv recorded under `<job>/processes/`, never by name, working directory
 * or open files. Linux only, because Windows records use another start-time source.
 */
export interface Launched {
  readonly jobId: string;
  readonly pid: number;
  readonly start: string;
  readonly boot: string | null;
  readonly host: string | null;
}

const LaunchRecord = Schema.fromJsonString(
  Schema.Struct({
    processes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          pid: Schema.Number,
          start: Schema.String,
          boot: Schema.optionalKey(Schema.NullOr(Schema.String)),
          host: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);
const decodeLaunchRecord = Schema.decodeUnknownEffect(LaunchRecord);
const RECORDS_PER_JOB = 200;

export const readLaunched = Effect.fn("Workenv.readLaunched")(function* (
  jobs: ReadonlyArray<{ readonly id: string; readonly root: string }>,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const launched: Launched[] = [];
  yield* Effect.forEach(
    jobs,
    (job) =>
      Effect.gen(function* () {
        const folder = path.join(job.root, "processes");
        const names = (yield* fs
          .readDirectory(folder)
          .pipe(Effect.orElseSucceed(() => [] as string[])))
          .filter((name) => name.endsWith(".json"))
          .slice(0, RECORDS_PER_JOB);
        for (const name of names) {
          const record = yield* fs
            .readFileString(path.join(folder, name))
            .pipe(Effect.flatMap(decodeLaunchRecord), Effect.option);
          if (record._tag === "None") continue;
          for (const identity of record.value.processes ?? [])
            launched.push({
              jobId: job.id,
              pid: identity.pid,
              start: identity.start,
              boot: identity.boot ?? null,
              host: identity.host ?? null,
            });
        }
      }),
    { concurrency: 8, discard: true },
  );
  return launched;
});

/** The live identity of a process: its start time, unless it is gone or a zombie. */
const startOf = (raw: string) => {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return fields[0] === "Z" || fields.length < 20 ? null : fields[19]!;
};

export const readBootId = Effect.fn("Workenv.readBootId")(function* (procRoot = "/proc") {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${procRoot}/sys/kernel/random/boot_id`).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => null),
  );
});

/** Ids of the jobs with at least one recorded process that is alive right now. */
export const runningJobs = Effect.fn("Workenv.runningJobs")(function* (
  launched: readonly Launched[],
  procRoot = "/proc",
) {
  const fs = yield* FileSystem.FileSystem,
    host = yield* HostProcess.Hostname;
  const running = new Set<string>();
  if (!launched.length) return running;
  const boot = yield* readBootId(procRoot);
  if (!boot) return running;
  yield* Effect.forEach(
    launched.filter((item) => item.boot === boot && item.host === host),
    (item) =>
      fs.readFileString(`${procRoot}/${item.pid}/stat`).pipe(
        Effect.tap((raw) =>
          Effect.sync(() => startOf(raw) === item.start && running.add(item.jobId)),
        ),
        Effect.ignore,
      ),
    { concurrency: 16, discard: true },
  );
  return running;
});

/** The job that launched the process with this live identity, or null. */
export function attributeToJob(
  launched: ReadonlyMap<number, readonly Launched[]>,
  process: { readonly pid: number; readonly start: string },
  boot: string | null,
  host: string,
): string | null {
  return (
    launched
      .get(process.pid)
      ?.find((item) => item.start === process.start && item.boot === boot && item.host === host)
      ?.jobId ?? null
  );
}
