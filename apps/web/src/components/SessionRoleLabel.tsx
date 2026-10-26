import { useMemo } from "react";
import {
  buildSessionHierarchy,
  describeSessionRole,
  sessionKey,
  sessionRole,
} from "@t3tools/client-runtime/state/session-organization";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadShell, useThreadShells } from "../state/entities";
import { cn } from "../lib/utils";
import { openSessionOrganization } from "./SessionOrganizationDialog";

/**
 * Masters read as a labelled badge; `nested` rows sit under a group header
 * that already names their role (see `describeSessionRole`).
 */
export function SessionRoleLabel({
  thread,
  nested = false,
}: {
  thread: EnvironmentThreadShell;
  nested?: boolean;
}) {
  const role = describeSessionRole(thread, { nested });
  if (role === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-3xs",
        role.master
          ? "rounded-sm border border-sidebar-foreground/20 px-1 font-medium text-sidebar-foreground/80"
          : "text-muted-foreground",
      )}
      aria-label={role.ariaLabel}
    >
      {role.text}
    </span>
  );
}

export function ChatSessionRole({ threadRef }: { threadRef: ScopedThreadRef }) {
  const source = useThreadShell(threadRef);
  const shells = useThreadShells();
  const hierarchy = useMemo(() => buildSessionHierarchy(shells), [shells]);
  const thread = source ? (hierarchy.byKey.get(sessionKey(source)) ?? source) : undefined;
  if (!thread?.organization) return null;
  return (
    <button
      type="button"
      className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2"
      onClick={() => openSessionOrganization(threadRef)}
      aria-label={`Session organization: ${thread.isBase ? `Base · ${sessionRole(thread)}` : sessionRole(thread)}`}
    >
      {thread.isBase ? `Base · ${sessionRole(thread)}` : sessionRole(thread)}
    </button>
  );
}
