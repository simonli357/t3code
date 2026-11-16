import { Fragment, type ReactNode } from "react";
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
  allocationAccountCap,
  allocationAccountOrder,
  allocationAccountRows,
  allocationReadingAge,
  allocationSupportsFiveHourCap,
  withAllocationAccountFableMode,
  withAllocationAccountGoal,
  withAllocationAccountMoved,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { cn } from "~/lib/utils";
import { FoldedSettingsSection } from "../settings/FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

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
/** "Sun 3:00 PM" within a week, else "Dec 10". */
function resetTime(resetsAt: string, now: number) {
  const at = new Date(resetsAt);
  return at.getTime() - now < 7 * 86_400_000
    ? at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/** One column layout for the heading row and every account, once the list is wide enough. */
const columns =
  "@min-[60rem]/accounts:grid @min-[60rem]/accounts:grid-cols-[4.75rem_minmax(7rem,1fr)_minmax(19rem,2.6fr)_8.5rem_5.5rem_9.5rem] @min-[60rem]/accounts:gap-x-4";
const caption = "text-xs text-muted-foreground @min-[60rem]/accounts:hidden";
const divided = "[&>*+*]:border-t [&>*+*]:border-border/50";
const unsaved = <p className="text-xs text-destructive">Not saved</p>;

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
      <span className="w-16">
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
      className="block h-1.5 min-w-10 overflow-hidden rounded-full bg-muted"
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
  policy,
  snapshot,
  now,
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
  policy: AllocationPolicy;
  snapshot: AllocationSnapshot | null;
  now: number;
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
  return (
    <li className={cn(ITEM_ROW_CLASSNAME, "grid min-w-0 gap-y-3", columns)}>
      <div className="flex min-w-0 items-start gap-3 @min-[60rem]/accounts:contents">
        <div
          className={cn(
            "shrink-0 content-start gap-1",
            place ? "grid" : "hidden @min-[60rem]/accounts:block",
          )}
        >
          {place && (
            <div className="flex items-center gap-1">
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
            </div>
          )}
          {place && notSaved.has("accountOrder") && unsaved}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium">{row.label}</div>
          <div className="text-xs text-muted-foreground">
            {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
            {row.plan && ` ${row.plan}`} · {row.hosts.join(", ")}
          </div>
          {row.login === null && (
            <div className="text-xs text-muted-foreground">login unknown; matched by label</div>
          )}
        </div>
      </div>
      <div className="grid min-w-0 content-start gap-1 text-xs">
        {row.windows.length > 0 && (
          <div className="grid grid-cols-[auto_auto_minmax(2.5rem,1fr)] items-center gap-x-3 gap-y-1 @min-[30rem]/accounts:grid-cols-[auto_auto_minmax(2.5rem,1fr)_auto]">
            {row.windows.map((window) => {
              const goal = row.runway?.windows.find((w) => w.id === window.id)?.goalPercent;
              const stale =
                now - Date.parse(window.checkedAt) > policy.maxReadingAgeMinutes * 60_000;
              const cap =
                window.models.length > 0
                  ? null
                  : window.kind === "weekly"
                    ? row.cap?.weeklyPercent
                    : window.kind === "session"
                      ? row.cap?.fiveHourPercent
                      : null;
              return (
                <Fragment key={window.id}>
                  <span>{window.label}</span>
                  <span className="tabular-nums">
                    <span className="font-medium">{number(window.usedPercent)}%</span>
                    {goal != null && (
                      <span className="text-muted-foreground"> / {Math.round(goal)}% goal</span>
                    )}
                  </span>
                  <UsageMeter
                    name={`${row.name} ${window.label} used`}
                    used={window.usedPercent}
                    stale={stale}
                    full={window.usedPercent >= (cap ?? 90)}
                  />
                  <span className="col-span-full text-muted-foreground @min-[30rem]/accounts:col-span-1">
                    {window.resetsAt === null
                      ? "reset unknown"
                      : Date.parse(window.resetsAt) <= now
                        ? "reset"
                        : `resets ${resetTime(window.resetsAt, now)}`}
                    {stale && (
                      <span className="text-warning-foreground"> · read {window.age} ago</span>
                    )}
                  </span>
                </Fragment>
              );
            })}
          </div>
        )}
        {row.runway && row.windows.length > 0 && (
          <div className="text-muted-foreground">{row.runway.line}</div>
        )}
        {!row.windows.length && (
          <div className="text-muted-foreground">
            {row.capSource === "unsupported"
              ? "No subscription limit"
              : row.capSource === "probeFailed"
                ? "Usage could not be read"
                : row.capSource === "unverified"
                  ? "Usage not verified"
                  : "No reading"}
          </div>
        )}
      </div>
      <div className="grid min-w-0 content-start gap-1.5 text-xs">
        <label className="flex items-center gap-2">
          <Switch
            size="sm"
            aria-label={`${row.name} workers allowed`}
            checked={row.workersEnabled}
            disabled={disabled}
            onCheckedChange={(enabled) => onWorkersChange(row, enabled)}
          />
          <span className={caption}>Workers</span>
          <span className="text-muted-foreground">{row.workers} running</span>
        </label>
        {row.workersEnabled && row.workersOffOn.length > 0 && (
          <div className="text-muted-foreground">off on {row.workersOffOn.join(", ")}</div>
        )}
        {workersNotSaved.has(row.key) && unsaved}
        {row.fableMode !== null && (
          <label className="flex items-center gap-2">
            <Switch
              size="sm"
              aria-label={`${row.name} Fable mode`}
              checked={row.fableMode}
              disabled={goalsDisabled}
              onCheckedChange={(on) =>
                onEdit((current) => withAllocationAccountFableMode(current, snapshot, row, on))
              }
            />
            Fable mode
          </label>
        )}
        {row.fableMode !== null &&
          (notSaved.has("fableAccounts") || notSaved.has("fableOnly")) &&
          unsaved}
      </div>
      <div className="grid min-w-0 content-start gap-1">
        <span className={caption}>Daily goal</span>
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
        {row.goal && !row.goal.own && <div className="text-xs text-muted-foreground">default</div>}
        {failed("goal") && unsaved}
      </div>
      <div className="grid min-w-0 content-start gap-1 text-xs">
        <span className={caption}>Stop at</span>
        {row.supportsCaps ? (
          <>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {/* A cap can stop running work, so a half-typed one is never stored. */}
              <label className="grid gap-0.5 text-muted-foreground">
                Week
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
                <label className="grid gap-0.5 text-muted-foreground">
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
                <span className="text-muted-foreground">Stops</span>
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
              <div className="text-muted-foreground">stops nobody: no effect</div>
            )}
            {failed("cap") && unsaved}
          </>
        ) : (
          <div className="text-muted-foreground">No usage reading</div>
        )}
      </div>
    </li>
  );
}

/** One setting of the rules: its name, one line on what it does, and its control. */
function Rule(props: { title: string; description: string; failed: boolean; children: ReactNode }) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{props.title}</h3>
          <p className="max-w-xl text-xs text-muted-foreground/80">{props.description}</p>
          {props.failed && unsaved}
        </div>
        <div className="flex shrink-0 items-center">{props.children}</div>
      </div>
    </div>
  );
}

/** What T3 learned from every computer's history. Nobody edits these. */
function LearnedNumbers({ learned }: { learned: AllocationLearned }) {
  return (
    <div className="grid min-w-0 gap-3 px-3 py-3 sm:px-4">
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
        <p key={note} className="text-xs text-muted-foreground">
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
      policy={policy}
      snapshot={snapshot}
      now={now}
      disabled={disabled}
      notSaved={notSaved}
      workersNotSaved={workersNotSaved}
      onEdit={onEdit}
      onFlush={onFlush}
      onWorkersChange={onWorkersChange}
    />
  );
  return (
    <>
      <div className="@container/accounts grid min-w-0 gap-2.5">
        <SettingsSection title="Accounts" headerAction={status}>
          <div
            aria-hidden
            className={cn("hidden px-3 py-2 text-xs text-muted-foreground sm:px-4", columns)}
          >
            <span>Order</span>
            <span>Account</span>
            <span>Usage</span>
            <span>Workers</span>
            <span>Daily goal</span>
            <span>Stop at</span>
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
                  ? "Accounts could not be read. Refresh to try again."
                  : accounts === "offline"
                    ? "Not connected: accounts appear once this computer connects."
                    : "No accounts reported."}
            </p>
          )}
        </SettingsSection>
        <div className="grid gap-1 px-3 text-xs text-muted-foreground sm:px-4">
          <p>
            Order: between accounts with similar room left, the higher one is used. Daily goal: the
            share of the weekly limit to use each day; it only ranks accounts. Stop at: the usage
            where the account takes no more work. Fable mode: its workers run on Fable only.
          </p>
          {snapshot && snapshot.accountCapsSupported !== true && (
            <p>The computer that keeps these settings needs an update before caps can be edited.</p>
          )}
          {snapshot && snapshot.accountOrderSupported !== true && (
            <p>
              The computer that keeps these settings needs an update before the order and rules can
              be edited.
            </p>
          )}
          {unread.map((note) => (
            <p key={note} className="text-warning-foreground">
              {note}
            </p>
          ))}
        </div>
        {others.length > 0 && (
          <FoldedSettingsSection
            id="allocation-other-accounts"
            title={`Other accounts (${others.length})`}
            summary="Turned off, or no usage reading and no cap"
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
          description="Accounts within this much of the roomiest one count as equal; the order decides between them."
          failed={notSaved.has("closeMarginPoints")}
        >
          <NumberField
            name="Close-call margin"
            unit="%"
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
          description="A running worker that hits a limit waits this long for the reset; if it is further away, the worker moves to the closest model."
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
          description="Off: no worker runs on Fable. One that would starts on the nearest other model."
          failed={notSaved.has("fableWorkers")}
        >
          <Switch
            aria-label="Fable workers"
            checked={policy.fableWorkers !== false}
            disabled={disabled || snapshot?.runways === undefined}
            onCheckedChange={(fableWorkers) => onEdit((current) => ({ ...current, fableWorkers }))}
          />
        </Rule>
      </SettingsSection>
      <FoldedSettingsSection
        id="allocation-learned"
        title="Learned numbers"
        summary={
          snapshot?.learned
            ? `What models cost and limits hold, measured ${allocationReadingAge(snapshot.learned.learnedAt, now)} ago`
            : "Nothing measured yet: starting estimates are used"
        }
      >
        {snapshot?.learned ? (
          <LearnedNumbers learned={snapshot.learned} />
        ) : (
          <p className={cn(ITEM_ROW_CLASSNAME, "text-sm text-muted-foreground")}>
            Costs and limit sizes appear once turns and limit readings are recorded.
          </p>
        )}
      </FoldedSettingsSection>
    </>
  );
}
