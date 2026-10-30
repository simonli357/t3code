import type { ComputerActivity, ComputerInspection } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "./environments";
import type { ComputerCache } from "./computersCache";
import type {
  ActivityRow,
  ActivityStatus,
  ComputerPanelModel,
  ProcessList,
} from "../components/computers/computersViewModel";

type ComputerEnvironment = Pick<
  EnvironmentPresentation,
  "environmentId" | "label" | "connection" | "displayUrl" | "serverConfig"
>;

export const iso = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? new Date(value).toISOString() : null;
export const key = (environmentId: string, value: string) => JSON.stringify([environmentId, value]);
export const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const connected = (environment: ComputerEnvironment) =>
  environment.connection.phase === "connected";
/** null until the server has reported what it can do; a connected computer is not "outdated" before that. */
const computersSupport = (environment: ComputerEnvironment) =>
  environment.serverConfig === null
    ? null
    : environment.serverConfig.environment.capabilities.computers === true;
/** Whether this computer can be asked for data and actions right now. */
export const online = (environment: ComputerEnvironment) =>
  connected(environment) && computersSupport(environment) === true;

export function panel(
  environment: ComputerEnvironment,
  cache: ComputerCache,
  error: string | null,
): ComputerPanelModel {
  const snapshot = cache.overview,
    resources = snapshot?.resources;
  const sampledAt = iso(resources?.sampledAt);
  const history = snapshot?.history ?? [];
  const lastSeenAt = iso(
    Math.max(snapshot?.sampledAt ?? 0, cache.activity?.sampledAt ?? 0) || null,
  );
  return {
    id: environment.environmentId,
    name: environment.label,
    machineKind: environment.serverConfig?.environment.platform.machine ?? null,
    subtitle: environment.displayUrl,
    connection: connected(environment)
      ? { status: "online" }
      : ["connecting", "reconnecting"].includes(environment.connection.phase)
        ? { status: "connecting", lastSeenAt }
        : { status: "offline", lastSeenAt, reason: environment.connection.error },
    metricsError:
      error ??
      (connected(environment) && computersSupport(environment) === false
        ? "Update this computer’s T3 server to read computer details."
        : null),
    canInspect: online(environment),
    metrics: resources
      ? {
          sampledAt,
          cpu: {
            percent: resources.cpuUtilization === null ? null : resources.cpuUtilization * 100,
            logicalCores: resources.cpuCount || null,
            history: history.map((sample) => ({
              at: iso(sample.sampledAt)!,
              percent: sample.cpuUtilization === null ? null : sample.cpuUtilization * 100,
            })),
          },
          memory: {
            totalBytes: resources.totalMemoryBytes || null,
            usedBytes: resources.totalMemoryBytes
              ? resources.totalMemoryBytes - resources.availableMemoryBytes
              : null,
            history: history.map((sample) => ({
              at: iso(sample.sampledAt)!,
              percent: sample.totalMemoryBytes
                ? (1 - sample.availableMemoryBytes / sample.totalMemoryBytes) * 100
                : null,
            })),
          },
          disks: snapshot!.disks.map((disk) => ({
            id: disk.path,
            label: disk.path,
            mountPath: disk.path,
            totalBytes: disk.totalBytes,
            usedBytes: disk.totalBytes - disk.freeBytes,
            freeBytes: disk.availableBytes,
          })),
        }
      : null,
  };
}

/**
 * How the server's statuses read on screen: the keep and action states, and the Workenv job states.
 * Anything else, including a job that merely exists (`active`), is shown as it was reported and never
 * guessed to be running or done.
 */
const ACTIVITY_STATUS = new Map<string, ActivityStatus>([
  ["published", "succeeded"],
  ["completed", "succeeded"],
  ["delivered", "succeeded"],
  ["cancelled", "canceled"],
  ["canceled", "canceled"],
  ["pending", "queued"],
  ["queued", "queued"],
  ["running", "running"],
  ["failed", "failed"],
  ["invalid", "failed"],
  ["setup-failed", "failed"],
  // Stopped without a recorded result; its detail says to check receipts, and a backup can be retried.
  ["interrupted", "failed"],
]);
/** The statuses the row's own badge already says; every other one is named beside it. */
const SELF_EXPLANATORY = new Set([
  "running",
  "pending",
  "queued",
  "failed",
  "completed",
  "published",
  "cancelled",
  "canceled",
]);

export function activityRow(
  environment: ComputerEnvironment,
  activity: ComputerActivity,
): ActivityRow {
  const status = ACTIVITY_STATUS.get(activity.status) ?? "unknown";
  const named = SELF_EXPLANATORY.has(activity.status)
    ? null
    : `${activity.status[0]?.toUpperCase() ?? ""}${activity.status.slice(1)}`;
  return {
    id: key(environment.environmentId, activity.id),
    kind: activity.kind,
    status,
    title: activity.label,
    context: [environment.label, activity.source].filter(Boolean).join(" · "),
    startedAt: null,
    updatedAt: iso(activity.updatedAt),
    progress: null,
    failureReason: status === "failed" ? (activity.detail ?? named) : null,
    note: status === "failed" ? null : [named, activity.detail].filter(Boolean).join(" · ") || null,
    retry:
      status === "failed" && activity.retryable
        ? connected(environment)
          ? { state: "available" }
          : { state: "unavailable", reason: "Computer is offline" }
        : null,
  };
}

/** Explains the computers a server-side search could not cover. */
export function searchCaveats(
  environment: ComputerEnvironment,
  files: ComputerInspection | null,
  problems: ReadonlyArray<string | null>,
): string[] {
  const caveats = [...problems, ...(files?.errors ?? [])];
  if (!connected(environment)) caveats.push("Search needs this computer online.");
  else if (computersSupport(environment) === false)
    caveats.push("Update this computer’s T3 server to search its files.");
  if (files?.indexing) caveats.push("Indexing; results are incomplete. Refresh to try again.");
  return caveats.filter((message): message is string => Boolean(message));
}

/**
 * The processes dialog's list. A process names its job only when the computer says Workenv launched
 * it, and a job counts as running only when the computer reports it so; a workspace that merely
 * exists is not listed here.
 */
export function processList(
  environment: ComputerEnvironment,
  result: ComputerInspection,
  activities: ReadonlyArray<ComputerActivity>,
): ProcessList {
  const titles = new Map(activities.map((activity) => [activity.id, activity.label]));
  return {
    measuredAt: iso(result.sampledAt),
    totalCount: result.processes.length,
    jobs: activities
      .filter((activity) => activity.kind === "job")
      .map((activity) => activityRow(environment, activity))
      .filter((row) => row.status === "running"),
    processes: result.processes.map((process) => ({
      key: String(process.pid),
      pid: process.pid,
      name: process.name,
      command: process.command,
      owner: process.owner,
      job:
        process.jobId === null
          ? null
          : {
              id: process.jobId,
              title: titles.get(process.jobId) ?? process.jobId.replace(/^job:/, ""),
            },
      cpuPercent: process.cpuPercent,
      memoryBytes: process.memoryBytes,
    })),
  };
}
