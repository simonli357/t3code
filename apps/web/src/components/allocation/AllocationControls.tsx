import { type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  PROVIDER_DISPLAY_NAMES,
  type AllocationAccountCap,
  type AllocationLearned,
  type AllocationPolicy,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import {
  allocationAccountOrder,
  allocationAccountRows,
  allocationReadingAge,
  allocationSupportsFiveHourCap,
  withAllocationAccountGoal,
  withAllocationAccountMoved,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const number = (value: number) =>
  Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "";
const time = (value: string) => new Date(value).toLocaleString();
const dollars = (value: number) =>
  `$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}`;

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

function AccountsTable({
  rows,
  policy,
  snapshot,
  now,
  disabled,
  onChange,
  onWorkersChange,
}: {
  rows: readonly AllocationAccountRow[];
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  now: number;
  disabled: boolean;
  onChange: (policy: AllocationPolicy) => void;
  onWorkersChange: (row: AllocationAccountRow, enabled: boolean) => void;
}) {
  const capsDisabled = disabled || snapshot?.accountCapsSupported !== true;
  // Coordinators from before runway allocation neither keep nor apply goals.
  const goalsDisabled = disabled || snapshot?.runways === undefined;
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
          <TableHead>Daily goal %</TableHead>
          <TableHead>Hard cap %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const fiveHour = allocationSupportsFiveHourCap(row.driver);
          const capEnabled =
            row.cap !== undefined &&
            (row.cap.weeklyPercent !== null || (fiveHour && row.cap.fiveHourPercent !== null));
          return (
            <TableRow key={row.key}>
              <TableCell>
                <div className="font-medium">{row.label}</div>
                <div className="text-muted-foreground">
                  {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
                  {row.plan && ` ${row.plan}`} · {row.hosts.join(", ")}
                </div>
                {row.login === null && (
                  <div className="text-muted-foreground">login unknown; matched by label</div>
                )}
              </TableCell>
              <TableCell>
                {row.windows.map((window) => {
                  const runway = row.runway?.windows.find((w) => w.id === window.id);
                  return (
                    <div key={window.id}>
                      {window.label} {number(window.usedPercent)}%
                      <span className="text-muted-foreground">
                        {" · "}
                        {window.resetsAt === null
                          ? "reset unknown"
                          : Date.parse(window.resetsAt) <= now
                            ? "reset"
                            : `resets ${time(window.resetsAt)}`}
                        {` · read ${window.age} ago`}
                        {now - Date.parse(window.checkedAt) > policy.maxReadingAgeMinutes * 60_000
                          ? ", stale"
                          : ""}
                        {runway?.sizeDollars != null &&
                          ` · holds about ${dollars(runway.sizeDollars)}${
                            runway.source === "estimated" ? " (estimated)" : ""
                          }`}
                        {runway?.goalPercent != null &&
                          ` · goal ${Math.round(runway.goalPercent)}% by now`}
                      </span>
                    </div>
                  );
                })}
                {row.runway && row.windows.length > 0 && (
                  <div className="text-muted-foreground">{row.runway.line}</div>
                )}
                {!row.windows.length && (
                  <div className="text-muted-foreground">
                    {row.capSource === "unsupported"
                      ? "No subscription quota"
                      : row.capSource === "probeFailed"
                        ? "Quota read failed"
                        : row.capSource === "unverified"
                          ? "Quota unverified"
                          : "No reading"}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Switch
                    size="sm"
                    aria-label={`${row.name} workers allowed`}
                    checked={row.workersEnabled}
                    disabled={disabled}
                    onCheckedChange={(enabled) => onWorkersChange(row, enabled)}
                  />
                  {row.workers} now
                </div>
                {row.workersEnabled && row.workersOffOn.length > 0 && (
                  <div className="text-muted-foreground">off on {row.workersOffOn.join(", ")}</div>
                )}
              </TableCell>
              <TableCell>
                <NumberField
                  name={`${row.name} daily goal`}
                  className="w-16"
                  value={row.goal?.own ? row.goal.percentPerDay : undefined}
                  min={0}
                  max={100}
                  step={0.5}
                  placeholder={row.goal ? number(row.goal.percentPerDay) : "Off"}
                  disabled={goalsDisabled}
                  onChange={(value) => onChange(withAllocationAccountGoal(policy, row, value))}
                />
                {row.goal && !row.goal.own && (
                  <div className="text-muted-foreground">provider default</div>
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
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** What T3 learned from every computer's history. Nobody edits these. */
function LearnedNumbers({ learned, now }: { learned: AllocationLearned; now: number }) {
  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-sm text-muted-foreground">
        Learned {allocationReadingAge(learned.learnedAt, now)} ago from every computer&apos;s turns
        and limit readings. Measured numbers come from this history; estimated ones are scaled from
        a measured model or account until their own history is enough.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>Per working hour</TableHead>
            <TableHead>Turns</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {learned.costs.map((cost) => (
            <TableRow key={`${cost.driver}:${cost.model}:${cost.effort}:${cost.kind}`}>
              <TableCell>
                {cost.model} / {cost.effort ?? "default"}
              </TableCell>
              <TableCell>{cost.kind}</TableCell>
              <TableCell>
                {dollars(cost.dollarsPerHour)} at {Math.round(cost.contextTokens / 1000)}k context
                {cost.perHundredK > 0 && (
                  <div className="text-muted-foreground">
                    +{dollars(cost.perHundredK)} per 100k more
                  </div>
                )}
              </TableCell>
              <TableCell>
                {cost.samples} over {number(cost.hours)} h
              </TableCell>
              <TableCell>
                {cost.measuredShare === undefined ? cost.source : "thin"}
                {cost.basis && <div className="text-muted-foreground">{cost.basis}</div>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Account</TableHead>
            <TableHead>Limit</TableHead>
            <TableHead>Holds</TableHead>
            <TableHead>Outside use</TableHead>
            <TableHead>Reading pairs</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {learned.limits.map((limit) => (
            <TableRow key={`${limit.key}:${limit.windowId}`}>
              <TableCell>
                {limit.label}
                {limit.plan && <div className="text-muted-foreground">{limit.plan}</div>}
              </TableCell>
              <TableCell>{limit.windowLabel}</TableCell>
              <TableCell>about {dollars(100 / limit.percentPerDollar)}</TableCell>
              <TableCell>{number(limit.backgroundPercentPerHour)}% an hour</TableCell>
              <TableCell>
                {limit.samples} over {number(limit.hours)} h
              </TableCell>
              <TableCell>
                {limit.source}
                {limit.basis && <div className="text-muted-foreground">{limit.basis}</div>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {learned.notes.map((note) => (
        <p key={note} className="text-sm text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

export function AllocationControls({
  policy,
  snapshot,
  now,
  disabled,
  onChange,
  onWorkersChange,
}: {
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  /** When the snapshot was read: reading ages and resets are judged against it. */
  now: number;
  disabled: boolean;
  onChange: (policy: AllocationPolicy) => void;
  /** Turns workers on or off for this account on every computer that has it. */
  onWorkersChange: (row: AllocationAccountRow, enabled: boolean) => void;
}) {
  const rows = allocationAccountRows(snapshot, policy, now);
  const usable = rows.filter((row) => !row.other);
  const others = rows.filter((row) => row.other);
  const ordered = allocationAccountOrder(usable, policy);
  const orderDisabled = disabled || snapshot?.accountOrderSupported !== true;
  const table = (accounts: readonly AllocationAccountRow[]) => (
    <AccountsTable
      rows={accounts}
      policy={policy}
      snapshot={snapshot}
      now={now}
      disabled={disabled}
      onChange={onChange}
      onWorkersChange={onWorkersChange}
    />
  );
  return (
    <>
      <section aria-label="Accounts" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Accounts</h2>
        <p className="text-sm text-muted-foreground">
          A daily goal is the share of the weekly limit an account should use each day; blank uses
          the provider&apos;s default. It only changes which account is recommended: accounts on
          pace come first. It never stops, queues or changes a start, and a pinned account over its
          goal starts normally. Only a hard cap or a real limit stops work.
        </p>
        {snapshot && snapshot.accountCapsSupported !== true && (
          <p className="text-sm">
            Update the coordinator to edit hard caps. Existing saved caps remain enforced.
          </p>
        )}
        {rows.length ? (
          table(usable)
        ) : (
          <p className="text-sm">Accounts appear when account information is available.</p>
        )}
        {others.length > 0 && (
          <details className="min-w-0 rounded-lg border p-3">
            <summary className="cursor-pointer font-medium">
              Other accounts ({others.length})
            </summary>
            <p className="my-2 text-sm text-muted-foreground">
              Provider turned off, or no subscription quota reading and no cap saved.
            </p>
            {table(others)}
          </details>
        )}
      </section>
      <section aria-label="Preference order" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Preference order</h2>
        <p className="text-sm text-muted-foreground">
          Among accounts that fit the job and keep within their daily goal, the one with the most
          room until its reset wins. Between accounts that are close, the one higher in this list
          wins.
        </p>
        {snapshot && snapshot.accountOrderSupported !== true && (
          <p className="text-sm">
            Update the coordinator before the order, margin and long wait can be saved.
          </p>
        )}
        <ol className="grid min-w-0 gap-1">
          {ordered.map((row, index) => (
            <li key={row.key} className="flex min-w-0 items-center gap-2 text-sm">
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={`Move ${row.name} up`}
                disabled={orderDisabled || index === 0}
                onClick={() => onChange(withAllocationAccountMoved(policy, usable, row.key, -1))}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={`Move ${row.name} down`}
                disabled={orderDisabled || index === ordered.length - 1}
                onClick={() => onChange(withAllocationAccountMoved(policy, usable, row.key, 1))}
              >
                <ChevronDownIcon />
              </Button>
              <span>
                {index + 1}. {row.name}
              </span>
              <span className="text-muted-foreground">
                {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
              </span>
            </li>
          ))}
        </ol>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid min-w-0 content-start gap-1">
            <NumberField
              name="Closeness margin"
              caption="Closeness margin (%)"
              value={policy.closeMarginPoints ?? DEFAULT_CLOSE_MARGIN_POINTS}
              required
              min={0}
              max={50}
              disabled={orderDisabled}
              onChange={(value = Number.NaN) => onChange({ ...policy, closeMarginPoints: value })}
            />
            <span className="text-xs text-muted-foreground">
              Accounts with at least this much less room than the best account, in percent of its
              room, are not close.
            </span>
          </div>
          <div className="grid min-w-0 content-start gap-1">
            <NumberField
              name="Long wait"
              caption="Long wait (hours)"
              value={policy.longWaitHours ?? DEFAULT_LONG_WAIT_HOURS}
              required
              min={0}
              max={168}
              step={0.5}
              disabled={orderDisabled}
              onChange={(value = Number.NaN) => onChange({ ...policy, longWaitHours: value })}
            />
            <span className="text-xs text-muted-foreground">
              A running worker that hits a limit waits for a reset this near; later than this, it
              moves to the closest model.
            </span>
          </div>
          <div className="grid min-w-0 content-start gap-1">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                size="sm"
                checked={policy.fableWorkers !== false}
                disabled={disabled || snapshot?.runways === undefined}
                onCheckedChange={(fableWorkers) => onChange({ ...policy, fableWorkers })}
              />
              Fable workers
            </label>
            <span className="text-xs text-muted-foreground">
              Off: no worker runs on Fable. A table cell or pin that names Fable starts from the
              nearest rung without it, and a running worker never moves onto it.
            </span>
          </div>
        </div>
      </section>
      <section aria-label="Learned numbers" className="grid min-w-0 gap-3">
        <h2 className="font-semibold">Learned numbers</h2>
        {snapshot?.learned ? (
          <LearnedNumbers learned={snapshot.learned} now={now} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {snapshot && snapshot.runways === undefined
              ? "Update the coordinator to learn costs and limit sizes."
              : "Nothing learned yet: choices use starting estimates until turns and limit readings are recorded."}
          </p>
        )}
      </section>
    </>
  );
}
