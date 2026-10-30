import {
  allocationPreferenceKey,
  type AllocationAccountCap,
  type AllocationOperation,
  type EnvironmentId,
} from "@t3tools/contracts";
import { createAllocationAtoms } from "@t3tools/client-runtime/state/provider-allocation";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const allocation = createAllocationAtoms(connectionAtomRuntime);

const parsePercent = (text: string) => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
};

export function WorkerAccountSettings() {
  const { scope, environment } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) return null;
  return (
    <WorkerAccounts key={environment.environmentId} environmentId={environment.environmentId} />
  );
}

function WorkerAccounts({ environmentId }: { environmentId: EnvironmentId }) {
  const execute = useAtomCommand(allocation.execute, { reportFailure: false });
  const disabled = useScopedSettings().workerDisabledInstanceIds;
  const update = useUpdateScopedSettings();
  const query = useEnvironmentQuery(
    allocation.snapshot({ environmentId, input: { _tag: "snapshot" } }),
  );
  const snapshot = query.data?.snapshot ?? null;
  const [error, setError] = useState<string | null>(null);

  const call = async (input: AllocationOperation) => {
    const result = await execute({ environmentId, input });
    if (result._tag !== "Success") {
      setError("The request failed. Reload the page and try again.");
      return null;
    }
    setError(null);
    return result.value;
  };
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
    const merged = { ...current, ...next };
    const accountCaps = [...caps.filter((cap) => cap.key !== key), merged].filter(
      (cap) => cap.weeklyPercent !== null || cap.fiveHourPercent !== null,
    );
    const response = await call({
      _tag: "policy",
      input: {
        expectedVersion: snapshot.policy.version,
        policy: { ...snapshot.policy, accountCaps },
      },
    });
    if (response?.policy) query.refresh();
  };

  return (
    <SettingsSection id="worker-accounts" title="Worker accounts and usage caps">
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          A turned-off account is never chosen for workers, automatically or by name. A usage cap
          stops new work on an account once its verified quota passes the percentage; accounts
          without a verified subscription quota never reach a cap. Leave a cap blank to turn it off.
        </p>
        {accounts.length === 0 && !error && query.error === null && (
          <p className="text-sm text-muted-foreground">Loading accounts.</p>
        )}
        {accounts.map((account) => {
          const key = allocationPreferenceKey(account);
          const cap = caps.find((entry) => entry.key === key);
          const off = disabled.includes(account.instanceId);
          return (
            <div key={account.instanceId} className="space-y-2 border-t pt-3 first:border-t-0">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  {account.label}
                  <span className="text-muted-foreground"> · {account.instanceId}</span>
                </span>
                <Switch
                  aria-label={`Use ${account.label} for workers`}
                  checked={!off}
                  onCheckedChange={(checked) =>
                    update({
                      workerDisabledInstanceIds: checked
                        ? disabled.filter((id) => id !== account.instanceId)
                        : [...disabled, account.instanceId],
                    })
                  }
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["weeklyPercent", "Weekly cap (%)"],
                    ["fiveHourPercent", "Five-hour cap (%)"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="space-y-1 text-sm">
                    <span>{label}</span>
                    <Input
                      key={`${key}:${field}:${cap?.[field] ?? ""}`}
                      aria-label={`${account.label} ${label}`}
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      placeholder="Off"
                      defaultValue={cap?.[field] ?? ""}
                      onBlur={(event) => {
                        const next = parsePercent(event.currentTarget.value);
                        if (next === undefined) {
                          setError("Enter a percentage from 0 to 100, or leave it blank.");
                          return;
                        }
                        if (next !== (cap?.[field] ?? null)) void saveCap(key, { [field]: next });
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </label>
                ))}
              </div>
              {cap && (
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={cap.stopWorkers}
                      onCheckedChange={(checked) => void saveCap(key, { stopWorkers: checked })}
                    />
                    <span>Applies to workers</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={cap.stopMasters}
                      onCheckedChange={(checked) => void saveCap(key, { stopMasters: checked })}
                    />
                    <span>Applies to masters</span>
                  </label>
                </div>
              )}
            </div>
          );
        })}
        {(error ?? query.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? query.error}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
