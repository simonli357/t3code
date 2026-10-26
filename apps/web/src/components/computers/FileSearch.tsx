import {
  CircleAlertIcon,
  FileIcon,
  FolderIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react";
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { useComputersClock } from "./computersClock";
import {
  ALL_FILTER_VALUE,
  NOT_VERIFIED,
  describeResultCount,
  formatBytes,
  formatMoment,
  fromFilterSelectValue,
  hasActiveFilters,
  toFilterSelectValue,
} from "./computersFormat";
import type {
  ComputersActions,
  ComputersSearchModel,
  FileRow,
  FilterOption,
} from "./computersViewModel";
import { BackupBadge, EmptyNotice, LoadError, SectionHeading } from "./sectionParts";

/**
 * Name takes what is left; the figures keep fixed columns so rows line up from one to the next.
 * Below a roomy page a row is one column: name, then where it is, then size, modified, and backup on one line.
 */
const RESULT_COLUMNS = "@3xl/computers:grid-cols-[minmax(0,1fr)_6rem_9.5rem_12rem]";

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<FilterOption>;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={toFilterSelectValue(value)}
      onValueChange={(next) => onChange(fromFilterSelectValue(next))}
    >
      <SelectTrigger aria-label={label} size="sm" className="w-full @xl/computers:w-48">
        <SelectValue>{value === null ? allLabel : (selected?.label ?? value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={ALL_FILTER_VALUE}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The one search box for every computer, with the three filters. Always visible. */
export function SearchBar({
  search,
  actions,
}: {
  readonly search: ComputersSearchModel;
  readonly actions: Pick<ComputersActions, "onQueryChange" | "onFiltersChange">;
}) {
  const { query, filters } = search;
  return (
    <div className="flex flex-col gap-2">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search projects, work folders and kept archives"
          placeholder="Search projects, work folders and kept archives"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => actions.onQueryChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || query.length === 0) return;
            event.preventDefault();
            actions.onQueryChange("");
          }}
        />
        {query.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Clear search"
              onClick={() => actions.onQueryChange("")}
            >
              <XIcon />
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <div className="grid grid-cols-2 gap-2 @xl/computers:flex @xl/computers:flex-wrap @xl/computers:items-center">
        <FilterSelect
          label="Project"
          allLabel="All projects"
          value={filters.projectId}
          options={search.projectOptions}
          onChange={(projectId) => actions.onFiltersChange({ ...filters, projectId })}
        />
        <FilterSelect
          label="Computer"
          allLabel="All computers"
          value={filters.computerId}
          options={search.computerOptions}
          onChange={(computerId) => actions.onFiltersChange({ ...filters, computerId })}
        />
        <FilterSelect
          label="File type"
          allLabel="All file types"
          value={filters.fileType}
          options={search.fileTypeOptions}
          onChange={(fileType) => actions.onFiltersChange({ ...filters, fileType })}
        />
        {hasActiveFilters(filters) ? (
          <Button
            size="sm"
            variant="ghost-muted"
            className="justify-self-start"
            onClick={() =>
              actions.onFiltersChange({ projectId: null, computerId: null, fileType: null })
            }
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Unverified() {
  return <span className="text-muted-foreground">{NOT_VERIFIED}</span>;
}

function ResultRow({
  row,
  onOpen,
}: {
  readonly row: FileRow;
  readonly onOpen: (fileId: string) => void;
}) {
  const { nowMs, timestampFormat } = useComputersClock();
  const modified =
    row.modifiedAt === null ? null : formatMoment(row.modifiedAt, nowMs, timestampFormat);
  const Icon = row.kind === "folder" ? FolderIcon : FileIcon;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        className={cn(
          "grid w-full cursor-pointer grid-cols-1 items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4",
          RESULT_COLUMNS,
        )}
      >
        <span className="flex min-w-0 flex-col gap-0.5 @3xl/computers:col-start-1 @3xl/computers:row-start-1">
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
            {row.kept ? <Badge variant="info">Kept</Badge> : null}
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-medium">{row.computerName}</span>
            <span aria-hidden>·</span>
            <StartTruncatedPath path={row.path} className="min-w-0 flex-1 font-mono text-2xs" />
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums @3xl/computers:contents">
          <span className="text-foreground @3xl/computers:col-start-2 @3xl/computers:row-start-1">
            <span className="text-muted-foreground @3xl/computers:sr-only">Size </span>
            {row.sizeBytes === null ? <Unverified /> : formatBytes(row.sizeBytes)}
          </span>
          <span className="text-foreground @3xl/computers:col-start-3 @3xl/computers:row-start-1">
            <span className="text-muted-foreground @3xl/computers:sr-only">Modified </span>
            {modified === null ? <Unverified /> : modified}
          </span>
          <span className="@3xl/computers:col-start-4 @3xl/computers:row-start-1">
            <BackupBadge backup={row.backup} />
          </span>
        </span>
      </button>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <ul role="status" aria-label="Searching" className="divide-y divide-border/50">
      {[0, 1, 2, 3].map((index) => (
        <li key={index} aria-hidden className="flex flex-col gap-2 px-3 py-3 sm:px-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-3/4" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Search results in place of the overview. Every figure that is not known says so, and the computers
 * the search could not cover are named, so a short list is never mistaken for a complete one.
 */
export function SearchResultsSection({
  search,
  actions,
}: {
  readonly search: ComputersSearchModel;
  readonly actions: Pick<ComputersActions, "onRefresh" | "onOpenFile" | "onLoadMoreResults">;
}) {
  const headingId = useId();
  const { results, query, filters } = search;

  const summary =
    results.status === "ready" && results.rows.length > 0
      ? describeResultCount(results.rows.length, results.totalCount, results.hasMore)
      : null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <SectionHeading
        id={headingId}
        action={summary ? <span className="text-xs text-muted-foreground">{summary}</span> : null}
      >
        Search results
      </SectionHeading>
      <p className="-mt-1 text-xs text-muted-foreground">
        Projects, work folders and kept archives on every computer. Caches and system files are not
        searched.
      </p>

      {results.status === "error" ? (
        <LoadError title="Search failed" message={results.message} onRetry={actions.onRefresh} />
      ) : results.status !== "ready" ? (
        // Loading, or idle with a query typed: the data layer has not started yet.
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs/5">
          <ResultsSkeleton />
        </div>
      ) : (
        <>
          {results.caveats.length > 0 ? (
            <Alert variant="warning">
              <CircleAlertIcon />
              <AlertTitle>Results may be incomplete</AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-0.5">
                  {results.caveats.map((caveat) => (
                    <li key={`${caveat.computerName}:${caveat.message}`} className="wrap-anywhere">
                      <span className="font-medium">{caveat.computerName}</span>: {caveat.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {results.rows.length === 0 ? (
            <EmptyNotice
              icon={<SearchXIcon />}
              title={query.trim() ? `No matches for “${query.trim()}”` : "No matches"}
              description={
                hasActiveFilters(filters)
                  ? "Try clearing a filter, or a different word."
                  : "Try a different word, or part of the path."
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-xs/5">
                <div
                  aria-hidden
                  className={cn(
                    "hidden border-b border-border/50 px-4 py-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground @3xl/computers:grid @3xl/computers:gap-x-3",
                    RESULT_COLUMNS,
                  )}
                >
                  <span>Name</span>
                  <span>Size</span>
                  <span>Modified</span>
                  <span>Backup</span>
                </div>
                <ul className="divide-y divide-border/50">
                  {results.rows.map((row) => (
                    <ResultRow key={row.id} row={row} onOpen={actions.onOpenFile} />
                  ))}
                </ul>
              </div>
              {results.hasMore ? (
                <div className="flex justify-center">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={results.loadingMore}
                    onClick={actions.onLoadMoreResults}
                  >
                    {results.loadingMore ? <Spinner /> : null}
                    Show more
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
