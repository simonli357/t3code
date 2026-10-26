import { newThreadId } from "../lib/utils";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { agentSessionFork } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

// Retain the destination id across failed/disconnected requests so Retry can
// complete a partially published fork without copying the native session twice.
const pendingForks = new Map<string, { threadId: ThreadId; created: boolean }>();
const inFlight = new Set<string>();

export function useForkConversation() {
  const fork = useAtomCommand(agentSessionFork, { reportFailure: false });
  const router = useRouter();
  return useCallback(
    async function forkConversation(source: ScopedThreadRef) {
      const key = scopedThreadKey(source);
      if (inFlight.has(key)) return;
      const pending = pendingForks.get(key) ?? { threadId: newThreadId(), created: false };
      pendingForks.set(key, pending);
      inFlight.add(key);
      try {
        if (!pending.created) {
          const result = await fork({
            environmentId: source.environmentId,
            input: { sourceThreadId: source.threadId, threadId: pending.threadId },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          pending.threadId = result.value.threadId;
          pending.created = true;
        }
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(source.environmentId, pending.threadId)),
        });
        pendingForks.delete(key);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: pending.created
              ? "Conversation forked, but could not open it"
              : "Could not fork conversation",
            description: error instanceof Error ? error.message : "An error occurred.",
            actionProps: {
              children: pending.created ? "Open fork" : "Retry",
              onClick: () => {
                // An old toast must not create another destination after a retry succeeded.
                if (pendingForks.get(key) === pending) return forkConversation(source);
              },
            },
          }),
        );
      } finally {
        inFlight.delete(key);
      }
    },
    [fork, router],
  );
}
