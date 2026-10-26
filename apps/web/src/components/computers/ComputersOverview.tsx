import { MonitorOffIcon } from "lucide-react";
import { useId } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { ComputerPanel } from "./ComputerPanel";
import type { ComputersActions, ComputersViewModel } from "./computersViewModel";
import { EmptyNotice, LoadError, SectionHeading } from "./sectionParts";

/** Same geometry as a panel with data, so the page does not jump when the first measurement lands. */
function ComputerPanelSkeleton() {
  return (
    <div
      aria-hidden
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border/60 bg-card px-4 py-4 shadow-xs/5 sm:px-5"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Skeleton shape="card" className="h-28" />
        <Skeleton shape="card" className="h-28" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

/** One panel per connected computer, however many there are. */
export function ComputersOverview({
  computers,
  actions,
}: {
  readonly computers: ComputersViewModel["computers"];
  readonly actions: Pick<ComputersActions, "onRefresh" | "onOpenDisk" | "onOpenProcesses">;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} hidden>
        Computers
      </SectionHeading>
      {computers.status === "loading" ? (
        <div
          role="status"
          aria-label="Loading computers"
          className="grid grid-cols-1 gap-4 @3xl/computers:grid-cols-2"
        >
          <ComputerPanelSkeleton />
          <ComputerPanelSkeleton />
        </div>
      ) : computers.status === "error" ? (
        <LoadError
          title="Could not load computers"
          message={computers.message}
          onRetry={actions.onRefresh}
        />
      ) : computers.data.length === 0 ? (
        <EmptyNotice
          icon={<MonitorOffIcon />}
          title="No computers connected"
          description="Computers appear here once a T3 environment is connected."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 @3xl/computers:grid-cols-2">
          {computers.data.map((computer) => (
            <ComputerPanel
              key={computer.id}
              computer={computer}
              onOpenDisk={actions.onOpenDisk}
              onOpenProcesses={actions.onOpenProcesses}
            />
          ))}
        </div>
      )}
    </section>
  );
}
