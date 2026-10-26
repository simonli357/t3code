import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "../../env";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ActivityList } from "./ActivityList";
import { ComputersClockProvider } from "./computersClock";
import { isSearching } from "./computersFormat";
import type { ComputersPageViewProps } from "./computersViewModel";
import { ComputersOverview } from "./ComputersOverview";
import { DiskDetailDialog } from "./DiskDetailDialog";
import { FileDetailDialog } from "./FileDetailDialog";
import { SearchBar, SearchResultsSection } from "./FileSearch";
import { ProcessDetailDialog } from "./ProcessDetailDialog";

/**
 * The Computers page: every connected computer, a search across their projects and archives, and one
 * list of what Workenv has been doing. A controlled view; the data layer owns what is loaded and what
 * is open, and this reports intent through `actions`.
 *
 * Searching replaces the overview with the results so a long list never pushes the computers off screen;
 * clearing the search brings the overview back.
 */
export function ComputersPageView({ model, actions, timestampFormat }: ComputersPageViewProps) {
  const { detail } = model;

  return (
    <ComputersClockProvider timestampFormat={timestampFormat}>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron} className="h-auto">
            <div className="flex w-full min-w-0 items-center justify-between gap-3 py-2">
              <WorkspaceBreadcrumb ariaLabel="Computers breadcrumb">
                <WorkspaceBreadcrumbItem current>
                  <h1>Computers</h1>
                </WorkspaceBreadcrumbItem>
              </WorkspaceBreadcrumb>
              <Button
                aria-label="Refresh computers"
                aria-busy={model.refreshing}
                disabled={model.refreshing}
                size="icon-sm"
                variant="ghost"
                onClick={actions.onRefresh}
              >
                <RefreshIcon size="sm" refreshing={model.refreshing} />
              </Button>
            </div>
          </WorkspacePageHeader>

          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="expanded" className="@container/computers">
              <SearchBar search={model.search} actions={actions} />
              {isSearching(model.search) ? (
                <SearchResultsSection search={model.search} actions={actions} />
              ) : (
                <>
                  <ComputersOverview computers={model.computers} actions={actions} />
                  <ActivityList activity={model.activity} actions={actions} />
                </>
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        </div>
      </SidebarInset>

      {/* Keyed by what is open, so a different disk, process list, or file starts with a clean slate. */}
      {detail?.kind === "disk" ? (
        <DiskDetailDialog
          key={`${detail.computerId}:${detail.diskId}`}
          detail={detail}
          computers={model.computers}
          actions={actions}
        />
      ) : null}
      {detail?.kind === "processes" ? (
        <ProcessDetailDialog
          key={`${detail.computerId}:${detail.focus}`}
          detail={detail}
          computers={model.computers}
          actions={actions}
        />
      ) : null}
      {detail?.kind === "file" ? (
        <FileDetailDialog key={detail.fileId} detail={detail} actions={actions} />
      ) : null}
    </ComputersClockProvider>
  );
}
