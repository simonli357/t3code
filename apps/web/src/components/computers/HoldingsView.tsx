import type { StorageDetail, StorageEntry, StorageSize } from "@t3tools/contracts";
import { ChevronRightIcon, DatabaseIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { NOT_MEASURED, NOT_VERIFIED, formatBytes } from "./computersFormat";
import type { Loadable } from "./computersViewModel";
import { DatedTime, EmptyNotice, SectionHeading } from "./sectionParts";
import type {
  HoldingGroupModel,
  HoldingRow,
  HoldingsViewModel,
  StorageActions,
} from "./storageViewModel";
import { describeCoverage, describeGroupUsage } from "./storageText";

/** Entries rendered per group until the person asks for more; a group can list hundreds. */
const ROWS_PER_PAGE = 100;

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

const STATE_BADGE = {
  active: { label: "Active", variant: "success" },
  completed: { label: "Completed", variant: "outline" },
  "preservation-pending": { label: "Preservation pending", variant: "warning" },
  "cleanup-eligible": { label: "Cleanup eligible", variant: "info" },
  held: { label: "Held", variant: "warning" },
  unknown: { label: "State not reported", variant: "outline" },
} as const;

const BASIS_TEXT: Record<StorageSize["basis"], string> = {
  allocated: "on disk",
  logical: "logical size; allocated size is not reported on this platform",
  lifecycle: "estimate by the lifecycle tool: single-link files only",
  manifest: "recorded size of the bundle's files",
  filesystem: "from the filesystem",
  reported: "reported by the backup tool",
  unavailable: "",
};

function SizeText({ size }: { readonly size: StorageSize }) {
  if (size.bytes === null) return <span className="text-muted-foreground">{NOT_MEASURED}</span>;
  const at = iso(size.measuredAt);
  return (
    <span>
      <span className="font-mono tabular-nums">
        {size.complete ? "" : "At least "}
        {formatBytes(size.bytes)}
      </span>
      <span className="text-muted-foreground">
        {" "}
        {BASIS_TEXT[size.basis]}
        {at ? (
          <>
            {" · measured "}
            <DatedTime iso={at} format="age" />
          </>
        ) : null}
      </span>
      {size.sharedBytes ? (
        <span className="text-muted-foreground">
          {" · "}
          {formatBytes(size.sharedBytes)} in hard-linked files that other entries may also count
        </span>
      ) : null}
    </span>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-36 shrink-0 text-3xs font-semibold uppercase tracking-widest text-muted-foreground sm:pt-0.5">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-xs text-foreground [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

const time = (value: number | null, unknown: string) =>
  value === null ? (
    <span className="text-muted-foreground">{unknown}</span>
  ) : (
    <DatedTime iso={iso(value)!} />
  );

function Breakdown({ details }: { readonly details: Loadable<StorageDetail> | null }) {
  if (!details || details.status === "loading")
    return (
      <div role="status" aria-label="Measuring parts" className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-3 w-44" />
      </div>
    );
  if (details.status === "error")
    return <span className="text-destructive-foreground">{details.message}</span>;
  if (details.data.parts.length === 0)
    return <span className="text-muted-foreground">Nothing to break down.</span>;
  return (
    <ul className="flex flex-col gap-1">
      {details.data.parts.map((part) => (
        <li key={`${part.key}:${part.label}`} className="flex flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-medium">{part.label}</span>
              {part.ram ? (
                <Badge variant="info" size="sm">
                  RAM
                </Badge>
              ) : null}
            </span>
            <span className="shrink-0 text-right">
              <SizeText size={part.size} />
            </span>
          </span>
        </li>
      ))}
      {details.data.notes.map((note) => (
        <li key={note} className="text-2xs text-muted-foreground">
          {note}
        </li>
      ))}
    </ul>
  );
}

function Ram({ entry }: { readonly entry: StorageEntry }) {
  if (entry.ram.length === 0) return null;
  return (
    <Field label="RAM-backed">
      <ul className="flex flex-col gap-1">
        {entry.ram.map((ram) => (
          <li key={ram.path} className="flex flex-col gap-0.5">
            <span className="flex items-baseline gap-1.5">
              <Badge variant="info" size="sm">
                RAM
              </Badge>
              <StartTruncatedPath path={ram.path} className="font-mono" />
            </span>
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
              {ram.usedBytes === null ? NOT_MEASURED : formatBytes(ram.usedBytes)} used of a{" "}
              {ram.limitBytes === null
                ? "limit that is not reported"
                : `${formatBytes(ram.limitBytes)} limit`}
              . Memory, not disk: left out of the disk total.
            </span>
          </li>
        ))}
      </ul>
    </Field>
  );
}

function EntryDetails({ row }: { readonly row: HoldingRow }) {
  const { entry } = row;
  const where = (
    <>
      <Field label="Host">
        {row.hostLabel}
        {entry.local ? null : (
          <span className="text-muted-foreground">
            {" "}
            · stored there; nothing is charged to this computer
          </span>
        )}
      </Field>
      {entry.location ? (
        <Field label="Location">
          <StartTruncatedPath path={entry.location} className="font-mono" />
        </Field>
      ) : null}
      {row.diskLabel ? <Field label="Disk">{row.diskLabel}</Field> : null}
    </>
  );
  const notes = entry.notes.map((note) => (
    <p key={note} className="text-2xs text-muted-foreground">
      {note}
    </p>
  ));
  if (entry.workspace) {
    const w = entry.workspace;
    return (
      <dl className="flex flex-col gap-2 px-3 pb-3">
        {where}
        <Field label="Owner">
          {[
            w.owner.project ? `Project ${w.owner.project}` : null,
            w.owner.master ? `directed by ${w.owner.master}` : null,
            w.owner.workers.length
              ? `directs ${w.owner.workers.length} worker${w.owner.workers.length === 1 ? "" : "s"} (${w.owner.workers.join(", ")})`
              : null,
            w.owner.session ? `session ${w.owner.session}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || <span className="text-muted-foreground">Not recorded</span>}
        </Field>
        <Field label="State">
          {STATE_BADGE[w.state].label}
          <span className="text-muted-foreground">
            {" "}
            ·{" "}
            {w.stateSource === "lifecycle"
              ? "from the lifecycle tool"
              : w.stateSource === "session"
                ? "from the session; no lifecycle tool reports this folder"
                : "nothing reports it"}
          </span>
        </Field>
        <Field label="Last activity">{time(w.lastActivityAt, "Not recorded")}</Field>
        <Field label="Expires">
          {w.expiresAt !== null ? (
            time(w.expiresAt, "")
          ) : (
            <span className="text-muted-foreground">No expiry is scheduled</span>
          )}
        </Field>
        <Field label="Retention">
          {w.retention ?? <span className="text-muted-foreground">No reason reported</span>}
        </Field>
        {w.preservation.length ? (
          <Field label="Waiting on">
            <ul className="list-disc pl-4">
              {w.preservation.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Field>
        ) : null}
        <Field label="Size">
          <SizeText size={entry.size} />
        </Field>
        <Ram entry={entry} />
        <Field label="Made up of">
          <Breakdown details={row.details} />
        </Field>
        {w.keeps.length ? (
          <Field label="Kept results">
            <ul className="flex flex-col gap-0.5">
              {w.keeps.map((keep) => (
                <li key={keep.id}>
                  {keep.title}
                  <span className="text-muted-foreground"> · stored on {keep.host}</span>
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        {notes}
      </dl>
    );
  }
  if (entry.archive) {
    const a = entry.archive;
    return (
      <dl className="flex flex-col gap-2 px-3 pb-3">
        {where}
        <Field label="Source">
          {a.source ? (
            <StartTruncatedPath path={a.source} className="font-mono" />
          ) : (
            <span className="text-muted-foreground">Not recorded</span>
          )}
        </Field>
        <Field label="Kept">{time(a.createdAt, "Not recorded")}</Field>
        <Field label="Retention">{a.retention ?? NOT_VERIFIED}</Field>
        <Field label="Backup">
          {a.backup === "confirmed" ? (
            <>
              <Badge variant="success" size="sm">
                Verified
              </Badge>{" "}
              {a.backupSnapshot ? `in snapshot ${a.backupSnapshot} ` : ""}
              {a.backupVerifiedAt !== null ? <>on {time(a.backupVerifiedAt, "")}</> : null}
            </>
          ) : a.backup === "published" ? (
            <>
              <Badge variant="warning" size="sm">
                Published, backup not verified
              </Badge>{" "}
              <span className="text-muted-foreground">
                A library copy is not an independent backup.
              </span>
            </>
          ) : (
            NOT_VERIFIED
          )}
        </Field>
        <Field label="Size">
          <SizeText size={entry.size} />
          {a.files !== null ? (
            <span className="text-muted-foreground"> · {a.files} files</span>
          ) : null}
        </Field>
        {entry.local ? (
          <Field label="Occupied">
            <Breakdown details={row.details} />
          </Field>
        ) : null}
        {notes}
      </dl>
    );
  }
  if (entry.backup) {
    const b = entry.backup;
    return (
      <dl className="flex flex-col gap-2 px-3 pb-3">
        {where}
        <Field label="Repository">
          <StartTruncatedPath path={b.repository} className="font-mono" />
        </Field>
        <Field label="Occupied">
          <SizeText size={entry.size} />
        </Field>
        <Field label="Coverage">
          {b.covered !== null && b.expected !== null ? (
            <>
              {b.covered} of {b.expected} kept bundles confirmed in the latest backup
              {b.covered < b.expected ? (
                <span className="text-muted-foreground"> · the rest are not verified</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">
              {b.verifiedAt === null
                ? "Not known: the latest receipt is not readable"
                : "Not matched to kept bundles on this computer"}
            </span>
          )}
        </Field>
        <Field label="Last verified">{time(b.verifiedAt, NOT_VERIFIED)}</Field>
        <Field label="Retention">
          {b.retention ?? <span className="text-muted-foreground">Not reported</span>}
        </Field>
        <Field label="Independent">
          {b.independent === null ? (
            <span className="text-muted-foreground">Not known</span>
          ) : b.independent ? (
            "Yes: another physical disk than the library"
          ) : (
            <span className="text-warning-foreground">
              No: the same physical disk as the library
            </span>
          )}
        </Field>
        {notes}
      </dl>
    );
  }
  const other = entry.other;
  return (
    <dl className="flex flex-col gap-2 px-3 pb-3">
      {where}
      {other ? (
        <>
          <Field label="Kind">
            {
              {
                "permanent-source": "Permanent source",
                "original-data": "Original data",
                "project-runtime": "Installed project runtime",
                "shared-tooling": "Shared tooling or cache",
                "legacy-work": "Historical work",
                recovery: "Recovery refs of expired workspaces",
              }[other.classification]
            }
          </Field>
          <Field label="Protection">
            {other.protection ?? <span className="text-muted-foreground">Not reported</span>}
          </Field>
        </>
      ) : null}
      <Field label="Size">
        <SizeText size={entry.size} />
      </Field>
      {notes}
    </dl>
  );
}

function EntryHeadline({ row }: { readonly row: HoldingRow }) {
  const { entry } = row;
  const state = entry.workspace ? STATE_BADGE[entry.workspace.state] : null;
  const backup = entry.archive?.backup;
  return (
    <>
      <span className="flex min-w-0 flex-col gap-0.5 text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
          <span className="truncate text-sm font-medium text-foreground">{entry.title}</span>
          {state ? (
            <Badge variant={state.variant} size="sm">
              {state.label}
            </Badge>
          ) : null}
          {backup ? (
            <Badge variant={backup === "confirmed" ? "success" : "warning"} size="sm">
              {backup === "confirmed" ? "Backup verified" : "Backup not verified"}
            </Badge>
          ) : null}
          {entry.ram.length ? (
            <Badge variant="info" size="sm">
              RAM
            </Badge>
          ) : null}
        </span>
        <span className="truncate pl-5 text-2xs text-muted-foreground">
          {[entry.subtitle, row.hostLabel, row.diskLabel].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="shrink-0 text-right font-mono text-xs tabular-nums">
        {entry.size.bytes === null ? (
          <span className="text-muted-foreground">{NOT_MEASURED}</span>
        ) : (
          <span className={entry.local ? "text-foreground" : "text-muted-foreground"}>
            {entry.size.complete ? "" : "≥ "}
            {formatBytes(entry.size.bytes)}
          </span>
        )}
        {entry.local ? null : (
          <span className="block text-2xs text-muted-foreground">on {row.hostLabel}</span>
        )}
      </span>
    </>
  );
}

function EntryRow({
  row,
  onExpand,
}: {
  readonly row: HoldingRow;
  readonly onExpand: StorageActions["onExpandEntry"];
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/10">
      <Collapsible
        onOpenChange={(open) => {
          if (open && row.detailsAvailable && row.details === null)
            onExpand(row.computerId, row.entry.id);
        }}
      >
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start justify-between gap-3 rounded-lg px-3 py-2 outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <EntryHeadline row={row} />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <EntryDetails row={row} />
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

const COVERAGE_BADGE = {
  complete: null,
  partial: { label: "Partial", variant: "warning" },
  unsupported: { label: "Unsupported", variant: "outline" },
  unavailable: { label: "Unavailable", variant: "warning" },
} as const;

function GroupSection({
  group,
  onExpand,
  onToggle,
  onLoadMore,
}: {
  readonly group: HoldingGroupModel;
  readonly onExpand: StorageActions["onExpandEntry"];
  readonly onToggle: StorageActions["onToggleGroup"];
  readonly onLoadMore: StorageActions["onLoadMore"];
}) {
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  const usage = describeGroupUsage(group);
  const coverage = describeCoverage(group.coverage);
  const badge = COVERAGE_BADGE[coverage.overall];
  return (
    <div className="rounded-xl border border-border/60 bg-card shadow-xs/5">
      <Collapsible open={group.open} onOpenChange={(opened) => onToggle(group.id, opened)}>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start justify-between gap-3 rounded-xl px-4 py-3 text-left outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <ChevronRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
              />
              <span className="text-sm font-medium text-foreground">{group.title}</span>
              {badge ? (
                <Badge variant={badge.variant} size="sm">
                  {badge.label}
                </Badge>
              ) : null}
            </span>
            <span className="pl-6 text-xs text-muted-foreground">{usage.caveats.join(" · ")}</span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
            <span className="text-sm font-medium text-foreground">{usage.count}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {usage.bytes}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 px-3 pb-3">
            <p className="px-1 text-xs text-muted-foreground">{group.description}</p>
            {coverage.notes.map((note) => (
              <p key={note} className="px-1 text-xs text-warning-foreground">
                {note}
              </p>
            ))}
            {group.rowsLoading && group.rows.length === 0 ? (
              <div role="status" aria-label="Loading entries" className="flex flex-col gap-1.5">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} shape="card" className="h-11" />
                ))}
              </div>
            ) : group.rows.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {coverage.overall === "unsupported"
                  ? "Nothing to list: this is not supported on the connected computers."
                  : "Nothing is listed."}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {group.rows.slice(0, limit).map((row) => (
                  <li key={row.key} className="min-w-0">
                    <EntryRow row={row} onExpand={onExpand} />
                  </li>
                ))}
              </ul>
            )}
            {group.rows.length > limit ? (
              <div className="flex justify-center pt-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setLimit((value) => value + ROWS_PER_PAGE)}
                >
                  Show {Math.min(ROWS_PER_PAGE, group.rows.length - limit)} more of{" "}
                  {group.rows.length - limit}
                </Button>
              </div>
            ) : null}
            {group.truncated && group.rows.length <= limit ? (
              <div className="flex flex-col items-center gap-1 pt-1">
                <p className="px-1 text-2xs text-muted-foreground">
                  The computers have sent {group.rows.length} entries so far, newest first; the
                  count above covers all of them.
                </p>
                <Button size="xs" variant="outline" onClick={onLoadMore}>
                  Load more entries
                </Button>
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/**
 * The Workspaces & Archives view: exactly four groups, closed until opened, each with a truthful
 * count and disk usage and an explicit note where coverage is partial, unknown or shared.
 */
export function HoldingsView({
  model,
  actions,
}: {
  readonly model: HoldingsViewModel;
  readonly actions: Pick<StorageActions, "onExpandEntry" | "onToggleGroup" | "onLoadMore">;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading id={headingId} hidden>
        Workspaces and archives
      </SectionHeading>
      {model.loading ? (
        <div role="status" aria-label="Loading storage" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} shape="card" className="h-16" />
          ))}
        </div>
      ) : (
        <>
          {model.groups.every((group) => group.count === 0 && group.coverage.length === 0) ? (
            <EmptyNotice
              icon={<DatabaseIcon />}
              title="No computers connected"
              description="Workspaces and archives appear here once a T3 environment is connected."
            />
          ) : (
            model.groups.map((group) => (
              <GroupSection
                key={group.id}
                group={group}
                onExpand={actions.onExpandEntry}
                onToggle={actions.onToggleGroup}
                onLoadMore={actions.onLoadMore}
              />
            ))
          )}
          {model.notices.map((notice) => (
            <p key={notice} className={cn("px-1 text-2xs text-muted-foreground")}>
              {notice}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
