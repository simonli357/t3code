import { type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import {
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  DEFAULT_MEMORY_KILL_HOLD_MINUTES,
  DEFAULT_SESSION_RESERVE_GIB,
  MAX_MEMORY_KILL_HOLD_MINUTES,
  DEFAULT_MIN_FREE_MEMORY_GIB,
  DEFAULT_START_SETTLE_MINUTES,
  DEFAULT_WORKER_MEMORY_GIB,
  MAX_START_SETTLE_MINUTES,
  PROVIDER_DISPLAY_NAMES,
  type AllocationAccountCap,
  type AllocationLearned,
  type AllocationPolicy,
  type AllocationSnapshot,
} from "@t3tools/contracts";
import {
  allocationAccountCap,
  allocationAccountOrder,
  allocationAccountRows,
  allocationReadingAge,
  allocationSupportsFiveHourCap,
  withAllocationAccountFableGoal,
  withAllocationAccountFableMode,
  withAllocationAccountGoal,
  withAllocationAccountMoved,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { cn } from "~/lib/utils";
import { FoldedSettingsSection } from "../settings/FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME } from "../settings/itemRows";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { HINT_MARK, Hinted } from "./Hinted";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** How long typing may pause before a number that only ranks accounts is stored. */
const TYPING_PAUSE = 1000;
export type AllocationEdit = (
  update: (policy: AllocationPolicy) => AllocationPolicy,
  /** Milliseconds to wait before storing; null waits until the field is left. */
  pause?: number | null,
) => void;

const number = (value: number) =>
  Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "";
const dollars = (value: number) =>
  `$${value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2)}`;
/** One row of columns for the heading and every account, once the list is wide enough. */
const columns =
  "@min-[64rem]/accounts:grid @min-[64rem]/accounts:grid-cols-[4.5rem_minmax(7rem,1fr)_minmax(14.5rem,2fr)_6rem_4.5rem_4.5rem_4.5rem_11rem] @min-[64rem]/accounts:gap-x-3";
/** A control's name, where the heading row is not shown. */
const caption = "text-xs text-muted-foreground @min-[64rem]/accounts:hidden";
const divided = "[&>*+*]:border-t [&>*+*]:border-border/50";
const unsaved = <p className="text-xs text-destructive">Not saved</p>;
/** What a name does not say by itself, shown on hover. */
const HINTS = {
  order: "Between accounts similarly behind their goal, the higher one is used.",
  fable: "Workers on this account run on Fable only.",
  goal: "Share of the weekly limit to use each day. It only ranks accounts.",
  fableGoal:
    "Share of the Fable weekly limit to use each day. Behind it, workers here run on Fable.",
  cap: "Usage where the account takes no more work.",
};

/** Blank is `undefined`: unset for an optional value, invalid for a required one. */
function NumberField({
  name,
  unit,
  value,
  required = false,
  min,
  max,
  step = 1,
  placeholder,
  disabled,
  onChange,
  onCommit,
}: {
  /** What assistive technology reads. */
  name: string;
  unit?: string;
  value: number | undefined;
  required?: boolean;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
  /** The field was left or Enter was pressed: store what it holds now. */
  onCommit: () => void;
}) {
  const blank = value === undefined || !Number.isFinite(value);
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="w-14">
        <Input
          type="number"
          size="compact"
          aria-label={name}
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
            onChange(
              event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber,
            )
          }
          onBlur={onCommit}
          onKeyDown={(event) => event.key === "Enter" && onCommit()}
        />
      </span>
      {unit}
    </span>
  );
}

/** One limit's use as a bar: muted when the reading is old, warning at its cap or nearly full. */
function UsageMeter(props: { name: string; used: number; stale: boolean; full: boolean }) {
  return (
    <span
      role="meter"
      aria-label={props.name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.used)}
      className="block h-1.5 min-w-6 overflow-hidden rounded-full bg-muted"
    >
      <span
        className={cn(
          "block h-full rounded-full",
          props.stale ? "bg-muted-foreground/50" : props.full ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${Math.min(100, props.used)}%`, minWidth: props.used > 0 ? 2 : 0 }}
      />
    </span>
  );
}

function AccountRow({
  row,
  place,
  snapshot,
  disabled,
  notSaved,
  workersNotSaved,
  onEdit,
  onFlush,
  onWorkersChange,
}: {
  row: AllocationAccountRow;
  /** Where the account stands in the preference order; absent for accounts that take no order. */
  place?: { index: number; count: number; move: (delta: -1 | 1) => void };
  snapshot: AllocationSnapshot | null;
  disabled: boolean;
  notSaved: ReadonlySet<string>;
  workersNotSaved: ReadonlySet<string>;
  onEdit: AllocationEdit;
  onFlush: () => void;
  onWorkersChange: (row: AllocationAccountRow, enabled: boolean) => void;
}) {
  const capsDisabled = disabled || snapshot?.accountCapsSupported !== true;
  // A settings computer from before runway allocation neither keeps nor applies goals.
  const goalsDisabled = disabled || snapshot?.runways === undefined;
  const orderDisabled = disabled || snapshot?.accountOrderSupported !== true;
  const fiveHour = allocationSupportsFiveHourCap(row.driver);
  const capEnabled =
    row.cap !== undefined &&
    (row.cap.weeklyPercent !== null || (fiveHour && row.cap.fiveHourPercent !== null));
  const failed = (prefix: string) => row.keys.some((key) => notSaved.has(`${prefix}:${key}`));
  const setCap = (patch: Partial<Omit<AllocationAccountCap, "key">>, pause: number | null) =>
    onEdit((current) => {
      const next = {
        ...(row.keys.map((key) => allocationAccountCap(current, key)).find(Boolean) ?? {
          weeklyPercent: null,
          fiveHourPercent: null,
          stopWorkers: true,
          stopMasters: false,
        }),
        ...patch,
      };
      return {
        ...current,
        accountCaps: [
          ...(current.accountCaps ?? []).filter((cap) => !row.keys.includes(cap.key)),
          ...(next.weeklyPercent === null && next.fiveHourPercent === null
            ? []
            : row.keys.map((key) => ({ ...next, key }))),
        ],
      };
    }, pause);
  const about = `${PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}${row.plan ? ` ${row.plan}` : ""} · ${row.hosts.join(", ")}`;
  return (
    <li
      className={cn(
        ITEM_ROW_CLASSNAME,
        "flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 py-2",
        columns,
      )}
    >
      <div className="flex max-w-80 min-w-0 flex-1 basis-56 items-center gap-3 @min-[64rem]/accounts:contents">
        <div
          className={cn(
            "h-7 shrink-0 items-center gap-1",
            place ? "flex" : "hidden @min-[64rem]/accounts:block",
          )}
        >
          {place && (
            <>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={`Move ${row.name} up`}
                disabled={orderDisabled || place.index === 0}
                onClick={() => place.move(-1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={`Move ${row.name} down`}
                disabled={orderDisabled || place.index === place.count - 1}
                onClick={() => place.move(1)}
              >
                <ChevronDownIcon />
              </Button>
              <span className="w-4 text-center text-xs text-muted-foreground tabular-nums">
                {place.index + 1}
              </span>
            </>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{row.label}</div>
          <div className="text-xs text-muted-foreground">
            {about}
            {row.login === null && (
              <>
                {" · "}
                <Hinted hint="matched by its label">login unknown</Hinted>
              </>
            )}
          </div>
          {place && notSaved.has("accountOrder") && unsaved}
        </div>
      </div>
      <div className="grid min-w-0 flex-[2] basis-60 grid-cols-[minmax(0,5.5rem)_2.75rem_minmax(1.5rem,1fr)_auto] content-start items-center gap-x-2 gap-y-0.5 text-xs">
        {row.windows.map((window) => (
          <Hinted
            key={window.id}
            hint={window.detail}
            render={<div className="col-span-full grid grid-cols-subgrid items-center" />}
          >
            <span>{window.label}</span>
            <span className="text-right font-medium tabular-nums">
              {Math.round(window.usedPercent * 10) / 10}%
            </span>
            <UsageMeter
              name={`${row.name} ${window.label} used`}
              used={window.usedPercent}
              stale={window.stale}
              full={window.usedPercent >= (window.capPercent ?? 90)}
            />
            <span className="whitespace-nowrap text-muted-foreground tabular-nums">
              {window.resetIn ?? "no reset time"}
              {window.stale && <span className="text-warning-foreground"> · old</span>}
            </span>
          </Hinted>
        ))}
        {row.notice && (
          <p
            className={cn(
              "col-span-full",
              row.windows.length > 0 ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {row.notice}
          </p>
        )}
      </div>
      <div className="flex min-w-0 basis-full flex-wrap items-start gap-x-5 gap-y-2 @min-[64rem]/accounts:contents">
        <div className="grid min-w-0 content-start gap-0.5 text-xs">
          <label className="flex h-7 items-center gap-2">
            <span className={caption}>Workers</span>
            <Switch
              size="sm"
              aria-label={`${row.name} workers allowed`}
              checked={row.workersEnabled}
              disabled={disabled}
              onCheckedChange={(enabled) => onWorkersChange(row, enabled)}
            />
            {row.workers > 0 && (
              <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                {row.workers} running
              </span>
            )}
          </label>
          {row.workersEnabled && row.workersOffOn.length > 0 && (
            <div className="text-muted-foreground">off on {row.workersOffOn.join(", ")}</div>
          )}
          {workersNotSaved.has(row.key) && unsaved}
        </div>
        <div
          className={cn(
            "min-w-0 content-start gap-0.5 text-xs",
            row.fableMode === null ? "hidden @min-[64rem]/accounts:grid" : "grid",
          )}
        >
          {row.fableMode !== null && (
            <label className="flex h-7 items-center gap-2">
              <Hinted hint={HINTS.fable} render={<span className={cn(caption, HINT_MARK)} />}>
                Fable mode
              </Hinted>
              <Switch
                size="sm"
                aria-label={`${row.name} Fable mode`}
                checked={row.fableMode}
                disabled={goalsDisabled}
                onCheckedChange={(on) =>
                  onEdit((current) => withAllocationAccountFableMode(current, snapshot, row, on))
                }
              />
            </label>
          )}
          {row.fableMode !== null &&
            (notSaved.has("fableAccounts") || notSaved.has("fableOnly")) &&
            unsaved}
        </div>
        <div className="grid min-w-0 content-start gap-0.5">
          <div className="flex h-7 items-center gap-2">
            <Hinted hint={HINTS.goal} render={<span className={cn(caption, HINT_MARK)} />}>
              Daily goal
            </Hinted>
            <NumberField
              name={`${row.name} daily goal`}
              unit="%"
              value={row.goal?.own ? row.goal.percentPerDay : undefined}
              min={0}
              max={100}
              step={0.5}
              placeholder={row.goal ? number(row.goal.percentPerDay) : "Off"}
              disabled={goalsDisabled}
              onChange={(value) =>
                onEdit((current) => withAllocationAccountGoal(current, row, value), TYPING_PAUSE)
              }
              onCommit={onFlush}
            />
          </div>
          {failed("goal") && unsaved}
        </div>
        <div
          className={cn(
            "min-w-0 content-start gap-0.5",
            row.fableMode === null ? "hidden @min-[64rem]/accounts:grid" : "grid",
          )}
        >
          {row.fableMode !== null && (
            <div className="flex h-7 items-center gap-2">
              <Hinted hint={HINTS.fableGoal} render={<span className={cn(caption, HINT_MARK)} />}>
                Fable goal
              </Hinted>
              <NumberField
                name={`${row.name} Fable goal`}
                unit="%"
                value={row.fableGoal}
                min={0}
                max={100}
                step={0.5}
                placeholder="Off"
                disabled={goalsDisabled}
                onChange={(value) =>
                  onEdit(
                    (current) => withAllocationAccountFableGoal(current, row, value),
                    TYPING_PAUSE,
                  )
                }
                onCommit={onFlush}
              />
            </div>
          )}
          {row.fableMode !== null && failed("fableGoal") && unsaved}
        </div>
        <div className="grid min-w-0 content-start gap-0.5 text-xs">
          {row.supportsCaps ? (
            <>
              {/* A cap can stop running work, so a half-typed one is never stored. */}
              <div className="flex h-7 items-center gap-2 text-muted-foreground">
                <Hinted hint={HINTS.cap} render={<span className={cn(caption, HINT_MARK)} />}>
                  Hard cap
                </Hinted>
                <label className="flex items-center gap-1">
                  Wk
                  <NumberField
                    name={`${row.name} weekly cap`}
                    value={row.cap?.weeklyPercent ?? undefined}
                    min={0}
                    max={100}
                    step={0.1}
                    placeholder="Off"
                    disabled={capsDisabled}
                    onChange={(value) => setCap({ weeklyPercent: value ?? null }, null)}
                    onCommit={onFlush}
                  />
                </label>
                {fiveHour && (
                  <label className="flex items-center gap-1">
                    5h
                    <NumberField
                      name={`${row.name} 5-hour cap`}
                      value={row.cap?.fiveHourPercent ?? undefined}
                      min={0}
                      max={100}
                      step={0.1}
                      placeholder="Off"
                      disabled={capsDisabled}
                      onChange={(value) => setCap({ fiveHourPercent: value ?? null }, null)}
                      onCommit={onFlush}
                    />
                  </label>
                )}
              </div>
              {capEnabled && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">stops</span>
                  {(
                    [
                      { key: "stopWorkers", who: "workers" },
                      { key: "stopMasters", who: "masters" },
                    ] as const
                  ).map(({ key, who }) => (
                    <label key={key} className="flex items-center gap-1.5">
                      <Checkbox
                        aria-label={`${row.name} cap stops ${who}`}
                        checked={row.cap?.[key] ?? false}
                        disabled={capsDisabled}
                        onCheckedChange={(checked) =>
                          setCap(
                            key === "stopWorkers"
                              ? { stopWorkers: checked }
                              : { stopMasters: checked },
                            0,
                          )
                        }
                      />
                      {who}
                    </label>
                  ))}
                </div>
              )}
              {capEnabled && !row.cap?.stopWorkers && !row.cap?.stopMasters && (
                <div className="text-warning-foreground">stops nobody</div>
              )}
              {failed("cap") && unsaved}
            </>
          ) : (
            <span className="flex h-7 items-center text-muted-foreground">no cap</span>
          )}
        </div>
      </div>
    </li>
  );
}

/** The five numbers behind which linked computer a new worker starts on. */
const COMPUTER_RULES = [
  {
    value: "workerMemoryGiB",
    title: "Worker memory",
    hint: "expected for each worker",
    detail:
      "What a worker is expected to need once it builds or runs. A worker that just started counts this much against its computer.",
    unit: "GiB",
    initial: DEFAULT_WORKER_MEMORY_GIB,
    max: 256,
    step: 0.5,
  },
  {
    value: "startSettleMinutes",
    title: "Start settle time",
    hint: "how long a start counts as new",
    detail: "How long a worker that just started counts as not showing its memory yet.",
    unit: "minutes",
    initial: DEFAULT_START_SETTLE_MINUTES,
    max: MAX_START_SETTLE_MINUTES,
    step: 1,
  },
  {
    value: "sessionReserveGiB",
    title: "Session reserve",
    hint: "kept back per working session",
    detail: "Memory kept back for each session already working on a computer.",
    unit: "GiB",
    initial: DEFAULT_SESSION_RESERVE_GIB,
    max: 16,
    step: 0.05,
  },
  {
    value: "minFreeMemoryGiB",
    title: "Minimum free memory",
    hint: "below this, a computer comes last",
    detail:
      "A computer with less room than this gets a new worker only when every computer has less.",
    unit: "GiB",
    initial: DEFAULT_MIN_FREE_MEMORY_GIB,
    max: 256,
    step: 0.5,
  },
  {
    value: "memoryKillHoldMinutes",
    title: "Memory kill hold",
    hint: "comes last after a memory kill",
    detail:
      "After the system stops a session for lack of memory, that computer gets a new worker only when every other one is in the same state, for this long.",
    unit: "minutes",
    initial: DEFAULT_MEMORY_KILL_HOLD_MINUTES,
    max: MAX_MEMORY_KILL_HOLD_MINUTES,
    step: 1,
  },
] as const;

/** One stored value on one line: its name, a few words where the name is not enough, its control. */
function Rule(props: {
  title: string;
  hint: string;
  /** The whole explanation, on hover. */
  detail: string;
  failed: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(ITEM_ROW_CLASSNAME, "flex min-w-0 items-center justify-between gap-3 py-2")}>
      <div className="min-w-0">
        <Hinted
          hint={props.detail}
          render={<div className="flex min-w-0 flex-wrap items-baseline gap-x-2" />}
        >
          <h3 className="text-sm font-medium">{props.title}</h3>
          <span className="text-xs text-muted-foreground">{props.hint}</span>
        </Hinted>
        {props.failed && unsaved}
      </div>
      <div className="flex shrink-0 items-center">{props.children}</div>
    </div>
  );
}

/** One learned number: its name, then what was measured, side by side where there is room. */
const learnedRow =
  "grid grid-cols-1 gap-x-4 gap-y-0.5 px-3 py-1.5 sm:px-4 @min-[40rem]/learned:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]";

/** What T3 learned from every computer's history. Nobody edits these. */
function LearnedNumbers({ learned }: { learned: AllocationLearned }) {
  return (
    <div className={cn("@container/learned min-w-0 text-xs", divided)}>
      {learned.costs.map((cost) => (
        <div
          key={`${cost.driver}:${cost.model}:${cost.effort}:${cost.kind}`}
          className={learnedRow}
        >
          <span className="font-medium">
            {cost.model} / {cost.effort ?? "default"} · {cost.kind}
          </span>
          <span>
            {dollars(cost.dollarsPerHour)} an hour at {Math.round(cost.contextTokens / 1000)}k
            context
            {cost.perHundredK > 0 && `, +${dollars(cost.perHundredK)} per 100k more`}
          </span>
          <span>
            {cost.samples} {cost.samples === 1 ? "turn" : "turns"} over {number(cost.hours)} h
          </span>
          <span className="text-muted-foreground">
            {cost.measuredShare === undefined ? cost.source : "thin"}
            {cost.basis && ` · ${cost.basis}`}
          </span>
        </div>
      ))}
      {learned.limits.map((limit) => (
        <div key={`${limit.key}:${limit.windowId}`} className={learnedRow}>
          <span className="font-medium">
            {limit.label}
            {limit.plan && ` ${limit.plan}`} · {limit.windowLabel}
          </span>
          <span>
            holds about {dollars(100 / limit.percentPerDollar)}, outside use{" "}
            {number(limit.backgroundPercentPerHour)}% an hour
          </span>
          <span>
            {limit.samples} reading {limit.samples === 1 ? "pair" : "pairs"} over{" "}
            {number(limit.hours)} h
          </span>
          <span className="text-muted-foreground">
            {limit.source}
            {limit.basis && ` · ${limit.basis}`}
          </span>
        </div>
      ))}
      {learned.notes.map((note) => (
        <p key={note} className="px-3 py-1.5 text-muted-foreground sm:px-4">
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
  accounts,
  disabled,
  notSaved,
  workersNotSaved,
  status,
  onEdit,
  onFlush,
  onWorkersChange,
}: {
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  /** When the snapshot was read: reading ages and resets are judged against it. */
  now: number;
  /** Whether what every computer reports has arrived; the saved settings show before it. */
  accounts: "loading" | "loaded" | "failed" | "offline";
  disabled: boolean;
  /** Values shown but not stored after a failed save, as `allocationPolicyChanges` names them. */
  notSaved: ReadonlySet<string>;
  /** Accounts, by row key, whose workers switch could not be stored. */
  workersNotSaved: ReadonlySet<string>;
  /** The save state and Refresh, beside the Accounts heading. */
  status: ReactNode;
  onEdit: AllocationEdit;
  /** A field was left: store what is waiting. */
  onFlush: () => void;
  /** Turns workers on or off for this account on every computer that has it. */
  onWorkersChange: (row: AllocationAccountRow, enabled: boolean) => void;
}) {
  const rows = allocationAccountRows(snapshot, policy, now);
  const usable = rows.filter((row) => !row.other);
  const others = rows.filter((row) => row.other);
  const ordered = allocationAccountOrder(usable, policy);
  const rulesDisabled = disabled || snapshot?.accountOrderSupported !== true;
  // Every computer that answered sends the same standing notes on how limits are read; what
  // is worth a line here is what could not be read.
  const standing = new Set(
    snapshot?.inventories.flatMap((inventory) => (inventory.complete ? inventory.notices : [])),
  );
  const unread = [...new Set(snapshot?.notices)].filter((note) => !standing.has(note));
  const outdated = [
    ...(snapshot && snapshot.accountCapsSupported !== true ? ["caps"] : []),
    ...(snapshot && snapshot.accountOrderSupported !== true ? ["the order and rules"] : []),
  ];
  const account = (row: AllocationAccountRow, index?: number) => (
    <AccountRow
      key={row.key}
      row={row}
      {...(index === undefined
        ? {}
        : {
            place: {
              index,
              count: ordered.length,
              move: (delta: -1 | 1) =>
                onEdit((current) => withAllocationAccountMoved(current, usable, row.key, delta)),
            },
          })}
      snapshot={snapshot}
      disabled={disabled}
      notSaved={notSaved}
      workersNotSaved={workersNotSaved}
      onEdit={onEdit}
      onFlush={onFlush}
      onWorkersChange={onWorkersChange}
    />
  );
  const numberRule = (rule: (typeof COMPUTER_RULES)[number]) => (
    <Rule
      key={rule.value}
      title={rule.title}
      hint={rule.hint}
      detail={rule.detail}
      failed={notSaved.has(rule.value)}
    >
      <NumberField
        name={rule.title}
        unit={rule.unit}
        value={policy[rule.value] ?? rule.initial}
        required
        min={0}
        max={rule.max}
        step={rule.step}
        disabled={rulesDisabled}
        onChange={(value = Number.NaN) =>
          onEdit((current) => ({ ...current, [rule.value]: value }), TYPING_PAUSE)
        }
        onCommit={onFlush}
      />
    </Rule>
  );
  // A settings computer that has measured nothing yet still sends its learned numbers, empty.
  const learned =
    snapshot?.learned &&
    snapshot.learned.costs.length + snapshot.learned.limits.length + snapshot.learned.notes.length >
      0
      ? snapshot.learned
      : null;
  return (
    <>
      <div className="@container/accounts grid min-w-0 grid-cols-1 gap-2.5">
        <SettingsSection title="Accounts" headerAction={status}>
          <div
            aria-hidden
            className={cn("hidden px-3 py-1.5 text-xs text-muted-foreground sm:px-4", columns)}
          >
            {(
              [
                ["Order", HINTS.order],
                ["Account"],
                ["Usage"],
                ["Workers"],
                ["Fable mode", HINTS.fable],
                ["Daily goal", HINTS.goal],
                ["Fable goal", HINTS.fableGoal],
                ["Hard cap", HINTS.cap],
              ] as const
            ).map(([name, hint]) => (
              <span key={name}>{hint ? <Hinted hint={hint}>{name}</Hinted> : name}</span>
            ))}
          </div>
          {ordered.length > 0 ? (
            <ul aria-label="Accounts, most preferred first" className={divided}>
              {ordered.map(account)}
            </ul>
          ) : (
            <p className={cn(ITEM_ROW_CLASSNAME, "text-sm text-muted-foreground")}>
              {accounts === "loading"
                ? "Loading accounts…"
                : accounts === "failed"
                  ? "Accounts could not be read."
                  : accounts === "offline"
                    ? "Not connected."
                    : "No accounts reported."}
            </p>
          )}
        </SettingsSection>
        {(outdated.length > 0 || unread.length > 0) && (
          <div className="grid gap-1 px-3 text-xs text-warning-foreground sm:px-4">
            {outdated.length > 0 && (
              <p>
                The computer that keeps these settings needs an update before {outdated.join(", ")}{" "}
                can be edited.
              </p>
            )}
            {unread.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
        {others.length > 0 && (
          <FoldedSettingsSection
            id="allocation-other-accounts"
            title={`Other accounts (${others.length})`}
          >
            <ul aria-label="Other accounts" className={divided}>
              {others.map((row) => account(row))}
            </ul>
          </FoldedSettingsSection>
        )}
      </div>
      <SettingsSection title="Rules">
        <Rule
          title="Close-call margin"
          hint="accounts this close count as equal"
          detail="Between accounts this close on the same side of their goal, the order decides."
          failed={notSaved.has("closeMarginPoints")}
        >
          <NumberField
            name="Close-call margin"
            unit="points"
            value={policy.closeMarginPoints ?? DEFAULT_CLOSE_MARGIN_POINTS}
            required
            min={0}
            max={50}
            disabled={rulesDisabled}
            onChange={(value = Number.NaN) =>
              onEdit((current) => ({ ...current, closeMarginPoints: value }), TYPING_PAUSE)
            }
            onCommit={onFlush}
          />
        </Rule>
        <Rule
          title="Wait for a reset"
          hint="longer, and the worker changes model"
          detail="A running worker that hits a limit waits this long for the reset. If the reset is further away, it moves to the closest model."
          failed={notSaved.has("longWaitHours")}
        >
          <NumberField
            name="Wait for a reset"
            unit="hours"
            value={policy.longWaitHours ?? DEFAULT_LONG_WAIT_HOURS}
            required
            min={0}
            max={168}
            step={0.5}
            disabled={rulesDisabled}
            onChange={(value = Number.NaN) =>
              onEdit((current) => ({ ...current, longWaitHours: value }), TYPING_PAUSE)
            }
            onCommit={onFlush}
          />
        </Rule>
        <Rule
          title="Fable workers"
          hint="off: no worker runs on Fable"
          detail="Off: no worker runs on Fable. One that would starts on the nearest other model."
          failed={notSaved.has("fableWorkers")}
        >
          <Switch
            aria-label="Fable workers"
            checked={policy.fableWorkers !== false}
            disabled={disabled || snapshot?.runways === undefined}
            onCheckedChange={(fableWorkers) => onEdit((current) => ({ ...current, fableWorkers }))}
          />
        </Rule>
        <Rule
          title="Keep Fable in step with weekly"
          hint="compare projected weekly usage"
          detail="Use Fable when its projected usage is at or below Weekly. When Fable is ahead, use the nearest non-Fable rung for a Fable table entry."
          failed={notSaved.has("fableInStep")}
        >
          <Switch
            aria-label="Keep Fable in step with weekly"
            checked={policy.fableInStep === true}
            disabled={disabled || snapshot?.runways === undefined}
            onCheckedChange={(fableInStep) => onEdit((current) => ({ ...current, fableInStep }))}
          />
        </Rule>
      </SettingsSection>
      <FoldedSettingsSection
        id="allocation-computer"
        title="Computer for a new worker"
        summary={`${number(policy.workerMemoryGiB ?? DEFAULT_WORKER_MEMORY_GIB)} GiB per worker`}
      >
        {COMPUTER_RULES.map(numberRule)}
      </FoldedSettingsSection>
      <FoldedSettingsSection
        id="allocation-learned"
        title="Learned numbers"
        summary={
          learned
            ? `measured ${allocationReadingAge(learned.learnedAt, now)} ago`
            : "nothing measured yet"
        }
      >
        {learned ? (
          <LearnedNumbers learned={learned} />
        ) : (
          <p className={cn(ITEM_ROW_CLASSNAME, "text-sm text-muted-foreground")}>
            Nothing measured yet.
          </p>
        )}
      </FoldedSettingsSection>
    </>
  );
}
