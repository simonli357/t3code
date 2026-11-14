import type {
  IdleCompactionSettings as IdleCompactionValue,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  idleCompactionContextLabel,
  idleCompactionEnabledLabel,
  idleCompactionExplanation,
  idleCompactionLeadLabel,
  idleCompactionTitle,
  parseIdleCompactionContextTokens,
  parseIdleCompactionLeadMinutes,
} from "@t3tools/client-runtime/state/idle-compaction";
import { useState } from "react";
import { Switch, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";

export function IdleCompactionSettings({
  value,
  disabled,
  mixed,
  onChange,
}: {
  value: IdleCompactionValue;
  disabled: boolean;
  mixed: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <SettingsSection title={idleCompactionTitle}>
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">{idleCompactionExplanation}</Text>
        {mixed && (
          <Text className="text-sm text-foreground-muted">
            Selected computers have different values.
          </Text>
        )}
        <View className="flex-row items-center justify-between gap-4">
          <Text className="flex-1 text-sm text-foreground">{idleCompactionEnabledLabel}</Text>
          <Switch
            accessibilityLabel={idleCompactionEnabledLabel}
            value={value.enabled}
            disabled={disabled}
            onValueChange={(enabled) => onChange({ idleCompaction: { enabled } })}
          />
        </View>
        <Text className="text-sm text-foreground">{idleCompactionContextLabel}</Text>
        <AppTextInput
          key={`tokens:${value.contextTokens}`}
          accessibilityLabel={idleCompactionContextLabel}
          keyboardType="number-pad"
          editable={!disabled}
          defaultValue={String(value.contextTokens)}
          className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const next = parseIdleCompactionContextTokens(event.nativeEvent.text);
            if (next === undefined) {
              setError("Enter a whole number of tokens, at least 10,000.");
              return;
            }
            setError(null);
            if (mixed || next !== value.contextTokens)
              onChange({ idleCompaction: { contextTokens: next } });
          }}
        />
        <Text className="text-sm text-foreground">{idleCompactionLeadLabel}</Text>
        <AppTextInput
          key={`lead:${value.leadMinutes}`}
          accessibilityLabel={idleCompactionLeadLabel}
          keyboardType="number-pad"
          editable={!disabled}
          defaultValue={String(value.leadMinutes)}
          className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
          onEndEditing={(event) => {
            const next = parseIdleCompactionLeadMinutes(event.nativeEvent.text);
            if (next === undefined) {
              setError("Enter a whole number of minutes from 1 to 30.");
              return;
            }
            setError(null);
            if (mixed || next !== value.leadMinutes)
              onChange({ idleCompaction: { leadMinutes: next } });
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
