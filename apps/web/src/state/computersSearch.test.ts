import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ComputerInspection,
  type ComputerInspectInput,
} from "@t3tools/contracts";
import { createComputersSearch, RESULTS_PAGE_SIZE } from "./computersSearch";

const a = EnvironmentId.make("a"),
  b = EnvironmentId.make("b");
const inspection = (offset = 0, totalFiles = 500_000, indexedAt = 1): ComputerInspection => ({
  sampledAt: 1,
  resources: null,
  history: [],
  disks: [],
  processes: [],
  activities: [],
  errors: [],
  projects: ["Project"],
  indexedAt,
  indexing: false,
  totalFiles,
  files: Array.from({ length: Math.min(RESULTS_PAGE_SIZE, totalFiles - offset) }, (_, i) => ({
    path: `/work/${offset + i}.txt`,
    name: `${offset + i}.txt`,
    project: "Project",
    sizeBytes: 1,
    modifiedAt: 1,
    directory: false,
    backup: "not-verified",
    reference: null,
  })),
});

describe("server-side computer search", () => {
  it("reads one bounded page per online computer with server filters, then waits for Show more", async () => {
    const calls: { id: string; input: ComputerInspectInput }[] = [];
    const search = createComputersSearch(async (id, input) => {
      calls.push({ id, input });
      return inspection(input.offset);
    });
    const request = {
      section: "files",
      query: "design drawing",
      project: "Project",
      extension: "TXT",
    } as const;
    await search.search([a, b], request);
    expect(calls).toEqual(
      [a, b].map((id) => ({ id, input: { ...request, refresh: false, offset: 0, limit: 200 } })),
    );
    expect(search.getState().pages[a]?.result?.files).toHaveLength(200);
    await search.next();
    expect(calls.slice(2).map((call) => call.input.offset)).toEqual([200, 200]);
    expect(search.getState().pages[a]?.result?.files).toHaveLength(400);
    expect(search.getState().pages[a]?.result?.totalFiles).toBe(500_000);
    await search.search([b], { section: "files", query: "new" });
    expect(Object.keys(search.getState().pages)).toEqual([b]);
    expect(search.getState().pages[b]?.result?.files).toHaveLength(200);
  });

  it("stops at totals and reports partial failures without losing another computer's results", async () => {
    let calls = 0;
    const search = createComputersSearch(async (id) => {
      calls++;
      if (id === b) throw new Error("Offline");
      return inspection(0, 2);
    });
    await search.search([a, b], { section: "files" });
    expect(search.getState().pages[a]?.result?.files).toHaveLength(2);
    expect(search.getState().pages[b]?.error).toBe("Offline");
    await search.next();
    expect(calls).toBe(3); // Only the failed computer is retried.
  });

  it("ignores old responses after a changed query or closed page", async () => {
    let resolve!: (value: ComputerInspection) => void;
    const old = new Promise<ComputerInspection>((done) => {
      resolve = done;
    });
    const search = createComputersSearch(async (_id, input) =>
      input.query === "old" ? old : inspection(0, 1),
    );
    const pending = search.search([a], { section: "files", query: "old" });
    search.invalidate();
    await search.search([b], { section: "files", query: "new" });
    resolve(inspection());
    await pending;
    expect(Object.keys(search.getState().pages)).toEqual([b]);
    expect(search.getState().loading).toBe(false);
  });

  it("restarts a computer's pages when its index changes instead of stitching different indexes", async () => {
    const offsets: number[] = [];
    let index = 1;
    const search = createComputersSearch(async (_id, input) => {
      offsets.push(input.offset ?? 0);
      return inspection(input.offset, 500_000, index);
    });
    await search.search([a], { section: "files" });
    index = 2;
    await search.next();
    expect(offsets).toEqual([0, 200, 0]);
    expect(search.getState().pages[a]?.result?.files).toHaveLength(200);
  });
});
