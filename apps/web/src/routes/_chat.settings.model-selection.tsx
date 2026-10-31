import { createFileRoute } from "@tanstack/react-router";

import { ModelSelectionPage } from "../components/allocation/ModelSelectionPage";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function ModelSelectionRoute() {
  const { environment, environments } = useSettingsScope();
  const target = environment ?? environments[0];
  return (
    <SettingsPageContainer className="min-w-0" width="wide">
      {target ? (
        <ModelSelectionPage key={target.environmentId} environmentId={target.environmentId} />
      ) : (
        <p className="p-8">Connect an environment to configure model selection.</p>
      )}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/model-selection")({
  component: ModelSelectionRoute,
});
