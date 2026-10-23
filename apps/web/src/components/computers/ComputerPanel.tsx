import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useComputersClock } from "./computersClock";
import {
  NOT_MEASURED,
  formatBytes,
  formatPercent,
  isDiskNearlyFull,
  isWithinMs,
  memoryUsedPercent,
  resolveDataFreshness,
  resolveDiskUsage,
  type DataFreshness,
} from "./computersFormat";
import type {
  ComputerConnection,
  ComputerDisk,
  ComputerPanelModel,
  ComputersActions,
  MetricSample,
} from "./computersViewModel";
import { DatedTime } from "./sectionParts";
import { Sparkline } from "./Sparkline";

/** The same moment, give or take: last seen and last measured are then one fact, said once. */
const SAME_MOMENT_TOLERANCE_MS = 2 * 60_000;

const CONNECTION_PRESENTATION = {
  online: { label: "Online", dotClassName: "bg-success" },
  connecting: { label: "Connecting", dotClassName: "bg-warning" },
  offline: { label: "Offline", dotClassName: "bg-muted-foreground/50" },
} as const;

function ConnectionStatus({ status }: { readonly status: ComputerConnection["status"] }) {
  const { label, dotClassName } = CONNECTION_PRESENTATION[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", dotClassName)} />
      {label}
    </span>
  );
}

/**
 * Says when the numbers below are not live, with the date they are from. A computer that is online
 * with a recent measurement needs no notice, so it gets none.
 */
function FreshnessNotice({
  computer,
  freshness,
}: {
  readonly computer: ComputerPanelModel;
  readonly freshness: DataFreshness;
}) {
  if (freshness.kind === "current") return null;
  const { connection } = computer;
  const { sampledAt } = freshness;

  if (freshness.cause === "read-failed") {
    return (
      <p className="mx-4 rounded-lg bg-error-surface px-3 py-2 text-xs text-error-foreground sm:mx-5">
        <span className="wrap-anywhere">Could not read this computer: {computer.metricsError}</span>{" "}
        Showing the last measurement, from{" "}
        {sampledAt ? <DatedTime iso={sampledAt} /> : "an unknown time"}.
      </p>
    );
  }

  if (freshness.cause === "old-sample") {
    return (
      <p className="mx-4 rounded-lg bg-warning-surface px-3 py-2 text-xs text-warning-foreground sm:mx-5">
        Newer measurements have not arrived. This is the last one, from{" "}
        {sampledAt ? <DatedTime iso={sampledAt} /> : "an unknown time"}.
      </p>
    );
  }

  const lastSeenAt = connection.status === "online" ? null : connection.lastSeenAt;
  const reason = connection.status === "offline" ? connection.reason : null;
  const sameMoment = isWithinMs(lastSeenAt, sampledAt, SAME_MOMENT_TOLERANCE_MS);

  return (
    <div className="mx-4 flex flex-col gap-0.5 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:mx-5">
      <p>
        {connection.status === "connecting" ? (
          <span className="font-medium text-foreground">Connecting.</span>
        ) : null}
        {connection.status === "connecting" && lastSeenAt ? " " : null}
        {lastSeenAt ? (
          <>
            <span className="font-medium text-foreground">Last seen</span>{" "}
            <DatedTime iso={lastSeenAt} />
          </>
        ) : connection.status === "offline" ? (
          <span className="font-medium text-foreground">Never seen online</span>
        ) : null}
      </p>
      {reason ? <p className="wrap-anywhere">{reason}</p> : null}
      {computer.metrics === null ? null : sameMoment ? (
        <p>Showing the last known data, from then.</p>
      ) : sampledAt ? (
        <p>
          Showing the last known data, from <DatedTime iso={sampledAt} />.
        </p>
      ) : (
        <p>Showing the last known data. When it was measured was not recorded.</p>
      )}
    </div>
  );
}

function MetricTile({
  label,
  value,
  detail,
  samples,
  stale,
  ariaLabel,
  onOpen,
}: {
  readonly label: string;
  /** The current figure, or null when it is not known. */
  readonly value: string | null;
  readonly detail: string | null;
  readonly samples: ReadonlyArray<MetricSample>;
  readonly stale: boolean;
  readonly ariaLabel: string;
  /** Present when the tile opens details; absent for a plain readout. */
  readonly onOpen: (() => void) | null;
}) {
  const content = (
    <>
      <span className="flex items-center justify-between text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
        {onOpen ? <ChevronRightIcon aria-hidden className="size-3" /> : null}
      </span>
      {value === null ? (
        <span className="text-sm font-medium text-muted-foreground">{NOT_MEASURED}</span>
      ) : (
        <span
          className={cn(
            "truncate font-mono text-xl font-semibold tracking-tighter tabular-nums",
            stale ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {value}
        </span>
      )}
      {detail ? <span className="truncate text-2xs text-muted-foreground">{detail}</span> : null}
      <Sparkline samples={samples} label={label} muted={stale} />
    </>
  );
  const tileClassName =
    "flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-left";
  return onOpen ? (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onOpen}
      className={cn(
        tileClassName,
        "cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  ) : (
    <div className={tileClassName}>{content}</div>
  );
}

function UsageBar({
  usedShare,
  nearlyFull,
  stale,
  valueText,
}: {
  readonly usedShare: number | null;
  readonly nearlyFull: boolean;
  readonly stale: boolean;
  readonly valueText: string;
}) {
  // Unknown usage is an outlined, empty track with no fill at all: an empty bar would read as a disk
  // with nothing on it.
  if (usedShare === null) {
    return (
      <span aria-hidden className="block h-2 rounded-full border border-dashed border-border" />
    );
  }
  const percent = usedShare * 100;
  return (
    <span
      role="meter"
      aria-label="Disk used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={valueText}
      className="block h-2 overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          stale ? "bg-muted-foreground/50" : nearlyFull ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${percent}%`, minWidth: percent > 0 ? 2 : 0 }}
      />
    </span>
  );
}

function DiskRow({
  disk,
  stale,
  ariaLabel,
  onOpen,
}: {
  readonly disk: ComputerDisk;
  readonly stale: boolean;
  readonly ariaLabel: string;
  readonly onOpen: (() => void) | null;
}) {
  const usage = resolveDiskUsage(disk);
  const nearlyFull = isDiskNearlyFull(usage.usedShare);
  // Used and free are both needed to say how much of each there is; either missing means we say so.
  const amounts =
    usage.usedBytes !== null && usage.freeBytes !== null
      ? { used: formatBytes(usage.usedBytes), free: formatBytes(usage.freeBytes) }
      : null;
  const valueText = amounts ? `${amounts.used} used, ${amounts.free} free` : NOT_MEASURED;

  const content = (
    <>
      <span className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{disk.label}</span>
          {disk.mountPath && disk.mountPath !== disk.label ? (
            <span className="truncate font-mono text-2xs text-muted-foreground">
              {disk.mountPath}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
          {usage.totalBytes === null ? null : `${formatBytes(usage.totalBytes)} total`}
          {onOpen ? <ChevronRightIcon aria-hidden className="size-3" /> : null}
        </span>
      </span>
      <UsageBar
        usedShare={usage.usedShare}
        nearlyFull={nearlyFull}
        stale={stale}
        valueText={valueText}
      />
      {amounts ? (
        <span className="flex items-baseline justify-between gap-3 font-mono text-xs tabular-nums">
          <span className="text-muted-foreground">{amounts.used} used</span>
          <span
            className={nearlyFull && !stale ? "text-warning-foreground" : "text-muted-foreground"}
          >
            {amounts.free} free
          </span>
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Usage {NOT_MEASURED.toLowerCase()}</span>
      )}
    </>
  );
  const rowClassName = "flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2 text-left";
  return onOpen ? (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onOpen}
      className={cn(
        rowClassName,
        "cursor-pointer outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  ) : (
    <div className={rowClassName}>{content}</div>
  );
}

function MetricsUnavailable({ computer }: { readonly computer: ComputerPanelModel }) {
  if (computer.metricsError) {
    return (
      <p className="flex items-start gap-2 text-xs text-destructive-foreground">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="wrap-anywhere">Could not read this computer: {computer.metricsError}</span>
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {computer.connection.status === "offline"
        ? "No measurements were ever received from this computer."
        : "Waiting for the first measurement."}
    </p>
  );
}

function Caption({ children }: { readonly children: ReactNode }) {
  return (
    <h4 className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </h4>
  );
}

/**
 * One computer: its connection, whole-host CPU and memory with a short history, and every disk. CPU and
 * memory open process details, a disk opens its folder breakdown, when the data layer says it can.
 */
export function ComputerPanel({
  computer,
  onOpenDisk,
  onOpenProcesses,
}: {
  readonly computer: ComputerPanelModel;
  readonly onOpenDisk: ComputersActions["onOpenDisk"];
  readonly onOpenProcesses: ComputersActions["onOpenProcesses"];
}) {
  const headingId = useId();
  const { nowMs } = useComputersClock();
  const { metrics } = computer;
  const freshness = resolveDataFreshness(
    computer.connection,
    metrics,
    nowMs,
    computer.metricsError !== null,
  );
  const stale = freshness.kind === "last-known";
  const inspect = computer.canInspect;

  const memoryPercent = metrics ? memoryUsedPercent(metrics.memory) : null;
  const cpuCores = metrics?.cpu.logicalCores ?? null;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/60 bg-card pt-4 pb-4 shadow-xs/5"
    >
      <header className="flex items-start gap-3 px-4 sm:px-5">
        <EnvironmentMachineIcon
          aria-hidden
          kind={computer.machineKind ?? "server"}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-sm font-medium text-foreground">
            {computer.name}
          </h3>
          {computer.subtitle ? (
            <p className="truncate text-xs text-muted-foreground">{computer.subtitle}</p>
          ) : null}
        </div>
        <ConnectionStatus status={computer.connection.status} />
      </header>

      <FreshnessNotice computer={computer} freshness={freshness} />

      {metrics === null ? (
        <div className="px-4 sm:px-5">
          <MetricsUnavailable computer={computer} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 px-4 sm:px-5">
            <MetricTile
              label="CPU"
              value={metrics.cpu.percent === null ? null : formatPercent(metrics.cpu.percent)}
              detail={
                cpuCores === null
                  ? null
                  : `${cpuCores} logical ${cpuCores === 1 ? "core" : "cores"}`
              }
              samples={metrics.cpu.history}
              stale={stale}
              ariaLabel={`CPU on ${computer.name}: show processes and jobs`}
              onOpen={
                inspect ? () => onOpenProcesses({ computerId: computer.id, focus: "cpu" }) : null
              }
            />
            <MetricTile
              label="Memory"
              value={
                metrics.memory.usedBytes === null ? null : formatBytes(metrics.memory.usedBytes)
              }
              detail={
                [
                  metrics.memory.totalBytes === null
                    ? null
                    : `of ${formatBytes(metrics.memory.totalBytes)}`,
                  memoryPercent === null ? null : formatPercent(memoryPercent),
                ]
                  .filter((part) => part !== null)
                  .join(" · ") || null
              }
              samples={metrics.memory.history}
              stale={stale}
              ariaLabel={`Memory on ${computer.name}: show processes and jobs`}
              onOpen={
                inspect ? () => onOpenProcesses({ computerId: computer.id, focus: "memory" }) : null
              }
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="px-4 sm:px-5">
              <Caption>Disks</Caption>
            </div>
            {metrics.disks.length === 0 ? (
              <p className="px-4 text-xs text-muted-foreground sm:px-5">No disks were reported.</p>
            ) : (
              <ul className="flex flex-col px-2 sm:px-3">
                {metrics.disks.map((disk) => (
                  <li key={disk.id} className="min-w-0">
                    <DiskRow
                      disk={disk}
                      stale={stale}
                      ariaLabel={`${disk.label} on ${computer.name}: show folder sizes`}
                      onOpen={
                        inspect
                          ? () => onOpenDisk({ computerId: computer.id, diskId: disk.id })
                          : null
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
