// @effect-diagnostics nodeBuiltinImport:off - a worker thread, shared memory and synchronous file calls have no Effect equivalent, and the evidence must not depend on the main event loop.
// @effect-diagnostics globalDate:off - the watcher runs in a worker thread without Effect, on the wall clock that goes into the file.
// @effect-diagnostics globalTimers:off globalTimersInEffect:off - the publisher must be a plain unref'd timer the worker can judge the event loop by.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";

/**
 * Evidence for a memory burst that ends in a kill. See "Memory bursts" in
 * docs/operations/observability.md.
 *
 * A worker thread samples the process every few seconds and keeps the samples
 * in memory. It writes nothing until resident memory climbs fast or the main
 * thread stops answering; then it appends the samples it holds, the operations
 * in flight, and one line per sample until things are quiet again. The file
 * is written with synchronous calls from the worker, so each line is in the
 * page cache before a SIGKILL and a blocked main thread cannot delay it.
 *
 * Every threshold is here.
 */
export const BURST_EVIDENCE = {
  /** How often the worker samples and the main thread publishes its heap numbers. */
  sampleIntervalMs: 5_000,
  /** Samples kept in memory and written when a burst starts: 5 minutes. */
  historySamples: 60,
  /** A burst starts when RSS is this far above its lowest value in the window. */
  rssGrowthBytes: 1024 * 1024 * 1024,
  rssGrowthWindowMs: 60_000,
  /** A burst also starts when the main thread has not published for this long. */
  mainThreadStallMs: 10_000,
  /** A burst ends after this long with neither condition. */
  quietMs: 60_000,
  /** The burst file moves to `.1` when it reaches this size. */
  burstFileMaxBytes: 4 * 1024 * 1024,
  /** Operations tracked at once; more are counted as dropped. */
  inFlightSlots: 2048,
  inFlightNameBytes: 64,
  /** Most recently started operations written per record. */
  inFlightReported: 40,
  /** Sets kept from runs that did not shut down cleanly, and the size of each. */
  preservedSets: 2,
  preservedSetMaxBytes: 40 * 1024 * 1024,
  preservedLogTailBytes: 256 * 1024,
} as const;

export const BURST_FILE_NAME = "server.memory-burst.ndjson";
const PRESERVED_PREFIX = "unclean-shutdown-";

export interface BurstWatcherConfig {
  readonly sampleIntervalMs: number;
  readonly historySamples: number;
  readonly rssGrowthBytes: number;
  readonly rssGrowthWindowMs: number;
  readonly mainThreadStallMs: number;
  readonly quietMs: number;
}

export interface BurstWatcherIo {
  readonly now: () => number;
  readonly rssBytes: () => number;
  /** What the main thread last published; `publishedAtMs` is 0 before the first time. */
  readonly main: () => {
    readonly publishedAtMs: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
  };
  readonly inFlight: () => unknown;
  /** Extra fields read only while a burst is recorded (virtual size, swap). */
  readonly detail: () => Record<string, unknown>;
  readonly write: (record: Record<string, unknown>) => void;
  readonly alert: (text: string) => void;
}

/**
 * Returns the function the worker calls once per sample. It runs inside the
 * worker as source text (`Function.prototype.toString`), so it must not use
 * anything outside its own body.
 */
export const makeBurstWatcher = (config: BurstWatcherConfig, io: BurstWatcherIo) => {
  interface Sample {
    readonly atMs: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
    readonly arrayBuffersBytes: number;
    readonly mainThreadSilentMs: number;
  }
  const history: Array<Sample> = [];
  let active = false;
  let lastTriggerMs = 0;
  let lastTickMs = 0;
  let lastReasons = "";

  const line = (sample: Sample) => ({
    type: "sample",
    at: new Date(sample.atMs).toISOString(),
    rssMb: Math.round(sample.rssBytes / 1048576),
    heapUsedMb: Math.round(sample.heapUsedBytes / 1048576),
    heapTotalMb: Math.round(sample.heapTotalBytes / 1048576),
    externalMb: Math.round(sample.externalBytes / 1048576),
    arrayBuffersMb: Math.round(sample.arrayBuffersBytes / 1048576),
    // The heap numbers come from the main thread, so they are this old.
    mainThreadSilentMs: sample.mainThreadSilentMs,
  });

  return () => {
    const now = io.now();
    const main = io.main();
    const sample: Sample = {
      atMs: now,
      rssBytes: io.rssBytes(),
      heapUsedBytes: main.heapUsedBytes,
      heapTotalBytes: main.heapTotalBytes,
      externalBytes: main.externalBytes,
      arrayBuffersBytes: main.arrayBuffersBytes,
      mainThreadSilentMs: main.publishedAtMs === 0 ? 0 : Math.max(0, now - main.publishedAtMs),
    };
    // A late tick means the whole process was stopped (system sleep, SIGSTOP),
    // so a silent main thread proves nothing this time.
    const tickWasLate = lastTickMs !== 0 && now - lastTickMs > 3 * config.sampleIntervalMs;
    lastTickMs = now;

    let lowestRss = sample.rssBytes;
    for (const earlier of history) {
      if (now - earlier.atMs <= config.rssGrowthWindowMs && earlier.rssBytes < lowestRss) {
        lowestRss = earlier.rssBytes;
      }
    }
    const reasons: Array<string> = [];
    if (sample.rssBytes - lowestRss >= config.rssGrowthBytes) reasons.push("rss-growth");
    if (!tickWasLate && sample.mainThreadSilentMs >= config.mainThreadStallMs) {
      reasons.push("main-thread-silent");
    }

    if (reasons.length > 0) {
      lastTriggerMs = now;
      if (!active) {
        active = true;
        lastReasons = "";
        io.write({
          type: "burst-start",
          at: new Date(now).toISOString(),
          reasons,
          thresholds: config,
        });
        for (const earlier of history) io.write(line(earlier));
        io.alert(
          `memory burst watcher: ${reasons.join(", ")}; rss ${Math.round(sample.rssBytes / 1048576)} MB, ` +
            `was ${Math.round(lowestRss / 1048576)} MB; main thread silent ${sample.mainThreadSilentMs} ms`,
        );
      }
    }

    history.push(sample);
    if (history.length > config.historySamples) history.shift();
    if (!active) return;

    io.write({ ...line(sample), ...io.detail(), reasons });
    const reasonsKey = reasons.join(",");
    if (reasons.length > 0 && reasonsKey !== lastReasons) {
      lastReasons = reasonsKey;
      io.write({
        type: "in-flight",
        at: new Date(now).toISOString(),
        reasons,
        ...(io.inFlight() as object),
      });
    }
    if (now - lastTriggerMs >= config.quietMs) {
      active = false;
      io.write({ type: "burst-end", at: new Date(now).toISOString() });
    }
  };
};

// Shared memory, written by the main thread and read by the worker.
// Header: [publishedAtMs, heapUsed, heapTotal, external, arrayBuffers, dropped].
const HEADER_FIELDS = 6;
const layout = (slots: number, nameBytes: number) => {
  const startsOffset = HEADER_FIELDS * 8;
  const lengthsOffset = startsOffset + slots * 8;
  const namesOffset = lengthsOffset + slots;
  return { startsOffset, lengthsOffset, namesOffset, byteLength: namesOffset + slots * nameBytes };
};

/** Records which operations have started and not returned. */
export interface InFlightTable {
  /** Returns the slot to pass to `end`, or -1 when the table is full. */
  readonly start: (name: string) => number;
  readonly end: (slot: number) => void;
}

export interface InFlightOperation {
  readonly name: string;
  readonly startedAt: string;
  readonly runningMs: number;
}

/**
 * The table of operations in flight, over shared memory. `start` and `end`
 * cost one short string encode and two array writes, with no allocation.
 */
export const makeInFlightTable = (
  slots: number = BURST_EVIDENCE.inFlightSlots,
  nameBytes: number = BURST_EVIDENCE.inFlightNameBytes,
) => {
  const offsets = layout(slots, nameBytes);
  const shared = new SharedArrayBuffer(offsets.byteLength);
  const header = new Float64Array(shared, 0, HEADER_FIELDS);
  const starts = new Float64Array(shared, offsets.startsOffset, slots);
  const lengths = new Uint8Array(shared, offsets.lengthsOffset, slots);
  const names = new Uint8Array(shared, offsets.namesOffset, slots * nameBytes);
  const encoder = new TextEncoder();
  const free = Array.from({ length: slots }, (_, index) => slots - 1 - index);

  const table: InFlightTable = {
    start(name) {
      const slot = free.pop();
      if (slot === undefined) {
        header[5] = (header[5] ?? 0) + 1;
        return -1;
      }
      const offset = slot * nameBytes;
      lengths[slot] = encoder.encodeInto(name, names.subarray(offset, offset + nameBytes)).written;
      starts[slot] = Date.now();
      return slot;
    },
    end(slot) {
      if (slot < 0) return;
      starts[slot] = 0;
      free.push(slot);
    },
  };
  return { shared, header, table, slots, nameBytes };
};

/**
 * Reads the operations in flight, newest first. Runs in the worker as source
 * text too, so it must not use anything outside its own body.
 */
export const readInFlight = (
  shared: SharedArrayBuffer,
  slots: number,
  nameBytes: number,
  limit: number,
  now: number,
) => {
  const startsOffset = 6 * 8;
  const starts = new Float64Array(shared, startsOffset, slots);
  const lengths = new Uint8Array(shared, startsOffset + slots * 8, slots);
  const namesOffset = startsOffset + slots * 8 + slots;
  const running: Array<{ slot: number; startedMs: number }> = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const startedMs = starts[slot] ?? 0;
    if (startedMs > 0) running.push({ slot, startedMs });
  }
  running.sort((left, right) => right.startedMs - left.startedMs);
  const operations: Array<InFlightOperation> = running
    .slice(0, limit)
    .map(({ slot, startedMs }) => ({
      name: Buffer.from(
        new Uint8Array(shared, namesOffset + slot * nameBytes, lengths[slot] ?? 0),
      ).toString("utf8"),
      startedAt: new Date(startedMs).toISOString(),
      runningMs: Math.max(0, now - startedMs),
    }));
  return {
    inFlightCount: running.length,
    inFlightDropped: new Float64Array(shared, 0, 6)[5] ?? 0,
    // Newest first: a blocked main thread is inside the ones at the top.
    inFlight: operations,
  };
};

const workerSource = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const makeBurstWatcher = ${makeBurstWatcher.toString()};
const readInFlight = ${readInFlight.toString()};
const { shared, slots, nameBytes, config, limits, filePath } = workerData;
const header = new Float64Array(shared, 0, 6);
let fd;
let size = 0;
const open = () => {
  fd = fs.openSync(filePath, "a");
  size = fs.fstatSync(fd).size;
};
const write = (record) => {
  try {
    if (fd === undefined) open();
    if (size >= limits.burstFileMaxBytes) {
      fs.closeSync(fd);
      fs.renameSync(filePath, filePath + ".1");
      open();
    }
    const text = JSON.stringify({ pid: process.pid, ...record }) + "\\n";
    size += fs.writeSync(fd, text);
  } catch {}
};
const detail = () => {
  try {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const mb = (key) => {
      const match = new RegExp("^" + key + ":\\\\s+(\\\\d+) kB", "m").exec(status);
      return match ? Math.round(Number(match[1]) / 1024) : undefined;
    };
    return { virtualMb: mb("VmSize"), swapMb: mb("VmSwap") };
  } catch {
    return {};
  }
};
const tick = makeBurstWatcher(config, {
  now: () => Date.now(),
  rssBytes: () => process.memoryUsage.rss(),
  main: () => ({
    publishedAtMs: header[0],
    heapUsedBytes: header[1],
    heapTotalBytes: header[2],
    externalBytes: header[3],
    arrayBuffersBytes: header[4],
  }),
  inFlight: () => readInFlight(shared, slots, nameBytes, limits.inFlightReported, Date.now()),
  detail,
  write,
  // Straight to the descriptor: the worker's process.stderr goes through the main thread.
  alert: (text) => {
    try {
      fs.writeSync(2, "[" + new Date().toISOString() + "] WARN " + text + "; details in " + filePath + "\\n");
    } catch {}
  },
});
setInterval(tick, config.sampleIntervalMs);
`;

/**
 * Starts the worker and the main thread's publisher for the current scope and
 * returns the table the tracer records operations in.
 */
export const start = Effect.fn("BurstEvidence.start")(function* (logsDir: string) {
  const { shared, header, table, slots, nameBytes } = makeInFlightTable();
  const publish = () => {
    const usage = process.memoryUsage();
    header[1] = usage.heapUsed;
    header[2] = usage.heapTotal;
    header[3] = usage.external;
    header[4] = usage.arrayBuffers;
    header[0] = Date.now();
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      publish();
      const timer = setInterval(publish, BURST_EVIDENCE.sampleIntervalMs);
      timer.unref();
      const worker = new NodeWorkerThreads.Worker(workerSource, {
        eval: true,
        name: "t3-burst-watcher",
        workerData: {
          shared,
          slots,
          nameBytes,
          config: BURST_EVIDENCE satisfies BurstWatcherConfig,
          limits: BURST_EVIDENCE,
          filePath: NodePath.join(logsDir, BURST_FILE_NAME),
        },
      });
      worker.unref();
      // Without a listener a worker error would take the server down.
      worker.on("error", () => undefined);
      return { timer, worker };
    }),
    ({ timer, worker }) =>
      Effect.promise(() => {
        clearInterval(timer);
        return worker.terminate();
      }),
  );
  return table;
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Sets aside what the previous run left when it did not shut down cleanly: a
 * clean shutdown removes `server-runtime.json`, so finding one whose process
 * is gone means the run was killed. Moves that run's newest trace files (up to
 * `preservedSetMaxBytes`), and copies the burst file and the tail of the log,
 * into `<logsDir>/unclean-shutdown-<time>-pid<pid>`, then keeps the newest
 * `preservedSets` such folders. Must run before the trace sink opens, because
 * the new run rotates the old files away within minutes.
 *
 * Returns the folder, or undefined when there was nothing to set aside.
 */
export const preservePreviousRun = (input: {
  readonly logsDir: string;
  readonly tracePath: string;
  readonly runtimeStatePath: string;
  readonly logPath?: string | undefined;
  readonly now?: Date;
}) => {
  let state: { readonly pid?: unknown };
  try {
    state = JSON.parse(NodeFS.readFileSync(input.runtimeStatePath, "utf8"));
  } catch {
    return undefined;
  }
  const pid = typeof state.pid === "number" ? state.pid : undefined;
  // A live process under that pid may be another server on this state dir.
  if (pid !== undefined && pid !== process.pid && isAlive(pid)) return undefined;

  const stamp = (input.now ?? new Date()).toISOString().replaceAll(":", "-");
  const folder = NodePath.join(input.logsDir, `${PRESERVED_PREFIX}${stamp}-pid${pid ?? "unknown"}`);
  NodeFS.mkdirSync(folder, { recursive: true });

  const traceDir = NodePath.dirname(input.tracePath);
  const traceName = NodePath.basename(input.tracePath);
  const traces = NodeFS.readdirSync(traceDir)
    .filter((name) => name === traceName || name.startsWith(`${traceName}.`))
    .map((name) => ({ name, stat: NodeFS.statSync(NodePath.join(traceDir, name)) }))
    .filter(({ stat }) => stat.isFile())
    .toSorted((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  let bytes = 0;
  for (const { name, stat } of traces) {
    if (bytes > 0 && bytes + stat.size > BURST_EVIDENCE.preservedSetMaxBytes) break;
    bytes += stat.size;
    NodeFS.renameSync(NodePath.join(traceDir, name), NodePath.join(folder, name));
  }

  const burstPath = NodePath.join(input.logsDir, BURST_FILE_NAME);
  if (NodeFS.existsSync(burstPath)) {
    NodeFS.copyFileSync(burstPath, NodePath.join(folder, BURST_FILE_NAME));
  }
  if (input.logPath !== undefined) {
    try {
      const fd = NodeFS.openSync(input.logPath, "r");
      try {
        const size = NodeFS.fstatSync(fd).size;
        const length = Math.min(size, BURST_EVIDENCE.preservedLogTailBytes);
        const tail = Buffer.alloc(length);
        NodeFS.readSync(fd, tail, 0, length, size - length);
        NodeFS.writeFileSync(NodePath.join(folder, "log-tail.txt"), tail);
      } finally {
        NodeFS.closeSync(fd);
      }
    } catch {
      // The log is optional evidence.
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(folder, "previous-run.json"),
    `${JSON.stringify({ foundAt: (input.now ?? new Date()).toISOString(), runtimeState: state }, null, 2)}\n`,
  );
  // So a start that dies before it listens is not counted as another unclean run.
  NodeFS.rmSync(input.runtimeStatePath, { force: true });

  const sets = NodeFS.readdirSync(input.logsDir)
    .filter((name) => name.startsWith(PRESERVED_PREFIX))
    .toSorted();
  for (const name of sets.slice(0, Math.max(0, sets.length - BURST_EVIDENCE.preservedSets))) {
    NodeFS.rmSync(NodePath.join(input.logsDir, name), { recursive: true, force: true });
  }
  return folder;
};

/**
 * The file this process logs to, when stderr is a regular file (the service
 * unit appends both streams to one). Linux only; undefined elsewhere.
 */
export const stderrLogPath = () => {
  try {
    if (!NodeFS.fstatSync(2).isFile()) return undefined;
    return NodeFS.readlinkSync("/proc/self/fd/2");
  } catch {
    return undefined;
  }
};
