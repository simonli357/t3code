import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
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
import { DisksView } from "./DisksView";
import { HoldingsView } from "./HoldingsView";
import {
  STORAGE_VIEWS,
  type ComputersViewId,
  type DisksViewModel,
  type HoldingsViewModel,
  type StorageActions,
} from "./storageViewModel";

const VIEW_LABEL: Record<ComputersViewId, string> = {
  overview: "Computers",
  disks: "Disks",
  workspaces: "Workspaces & Archives",
};

/** The storage views' data, owned by `useStorage`; the page only shows it. */
export interface StorageViewsProps {
  readonly view: ComputersViewId;
  readonly onViewChange: (view: ComputersViewId) => void;
  readonly disks: DisksViewModel;
  readonly holdings: HoldingsViewModel;
  readonly actions: StorageActions;
  readonly refreshing: boolean;
}

/**
 * The Computers page: every connected computer, a search across their projects and archives, and one
 * list of what Workenv has been doing. A controlled view; the data layer owns what is loaded and what
 * is open, and this reports intent through `actions`.
 *
 * Searching replaces the overview with the results so a long list never pushes the computers off screen;
 * clearing the search brings the overview back.
 */
export function ComputersPageView({
  model,
  actions,
  timestampFormat,
  storage,
}: ComputersPageViewProps & { readonly storage: StorageViewsProps }) {
  const { detail } = model;
  const { view } = storage;
  const refreshing = view === "overview" ? model.refreshing : storage.refreshing;

  return (
    <ComputersClockProvider timestampFormat={timestampFormat}>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron} className="h-auto">
            <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                <WorkspaceBreadcrumb ariaLabel="Computers breadcrumb">
                  <WorkspaceBreadcrumbItem current>
                    <h1>Computers</h1>
                  </WorkspaceBreadcrumbItem>
                </WorkspaceBreadcrumb>
                <ToggleGroup
                  aria-label="Computers view"
                  variant="segmented"
                  value={[view]}
                  onValueChange={(value) => {
                    const next = STORAGE_VIEWS.find((candidate) => candidate === value[0]);
                    if (next) storage.onViewChange(next);
                  }}
                >
                  {STORAGE_VIEWS.map((id) => (
                    <Toggle key={id} value={id} aria-label={VIEW_LABEL[id]}>
                      {VIEW_LABEL[id]}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
              <Button
                aria-label={view === "overview" ? "Refresh computers" : "Refresh storage"}
                aria-busy={refreshing}
                disabled={refreshing}
                size="icon-sm"
                variant="ghost"
                onClick={view === "overview" ? actions.onRefresh : storage.actions.onRefresh}
              >
                <RefreshIcon size="sm" refreshing={refreshing} />
              </Button>
            </div>
          </WorkspacePageHeader>

          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="expanded" className="@container/computers">
              {view === "disks" ? (
                <DisksView
                  model={storage.disks}
                  actions={actions}
                  onRetry={storage.actions.onRefresh}
                />
              ) : view === "workspaces" ? (
                <HoldingsView model={storage.holdings} actions={storage.actions} />
              ) : (
                <>
                  <SearchBar search={model.search} actions={actions} />
                  {isSearching(model.search) ? (
                    <SearchResultsSection search={model.search} actions={actions} />
                  ) : (
                    <>
                      <ComputersOverview computers={model.computers} actions={actions} />
                      <ActivityList activity={model.activity} actions={actions} />
                    </>
                  )}
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
