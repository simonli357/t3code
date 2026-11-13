import type { AllocationInventory, ComputerNumbers } from "@t3tools/contracts";

const gib = (bytes: number) => Math.round((bytes / 2 ** 30) * 10) / 10;

/**
 * One computer's load as plain numbers, from the inventory a placement read collected. Nothing
 * is ranked: where a worker runs also depends on what the task needs and where its data is,
 * which only the master knows.
 */
export function computerNumbers(inventory: AllocationInventory): ComputerNumbers {
  const computer = inventory.complete ? inventory.computer : undefined;
  const resources = computer?.resources;
  const disk = computer?.disks.find((entry) => entry.path === computer.workDisk);
  return {
    environmentId: inventory.environmentId,
    label: inventory.environmentLabel ?? inventory.environmentId,
    reachable: inventory.complete,
    cpuThreadsIdle:
      resources && resources.cpuUtilization !== null
        ? Math.round(resources.cpuCount * (1 - resources.cpuUtilization) * 10) / 10
        : null,
    cpuThreads: resources?.cpuCount ?? null,
    memoryFreeGiB: resources ? gib(resources.availableMemoryBytes) : null,
    memoryTotalGiB: resources ? gib(resources.totalMemoryBytes) : null,
    workDiskFreeGiB: disk ? gib(disk.availableBytes) : null,
    sessions: inventory.complete
      ? inventory.demand.filter((session) => session.state !== "uncertain").length
      : null,
    projectId: inventory.projects?.[0]?.id ?? null,
  };
}
