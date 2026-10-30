import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ComputersPageView } from "../components/computers/ComputersPageView";
import { STORAGE_VIEWS, type ComputersViewId } from "../components/computers/storageViewModel";
import { useComputers } from "../hooks/useComputers";
import { useClientSettings } from "../hooks/useSettings";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { useStorage } from "../hooks/useStorage";

function ComputersPage() {
  const view = Route.useSearch().view ?? "overview";
  const navigate = useNavigate();
  const { model, actions } = useComputers();
  const storage = useStorage(view);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  useEscapeToGoBack();
  return (
    <ComputersPageView
      model={model}
      actions={actions}
      timestampFormat={timestampFormat}
      storage={{
        view,
        onViewChange: (next) =>
          void navigate({
            to: "/computers",
            search: next === "overview" ? {} : { view: next },
            replace: true,
          }),
        disks: storage.disks,
        holdings: storage.holdings,
        actions: storage.actions,
        refreshing: storage.refreshing,
      }}
    />
  );
}

export const Route = createFileRoute("/computers")({
  // The overview needs no parameter; the storage views are reachable from links and the palette.
  validateSearch: (search: Record<string, unknown>): { view?: ComputersViewId } => {
    const view = STORAGE_VIEWS.find((candidate) => candidate === search.view);
    return view && view !== "overview" ? { view } : {};
  },
  component: ComputersPage,
});
