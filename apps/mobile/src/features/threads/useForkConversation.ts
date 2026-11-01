import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { openConversationFork } from "@t3tools/client-runtime/state/conversation-fork";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { baseSubmissionStorage } from "../../state/base-submissions";
import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";

const inFlight = new Set<string>();
export function useForkConversation() {
  const fork = useAtomCommand(threadEnvironment.forkConversation, { reportFailure: false });
  const selectDetail = useSelectWorkspaceDetail();
  return async (thread: EnvironmentThreadShell) => {
    const key = `conversation-fork:${thread.environmentId}:${thread.id}`;
    if (inFlight.has(key)) return;
    const storage = baseSubmissionStorage(key);
    inFlight.add(key);
    try {
      await openConversationFork({
        storage, newId: uuidv4,
        submit: async ({ commandId, targetThreadId }) => {
          const result = await fork({ environmentId: thread.environmentId, input: { commandId, sourceThreadId: thread.id, targetThreadId, creationSource: "mobile" } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        open: async (threadId) => { selectDetail({ name: "Thread", params: { environmentId: thread.environmentId, threadId } }); },
      });
    } catch (error) {
      Dialog.confirm({
        title: "Could not fork conversation",
        message: `${error instanceof Error ? error.message : "An error occurred."} Fork again to retry the same saved request. Discard only after inspecting any uncertain native fork; existing sessions are retained.`,
        confirmText: "Discard saved request",
        onConfirm: () => { void storage.clear(); },
      });
    } finally { inFlight.delete(key); }
  };
}
