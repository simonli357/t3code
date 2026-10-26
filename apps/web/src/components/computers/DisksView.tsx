import { ChevronRightIcon, HardDriveIcon, NetworkIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { NOT_MEASURED, formatBytes, isDiskNearlyFull } from "./computersFormat";
import type { ComputersActions } from "./computersViewModel";
import { DatedTime, EmptyNotice, LoadError, SectionHeading } from "./sectionParts";
import type {
  ComputerDisksModel,
  DiskModel,
  DisksViewModel,
  RemoteStorageModel,
  SystemMountModel,
  VolumeModel,
} from "./storageViewModel";

const ROLE_LABEL = {
  data: null,
  system: "System",
  boot: "Boot",
  swap: "Swap",
  recovery: "Recovery",
  unmounted: "Not mounted",
} as const;
const HOLD_LABEL = {
  "agent-work": "Agent work",
  library: "Kept results",
  backup: "Backup",
} as const;
const KIND_LABEL = {
  memory: "Memory (RAM)",
  image: "Mounted images",
  pseudo: "Kernel and system views",
  alias: "Aliases of a volume above",
  other: "Other",
} as const;

/** A measured amount, or the fact that it is unknown. Unknown is never drawn as zero. */
const amount = (bytes: number | null, unknown: string = NOT_MEASURED) =>
  bytes === null ? unknown : formatBytes(bytes);

function Stat({
  label,
  value,
  unknown,
  title,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly unknown?: string;
  readonly title: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex min-w-0 flex-col gap-0.5" />}>
        <dt className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </dt>
        <dd
          className={cn(
            "truncate font-mono text-xs tabular-nums",
            value === null ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {amount(value, unknown)}
        </dd>
      </TooltipTrigger>
      <TooltipPopup side="top">{title}</TooltipPopup>
    </Tooltip>
  );
}

/** Used space as a share of capacity; unknown usage is an outlined, empty track, not an empty bar. */
function UsageBar({ volume, stale }: { readonly volume: VolumeModel; readonly stale: boolean }) {
  if (volume.capacityBytes === null || volume.usedBytes === null || volume.capacityBytes <= 0)
    return (
      <span aria-hidden className="block h-2 rounded-full border border-dashed border-border" />
    );
  const used = Math.min(1, volume.usedBytes / volume.capacityBytes);
  const reserve =
    volume.reserveBytes !== null && volume.reserveBytes < volume.capacityBytes
      ? 1 - volume.reserveBytes / volume.capacityBytes
      : null;
  const nearlyFull = isDiskNearlyFull(used);
  return (
    <span
      role="meter"
      aria-label="Filesystem used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(used * 100)}
      aria-valuetext={`${formatBytes(volume.usedBytes)} used of ${formatBytes(volume.capacityBytes)}`}
      className="relative block h-2 overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          stale ? "bg-muted-foreground/50" : nearlyFull ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${used * 100}%`, minWidth: used > 0 ? 2 : 0 }}
      />
      {reserve !== null ? (
        // Where the configured reserve begins: used space beyond this line eats into the reserve.
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-foreground/60"
          style={{ left: `${reserve * 100}%` }}
        />
      ) : null}
    </span>
  );
}

function VolumeRow({
  volume,
  stale,
  ariaLabel,
  onOpen,
}: {
  readonly volume: VolumeModel;
  readonly stale: boolean;
  readonly ariaLabel: string;
  readonly onOpen: (() => void) | null;
}) {
  const role = ROLE_LABEL[volume.role];
  const aliases = volume.mountPaths.slice(1);
  const holdsWork = volume.holds.includes("agent-work");
  const content = (
    <>
      <span className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{volume.label}</span>
          {volume.mountPaths[0] && volume.mountPaths[0] !== volume.label ? (
            <span className="truncate font-mono text-2xs text-muted-foreground">
              {volume.mountPaths[0]}
            </span>
          ) : null}
          {role ? (
            <Badge variant="outline" size="sm">
              {role}
            </Badge>
          ) : null}
          {volume.holds.map((hold) => (
            <Badge key={hold} variant="info" size="sm">
              {HOLD_LABEL[hold]}
            </Badge>
          ))}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
          {volume.capacityBytes === null
            ? NOT_MEASURED
            : `${formatBytes(volume.capacityBytes)} capacity`}
          {onOpen ? <ChevronRightIcon aria-hidden className="size-3" /> : null}
        </span>
      </span>
      <UsageBar volume={volume} stale={stale} />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
        <Stat label="Used" value={volume.usedBytes} title="Space the filesystem reports as used" />
        <Stat
          label="Available"
          value={volume.availableBytes}
          title="Space a user may still write; it can be less than capacity minus used"
        />
        <Stat
          label="Reserve"
          value={volume.reserveBytes}
          unknown="Not configured"
          title="Space that must stay free, from the configuration of this computer"
        />
        {holdsWork ? (
          <Stat
            label="Agent headroom"
            value={volume.headroomBytes}
            unknown="Unknown"
            title="Available space minus the reserve: what agent work may still use here"
          />
        ) : (
          <Stat
            label="Agent headroom"
            value={null}
            unknown="Not used for agent work"
            title="No agent work is configured on this volume"
          />
        )}
      </dl>
      {volume.filesystem || volume.device || aliases.length ? (
        <span className="truncate text-2xs text-muted-foreground">
          {[
            volume.filesystem,
            volume.device,
            aliases.length ? `also at ${aliases.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
    </>
  );
  const className = "flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-2 py-2 text-left";
  return onOpen ? (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onOpen}
      className={cn(
        className,
        "cursor-pointer outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function DiskBlock({
  disk,
  stale,
  computerName,
  computerId,
  onOpenDisk,
}: {
  readonly disk: DiskModel;
  readonly stale: boolean;
  readonly computerName: string;
  readonly computerId: string;
  readonly onOpenDisk: ComputersActions["onOpenDisk"];
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-3 px-4 sm:px-5">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <HardDriveIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{disk.title}</span>
          {disk.detail ? (
            <span className="shrink-0 font-normal text-muted-foreground">{disk.detail}</span>
          ) : null}
        </h4>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {disk.sizeBytes === null ? NOT_MEASURED : formatBytes(disk.sizeBytes)}
        </span>
      </div>
      {disk.volumes.length === 0 ? (
        <p className="px-4 text-xs text-muted-foreground sm:px-5">
          No mounted data volume on this disk.
        </p>
      ) : (
        <ul className="flex flex-col px-2 sm:px-3">
          {disk.volumes.map((volume) => (
            <li key={volume.id} className="min-w-0">
              <VolumeRow
                volume={volume}
                stale={stale}
                ariaLabel={`${volume.label} on ${computerName}: show folder sizes`}
                onOpen={
                  volume.openable
                    ? () => onOpenDisk({ computerId, diskId: volume.mountPaths[0]! })
                    : null
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoteBlock({
  remote,
  stale,
}: {
  readonly remote: ReadonlyArray<RemoteStorageModel>;
  readonly stale: boolean;
}) {
  if (remote.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="px-4 sm:px-5">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <NetworkIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Remote storage
          <span className="font-normal text-muted-foreground">
            on other computers; not this computer's disks
          </span>
        </h4>
      </div>
      <ul className="flex flex-col px-2 sm:px-3">
        {remote.map((entry) => (
          <li key={entry.id} className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-2">
            <span className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-mono text-xs text-foreground">{entry.label}</span>
                <Badge variant="outline" size="sm">
                  {entry.protocol}
                </Badge>
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {entry.capacityBytes === null
                  ? NOT_MEASURED
                  : `${formatBytes(entry.capacityBytes)} capacity`}
              </span>
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {entry.host ? `On ${entry.host}` : "Host not named"}
              {entry.backing ? ` · ${entry.backing}` : ""}
            </span>
            <span
              className={cn(
                "font-mono text-2xs tabular-nums",
                stale ? "text-muted-foreground" : "",
              )}
            >
              {entry.usedBytes === null && entry.availableBytes === null
                ? "Usage not measured"
                : `${amount(entry.usedBytes)} used · ${amount(entry.availableBytes)} available`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdvancedBlock({ computer }: { readonly computer: ComputerDisksModel }) {
  const system = computer.disks.flatMap((disk) =>
    disk.system.map((volume) => ({ disk: disk.title, volume })),
  );
  const grouped = new Map<SystemMountModel["kind"], SystemMountModel[]>();
  for (const mount of computer.advanced)
    grouped.set(mount.kind, [...(grouped.get(mount.kind) ?? []), mount]);
  const byKind = [...grouped];
  if (system.length === 0 && byKind.length === 0) return null;
  return (
    <div className="px-4 sm:px-5">
      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          Advanced details
          <span className="font-normal">boot, swap, recovery, memory, images and kernel views</span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 pt-2">
            {system.length ? (
              <section className="flex flex-col gap-1">
                <h5 className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Boot, swap and recovery partitions
                </h5>
                <ul className="flex flex-col gap-1">
                  {system.map(({ disk, volume }) => (
                    <li
                      key={`${disk}:${volume.id}`}
                      className="flex items-baseline justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-foreground">{volume.label}</span>{" "}
                        <span className="text-muted-foreground">
                          {[ROLE_LABEL[volume.role], volume.filesystem, disk]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                        {amount(volume.capacityBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {byKind.map(([kind, mounts]) => (
              <section key={kind} className="flex flex-col gap-1">
                <h5 className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {KIND_LABEL[kind]}
                </h5>
                <ul className="flex flex-col gap-1">
                  {mounts.map((mount) => (
                    <li key={mount.id} className="flex flex-col gap-0.5 text-xs">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-mono text-foreground">
                          {mount.label}
                        </span>
                        {mount.capacityBytes !== null ? (
                          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                            {mount.usedBytes === null ? "" : `${formatBytes(mount.usedBytes)} of `}
                            {formatBytes(mount.capacityBytes)}
                          </span>
                        ) : null}
                      </span>
                      {mount.backing || mount.filesystem ? (
                        <span className="truncate text-2xs text-muted-foreground">
                          {[mount.filesystem, mount.backing].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function ComputerDisks({
  computer,
  onOpenDisk,
}: {
  readonly computer: ComputerDisksModel;
  readonly onOpenDisk: ComputersActions["onOpenDisk"];
}) {
  const headingId = useId();
  const stale = computer.lastKnown;
  let body: ReactNode;
  if (computer.state === "loading") {
    body = (
      <div className="flex flex-col gap-3 px-4 sm:px-5" role="status" aria-label="Loading disks">
        <Skeleton className="h-4 w-40" />
        <Skeleton shape="card" className="h-20" />
      </div>
    );
  } else if (computer.state === "unsupported" || computer.state === "error") {
    body = (
      <p className="px-4 text-xs text-muted-foreground sm:px-5">
        {computer.message ?? "No disk reading is available."}
      </p>
    );
  } else if (computer.disks.length === 0 && computer.remote.length === 0) {
    body = (
      <p className="px-4 text-xs text-muted-foreground sm:px-5">No physical disks were reported.</p>
    );
  } else {
    body = (
      <>
        {computer.disks.map((disk) => (
          <DiskBlock
            key={disk.id}
            disk={disk}
            stale={stale}
            computerName={computer.name}
            computerId={computer.computerId}
            onOpenDisk={onOpenDisk}
          />
        ))}
        <RemoteBlock remote={computer.remote} stale={stale} />
        <AdvancedBlock computer={computer} />
        {computer.reserveSource ? (
          <p className="px-4 text-2xs text-muted-foreground sm:px-5">
            Reserves come from {computer.reserveSource}.
          </p>
        ) : (
          <p className="px-4 text-2xs text-muted-foreground sm:px-5">
            No reserve is configured on this computer, so no agent headroom is calculated.
          </p>
        )}
        {computer.notices.map((notice) => (
          <p key={notice} className="px-4 text-2xs text-warning-foreground sm:px-5">
            {notice}
          </p>
        ))}
      </>
    );
  }
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
          <p className="truncate text-xs text-muted-foreground">
            {computer.sampledAt ? (
              <>
                {stale ? "Last known, measured " : "Measured "}
                <DatedTime iso={computer.sampledAt} />
              </>
            ) : (
              "Not measured yet"
            )}
          </p>
        </div>
        <Badge variant={computer.connection.status === "online" ? "success" : "outline"} size="sm">
          {computer.connection.status === "online"
            ? "Online"
            : computer.connection.status === "connecting"
              ? "Connecting"
              : "Offline"}
        </Badge>
      </header>
      {stale && computer.state === "ready" ? (
        <p className="mx-4 rounded-lg bg-warning-surface px-3 py-2 text-xs text-warning-foreground sm:mx-5">
          {computer.connection.status === "online"
            ? `The newest read failed${computer.message ? `: ${computer.message}` : ""}. `
            : "This computer is not connected. "}
          These are its last known numbers.
        </p>
      ) : null}
      {body}
    </section>
  );
}

/** The Disks view: every connected computer's real disks and volumes, system detail collapsed. */
export function DisksView({
  model,
  actions,
  onRetry,
}: {
  readonly model: DisksViewModel;
  readonly actions: Pick<ComputersActions, "onOpenDisk">;
  readonly onRetry: () => void;
}) {
  const headingId = useId();
  const { computers } = model;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} hidden>
        Disks
      </SectionHeading>
      {computers.status === "loading" ? (
        <div role="status" aria-label="Loading computers" className="grid grid-cols-1 gap-4">
          <Skeleton shape="card" className="h-40" />
        </div>
      ) : computers.status === "error" ? (
        <LoadError title="Could not load disks" message={computers.message} onRetry={onRetry} />
      ) : computers.data.length === 0 ? (
        <EmptyNotice
          icon={<HardDriveIcon />}
          title="No computers connected"
          description="Disks appear here once a T3 environment is connected."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 @3xl/computers:grid-cols-2">
          {computers.data.map((computer) => (
            <ComputerDisks
              key={computer.computerId}
              computer={computer}
              onOpenDisk={actions.onOpenDisk}
            />
          ))}
        </div>
      )}
    </section>
  );
}
