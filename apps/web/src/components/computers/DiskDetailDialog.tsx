import { CircleAlertIcon, ArrowUpIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { DetailDialog } from "./DetailDialog";
import {
  NOT_MEASURED,
  folderShare,
  formatBytes,
  formatExactBytes,
  formatPercent,
  resolveDiskUsage,
  sortFolders,
} from "./computersFormat";
import type {
  ComputerDisk,
  ComputersActions,
  ComputersDetail,
  ComputersViewModel,
  DiskBreakdown,
  FolderRow,
} from "./computersViewModel";
import { DatedTime, EmptyNotice, LoadError } from "./sectionParts";

/** A big folder can hold thousands of entries; the largest come first, so a screenful is the answer. */
const FOLDER_PAGE_SIZE = 40;

type DiskDetail = Extract<ComputersDetail, { kind: "disk" }>;

/** The numbers of the disk itself, whole and exact, above the folders that make them up. */
function DiskFacts({ disk }: { readonly disk: ComputerDisk }) {
  const usage = resolveDiskUsage(disk);
  const known = (label: string, bytes: number | null) =>
    bytes === null ? null : (
      <div key={label} className="flex flex-col gap-0.5">
        <dt className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </dt>
        <dd className="font-mono text-sm tabular-nums text-foreground">{formatBytes(bytes)}</dd>
        <dd className="hidden font-mono text-2xs tabular-nums text-muted-foreground sm:block">
          {formatExactBytes(bytes)}
        </dd>
      </div>
    );
  const facts = [
    known("Used", usage.usedBytes),
    known("Free", usage.freeBytes),
    known("Total", usage.totalBytes),
  ].filter((fact) => fact !== null);
  if (facts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">Disk usage {NOT_MEASURED.toLowerCase()}.</p>
    );
  }
  return <dl className="grid grid-cols-3 gap-3">{facts}</dl>;
}

function FolderItemContent({
  row,
  share,
}: {
  readonly row: FolderRow;
  readonly share: number | null;
}) {
  const Icon = row.kind === "folder" ? FolderIcon : FileIcon;
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
        {row.kind === "folder" && row.openable ? (
          <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
      <span className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
        {row.sizeBytes === null ? (
          <span className="font-sans text-muted-foreground">{NOT_MEASURED}</span>
        ) : (
          <>
            <span className="text-foreground">{formatBytes(row.sizeBytes)}</span>
            {share === null ? null : (
              <span className="w-10 text-right text-muted-foreground">
                {formatPercent(share * 100)}
              </span>
            )}
          </>
        )}
      </span>
      {share === null ? null : (
        <span aria-hidden className="col-span-2 block h-1.5 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${share * 100}%`, minWidth: share > 0 ? 2 : 0 }}
          />
        </span>
      )}
      {row.note ? (
        <span className="col-span-2 text-xs text-muted-foreground">{row.note}</span>
      ) : null}
    </>
  );
}

function FolderList({
  breakdown,
  onOpenFolder,
}: {
  readonly breakdown: DiskBreakdown;
  readonly onOpenFolder: (path: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(FOLDER_PAGE_SIZE);
  const sorted = sortFolders(breakdown.folders);
  const largest = sorted.find((row) => row.sizeBytes !== null)?.sizeBytes ?? null;
  const shown = sorted.slice(0, visibleCount);
  const hidden = sorted.length - shown.length;

  if (sorted.length === 0) {
    return <EmptyNotice icon={<FolderIcon />} title="Nothing in this folder" />;
  }
  const itemClassName =
    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5";
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
        {shown.map((row) => {
          const share = folderShare(row, breakdown.scopeBytes, largest);
          return (
            <li key={row.path}>
              {row.kind === "folder" && row.openable ? (
                <button
                  type="button"
                  aria-label={`Open ${row.name}`}
                  onClick={() => onOpenFolder(row.path)}
                  className={cn(
                    itemClassName,
                    "w-full cursor-pointer text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                >
                  <FolderItemContent row={row} share={share} />
                </button>
              ) : (
                <div className={itemClassName}>
                  <FolderItemContent row={row} share={share} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setVisibleCount((count) => count + FOLDER_PAGE_SIZE)}
          >
            Show {Math.min(FOLDER_PAGE_SIZE, hidden)} more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BreakdownBody({
  breakdown,
  onOpenFolder,
}: {
  readonly breakdown: DiskBreakdown;
  readonly onOpenFolder: (path: string) => void;
}) {
  const { parentPath } = breakdown;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {parentPath === null ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label="Up one folder"
            onClick={() => onOpenFolder(parentPath)}
          >
            <ArrowUpIcon />
            Up
          </Button>
        )}
        <span className="flex min-w-0 flex-1 font-mono text-xs text-foreground">
          <StartTruncatedPath path={breakdown.path} />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {breakdown.measuredAt === null ? (
          "When this was measured was not recorded."
        ) : (
          <>
            Measured <DatedTime iso={breakdown.measuredAt} />
          </>
        )}
      </p>
      {breakdown.notice ? (
        <Alert variant="warning">
          <CircleAlertIcon />
          <AlertTitle>These sizes may be partial</AlertTitle>
          <AlertDescription>
            <p className="wrap-anywhere">{breakdown.notice}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {/* Keyed by folder so a new folder starts from its first screenful. */}
      <FolderList key={breakdown.path} breakdown={breakdown} onOpenFolder={onOpenFolder} />
    </div>
  );
}

/** Where a disk's space went: its folders (and big loose files), largest first, one level at a time. */
export function DiskDetailDialog({
  detail,
  computers,
  actions,
}: {
  readonly detail: DiskDetail;
  readonly computers: ComputersViewModel["computers"];
  readonly actions: Pick<ComputersActions, "onCloseDetail" | "onOpenFolder" | "onOpenDisk">;
}) {
  const computer =
    computers.status === "ready"
      ? computers.data.find((candidate) => candidate.id === detail.computerId)
      : undefined;
  const disk = computer?.metrics?.disks.find((candidate) => candidate.id === detail.diskId);
  const { breakdown } = detail;

  return (
    <DetailDialog
      title="Folder sizes"
      description={
        disk && computer ? `${disk.label} on ${computer.name}` : (computer?.name ?? null)
      }
      onClose={actions.onCloseDetail}
    >
      {disk ? <DiskFacts disk={disk} /> : null}
      {breakdown.status === "loading" ? (
        <div role="status" aria-label="Measuring folder sizes" className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Measuring folder sizes. This can take a minute on a large disk.
          </p>
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : breakdown.status === "error" ? (
        <LoadError
          title="Could not measure this disk"
          message={breakdown.message}
          onRetry={() =>
            actions.onOpenDisk({ computerId: detail.computerId, diskId: detail.diskId })
          }
        />
      ) : (
        <BreakdownBody breakdown={breakdown.data} onOpenFolder={actions.onOpenFolder} />
      )}
    </DetailDialog>
  );
}
