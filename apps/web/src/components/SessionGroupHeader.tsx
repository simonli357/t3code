import {
  describeSessionWorkers,
  type SessionWorkerSummary,
} from "@t3tools/client-runtime/state/session-organization";
import { ChevronDownIcon, CircleAlertIcon, CircleDashedIcon, CloudOffIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Rows below a group header hang off one guide line; workers of workers step in once more. */
export function sessionNestingClassName(depth: number) {
  return depth === 0
    ? undefined
    : cn("border-l border-sidebar-foreground/20 pl-1.5", depth === 1 ? "ml-4" : "ml-7");
}

const PART_ICON = {
  attention: CircleAlertIcon,
  running: CircleDashedIcon,
  unavailable: CloudOffIcon,
} as const;
const PART_CLASS_NAME = {
  attention: "rounded-sm bg-warning-surface px-1 font-medium text-warning-foreground",
  running: "text-sky-600 dark:text-sky-400",
  unavailable: "text-sidebar-muted-foreground",
} as const;

/**
 * Disclosure row under a master. One line at any width: counts are icon plus
 * number, and the attention count spells itself out once the row is wide
 * enough. The button's name carries the full sentence for assistive tech.
 */
export function SessionGroupHeader(props: {
  readonly title: string;
  readonly summary: SessionWorkerSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const description = describeSessionWorkers(props.summary);
  return (
    <li className="list-none" data-thread-selection-safe data-testid="session-group-header">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-expanded={props.expanded}
              aria-label={`${props.expanded ? "Collapse" : "Expand"} workers of ${props.title}: ${description.text}`}
              onClick={props.onToggle}
              className="@container/session-group flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-foreground/85 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform motion-reduce:transition-none",
              !props.expanded && "-rotate-90",
            )}
          />
          <span className="shrink-0 font-medium">{description.total}</span>
          <span className="ml-auto flex min-w-0 items-center gap-2 tabular-nums">
            {description.parts.map((part) => {
              const Icon = PART_ICON[part.kind];
              return (
                <span
                  key={part.kind}
                  data-testid={`session-group-${part.kind}`}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1",
                    PART_CLASS_NAME[part.kind],
                  )}
                >
                  <Icon aria-hidden className="size-3" />
                  {part.count}
                  {part.kind === "attention" ? (
                    <span aria-hidden className="hidden @[17.5rem]/session-group:inline">
                      {part.phrase}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">{description.text}</TooltipPopup>
      </Tooltip>
    </li>
  );
}

/** Completed workers stay one click away at the end of an open group. */
export function SessionFinishedToggle(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li
      className={cn("list-none", sessionNestingClassName(1))}
      data-thread-selection-safe
      data-testid="session-finished-toggle"
    >
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? "Hide" : "Show"} ${props.count} finished ${props.count === 1 ? "worker" : "workers"}`}
        onClick={props.onToggle}
        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-(--sidebar-row-content-inset) text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform motion-reduce:transition-none",
            !props.expanded && "-rotate-90",
          )}
        />
        <span className="tabular-nums">Finished ({props.count})</span>
      </button>
    </li>
  );
}
