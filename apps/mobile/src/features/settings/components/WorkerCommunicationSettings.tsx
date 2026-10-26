import type { ServerSettingsPatch } from "@t3tools/contracts";
import {
  communicationWindowLabel,
  communicationWindowExplanation,
  parseCommunicationWindowMinutes,
} from "@t3tools/client-runtime/state/worker-communication";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";

export function WorkerCommunicationSettings({
  value,
  disabled,
  mixed,
  onChange,
}: {
  value: number;
  disabled: boolean;
  mixed: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title="Worker communication">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">{communicationWindowExplanation}</Text>
        {mixed && (
          <Text className="text-sm text-foreground-muted">
            Selected computers have different values. Edits apply to the selected connected
            computers.
          </Text>
        )}
        <Text className="text-sm text-foreground">{communicationWindowLabel}</Text>
        <AppTextInput
          key={value}
          accessibilityLabel={communicationWindowLabel}
          keyboardType="decimal-pad"
          editable={!disabled}
          defaultValue={String(value)}
          className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const next = parseCommunicationWindowMinutes(event.nativeEvent.text);
            if (next === undefined) {
              setError("Enter zero or a positive number of minutes.");
              return;
            }
            setError(null);
            if (mixed || next !== value) onChange({ workerCommunicationWindowMinutes: next });
          }}
        />
        {error && (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        )}
      </View>
    </SettingsSection>
  );
}
