import type { ServerSettingsPatch } from "@t3tools/contracts";
import {
  communicationWindowLabel,
  communicationWindowExplanation,
  parseCommunicationWindowMinutes,
} from "@t3tools/client-runtime/state/worker-communication";
import { useState } from "react";
import { Switch, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";

export function WorkerCommunicationSettings({
  value,
  maxActiveAgentSessions,
  capMixed,
  autoSwitch,
  switchMixed,
  disabled,
  mixed,
  onChange,
}: {
  value: number;
  maxActiveAgentSessions: number;
  capMixed: boolean;
  autoSwitch: boolean;
  switchMixed: boolean;
  disabled: boolean;
  mixed: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title="Worker automation">
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
        <Text className="text-sm text-foreground">
          Max active agent sessions per computer (advisory)
        </Text>
        <AppTextInput
          key={`cap:${maxActiveAgentSessions}`}
          accessibilityLabel="Max active agent sessions per computer"
          keyboardType="number-pad"
          editable={!disabled}
          defaultValue={String(maxActiveAgentSessions)}
          className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const next = Number(event.nativeEvent.text);
            if (!Number.isSafeInteger(next) || next < 1) {
              setError("Enter a positive whole number of sessions.");
              return;
            }
            setError(null);
            if (capMixed || next !== maxActiveAgentSessions)
              onChange({ maxActiveAgentSessions: next });
          }}
        />
        <Text className="text-sm text-foreground-muted">
          Computer advice prefers computers below this cap. Starts remain allowed.
          {capMixed ? " Selected computers have different session caps." : ""}
        </Text>
        <View className="flex-row items-center justify-between gap-4">
          <Text className="flex-1 text-sm text-foreground">
            Switch worker accounts after a usage limit{switchMixed ? " (mixed)" : ""}
          </Text>
          <Switch
            accessibilityLabel="Switch worker accounts after a usage limit"
            value={autoSwitch}
            disabled={disabled}
            onValueChange={(value) => onChange({ workerAutoSwitchOnUsageLimit: value })}
          />
        </View>
        <Text className="text-sm text-foreground-muted">
          Retries the failed prompt once using another account with quota headroom. Masters never
          switch automatically.
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
