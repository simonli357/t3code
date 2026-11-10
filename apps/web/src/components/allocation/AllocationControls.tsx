import { useId, type ReactNode } from "react";
import {
  allocationWorkerModel,
  defaultAllocationPolicy,
  PROVIDER_DISPLAY_NAMES,
  type AllocationAccountCap,
  type AllocationAccountRule,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationWorkerModel,
} from "@t3tools/contracts";
import {
  allocationAccountRows,
  allocationCurveFields,
  allocationCurveValue,
  allocationEstimateFields,
  allocationAccountGroups,
  allocationFamilies,
  allocationModelRows,
  allocationRateEvidence,
  allocationReadingAge,
  allocationSupportsFiveHourCap,
  allocationWorkerModelChoices,
  withAllocationTarget,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

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

const select =
  "block h-7 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs disabled:opacity-60";
const localTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : "";
};

/** A compact field. Its name is what assistive technology reads; the caption is what shows. */
function Field({
  name,
  caption,
  className,
  children,
}: {
  name: string;
  caption?: string;
  /** Layout only: the width of the field in its row. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`grid min-w-0 gap-0.5 ${className ?? ""}`}>
      {caption ? (
        <span className="text-xs font-normal text-muted-foreground">
          <span className="sr-only">{name}: </span>
          {caption}
        </span>
      ) : (
        <span className="sr-only">{name}</span>
      )}
      {children}
    </label>
  );
}

/** Blank is `undefined`: unset for an optional value, invalid for a required one. */
function NumberField({
  value,
  required = false,
  min,
  max,
  step = 1,
  placeholder,
  disabled,
  onChange,
  ...field
}: {
  name: string;
  caption?: string;
  className?: string;
  value: number | undefined;
  required?: boolean;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const blank = value === undefined || !Number.isFinite(value);
  return (
    <Field {...field}>
      <Input
        type="number"
        size="compact"
        min={min}
        max={max}
        step={step}
        value={blank ? "" : value}
        placeholder={placeholder}
        aria-invalid={
          (blank ? required || value !== undefined : value < min || value > max) || undefined
        }
        disabled={disabled}
        onChange={(event) =>
          onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)
        }
      />
    </Field>
  );
}

function TimeField({
  value,
  disabled,
  onChange,
  ...field
}: {
  name: string;
  caption?: string;
  className?: string;
  value: string | undefined;
  disabled: boolean;
  onChange: (iso: string | undefined) => void;
}) {
  return (
    <Field {...field}>
      <Input
        type="datetime-local"
        size="compact"
        value={value ? localTime(value) : ""}
        disabled={disabled}
        onChange={(event) => {
          const until = new Date(event.currentTarget.value);
          onChange(Number.isFinite(until.getTime()) ? until.toISOString() : undefined);
        }}
      />
    </Field>
  );
}

function NoteField({
  value,
  disabled,
  onChange,
  ...field
}: {
  name: string;
  caption?: string;
  className?: string;
  value: string | undefined;
  disabled: boolean;
  onChange: (note: string | undefined) => void;
}) {
  return (
    <Field {...field}>
      <Input
        size="compact"
        maxLength={200}
        placeholder="Note"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.currentTarget.value.trim() ? event.currentTarget.value : undefined)
        }
      />
    </Field>
  );
}

/** Short enough to sit on one line above a narrow field. */
const CURVE_CAPTIONS = {
  burstPoints: "Initial budget",
  dailyPoints: "Daily budget",
  burstHours: "Release time",
  reservePoints: "Reserve",
  borrowPoints: "Borrow warning",
};
const RULE_KINDS = [
  { kind: "exclude", label: "workers off" },
  { kind: "maxWorkers", label: "max workers" },
  { kind: "priority", label: "priority" },
] as const;
type RuleDraft = Omit<AllocationAccountRule, "key" | "kind">;
/** A field left out, not set to `undefined`, so the saved policy stays exact. */
const withField = <T extends object, K extends keyof T>(
  value: T,
  key: K,
  next: T[K] | undefined,
) => {
  const { [key]: _old, ...rest } = value;
  return (next === undefined ? rest : { ...rest, [key]: next }) as T;
};

function AccountsTable({
  rows,
  policy,
  snapshot,
  now,
  disabled,
  onChange,
}: {
  rows: readonly AllocationAccountRow[];
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  now: number;
  disabled: boolean;
  onChange: (policy: AllocationPolicy) => void;
}) {
  const rulesDisabled = disabled || snapshot?.accountRulesSupported !== true;
  const capsDisabled = disabled || snapshot?.accountCapsSupported !== true;
  const setRule = (
    row: AllocationAccountRow,
    kind: AllocationAccountRule["kind"],
    rule: RuleDraft | undefined,
  ) =>
    onChange({
      ...policy,
      accountRules: [
        ...(policy.accountRules ?? []).filter((r) => !row.keys.includes(r.key) || r.kind !== kind),
        ...(rule ? row.keys.map((key) => ({ ...rule, key, kind })) : []),
      ],
    });
  const setCap = (row: AllocationAccountRow, patch: Partial<Omit<AllocationAccountCap, "key">>) => {
    const next = {
      ...(row.cap ?? {
        weeklyPercent: null,
        fiveHourPercent: null,
        stopWorkers: true,
        stopMasters: false,
      }),
      ...patch,
    };
    onChange({
      ...policy,
      accountCaps: [
        ...(policy.accountCaps ?? []).filter((cap) => !row.keys.includes(cap.key)),
        ...(next.weeklyPercent === null && next.fiveHourPercent === null
          ? []
          : row.keys.map((key) => ({ ...next, key }))),
      ],
    });
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
          <TableHead>Usage now</TableHead>
          <TableHead>Workers</TableHead>
          <TableHead>Max workers</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead>Budget %</TableHead>
          <TableHead>Hard cap %</TableHead>
          <TableHead>Rule end and note</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const reading = row.usage.weekly ?? row.usage.short;
          const family = policy[row.family];
          const familyValue = (key: "burstPoints" | "dailyPoints") => {
            const value = allocationCurveValue(family, key);
            return value === null ? "auto" : number(value);
          };
          const fiveHour = allocationSupportsFiveHourCap(row.driver);
          const capEnabled =
            row.cap !== undefined &&
            (row.cap.weeklyPercent !== null || (fiveHour && row.cap.fiveHourPercent !== null));
          const setTarget = (patch: Parameters<typeof withAllocationTarget>[2]) =>
            onChange(withAllocationTarget(policy, row, patch, Date.now()));
          return (
            <TableRow key={row.key}>
              <TableCell>
                <div className="font-medium">{row.label}</div>
                <div className="text-muted-foreground">
                  {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver} · {row.hosts.join(", ")}
                </div>
                {row.login === null && (
                  <div className="text-muted-foreground">login unknown; matched by label</div>
                )}
              </TableCell>
              <TableCell>
                {[
                  { label: "Week", window: row.usage.weekly },
                  {
                    label: row.usage.short?.durationHours
                      ? `${number(row.usage.short.durationHours)}h`
                      : (row.usage.short?.label ?? ""),
                    window: row.usage.short,
                  },
                ].map(
                  ({ label, window }) =>
                    window && (
                      <div key={window.id}>
                        {label} {number(window.usedPoints)}%
                        {window.resetsAt && Date.parse(window.resetsAt) <= now ? " (reset)" : ""}
                      </div>
                    ),
                )}
                <div className="text-muted-foreground">
                  {reading
                    ? `${allocationReadingAge(reading.checkedAt, now)} ago${
                        now - Date.parse(reading.checkedAt) > policy.maxReadingAgeMinutes * 60_000
                          ? ", stale"
                          : ""
                      }`
                    : row.capSource === "unsupported"
                      ? "No subscription quota"
                      : row.capSource === "probeFailed"
                        ? "Quota read failed"
                        : row.capSource === "unverified"
                          ? "Quota unverified"
                          : "No reading"}
                </div>
              </TableCell>
              <TableCell>
                <Switch
                  size="sm"
                  aria-label={`${row.name} workers allowed`}
                  checked={row.rules.exclude === undefined}
                  disabled={rulesDisabled}
                  onCheckedChange={(allowed) => setRule(row, "exclude", allowed ? undefined : {})}
                />
                {row.workersOffOn.length > 0 && (
                  <div className="text-muted-foreground">off on {row.workersOffOn.join(", ")}</div>
                )}
              </TableCell>
              {(["maxWorkers", "priority"] as const).map((kind) => (
                <TableCell key={kind}>
                  <NumberField
                    name={`${row.name} ${kind === "maxWorkers" ? "max workers" : "priority"}`}
                    className="w-16"
                    value={row.rules[kind] && (row.rules[kind].value ?? Number.NaN)}
                    min={kind === "maxWorkers" ? 1 : -100}
                    max={100}
                    placeholder={kind === "maxWorkers" ? "Any" : "0"}
                    disabled={rulesDisabled}
                    onChange={(value) =>
                      setRule(
                        row,
                        kind,
                        value === undefined ? undefined : { ...row.rules[kind], value },
                      )
                    }
                  />
                </TableCell>
              ))}
              <TableCell>
                {row.targetWindows.length ? (
                  <div className="grid gap-1">
                    <div className="flex gap-1">
                      {(
                        [
                          { key: "burstPoints", caption: "Initial", name: "initial budget" },
                          { key: "dailyPoints", caption: "Daily", name: "daily budget" },
                        ] as const
                      ).map(({ key, caption, name }) => (
                        <NumberField
                          key={key}
                          name={`${row.name} ${name}`}
                          caption={caption}
                          className="w-16"
                          value={row.target?.curve?.[key]}
                          required={row.target !== undefined}
                          min={0}
                          max={100}
                          step={0.1}
                          placeholder={familyValue(key)}
                          disabled={disabled}
                          onChange={(value = Number.NaN) =>
                            setTarget(
                              key === "burstPoints"
                                ? { burstPoints: value }
                                : { dailyPoints: value },
                            )
                          }
                        />
                      ))}
                    </div>
                    {row.target ? (
                      <>
                        <TimeField
                          name={`${row.name} budget until`}
                          caption="Until"
                          className="w-44"
                          value={row.target.expiresAt}
                          disabled={disabled}
                          onChange={(expiresAt) => expiresAt && setTarget({ expiresAt })}
                        />
                        <div>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => setTarget(undefined)}
                          >
                            Use family default
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="text-muted-foreground">family default</div>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground">
                    {familyValue("burstPoints")} / {familyValue("dailyPoints")} family default
                  </div>
                )}
              </TableCell>
              <TableCell>
                {row.supportsCaps ? (
                  <div className="grid gap-1">
                    <div className="flex gap-1">
                      <NumberField
                        name={`${row.name} weekly cap`}
                        caption="Week"
                        className="w-16"
                        value={row.cap?.weeklyPercent ?? undefined}
                        min={0}
                        max={100}
                        step={0.1}
                        placeholder="Off"
                        disabled={capsDisabled}
                        onChange={(value) => setCap(row, { weeklyPercent: value ?? null })}
                      />
                      {fiveHour && (
                        <NumberField
                          name={`${row.name} 5-hour cap`}
                          caption="5h"
                          className="w-16"
                          value={row.cap?.fiveHourPercent ?? undefined}
                          min={0}
                          max={100}
                          step={0.1}
                          placeholder="Off"
                          disabled={capsDisabled}
                          onChange={(value) => setCap(row, { fiveHourPercent: value ?? null })}
                        />
                      )}
                    </div>
                    {capEnabled &&
                      (
                        [
                          { key: "stopWorkers", caption: "stops workers" },
                          { key: "stopMasters", caption: "stops masters" },
                        ] as const
                      ).map(({ key, caption }) => (
                        <div key={key} className="flex items-center gap-1.5">
                          <Checkbox
                            aria-label={`${row.name} cap ${caption}`}
                            checked={row.cap?.[key] ?? false}
                            disabled={capsDisabled}
                            onCheckedChange={(checked) =>
                              setCap(
                                row,
                                key === "stopWorkers"
                                  ? { stopWorkers: checked }
                                  : { stopMasters: checked },
                              )
                            }
                          />
                          {caption}
                        </div>
                      ))}
                    {capEnabled && !row.cap?.stopWorkers && !row.cap?.stopMasters && (
                      <div className="text-muted-foreground">stops nothing: inactive</div>
                    )}
                  </div>
                ) : (
                  <div className="text-muted-foreground">No quota reading</div>
                )}
              </TableCell>
              <TableCell>
                <div className="grid gap-1">
                  {RULE_KINDS.map(({ kind, label }) => {
                    const rule = row.rules[kind];
                    return (
                      rule && (
                        <div key={kind} className="flex items-end gap-1">
                          <TimeField
                            name={`${row.name} ${label} until`}
                            caption={`${label} until`}
                            className="w-44"
                            value={rule.expiresAt}
                            disabled={rulesDisabled}
                            onChange={(expiresAt) =>
                              setRule(row, kind, withField(rule, "expiresAt", expiresAt))
                            }
                          />
                          <NoteField
                            name={`${row.name} ${label} note`}
                            className="w-36"
                            value={rule.note}
                            disabled={rulesDisabled}
                            onChange={(note) => setRule(row, kind, withField(rule, "note", note))}
                          />
                        </div>
                      )
                    );
                  })}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function AllocationControls({
  policy,
  snapshot,
  now,
  disabled,
  onChange,
}: {
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  /** When the snapshot was read: reading ages and end times are judged against it. */
  now: number;
  disabled: boolean;
  onChange: (policy: AllocationPolicy) => void;
}) {
  type Family = "codex" | "claude" | "other";
  type CurveField = (typeof allocationCurveFields)[number];
  const setCurve = (family: Family, key: CurveField["key"], value: number) =>
    onChange({
      ...policy,
      [family]: {
        ...policy[family],
        ...(policy[family].preset === "aggressive17"
          ? { dailyPoints: 17, burstPoints: 0, burstHours: 0 }
          : {}),
        ...(policy[family].preset !== "sustainable" ? { preset: "custom" as const } : {}),
        [key]: value,
      },
    });
  const curveControl = (family: Family, title: string, item: CurveField) => (
    <NumericControl
      key={item.key}
      name={`${title} ${item.label}`}
      unit={item.unit}
      value={allocationCurveValue(policy[family], item.key) ?? policy[family][item.key]}
      defaultValue={defaultAllocationPolicy[family][item.key]}
      max={item.max}
      help={item.help}
      disabled={disabled}
      derived={allocationCurveValue(policy[family], item.key) === null}
      onChange={(value) => setCurve(family, item.key, value)}
    />
  );
  const rows = allocationAccountRows(snapshot, policy, now);
  const others = rows.filter((row) => row.other);
  const table = (accounts: readonly AllocationAccountRow[]) => (
    <AccountsTable
      rows={accounts}
      policy={policy}
      snapshot={snapshot}
      now={now}
      disabled={disabled}
      onChange={onChange}
    />
  );
  // An expired default no longer applies, so it shows as unset.
  const at = new Date(now).toISOString();
  const modelsDisabled = disabled || snapshot?.workerModelsSupported !== true;
  return (
    <>
      <section aria-label="Accounts" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Accounts</h2>
        <p className="text-sm text-muted-foreground">
          Every worker start obeys these on every computer; a blank budget follows the family
          default.
        </p>
        {snapshot && snapshot.accountRulesSupported !== true && (
          <p className="text-sm">Update the coordinator to edit account rules.</p>
        )}
        {snapshot && snapshot.accountCapsSupported !== true && (
          <p className="text-sm">
            Update the coordinator to edit hard caps. Existing saved caps remain enforced.
          </p>
        )}
        {rows.length ? (
          table(rows.filter((row) => !row.other))
        ) : (
          <p className="text-sm">Accounts appear when account information is available.</p>
        )}
        {others.length > 0 && (
          <details className="min-w-0 rounded-lg border p-3">
            <summary className="cursor-pointer font-medium">
              Other accounts ({others.length})
            </summary>
            <p className="my-2 text-sm text-muted-foreground">
              Provider turned off, or no subscription quota reading and nothing saved.
            </p>
            {table(others)}
          </details>
        )}
      </section>
      <section aria-label="Family defaults" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Family defaults</h2>
        <p className="text-sm text-muted-foreground">
          Budgets in percent of the weekly allowance, and the model of a worker that pins none.
        </p>
        {snapshot && snapshot.workerModelsSupported !== true && (
          <p className="text-sm">Update the coordinator to set a default worker model.</p>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          {allocationFamilies.map(({ family, driver, label }) => {
            const current = policy[family];
            const worker = allocationWorkerModel(policy, driver, at);
            const choices = allocationWorkerModelChoices(snapshot, driver);
            const efforts = choices.find((choice) => choice.model === worker?.model)?.efforts ?? [];
            const setWorker = (next: AllocationWorkerModel | undefined) =>
              onChange({
                ...policy,
                workerModels: withField(policy.workerModels ?? {}, family, next),
              });
            return (
              <fieldset key={family} className="grid min-w-0 gap-3 rounded-lg border p-3">
                <legend className="px-1 font-semibold">{label}</legend>
                <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
                  {allocationCurveFields
                    .filter((item) => item.key !== "burstHours")
                    .map((item) => {
                      const value = allocationCurveValue(current, item.key);
                      return (
                        <div key={item.key} className="grid min-w-0 content-start gap-0.5">
                          {value === null ? (
                            <Field
                              name={`${label} ${item.label}`}
                              caption={CURVE_CAPTIONS[item.key]}
                            >
                              <Input size="compact" readOnly disabled value="Derived" />
                            </Field>
                          ) : (
                            <NumberField
                              name={`${label} ${item.label}`}
                              caption={CURVE_CAPTIONS[item.key]}
                              value={value}
                              required
                              min={0}
                              max={item.max}
                              step={0.1}
                              disabled={disabled}
                              onChange={(next) => setCurve(family, item.key, next ?? Number.NaN)}
                            />
                          )}
                          <span className="text-xs text-muted-foreground">
                            default {number(defaultAllocationPolicy[family][item.key])}
                          </span>
                        </div>
                      );
                    })}
                </div>
                {current.preset === "sustainable" && (
                  <Button
                    size="sm-multiline"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      onChange({ ...policy, [family]: { ...current, preset: "custom" } })
                    }
                  >
                    Use saved numeric budgets for {label}
                  </Button>
                )}
                <div className="grid min-w-0 grid-cols-2 gap-3">
                  <Field name={`${label} default worker model`} caption="Worker model">
                    <select
                      className={select}
                      value={worker?.model ?? ""}
                      disabled={modelsDisabled}
                      onChange={(event) => {
                        const choice = choices.find((c) => c.model === event.currentTarget.value);
                        setWorker(
                          choice && {
                            ...worker,
                            model: choice.model,
                            effort:
                              [worker?.effort, "medium"].find(
                                (effort) => effort !== undefined && choice.efforts.includes(effort),
                              ) ?? choice.efforts[0]!,
                          },
                        );
                      }}
                    >
                      <option value="">Difficulty table</option>
                      {worker && !choices.some((choice) => choice.model === worker.model) && (
                        <option value={worker.model}>{worker.model} (not offered now)</option>
                      )}
                      {choices.map((choice) => (
                        <option key={choice.model}>{choice.model}</option>
                      ))}
                    </select>
                  </Field>
                  <Field name={`${label} default worker effort`} caption="Effort">
                    <select
                      className={select}
                      value={worker?.effort ?? ""}
                      disabled={modelsDisabled || !worker}
                      onChange={(event) =>
                        worker && setWorker({ ...worker, effort: event.currentTarget.value })
                      }
                    >
                      {!worker && <option value="">From the table</option>}
                      {worker && !efforts.includes(worker.effort) && (
                        <option>{worker.effort}</option>
                      )}
                      {efforts.map((effort) => (
                        <option key={effort}>{effort}</option>
                      ))}
                    </select>
                  </Field>
                  <TimeField
                    name={`${label} default worker model until`}
                    caption="Until"
                    value={worker?.expiresAt}
                    disabled={modelsDisabled || !worker}
                    onChange={(expiresAt) =>
                      worker && setWorker(withField(worker, "expiresAt", expiresAt))
                    }
                  />
                  <NoteField
                    name={`${label} default worker model note`}
                    caption="Note"
                    value={worker?.note}
                    disabled={modelsDisabled || !worker}
                    onChange={(note) => worker && setWorker(withField(worker, "note", note))}
                  />
                </div>
              </fieldset>
            );
          })}
        </div>
      </section>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">Advanced budgets and estimation</summary>
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          {allocationFamilies.map(({ family, label }) => (
            <fieldset key={family} className="grid min-w-0 gap-4 rounded border p-3">
              <legend>{label}</legend>
              {allocationCurveFields
                .filter((item) => item.key === "burstHours")
                .map((item) => curveControl(family, label, item))}
            </fieldset>
          ))}
          <fieldset className="min-w-0 rounded-lg border p-4">
            <legend className="px-1 font-semibold">Other providers</legend>
            <div className="grid min-w-0 gap-4">
              {allocationCurveFields.map((item) => curveControl("other", "Other providers", item))}
              {policy.other.preset === "sustainable" && (
                <Button
                  size="sm-multiline"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    onChange({ ...policy, other: { ...policy.other, preset: "custom" } })
                  }
                >
                  Use saved numeric budgets for Other providers
                </Button>
              )}
            </div>
          </fieldset>
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
          These estimates never prevent an explicit Start.
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
  const groups = allocationAccountGroups(snapshot);
  return (
    <section aria-label="Usage analytics" className="grid min-w-0 gap-3">
      <h2 className="font-semibold">Usage analytics</h2>
      <p className="text-sm text-muted-foreground">
        Allowance burn is measured per account, for accounts opted into usage measurements.
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
                  Token throughput, never allowance points; the weekly planning fallback is{" "}
                  {number(policy.coldLongPointsPerHour)} points/hour per account.
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
