import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProviderAllocationPage } from "../components/allocation/ProviderAllocationPage";

function AllocationRoute() {
  const { environment, environments } = useSettingsScope();
  const target = environment ?? environments[0];
  return target ? (
    <ProviderAllocationPage key={target.environmentId} environmentId={target.environmentId} />
  ) : (
    <p className="p-8">Connect an environment to inspect provider allocation.</p>
  );
}
export const Route = createFileRoute("/settings/allocation")({ component: AllocationRoute });
