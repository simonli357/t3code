import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ComputerInspection,
  type ComputerInspectInput,
} from "@t3tools/contracts";
import { createComputerDetailReader } from "./computersDetail";

const computer = EnvironmentId.make("a");
const snapshot: ComputerInspection = {
  sampledAt: 1,
  resources: null,
  history: [],
  disks: [],
  files: [],
  totalFiles: 0,
  indexedAt: null,
  indexing: false,
  projects: [],
  processes: [],
  activities: [],
  errors: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("selected computer details", () => {
  it("keeps a slow request through several polling ticks and displays its answer", async () => {
    const answer = deferred<ComputerInspection>();
    const received: ComputerInspection[] = [];
    let calls = 0;
    const reader = createComputerDetailReader(
      async () => {
        calls++;
        return answer.promise;
      },
      (result) => received.push(result),
      () => {},
    );
    const first = reader.request(computer, { section: "processes" });
    const ticks = Array.from({ length: 4 }, () =>
      reader.request(computer, { section: "processes" }),
    );
    expect(calls).toBe(1);
    answer.resolve(snapshot);
    await Promise.all([first, ...ticks]);
    expect(received).toEqual([snapshot]);
  });

  it("ignores an old answer after switching away and back to the same selection", async () => {
    const old = deferred<ComputerInspection>();
    const received: ComputerInspection[] = [];
    let calls = 0;
    const reader = createComputerDetailReader(
      async () => (++calls === 1 ? old.promise : { ...snapshot, sampledAt: 2 }),
      (result) => received.push(result),
      () => {},
    );
    const first = reader.request(computer, { section: "processes" });
    reader.invalidate();
    await reader.request(computer, { section: "processes" });
    old.resolve(snapshot);
    await first;
    expect(received.map((result) => result.sampledAt)).toEqual([2]);
  });

  it("coalesces forced refreshes during a pending folder read", async () => {
    const old = deferred<ComputerInspection>();
    const calls: ComputerInspectInput[] = [];
    const reader = createComputerDetailReader(
      async (_id, input) => {
        calls.push(input);
        return calls.length === 1 ? old.promise : snapshot;
      },
      () => {},
      () => {},
    );
    const first = reader.request(computer, { section: "folders", path: "/work" });
    void reader.request(computer, { section: "folders", path: "/work", refresh: true });
    void reader.request(computer, { section: "folders", path: "/work", refresh: true });
    old.resolve(snapshot);
    await first;
    expect(calls).toEqual([
      { section: "folders", path: "/work" },
      { section: "folders", path: "/work", refresh: true },
    ]);
  });

  it("ignores errors after close and allows retry after a current failure", async () => {
    const old = deferred<ComputerInspection>();
    const errors: unknown[] = [];
    let calls = 0;
    const reader = createComputerDetailReader(
      async () => {
        if (++calls === 1) return old.promise;
        throw new Error("offline");
      },
      () => {},
      (error) => errors.push(error),
    );
    const first = reader.request(computer, { section: "processes" });
    reader.invalidate();
    old.reject(new Error("old failure"));
    await first;
    expect(errors).toEqual([]);
    await reader.request(computer, { section: "processes" });
    await reader.request(computer, { section: "processes" });
    expect(errors.map(String)).toEqual(["Error: offline", "Error: offline"]);
  });
});
