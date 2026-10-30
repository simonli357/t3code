import { CpuIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ActivityItem } from "./ActivityList";
import { DetailDialog } from "./DetailDialog";
import { formatBytes, formatPercent, sortProcesses } from "./computersFormat";
import type {
  ComputersActions,
  ComputersDetail,
  ComputersViewModel,
  ProcessFocus,
  ProcessList,
  ProcessRow,
} from "./computersViewModel";
import { DatedTime, EmptyNotice, LoadError } from "./sectionParts";

/** A host can run hundreds of processes; the busiest come first, so a screenful is the answer. */
const PROCESS_PAGE_SIZE = 50;

type ProcessesDetail = Extract<ComputersDetail, { kind: "processes" }>;

const isProcessFocus = (value: unknown): value is ProcessFocus =>
  value === "cpu" || value === "memory";

/** A figure that may not be known: shown as a dash a screen reader says out loud, never as 0. */
function Figure({ text }: { readonly text: string | null }) {
  return text === null ? (
    <>
      <span aria-hidden>–</span>
      <span className="sr-only">Not measured</span>
    </>
  ) : (
    text
  );
}

function ProcessNameCell({ row }: { readonly row: ProcessRow }) {
  const name = (
    <span className="block truncate text-sm font-medium text-foreground">{row.name}</span>
  );
  const secondary = [row.owner, row.job ? `Job: ${row.job.title}` : null]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <>
      {row.command ? (
        <Tooltip>
          <TooltipTrigger render={name} />
          <TooltipPopup side="top" variant="code">
            {row.command}
          </TooltipPopup>
        </Tooltip>
      ) : (
        name
      )}
      {secondary ? (
        <span className="block truncate text-2xs text-muted-foreground">{secondary}</span>
      ) : null}
      <span className="block font-mono text-2xs text-muted-foreground sm:hidden">
        {row.pid === null ? null : `PID ${row.pid}`}
      </span>
    </>
  );
}

function ProcessTable({
  list,
  initialSort,
}: {
  readonly list: ProcessList;
  readonly initialSort: ProcessFocus;
}) {
  const [sortBy, setSortBy] = useState(initialSort);
  const [visibleCount, setVisibleCount] = useState(PROCESS_PAGE_SIZE);
  const sorted = sortProcesses(list.processes, sortBy);
  const shown = sorted.slice(0, visibleCount);
  const hidden = sorted.length - shown.length;
  const partial = list.totalCount !== null && list.totalCount > list.processes.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {list.measuredAt === null ? (
            "When this was read was not recorded."
          ) : (
            <>
              Read <DatedTime iso={list.measuredAt} />
            </>
          )}
          {partial ? ` · the busiest ${list.processes.length} of ${list.totalCount}` : ""}
        </p>
        <ToggleGroup
          aria-label="Sort processes by"
          variant="segmented"
          value={[sortBy]}
          onValueChange={(next) => {
            const value = next[0];
            if (isProcessFocus(value)) setSortBy(value);
          }}
        >
          <Toggle value="cpu">CPU</Toggle>
          <Toggle value="memory">Memory</Toggle>
        </ToggleGroup>
      </div>
      {sorted.length === 0 ? (
        <EmptyNotice icon={<CpuIcon />} title="No processes were reported" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60">
          <table className="w-full table-fixed text-left text-xs">
            <thead className="border-b border-border/60 bg-muted/20 text-3xs uppercase tracking-widest text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Process
                </th>
                <th
                  scope="col"
                  className="hidden w-20 px-3 py-2 text-right font-semibold sm:table-cell"
                >
                  PID
                </th>
                <th scope="col" className="w-16 px-3 py-2 text-right font-semibold sm:w-20">
                  CPU
                </th>
                <th scope="col" className="w-24 px-3 py-2 text-right font-semibold">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {shown.map((row) => (
                <tr key={row.key}>
                  <td className="min-w-0 px-3 py-2">
                    <ProcessNameCell row={row} />
                  </td>
                  <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:table-cell">
                    <Figure text={row.pid === null ? null : String(row.pid)} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    <Figure text={row.cpuPercent === null ? null : formatPercent(row.cpuPercent)} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    <Figure text={row.memoryBytes === null ? null : formatBytes(row.memoryBytes)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hidden > 0 ? (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setVisibleCount((count) => count + PROCESS_PAGE_SIZE)}
          >
            Show {Math.min(PROCESS_PAGE_SIZE, hidden)} more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function JobsSection({ jobs }: { readonly jobs: ProcessList["jobs"] }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-label="Workenv jobs" className="flex flex-col gap-2">
      <h3 className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
        Workenv jobs
      </h3>
      <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
        {jobs.map((job) => (
          <ActivityItem key={job.id} row={job} />
        ))}
      </ul>
    </section>
  );
}

/**
 * What is using a computer: the Workenv jobs running on it and its processes, busiest first. Read-only:
 * nothing here stops or changes a process or a job.
 */
export function ProcessDetailDialog({
  detail,
  computers,
  actions,
}: {
  readonly detail: ProcessesDetail;
  readonly computers: ComputersViewModel["computers"];
  readonly actions: Pick<ComputersActions, "onCloseDetail" | "onOpenProcesses">;
}) {
  const computer =
    computers.status === "ready"
      ? computers.data.find((candidate) => candidate.id === detail.computerId)
      : undefined;
  const { processes } = detail;

  return (
    <DetailDialog
      title={computer ? `${computer.name}: processes` : "Processes"}
      description="Jobs and processes using this computer."
      onClose={actions.onCloseDetail}
    >
      {processes.status === "loading" ? (
        <div role="status" aria-label="Reading processes" className="flex flex-col gap-3">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : processes.status === "error" ? (
        <LoadError
          title="Could not read processes"
          message={processes.message}
          onRetry={() =>
            actions.onOpenProcesses({ computerId: detail.computerId, focus: detail.focus })
          }
        />
      ) : (
        <>
          <JobsSection jobs={processes.data.jobs} />
          <ProcessTable list={processes.data} initialSort={detail.focus} />
        </>
      )}
    </DetailDialog>
  );
}
