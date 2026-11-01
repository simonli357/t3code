import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { describeSessionOwner } from "@t3tools/client-runtime/state/session-organization";
import { scopeThreadRef, type ScopedThreadRef } from "@t3tools/client-runtime/environment";
import { SessionRoleLabel } from "./SessionRoleLabel";

/** Metadata belongs to the selectable surface, including compact and settled rows. */
export function SessionRowLabels(props: {
  thread: EnvironmentThreadShell;
  environmentLabel: string | null;
  owner?: ReturnType<typeof describeSessionOwner>;
  nested?: boolean | undefined;
  onOrganization?: ((ref: ScopedThreadRef) => void) | undefined;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        aria-label="Session organization"
        disabled={!props.onOrganization}
        className="shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          props.onOrganization?.(scopeThreadRef(props.thread.environmentId, props.thread.id));
        }}
      >
        <SessionRoleLabel thread={props.thread} nested={props.nested ?? false} />
      </button>
      {props.owner && (
        <span className="min-w-0 truncate" title={props.owner.detail} aria-label={props.owner.ariaLabel}>
          {props.owner.text}
        </span>
      )}
      <span className="ml-auto max-w-1/2 shrink-0 truncate" title="Originating computer">
        {props.environmentLabel ?? props.thread.environmentId}
      </span>
    </span>
  );
}
