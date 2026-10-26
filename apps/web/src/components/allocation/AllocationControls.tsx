import { useId } from "react";
import {
  defaultAllocationPolicy,
  PROVIDER_DISPLAY_NAMES,
  type AllocationPolicy,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import {
  allocationCurveFields,
  allocationEstimateFields,
  allocationAccountGroups,
  allocationModelRows,
  allocationRateEvidence,
} from "@t3tools/client-runtime/state/provider-allocation";
import { Button } from "../ui/button";

const field =
  "block w-full min-w-0 rounded border bg-background px-2 py-2 text-sm disabled:opacity-60";
const number = (value: number) =>
  Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "";
const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "Unknown");

function NumericControl({
  name,
  value,
  defaultValue,
  unit,
  help,
  disabled,
  min = 0,
  max,
  step = 0.1,
  derived,
  onChange,
}: {
  name: string;
  value: number;
  defaultValue: number;
  unit: string;
  help: string;
  disabled: boolean;
  min?: number;
  max: number;
  step?: number;
  derived?: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <label className="grid min-w-0 gap-1">
      <span className="font-medium">{name}</span>
      <span id={`${id}-default`} className="text-xs text-muted-foreground">
        {unit} · Default {number(defaultValue)}
      </span>
      {derived ? (
        <input
          className={field}
          aria-label={`${name} current`}
          aria-describedby={`${id}-default ${id}-help`}
          readOnly
          disabled
          value="Derived from each cycle"
        />
      ) : (
        <input
          className={field}
          aria-label={`${name} current`}
          aria-describedby={`${id}-default ${id}-help`}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          aria-invalid={!Number.isFinite(value) || value < min || value > max}
          disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.valueAsNumber)}
        />
      )}
      <span id={`${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </span>
      {!derived && (!Number.isFinite(value) || value < min || value > max) && (
        <span className="text-xs text-destructive">
          Enter a number from {min} to {max}.
        </span>
      )}
    </label>
  );
}

export function AllocationControls({
  policy,
  snapshot,
  disabled,
  onChange,
}: {
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  disabled: boolean;
  onChange: (policy: AllocationPolicy) => void;
}) {
  const curve = (family: "codex" | "claude" | "other", advanced = false) => {
    const current = policy[family];
    const title = family === "codex" ? "Codex" : family === "claude" ? "Claude" : "Other providers";
    const fields = advanced ? allocationCurveFields : allocationCurveFields.slice(0, 2);
    return (
      <fieldset key={family} className="min-w-0 rounded-lg border p-4">
        <legend className="px-1 font-semibold">{title}</legend>
        <div className="grid min-w-0 gap-4">
          {current.preset === "sustainable" && (
            <p className="text-sm text-muted-foreground">
              Saved cycle-based policy: usage is released evenly after the reserve, so daily and
              initial budgets are derived. Your saved values remain unchanged.
            </p>
          )}
          {fields.map((item) => (
            <NumericControl
              key={item.key}
              name={`${title} ${item.label}`}
              unit={item.unit}
              value={
                current.preset === "aggressive17" && item.key === "dailyPoints"
                  ? 17
                  : current.preset === "aggressive17" &&
                      ["burstPoints", "burstHours"].includes(item.key)
                    ? 0
                    : current[item.key]
              }
              defaultValue={defaultAllocationPolicy[family][item.key]}
              max={item.max}
              help={item.help}
              disabled={disabled}
              derived={
                current.preset === "sustainable" &&
                ["dailyPoints", "burstPoints", "burstHours"].includes(item.key)
              }
              onChange={(value) =>
                onChange({
                  ...policy,
                  [family]: {
                    ...current,
                    ...(current.preset === "aggressive17"
                      ? { dailyPoints: 17, burstPoints: 0, burstHours: 0 }
                      : {}),
                    ...(current.preset !== "sustainable" ? { preset: "custom" as const } : {}),
                    [item.key]: value,
                  },
                })
              }
            />
          ))}
          {current.preset === "sustainable" && (
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange({ ...policy, [family]: { ...current, preset: "custom" } })}
            >
              Use saved numeric budgets for {title}
            </Button>
          )}
        </div>
      </fieldset>
    );
  };
  const groups = allocationAccountGroups(snapshot, policy);
  return (
    <>
      <section aria-label="Usage budgets" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Usage budgets</h2>
        <p className="text-sm text-muted-foreground">
          Each number is a percentage of the provider’s allowance. The initial budget plus the daily
          budget builds a target from the weekly reset, capped below the reserve. Claude’s 17 points
          per day can use a week’s allowance before seven days.
        </p>
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          {curve("codex")}
          {curve("claude")}
        </div>
      </section>
      <section aria-label="Account preferences" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Account preferences</h2>
        <p className="text-sm text-muted-foreground">
          Weights are relative recommendation preferences among compatible accounts with comparable
          warnings, not hard quotas or rejection rules; an explicit valid choice always wins.
        </p>
        <p className="text-xs text-muted-foreground">
          Equal defaults: 50 per account. Shares are normalized within each provider family,
          counting known shared identities once. They describe preference, not promised usage
          distribution. Available choices still depend on the selected computer and model.
        </p>
        {snapshot && snapshot.accountWeightsSupported !== true && (
          <p className="text-sm">
            Update the coordinator to edit account preference weights. Existing budget settings are
            still available.
          </p>
        )}
        {!groups.length && (
          <p className="text-sm">
            Account preferences appear when account information is available.
          </p>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.key} className="min-w-0 rounded-lg border p-3">
              <NumericControl
                name={`${group.label}${group.members[0]?.accountKey === null ? ` (${group.hosts.join(", ")})` : ""} preference weight`}
                unit="relative weight"
                value={group.weight}
                defaultValue={50}
                max={100}
                step={0.1}
                disabled={disabled || snapshot?.accountWeightsSupported !== true}
                help={`${PROVIDER_DISPLAY_NAMES[group.driver] ?? group.driver} · ${group.hosts.join(", ")} · ${number(group.share)}% family preference share${group.equalFallback ? " (all zero: equal tie-breaking)" : ""}`}
                onChange={(weight) =>
                  onChange({
                    ...policy,
                    accountWeights: [
                      ...(policy.accountWeights ?? []).filter((w) => w.key !== group.key),
                      { key: group.key, weight },
                    ],
                  })
                }
              />
              {group.members[0]?.accountKey === null && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Identity unknown; this computer’s account stays separate.
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">Advanced budgets and estimation</summary>
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          {(["codex", "claude"] as const).map((family) => (
            <fieldset key={family} className="grid min-w-0 gap-4 rounded border p-3">
              <legend>{family === "codex" ? "Codex" : "Claude"}</legend>
              {allocationCurveFields.slice(2).map((item) => (
                <NumericControl
                  key={item.key}
                  name={`${family === "codex" ? "Codex" : "Claude"} ${item.label}`}
                  unit={item.unit}
                  value={
                    policy[family].preset === "aggressive17" && item.key === "burstHours"
                      ? 0
                      : policy[family][item.key]
                  }
                  defaultValue={defaultAllocationPolicy[family][item.key]}
                  max={item.max}
                  help={item.help}
                  disabled={disabled}
                  derived={policy[family].preset === "sustainable" && item.key === "burstHours"}
                  onChange={(value) =>
                    onChange({
                      ...policy,
                      [family]: {
                        ...policy[family],
                        ...(policy[family].preset === "aggressive17"
                          ? { preset: "custom", dailyPoints: 17, burstPoints: 0, burstHours: 0 }
                          : {}),
                        [item.key]: value,
                      },
                    })
                  }
                />
              ))}
            </fieldset>
          ))}
          {curve("other", true)}
          <div className="grid min-w-0 gap-4">
            {allocationEstimateFields.map((item) => (
              <NumericControl
                key={item.key}
                name={item.label}
                value={policy[item.key]}
                defaultValue={defaultAllocationPolicy[item.key]}
                unit={item.unit}
                help={item.help}
                min={item.min}
                max={item.max}
                step={item.step}
                disabled={disabled}
                onChange={(value) => onChange({ ...policy, [item.key]: value })}
              />
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Short-window forecasts use their own observed rate or fallback burn. Family reserve and
          warning settings apply to each allowance window. These estimates never prevent an explicit
          Start.
        </p>
      </details>
    </>
  );
}

export function AllocationAnalytics({
  snapshot,
  policy,
}: {
  snapshot: AllocationSnapshot | null;
  policy: AllocationPolicy;
}) {
  const groups = allocationAccountGroups(snapshot, policy);
  return (
    <section aria-label="Usage analytics" className="grid min-w-0 gap-3">
      <h2 className="font-semibold">Usage analytics</h2>
      <p className="text-sm text-muted-foreground">
        Allowance burn is measured for an account as a whole. Model and effort token samples cannot
        establish a subscription burn rate when account traffic is mixed. Measurements use the
        existing account opt-in.
      </p>
      {!groups.length && <p>No account readings yet.</p>}
      {groups.map((group) => (
        <article key={group.key} className="min-w-0 rounded-lg border p-4">
          <h3 className="font-semibold">
            {group.label} · {PROVIDER_DISPLAY_NAMES[group.driver] ?? group.driver}
          </h3>
          {group.members.map((account) => (
            <div
              key={`${account.environmentId}:${account.instanceId}`}
              className="mt-3 grid min-w-0 gap-2"
            >
              <p className="text-sm">
                {snapshot?.inventories.find((host) => host.environmentId === account.environmentId)
                  ?.environmentLabel ?? account.environmentId}
              </p>
              {!account.windows.length && (
                <p className="text-sm text-muted-foreground">
                  Usage and reset time unavailable. Not enough data for measured burn.
                </p>
              )}
              {account.windows.map((window) => {
                const host = snapshot?.inventories.find(
                  (item) => item.environmentId === account.environmentId,
                );
                const evidence = allocationRateEvidence(
                  window,
                  host?.observedAt ?? "",
                  policy,
                  Date.now(),
                );
                return (
                  <div key={window.id} className="rounded border p-2 text-sm">
                    <p>
                      {window.label}: {number(window.usedPoints)}% used · Reset{" "}
                      {time(window.resetsAt)}
                    </p>
                    <p>
                      Measured burn:{" "}
                      {window.ratePointsPerHour === null
                        ? "Not enough data"
                        : `${number(window.ratePointsPerHour)} allowance points / hour`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {window.samples} samples ·{" "}
                      {evidence.ageMinutes === null
                        ? "Age unknown"
                        : `${number(evidence.ageMinutes)} minutes old`}{" "}
                      · {evidence.confidence === "medium" ? "Medium" : "Low"} confidence · Read{" "}
                      {time(window.checkedAt)}
                    </p>
                  </div>
                );
              })}
              <details>
                <summary className="cursor-pointer text-sm">Model and effort burn evidence</summary>
                <p className="my-2 text-xs text-muted-foreground">
                  No attributable model quota rate is available from the current measurements. Token
                  throughput below is a separate observed metric, never allowance points. The weekly
                  planning fallback is {number(policy.coldLongPointsPerHour)} points/hour per
                  account.
                </p>
                <ul className="grid min-w-0 gap-2">
                  {allocationModelRows(account).map((row) => (
                    <li
                      key={`${row.model}:${row.effort}:${row.contextBand}`}
                      className="min-w-0 rounded border p-2 text-sm"
                    >
                      <p>
                        {row.model} · {row.effort ?? "Effort unknown"} · {row.contextBand}
                      </p>
                      <p>Allowance points/hour: Not enough data · Low confidence</p>
                      <p className="text-xs text-muted-foreground">
                        {row.samples} token samples · Latest matching turn {time(row.observedAt)}
                        {row.outputTokensPerHour === null
                          ? ""
                          : ` · Median output ${number(row.outputTokensPerHour)} tokens / turn-hour`}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
