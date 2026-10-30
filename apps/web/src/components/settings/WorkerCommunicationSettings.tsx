import { useState } from "react";
import {
  communicationWindowLabel,
  communicationWindowExplanation,
  parseCommunicationWindowMinutes,
} from "@t3tools/client-runtime/state/worker-communication";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorkerCommunicationSettings() {
  const settings = useScopedSettings();
  const value = settings.workerCommunicationWindowMinutes;
  const switchMixed = useScopedSettingsMixed(["workerAutoSwitchOnUsageLimit"]);
  const capMixed = useScopedSettingsMixed(["maxActiveAgentSessions"]);
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workerCommunicationWindowMinutes"]);
  const { scope, connectedEnvironments } = useSettingsScope();
  const [error, setError] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  return (
    <SettingsSection id="worker-communication" title="Worker automation">
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
        <label className="block space-y-1 text-sm">
          <span>Max active agent sessions per computer (advisory)</span>
          <Input
            key={`cap:${scope.environmentIds.join(",")}:${settings.maxActiveAgentSessions}`}
            aria-label="Max active agent sessions per computer"
            type="number"
            min={1}
            step={1}
            defaultValue={settings.maxActiveAgentSessions}
            disabled={connectedEnvironments.length === 0}
            onBlur={(event) => {
              const next = Number(event.currentTarget.value);
              if (!Number.isSafeInteger(next) || next < 1) {
                setError("Enter a positive whole number of sessions.");
                return;
              }
              setError(null);
              if (capMixed || next !== settings.maxActiveAgentSessions)
                update({ maxActiveAgentSessions: next });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span>Computer advice prefers computers below this cap. Starts remain allowed.</span>
        </label>
        {capMixed && <p className="text-sm">Selected computers have different session caps.</p>}
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>Switch worker accounts after a usage limit{switchMixed ? " (mixed)" : ""}</span>
          <Switch
            checked={settings.workerAutoSwitchOnUsageLimit}
            disabled={connectedEnvironments.length === 0}
            onCheckedChange={(checked) => update({ workerAutoSwitchOnUsageLimit: checked })}
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Retries the failed prompt once using another account with quota headroom. Masters never
          switch automatically.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
