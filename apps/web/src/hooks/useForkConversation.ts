import { randomUUID } from "../lib/utils";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { openConversationFork } from "@t3tools/client-runtime/state/conversation-fork";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const keyFor = (source: ScopedThreadRef) => `t3code:conversation-fork:${scopedThreadKey(source)}`;
export const hasSavedConversationFork = (source: ScopedThreadRef) => localStorage.getItem(keyFor(source)) !== null;
export const discardConversationFork = (source: ScopedThreadRef) => localStorage.removeItem(keyFor(source));
const inFlight = new Set<string>();

export function useForkConversation() {
  const fork = useAtomCommand(threadEnvironment.forkConversation, { reportFailure: false });
  const router = useRouter();
  return useCallback(async function forkConversation(source: ScopedThreadRef) {
    const key = keyFor(source);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await openConversationFork({
        storage: {
          read: async () => localStorage.getItem(key),
          write: async (value) => localStorage.setItem(key, value),
          clear: async () => localStorage.removeItem(key),
        },
        newId: randomUUID,
        submit: async ({ commandId, targetThreadId }) => {
          const result = await fork({ environmentId: source.environmentId, input: { commandId, sourceThreadId: source.threadId, targetThreadId } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        open: (threadId) => router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(source.environmentId, threadId)) }),
      });
    } catch (error) {
      toastManager.add(stackedThreadToast({
        type: "error", title: "Could not fork conversation",
        description: `${error instanceof Error ? error.message : "An error occurred."} The saved request is retained; Retry uses the same destination.`,
        actionProps: { children: "Retry", onClick: () => { if (hasSavedConversationFork(source)) return forkConversation(source); } },
      }));
    } finally { inFlight.delete(key); }
  }, [fork, router]);
}
