import { useState } from "react";
import {
  idleCompactionContextLabel,
  idleCompactionEnabledLabel,
  idleCompactionExplanation,
  idleCompactionLeadLabel,
  idleCompactionTitle,
  parseIdleCompactionContextTokens,
  parseIdleCompactionLeadMinutes,
} from "@t3tools/client-runtime/state/idle-compaction";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function IdleCompactionSettings() {
  const { idleCompaction } = useScopedSettings();
  const mixed = useScopedSettingsMixed(["idleCompaction"]);
  const update = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const [error, setError] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  // Older servers drop the key, so editing them would silently do nothing.
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.idleCompaction === true,
    );
  const key = `${scope.environmentIds.join(",")}:${idleCompaction.contextTokens}:${idleCompaction.leadMinutes}`;
  return (
    <SettingsSection id="idle-compaction" title={idleCompactionTitle}>
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{idleCompactionExplanation}</p>
        {!supported && connectedEnvironments.length > 0 && (
          <p className="text-sm">A selected computer runs a server without idle compaction.</p>
        )}
        {mixed && <p className="text-sm">Selected computers have different values.</p>}
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>{idleCompactionEnabledLabel}</span>
          <Switch
            checked={idleCompaction.enabled}
            disabled={!supported}
            onCheckedChange={(checked) => update({ idleCompaction: { enabled: checked } })}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{idleCompactionContextLabel}</span>
          <Input
            key={`tokens:${key}`}
            aria-label={idleCompactionContextLabel}
            type="number"
            min={10_000}
            step={10_000}
            defaultValue={idleCompaction.contextTokens}
            disabled={!supported}
            onBlur={(event) => {
              const next = parseIdleCompactionContextTokens(event.currentTarget.value);
              if (next === undefined) {
                setError("Enter a whole number of tokens, at least 10,000.");
                return;
              }
              setError(null);
              if (mixed || next !== idleCompaction.contextTokens)
                update({ idleCompaction: { contextTokens: next } });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{idleCompactionLeadLabel}</span>
          <Input
            key={`lead:${key}`}
            aria-label={idleCompactionLeadLabel}
            type="number"
            min={1}
            max={30}
            step={1}
            defaultValue={idleCompaction.leadMinutes}
            disabled={!supported}
            onBlur={(event) => {
              const next = parseIdleCompactionLeadMinutes(event.currentTarget.value);
              if (next === undefined) {
                setError("Enter a whole number of minutes from 1 to 30.");
                return;
              }
              setError(null);
              if (mixed || next !== idleCompaction.leadMinutes)
                update({ idleCompaction: { leadMinutes: next } });
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
