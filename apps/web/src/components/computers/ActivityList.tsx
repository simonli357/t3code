import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ArrowLeftRightIcon,
  DatabaseBackupIcon,
  RotateCcwIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { ExpandableText } from "../settings/ExpandableText";
import { useComputersClock } from "./computersClock";
import {
  ACTIVITY_KIND_LABELS,
  activityProgressPercent,
  describeActivityTime,
  filterActivity,
  formatBytes,
  presentActivityStatus,
  retryOffer,
  type ActivityFilter,
} from "./computersFormat";
import type {
  ActivityKind,
  ActivityRow,
  ComputersActions,
  ComputersViewModel,
} from "./computersViewModel";
import { EmptyNotice, LoadError, SectionHeading, ToneBadge } from "./sectionParts";

/** A screenful at a time: the data layer may send every job workspace the computer has ever kept. */
const ACTIVITY_PAGE_SIZE = 20;

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  job: TerminalIcon,
  transfer: ArrowLeftRightIcon,
  backup: DatabaseBackupIcon,
  restore: ArchiveRestoreIcon,
};

const FILTER_OPTIONS: ReadonlyArray<{ readonly value: ActivityFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "in-progress", label: "In progress" },
  { value: "failed", label: "Failed" },
];

const isActivityFilter = (value: unknown): value is ActivityFilter =>
  FILTER_OPTIONS.some((option) => option.value === value);

const EMPTY_FILTER_COPY: Record<Exclude<ActivityFilter, "all">, string> = {
  "in-progress": "Nothing is running or queued.",
  failed: "Nothing has failed.",
};

function RetryControl({
  row,
  onRetry,
}: {
  readonly row: ActivityRow;
  readonly onRetry: (activityId: string) => void;
}) {
  const retry = retryOffer(row);
  if (retry === null) return null;
  if (retry.state === "unavailable") {
    return <p className="text-xs text-muted-foreground">Cannot retry from here: {retry.reason}</p>;
  }
  return (
    <div>
      <Button
        size="xs"
        variant="outline"
        aria-label={`Retry ${row.title}`}
        disabled={retry.state === "in-flight"}
        onClick={() => onRetry(row.id)}
      >
        {retry.state === "in-flight" ? <Spinner /> : <RotateCcwIcon />}
        {retry.state === "in-flight" ? "Retrying" : "Retry"}
      </Button>
    </div>
  );
}

function ProgressReadout({ row }: { readonly row: ActivityRow }) {
  if (row.status !== "running" || row.progress === null) return null;
  const percent = activityProgressPercent(row.progress);
  const { bytesDone, bytesTotal } = row.progress;
  const sizes =
    bytesDone !== null && bytesTotal !== null
      ? `${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`
      : null;
  if (percent === null && sizes === null) return null;
  return (
    <div className="flex flex-col gap-1">
      {percent === null ? null : (
        <span
          role="progressbar"
          aria-label={`${row.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="block h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
        {[sizes, percent === null ? null : `${Math.round(percent)}%`]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
    </div>
  );
}

/** One entry. Without `onRetry` it never shows a Retry button, which is how a job list uses it. */
export function ActivityItem({
  row,
  onRetry,
}: {
  readonly row: ActivityRow;
  readonly onRetry?: ((activityId: string) => void) | undefined;
}) {
  const { nowMs, timestampFormat } = useComputersClock();
  const Icon = KIND_ICON[row.kind];
  const status = presentActivityStatus(row.status);
  const timeLine = describeActivityTime(row, nowMs, timestampFormat);
  const failureReason = row.failureReason?.trim() ? row.failureReason : null;

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-3 py-3 sm:px-4">
      <Icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="line-clamp-2 wrap-anywhere text-sm font-medium text-foreground">
            {row.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[ACTIVITY_KIND_LABELS[row.kind], row.context].filter(Boolean).join(" · ")}
          </p>
        </div>
        <ProgressReadout row={row} />
        {row.status === "failed" ? (
          <div className="rounded-lg bg-error-surface px-3 py-2 text-xs text-error-foreground">
            {failureReason ? (
              <ExpandableText text={failureReason} expandLabel="Show full reason" />
            ) : (
              "Failed, and no reason was recorded."
            )}
          </div>
        ) : null}
        {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
        {timeLine ? <p className="text-xs text-muted-foreground">{timeLine}</p> : null}
        {onRetry ? <RetryControl row={row} onRetry={onRetry} /> : null}
      </div>
      <div className="pt-0.5">
        <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
      </div>
    </li>
  );
}

function ActivitySkeleton() {
  return (
    <ul role="status" aria-label="Loading activity" className="divide-y divide-border/50">
      {[0, 1, 2].map((index) => (
        <li key={index} aria-hidden className="flex flex-col gap-2 px-3 py-3 sm:px-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Jobs, transfers, backups, and restores in one list, newest first. A failed one says why, in the
 * words it was given. Retry appears only on a failed transfer, backup, or restore.
 */
export function ActivityList({
  activity,
  actions,
}: {
  readonly activity: ComputersViewModel["activity"];
  readonly actions: Pick<ComputersActions, "onRefresh" | "onRetryActivity">;
}) {
  const headingId = useId();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [visibleCount, setVisibleCount] = useState(ACTIVITY_PAGE_SIZE);

  const filterControl = (
    <ToggleGroup
      aria-label="Filter activity"
      variant="segmented"
      value={[filter]}
      onValueChange={(next) => {
        const value = next[0];
        if (!isActivityFilter(value)) return;
        setFilter(value);
        setVisibleCount(ACTIVITY_PAGE_SIZE);
      }}
    >
      {FILTER_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );

  let body;
  if (activity.status === "loading") {
    body = (
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs/5">
        <ActivitySkeleton />
      </div>
    );
  } else if (activity.status === "error") {
    body = (
      <LoadError
        title="Could not load activity"
        message={activity.message}
        onRetry={actions.onRefresh}
      />
    );
  } else if (activity.data.length === 0) {
    body = (
      <EmptyNotice
        icon={<ActivityIcon />}
        title="No activity yet"
        description="Jobs, transfers, backups and restores show up here."
      />
    );
  } else {
    const rows = filterActivity(activity.data, filter);
    const shown = rows.slice(0, visibleCount);
    const hidden = rows.length - shown.length;
    body =
      rows.length === 0 && filter !== "all" ? (
        <EmptyNotice icon={<ActivityIcon />} title={EMPTY_FILTER_COPY[filter]} />
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs/5">
            {shown.map((row) => (
              <ActivityItem key={row.id} row={row} onRetry={actions.onRetryActivity} />
            ))}
          </ul>
          {hidden > 0 ? (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVisibleCount((count) => count + ACTIVITY_PAGE_SIZE)}
              >
                Show {Math.min(ACTIVITY_PAGE_SIZE, hidden)} more
              </Button>
            </div>
          ) : null}
        </div>
      );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} action={filterControl}>
        Activity
      </SectionHeading>
      {body}
    </section>
  );
}
