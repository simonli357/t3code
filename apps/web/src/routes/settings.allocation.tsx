import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProviderAllocationPage } from "../components/allocation/ProviderAllocationPage";

function AllocationRoute() {
  const { environment } = useSettingsScope();
  return environment ? (
    <ProviderAllocationPage
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ) : (
    <p className="p-8">Connect an environment to inspect provider allocation.</p>
  );
}
export const Route = createFileRoute("/settings/allocation")({ component: AllocationRoute });
