import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { COMPUTER_CAPACITY_MAX_DISKS, type ComputerCapacity } from "./computers.ts";
import {
  AllocationInventory,
  AllocationOperation,
  AllocationResponse,
  ComputerPlacementRequest,
} from "./providerAllocation.ts";

const decodeInventory = Schema.decodeUnknownSync(AllocationInventory);
const decodeRequest = Schema.decodeUnknownSync(ComputerPlacementRequest);
const decodeOperation = Schema.decodeUnknownSync(AllocationOperation);
const decodeResponse = Schema.decodeUnknownSync(AllocationResponse);

const capacity: ComputerCapacity = {
  sampledAt: 1_000,
  os: "linux",
  resources: {
    sampledAt: 1_000,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 2 ** 33,
    totalMemoryBytes: 2 ** 34,
  },
  disks: [{ path: "/", label: "root", totalBytes: 10, availableBytes: 4, freeBytes: 4 }],
  workDisk: "/",
  jobs: { active: 2, running: 1 },
  notices: [],
};
const inventory = {
  environmentId: "env",
  observedAt: "2026-10-26T12:00:00.000Z",
  accounts: [],
  demand: [],
  complete: true,
  notices: [],
};

describe("computer placement wire contract", () => {
  // A peer on an older build sends none of the new fields; that must read as "not reported".
  it("reads an inventory from a server that predates capacity readings", () => {
    const decoded = decodeInventory(inventory);
    expect(decoded.computer).toBeUndefined();
    expect(decoded.projects).toBeUndefined();
  });

  it("carries a capacity reading and checkouts through JSON unchanged", () => {
    const sent = {
      ...inventory,
      computer: capacity,
      projects: [{ id: "project-1", title: "scratch" }],
    };
    const decoded = decodeInventory(JSON.parse(JSON.stringify(sent)));
    expect(decoded.computer).toEqual(capacity);
    expect(decoded.projects).toEqual([{ id: "project-1", title: "scratch" }]);
  });

  it("keeps the reading bounded", () => {
    const disk = capacity.disks[0]!;
    const tooManyDisks = {
      ...capacity,
      disks: Array.from({ length: COMPUTER_CAPACITY_MAX_DISKS + 1 }, () => disk),
    };
    expect(() => decodeInventory({ ...inventory, computer: tooManyDisks })).toThrow();
    const tooManyProjects = Array.from({ length: 21 }, (_, index) => ({
      id: `project-${index}`,
      title: "scratch",
    }));
    expect(() => decodeInventory({ ...inventory, projects: tooManyProjects })).toThrow();
  });

  it("accepts needs as extra peak load and rejects ones that cannot be meant", () => {
    const decode = decodeRequest;
    expect(decode({})).toEqual({});
    expect(
      decode({
        needs: { memoryBytes: 2 ** 32, cpuThreads: 1.5, diskBytes: 0, os: "windows" },
        environmentId: "env",
      }),
    ).toMatchObject({ needs: { cpuThreads: 1.5, os: "windows" } });
    for (const needs of [
      { memoryBytes: -1 },
      { cpuThreads: 0 },
      { cpuThreads: Number.POSITIVE_INFINITY },
      { diskBytes: 1.5 },
      { os: "beos" },
    ])
      expect(() => decode({ needs }), JSON.stringify(needs)).toThrow();
  });

  it("is an operation of the existing allocation call, answered in its existing response", () => {
    const operation = decodeOperation({
      _tag: "placement",
      request: { projectId: "project-1" },
    });
    expect(operation._tag).toBe("placement");
    expect(decodeResponse({})).toEqual({});
  });
});
