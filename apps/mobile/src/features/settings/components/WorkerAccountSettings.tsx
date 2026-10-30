import {
  allocationPreferenceKey,
  type AllocationAccountCap,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useState } from "react";
import { Switch, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { allocationEnvironment } from "../../../state/allocation";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

const parsePercent = (text: string) => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
};

export function WorkerAccountSettings({
  environmentId,
  disabledIds,
  disabled,
  onChange,
}: {
  environmentId: EnvironmentId;
  disabledIds: ReadonlyArray<ProviderInstanceId>;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const execute = useAtomCommand(allocationEnvironment.execute, { reportFailure: false });
  const query = useEnvironmentQuery(
    allocationEnvironment.snapshot({ environmentId, input: { _tag: "snapshot" } }),
  );
  const [error, setError] = useState<string | null>(null);
  const snapshot = query.data?.snapshot ?? null;
  const accounts = snapshot?.inventories.flatMap((inventory) => inventory.accounts) ?? [];
  const caps = snapshot?.policy.accountCaps ?? [];

  const saveCap = async (key: string, next: Partial<AllocationAccountCap>) => {
    if (!snapshot) return;
    const current = caps.find((cap) => cap.key === key) ?? {
      key,
      weeklyPercent: null,
      fiveHourPercent: null,
      stopWorkers: true,
      stopMasters: false,
    };
    const accountCaps = [...caps.filter((cap) => cap.key !== key), { ...current, ...next }].filter(
      (cap) => cap.weeklyPercent !== null || cap.fiveHourPercent !== null,
    );
    const result = await execute({
      environmentId,
      input: {
        _tag: "policy",
        input: {
          expectedVersion: snapshot.policy.version,
          policy: { ...snapshot.policy, accountCaps },
        },
      },
    });
    if (result._tag === "Success") {
      setError(null);
      query.refresh();
    } else setError("The cap was not saved. Reload and try again.");
  };

  return (
    <SettingsSection title="Worker accounts and usage caps">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          A turned-off account is never chosen for workers. A usage cap stops new work on an account
          once its verified quota passes the percentage; accounts without a verified subscription
          quota never reach a cap. Leave a cap blank to turn it off.
        </Text>
        {accounts.length === 0 && !error && query.error === null && (
          <Text className="text-sm text-foreground-muted">Loading accounts.</Text>
        )}
        {accounts.map((account) => {
          const key = allocationPreferenceKey(account);
          const cap = caps.find((entry) => entry.key === key);
          return (
            <View key={account.instanceId} className="gap-2">
              <View className="flex-row items-center justify-between gap-4">
                <Text className="flex-1 text-sm text-foreground">{account.label}</Text>
                <Switch
                  accessibilityLabel={`Use ${account.label} for workers`}
                  value={!disabledIds.includes(account.instanceId)}
                  disabled={disabled}
                  onValueChange={(on) =>
                    onChange({
                      workerDisabledInstanceIds: on
                        ? disabledIds.filter((id) => id !== account.instanceId)
                        : [...disabledIds, account.instanceId],
                    })
                  }
                />
              </View>
              {(
                [
                  ["weeklyPercent", "Weekly cap (%)"],
                  ["fiveHourPercent", "Five-hour cap (%)"],
                ] as const
              ).map(([field, label]) => (
                <View key={field} className="gap-1">
                  <Text className="text-xs text-foreground-muted">{label}</Text>
                  <AppTextInput
                    key={`${key}:${field}:${cap?.[field] ?? ""}`}
                    accessibilityLabel={`${account.label} ${label}`}
                    keyboardType="decimal-pad"
                    editable={!disabled}
                    placeholder="Off"
                    defaultValue={cap?.[field] === null || !cap ? "" : String(cap[field])}
                    className="rounded-xl bg-background px-3 py-2 text-base text-foreground"
                    onEndEditing={(event) => {
                      const next = parsePercent(event.nativeEvent.text);
                      if (next === undefined) {
                        setError("Enter a percentage from 0 to 100, or leave it blank.");
                        return;
                      }
                      if (next !== (cap?.[field] ?? null)) void saveCap(key, { [field]: next });
                    }}
                  />
                </View>
              ))}
            </View>
          );
        })}
        {(error ?? query.error) && (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error ?? query.error}
          </Text>
        )}
      </View>
    </SettingsSection>
  );
}
