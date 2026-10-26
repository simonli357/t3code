// @effect-diagnostics nodeBuiltinImport:off - Execute the real source branch with isolated IO boundaries.
import { it, expect } from "vite-plus/test";
import * as NodeFS from "node:fs";
import { CommandId } from "@t3tools/contracts";
import {
  retainBaseSubmission,
  readBaseSubmission,
  openBaseDestination,
} from "@t3tools/client-runtime/state/base-sessions";
it.each(["navigation", "provider"])(
  "retains the Base request and draft after %s failure",
  async (failure) => {
    const storage = new Map<string, string>();
    const errors: string[] = [];
    let sends = 0;
    let opens = 0;
    const deps = {
      activeThread: {
        isBase: true,
        modelSelection: { instanceId: "codex", model: "model" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      environmentId: "owning-remote",
      threadIdForSend: "base",
      turnAttachmentsPromise: Promise.resolve([]),
      composerAttachmentsSnapshot: [],
      buildOutgoingMessageContext: () => undefined,
      retainBaseSubmission,
      openBaseDestination,
      CommandId,
      randomUUID: () => "stable-request",
      messageCreatedAt: "2026-10-24T12:00:00.000Z",
      messageIdForSend: "message",
      outgoingMessageText: "Task",
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
      startThreadTurn: async () => {
        sends++;
        if (failure === "provider") return { _tag: "Failure", cause: new Error("Image rejected") };
        return { _tag: "Success", value: { threadId: "confirmed-destination" } };
      },
      squashAtomCommandFailure: (v: { cause: Error }) => v.cause,
      promptRef: { current: "Task" },
      clearComposerDraftContent: () => {},
      composerDraftTarget: "base",
      composerRef: { current: { resetCursorState: () => {} } },
      navigate: async () => {
        if (++opens === 1) throw new Error("Route could not load");
      },
      buildThreadRouteParams: (v: unknown) => v,
      scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
      setThreadError: (_id: string, message: string) => errors.push(message),
      sendInFlightRef: { current: true },
      resetLocalDispatch: () => {},
    };
    const source = NodeFS.readFileSync(
      new URL("./ChatView.tsx", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n");
    const start = source.indexOf(
      "    if (activeThread.isBase) {\n      const key = `t3code:base-submission:",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const body = source.slice(
      start,
      source.indexOf("    if (multipleModelSelections !== null) {", start),
    );
    // Erase the block's type annotation and non-null assertion only.
    const executable = `async function execute(deps){ const {${Object.keys(deps).join(",")}}=deps;${body.replace("composerAttachmentsSnapshot[i]!.id", "composerAttachmentsSnapshot[i].id").replace("(value: string)", "(value)")}}`;
    const execute = new Function(executable + "; return execute;")();
    await execute(deps);
    const saved = await readBaseSubmission({
      read: async () => storage.get("t3code:base-submission:owning-remote:base") ?? null,
      write: async () => {},
      clear: async () => {},
    });

    expect(saved).not.toBeNull();
    expect(deps.promptRef.current).toBe("Task");
    if (failure === "provider") {
      expect(errors[0]).toContain("Image rejected");
      expect(sends).toBe(1);
      expect(opens).toBe(0);
      return;
    }
    expect(errors[0]).toContain("Base request completed");
    await execute(deps);
    expect(sends).toBe(1);
    expect(opens).toBe(2);
    expect(storage.size).toBe(0);
    expect(deps.promptRef.current).toBe("");
  },
);
