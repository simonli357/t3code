import { useState } from "react";
import {
  communicationWindowLabel,
  communicationWindowExplanation,
  parseCommunicationWindowMinutes,
} from "@t3tools/client-runtime/state/worker-communication";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorkerCommunicationSettings() {
  const value = useScopedSettings().workerCommunicationWindowMinutes;
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workerCommunicationWindowMinutes"]);
  const { scope, connectedEnvironments } = useSettingsScope();
  const [error, setError] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  return (
    <SettingsSection id="worker-communication" title="Worker communication">
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{communicationWindowExplanation}</p>
        {mixed && (
          <p className="text-sm">
            Selected computers have different values. Edits apply to the selected connected
            computers.
          </p>
        )}
        <label className="block space-y-1 text-sm">
          <span>{communicationWindowLabel}</span>
          <Input
            key={`${scope.environmentIds.join(",")}:${value}`}
            aria-label={communicationWindowLabel}
            type="number"
            min={0}
            step="any"
            defaultValue={value}
            disabled={connectedEnvironments.length === 0}
            onBlur={(event) => {
              const next = parseCommunicationWindowMinutes(event.currentTarget.value);
              if (next === undefined) {
                setError("Enter zero or a positive number of minutes.");
                return;
              }
              setError(null);
              if (mixed || next !== value) update({ workerCommunicationWindowMinutes: next });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
