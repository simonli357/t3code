import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ProviderAllocationPage } from "../components/allocation/ProviderAllocationPage";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function AllocationRoute() {
  const { environment, environments } = useSettingsScope();
  const target = environment ?? environments[0];
  return (
    <SettingsPageContainer className="min-w-0" width="wide">
      {target ? (
        <ProviderAllocationPage key={target.environmentId} environmentId={target.environmentId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect an environment to inspect provider allocation.
        </p>
      )}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/settings/allocation")({ component: AllocationRoute });
