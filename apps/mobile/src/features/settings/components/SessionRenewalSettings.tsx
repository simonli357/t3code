import {
  DEFAULT_SERVER_SETTINGS,
  type WorkerRenewalSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { renewalFields, renewalFieldPatch } from "@t3tools/client-runtime/state/session-renewal";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

export function SessionRenewalSettings({
  value,
  disabled,
  mixed,
  onChange,
}: {
  value: WorkerRenewalSettings;
  disabled: boolean;
  mixed: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title="Session renewal">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          Worker reports include working time and suggest renewing a session once it passes the
          warning. A hard limit makes that advice firmer; sessions are never renewed automatically.
          Leave a hard limit blank to turn it off. Zero disables a warning.
        </Text>
        {mixed && (
          <Text className="text-sm text-foreground-muted">
            Computers have different limits. Edits apply to the selected connected computers.
          </Text>
        )}
        {renewalFields.map(({ key, label }) => (
          <View key={key} className="gap-1">
            <Text className="text-sm text-foreground">{label}</Text>
            <AppTextInput
              key={`${key}:${value[key]}`}
              accessibilityLabel={label}
              keyboardType="decimal-pad"
              editable={!disabled}
              defaultValue={value[key] === null ? "" : String(value[key])}
              placeholder={key.endsWith("HardHours") ? "Off" : undefined}
              className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
              onEndEditing={(event) => {
                const patch = renewalFieldPatch(key, event.nativeEvent.text);
                if (!patch) {
                  setError(`Enter a valid value for ${label.toLowerCase()}.`);
                  return;
                }
                setError(null);
                if (mixed || patch[key] !== value[key]) onChange({ workerRenewal: patch });
              }}
            />
            <Text className="text-xs text-foreground-muted">
              Default: {DEFAULT_SERVER_SETTINGS.workerRenewal[key] ?? "Off"}
            </Text>
          </View>
        ))}
        <Text className="text-sm text-foreground-muted">
          Both limits use working hours and the Codex multiplier. Long tool waits are excluded.
        </Text>
        {error && (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        )}
      </View>
    </SettingsSection>
  );
}
