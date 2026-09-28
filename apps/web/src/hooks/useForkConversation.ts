import { newThreadId } from "../lib/utils";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { agentSessionFork } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";

// Retain the destination id across failed/disconnected requests so Retry can
// complete a partially published fork without copying the native session twice.
const pendingForks = new Map<string, ThreadId>();
const inFlight = new Set<string>();

export function useForkConversation() {
  const fork = useAtomCommand(agentSessionFork);
  const router = useRouter();
  return useCallback(async (source: ScopedThreadRef) => {
    const key = scopedThreadKey(source);
    if (inFlight.has(key)) return;
    const threadId = pendingForks.get(key) ?? newThreadId();
    pendingForks.set(key, threadId);
    inFlight.add(key);
    try {
      const result = await fork({
        environmentId: source.environmentId,
        input: { sourceThreadId: source.threadId, threadId },
      });
      if (result._tag === "Failure") return;
      pendingForks.delete(key);
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(source.environmentId, result.value.threadId)),
      });
    } finally {
      inFlight.delete(key);
    }
  }, []);
}
