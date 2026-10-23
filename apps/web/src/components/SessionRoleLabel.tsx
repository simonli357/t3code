import { useMemo } from "react";
import {
  buildSessionHierarchy,
  sessionKey,
  sessionRole,
} from "@t3tools/client-runtime/state/session-organization";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadShell, useThreadShells } from "../state/entities";
import { openSessionOrganization } from "./SessionOrganizationDialog";
export function SessionRoleLabel({ thread }: { thread: EnvironmentThreadShell }) {
  const role = sessionRole(thread);
  return role ? (
    <span className="shrink-0 text-3xs text-muted-foreground" aria-label={`Session role: ${role}`}>
      {role}
      {thread.organization?.directInputAt ? " · Direct input" : ""}
    </span>
  ) : null;
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
      aria-label={`Session organization: ${sessionRole(thread)}`}
    >
      {sessionRole(thread)}
    </button>
  );
}
