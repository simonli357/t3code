// @effect-diagnostics nodeBuiltinImport:off - the code under test reads and moves real files synchronously.
// @effect-diagnostics globalDate:off - fixed wall-clock times for the file names and ages under test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";

import {
  BURST_FILE_NAME,
  type BurstWatcherIo,
  makeBurstWatcher,
  makeInFlightTable,
  preservePreviousRun,
  readInFlight,
} from "./BurstEvidence.ts";

const MB = 1024 * 1024;
const config = {
  sampleIntervalMs: 2_000,
  historySamples: 5,
  rssGrowthBytes: 1024 * MB,
  rssGrowthWindowMs: 60_000,
  mainThreadStallMs: 10_000,
  quietMs: 6_000,
};

const makeHarness = () => {
  const state = { now: 1_000_000, rssMb: 800, publishedAtMs: 1_000_000 };
  const records: Array<Record<string, unknown>> = [];
  const alerts: Array<string> = [];
  const io: BurstWatcherIo = {
    now: () => state.now,
    rssBytes: () => state.rssMb * MB,
    main: () => ({
      publishedAtMs: state.publishedAtMs,
      heapUsedBytes: 500 * MB,
      heapTotalBytes: 600 * MB,
      externalBytes: 30 * MB,
      arrayBuffersBytes: 10 * MB,
    }),
    inFlight: () => ({ inFlight: [{ name: "server.heapSnapshot" }] }),
    detail: () => ({ virtualMb: 4000 }),
    write: (record) => records.push(record),
    alert: (text) => alerts.push(text),
  };
  const tick = makeBurstWatcher(config, io);
  /** Advances one sample; the main thread keeps publishing unless `blocked`. */
  const step = (rssMb: number, blocked = false) => {
    state.now += config.sampleIntervalMs;
    state.rssMb = rssMb;
    if (!blocked) state.publishedAtMs = state.now;
    tick();
  };
  return { state, records, alerts, step, tick };
};

const types = (records: ReadonlyArray<Record<string, unknown>>) => records.map((r) => r.type);

describe("makeBurstWatcher", () => {
  it("writes nothing while memory is steady and the main thread answers", () => {
    const { records, alerts, step } = makeHarness();
    for (let index = 0; index < 100; index += 1) step(800 + (index % 7) * 20);
    assert.deepEqual(records, []);
    assert.deepEqual(alerts, []);
  });

  it("writes the samples it held, then one per tick, when RSS climbs fast", () => {
    const { records, alerts, step } = makeHarness();
    step(800);
    step(810);
    step(2000);
    assert.deepEqual(types(records), ["burst-start", "sample", "sample", "sample", "in-flight"]);
    assert.deepEqual(records[0]?.reasons, ["rss-growth"]);
    assert.deepEqual(
      records.filter((r) => r.type === "sample").map((r) => r.rssMb),
      [800, 810, 2000],
    );
    assert.strictEqual(records[3]?.heapUsedMb, 500);
    assert.strictEqual(records[3]?.externalMb, 30);
    assert.strictEqual(records[3]?.arrayBuffersMb, 10);
    assert.strictEqual(records[3]?.virtualMb, 4000);
    assert.strictEqual(alerts.length, 1);

    step(4000);
    assert.strictEqual(records.at(-1)?.rssMb, 4000);
    assert.strictEqual(alerts.length, 1);
  });

  it("reports a silent main thread with the operations in flight", () => {
    const { records, step } = makeHarness();
    for (let index = 0; index < 4; index += 1) step(800, true);
    assert.deepEqual(records, []);
    step(800, true);
    assert.deepEqual(records[0]?.reasons, ["main-thread-silent"]);
    const inFlight = records.find((r) => r.type === "in-flight");
    assert.deepEqual(inFlight?.inFlight, [{ name: "server.heapSnapshot" }]);
    assert.strictEqual(records.at(-2)?.mainThreadSilentMs, 10_000);
  });

  it("ends the burst after the quiet period and starts a new one later", () => {
    const { records, step } = makeHarness();
    step(800);
    step(2000);
    // RSS stays high but stops growing: the window forgets the low value only
    // after rssGrowthWindowMs, so the burst ends quietMs after that.
    for (let index = 0; index < 40; index += 1) step(2000);
    assert.strictEqual(records.at(-1)?.type, "burst-end");
    const written = records.length;
    step(2000);
    assert.strictEqual(records.length, written);
    step(3100);
    assert.strictEqual(records.filter((r) => r.type === "burst-start").length, 2);
  });

  it("does not call the main thread silent after the whole process was stopped", () => {
    const { state, records, tick, step } = makeHarness();
    step(800);
    // A system sleep: both threads miss an hour, and the worker wakes first.
    state.now += 3_600_000;
    tick();
    assert.deepEqual(records, []);
    step(800);
    assert.deepEqual(records, []);
  });
});

describe("in-flight table", () => {
  it("lists operations that started and have not ended, newest first", () => {
    const { shared, table, slots, nameBytes } = makeInFlightTable(4, 16);
    const first = table.start("ws.rpc.first");
    const second = table.start("sql.execute");
    table.end(first);
    const third = table.start("a-name-longer-than-sixteen-bytes");
    const read = readInFlight(shared, slots, nameBytes, 10, Date.now() + 5);
    assert.strictEqual(read.inFlightCount, 2);
    assert.deepEqual(read.inFlight.map((operation) => operation.name).toSorted(), [
      "a-name-longer-th",
      "sql.execute",
    ]);
    table.end(second);
    table.end(third);
    assert.strictEqual(readInFlight(shared, slots, nameBytes, 10, Date.now()).inFlightCount, 0);
  });

  it("counts operations it has no slot for instead of failing", () => {
    const { shared, table, slots, nameBytes } = makeInFlightTable(2, 16);
    table.start("a");
    table.start("b");
    const overflow = table.start("c");
    table.end(overflow);
    const read = readInFlight(shared, slots, nameBytes, 1, Date.now());
    assert.strictEqual(read.inFlightCount, 2);
    assert.strictEqual(read.inFlightDropped, 1);
    assert.strictEqual(read.inFlight.length, 1);
  });
});

describe("preservePreviousRun", () => {
  const setup = () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-burst-evidence-"));
    const logsDir = NodePath.join(stateDir, "logs");
    NodeFS.mkdirSync(logsDir);
    const input = {
      logsDir,
      tracePath: NodePath.join(logsDir, "server.trace.ndjson"),
      runtimeStatePath: NodePath.join(stateDir, "server-runtime.json"),
      logPath: NodePath.join(stateDir, "service.log"),
    };
    const writeTraces = () => {
      NodeFS.writeFileSync(input.tracePath, "current\n");
      NodeFS.writeFileSync(`${input.tracePath}.1`, "older\n");
    };
    return { stateDir, logsDir, input, writeTraces };
  };
  // A pid no process has: above the kernel's default pid_max.
  const deadPid = 4_194_305;

  it("does nothing after a clean shutdown", () => {
    const { stateDir, logsDir, input, writeTraces } = setup();
    writeTraces();
    assert.strictEqual(preservePreviousRun(input), undefined);
    assert.deepEqual(NodeFS.readdirSync(logsDir).toSorted(), [
      "server.trace.ndjson",
      "server.trace.ndjson.1",
    ]);
    NodeFS.rmSync(stateDir, { recursive: true });
  });

  it("leaves the files alone while the recorded server is still running", () => {
    const { stateDir, logsDir, input, writeTraces } = setup();
    writeTraces();
    NodeFS.writeFileSync(input.runtimeStatePath, JSON.stringify({ pid: process.ppid }));
    assert.strictEqual(preservePreviousRun(input), undefined);
    assert.strictEqual(NodeFS.readdirSync(logsDir).length, 2);
    NodeFS.rmSync(stateDir, { recursive: true });
  });

  it("moves the killed run's traces, burst file and log tail aside", () => {
    const { stateDir, logsDir, input, writeTraces } = setup();
    writeTraces();
    NodeFS.writeFileSync(NodePath.join(logsDir, BURST_FILE_NAME), "burst\n");
    NodeFS.writeFileSync(input.logPath, "last log line\n");
    NodeFS.writeFileSync(input.runtimeStatePath, JSON.stringify({ pid: deadPid }));

    const folder = preservePreviousRun({ ...input, now: new Date("2026-11-16T23:56:40Z") });

    assert.strictEqual(
      folder,
      NodePath.join(logsDir, `unclean-shutdown-2026-11-16T23-56-40.000Z-pid${deadPid}`),
    );
    assert.deepEqual(NodeFS.readdirSync(folder ?? "").toSorted(), [
      "log-tail.txt",
      "previous-run.json",
      BURST_FILE_NAME,
      "server.trace.ndjson",
      "server.trace.ndjson.1",
    ]);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(folder ?? "", "log-tail.txt"), "utf8"),
      "last log line\n",
    );
    // Nothing is left for the new run to overwrite, and the next start is clean.
    assert.strictEqual(NodeFS.existsSync(input.tracePath), false);
    assert.strictEqual(NodeFS.existsSync(input.runtimeStatePath), false);
    assert.strictEqual(preservePreviousRun(input), undefined);
    NodeFS.rmSync(stateDir, { recursive: true });
  });

  it("keeps the two newest sets", () => {
    const { stateDir, logsDir, input, writeTraces } = setup();
    for (const day of ["13", "14", "15"]) {
      writeTraces();
      NodeFS.writeFileSync(input.runtimeStatePath, JSON.stringify({ pid: deadPid }));
      preservePreviousRun({ ...input, now: new Date(`2026-11-${day}T12:00:00Z`) });
    }
    assert.deepEqual(
      NodeFS.readdirSync(logsDir).map((name) => name.slice(0, 27)),
      ["unclean-shutdown-2026-11-14", "unclean-shutdown-2026-11-15"],
    );
    NodeFS.rmSync(stateDir, { recursive: true });
  });
});
