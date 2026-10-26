import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { renewalFields, renewalFieldPatch } from "@t3tools/client-runtime/state/session-renewal";
import { useState } from "react";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function SessionRenewalSettings() {
  const settings = useScopedSettings().workerRenewal;
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workerRenewal"]);
  const { scope, connectedEnvironments } = useSettingsScope();
  const [error, setError] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  return (
    <SettingsSection id="session-renewal" title="Session renewal">
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          Working time excludes long tool waits. The soft limit warns on the next session activity;
          the hard limit prepares a checkpoint and starts a successor after the current turn
          finishes. Independent and Base sessions are excluded. Leave a hard limit blank to turn
          automatic renewal off.
        </p>
        {mixed && (
          <p className="text-sm">
            Selected computers have different limits. Edits apply to the selected connected
            computers.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {renewalFields.map(({ key, label }) => (
            <label key={key} className="space-y-1 text-sm">
              <span>{label}</span>
              <Input
                key={`${scope.environmentIds.join(",")}:${settings[key]}`}
                aria-label={label}
                type="number"
                step="any"
                min={key === "codexScale" ? 0.1 : key.endsWith("HardHours") ? 0.01 : 0}
                placeholder={key.endsWith("HardHours") ? "Off" : undefined}
                defaultValue={settings[key] ?? ""}
                disabled={connectedEnvironments.length === 0}
                onBlur={(event) => {
                  const patch = renewalFieldPatch(key, event.currentTarget.value);
                  if (!patch) {
                    setError(`Enter a valid value for ${label.toLowerCase()}.`);
                    return;
                  }
                  setError(null);
                  if (patch[key] !== settings[key] || mixed) update({ workerRenewal: patch });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="text-xs text-muted-foreground">
                Default: {DEFAULT_SERVER_SETTINGS.workerRenewal[key] ?? "Off"}
              </span>
            </label>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Zero disables a soft warning. The Codex multiplier applies to both limits; use 1 for the
          same limits across providers. Saved changes take effect on the owning computer.
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
