import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  ProviderInstanceId,
  type ScopedThreadRef,
  type SessionMoveInput,
  type SessionMoveResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { useEnvironments } from "../state/environments";
import { readThreadShell, useProjects } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { sessionMoveRequest, sessionMoveStatus } from "../state/agentSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

const useMoveDialog = create<{ source: ScopedThreadRef | null }>(() => ({ source: null }));
export function openMoveSession(source: ScopedThreadRef) {
  useMoveDialog.setState({ source });
}
const close = () => useMoveDialog.setState({ source: null });
const storageKey = (source: ScopedThreadRef) =>
  `t3-session-move:${source.environmentId}:${source.threadId}`;
function savedMove(source: ScopedThreadRef): SessionMoveInput | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey(source)) ?? "null",
    ) as SessionMoveInput | null;
    return value?.threadId === source.threadId &&
      typeof value.requestId === "string" &&
      typeof value.environment === "string" &&
      typeof value.projectId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function MoveSessionDialogHost() {
  const source = useMoveDialog((state) => state.source);
  return source ? (
    <MoveSessionDialog key={`${source.environmentId}:${source.threadId}`} source={source} />
  ) : null;
}

function MoveSessionDialog({ source }: { source: ScopedThreadRef }) {
  const projects = useProjects();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const { environments } = useEnvironments();
  const router = useRouter();
  const move = useAtomCommand(sessionMoveRequest, { reportFailure: false });
  const status = useAtomCommand(sessionMoveStatus, { reportFailure: false });
  const [pending, setPending] = useState(() => savedMove(source));
  const [receipt, setReceipt] = useState<SessionMoveResult | null>(null);
  const [destination, setDestination] = useState(
    pending ? `${pending.environment}:${pending.projectId}` : "",
  );
  const thread = readThreadShell(source);
  const currentSelection = thread?.modelSelection;
  const driver = configs
    .get(source.environmentId)
    ?.providers.find((entry) => entry.instanceId === currentSelection?.instanceId)?.driver;
  const choices = projects.filter(
    (project) =>
      project.environmentId !== source.environmentId &&
      configs.get(project.environmentId)?.environment.capabilities.nativeSessionMoves === true,
  );
  const target = choices.find(
    (project) => `${project.environmentId}:${project.id}` === destination,
  );
  const accounts =
    configs
      .get(target?.environmentId ?? source.environmentId)
      ?.providers.filter(
        (entry) =>
          entry.driver === driver && entry.enabled && entry.auth.status === "authenticated",
      ) ?? [];
  const [account, setAccount] = useState(
    pending?.providerInstanceId ?? currentSelection?.instanceId ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useCallback(
    async (value: SessionMoveResult) => {
      setReceipt(value);
      setError(value.error);
      if (value.state === "complete") {
        localStorage.removeItem(storageKey(source));
        close();
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(value.targetEnvironmentId, value.targetThreadId),
          ),
        });
      } else if (value.state === "cancelled") {
        localStorage.removeItem(storageKey(source));
        setPending(null);
      }
    },
    [router, source],
  );
  useEffect(() => {
    if (!pending || busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const result = await status({
        environmentId: source.environmentId,
        input: { requestId: pending.requestId },
      });
      if (disposed) return;
      if (result._tag === "Success") await accept(result.value);
      else setError(String(squashAtomCommandFailure(result)));
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [pending, source.environmentId, busy, status, accept]);
  const submit = async () => {
    if (!target || !account || busy) return;
    setBusy(true);
    setError(null);
    const input: SessionMoveInput = pending ?? {
      requestId: CommandId.make(randomUUID()),
      threadId: source.threadId,
      environment: target.environmentId,
      projectId: target.id,
      providerInstanceId: ProviderInstanceId.make(account),
    };
    // Keep the same request after reconnects and ambiguous network errors.
    localStorage.setItem(storageKey(source), JSON.stringify(input));
    setPending(input);
    try {
      const result = await move({ environmentId: source.environmentId, input });
      if (result._tag === "Success") await accept(result.value);
      else setError(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const result = await status({
        environmentId: source.environmentId,
        input: { requestId: pending.requestId, cancel: true },
      });
      if (result._tag === "Success") await accept(result.value);
      else setError(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to another computer</DialogTitle>
          <DialogDescription>
            The conversation and native context continue with the same provider. The move waits for
            the current turn to finish. Terminal processes stay on this computer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Computer and project</Label>
              <Select
                value={destination}
                onValueChange={(value) => setDestination(value ?? "")}
                disabled={pending !== null}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a destination" />
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((project) => (
                    <SelectItem
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}:${project.id}`}
                    >
                      {environments.find((entry) => entry.environmentId === project.environmentId)
                        ?.label ?? project.environmentId}{" "}
                      · {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {!choices.length && (
                <p className="text-sm text-muted-foreground">
                  Connect another computer with native session moves enabled.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Destination account</Label>
              <Select
                value={account}
                onValueChange={(value) => setAccount(value ?? "")}
                disabled={!target || pending !== null}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectPopup>
                  {accounts.map((entry) => (
                    <SelectItem key={entry.instanceId} value={entry.instanceId}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {receipt && (
              <p className="text-sm" role="status">
                {receipt.state === "queued"
                  ? "Waiting for the session to finish its current work…"
                  : receipt.state === "copying"
                    ? "Copying and verifying the complete session…"
                    : receipt.state === "committing"
                      ? "Finishing the move…"
                      : receipt.state === "cancelling"
                        ? "Confirming cancellation with the destination…"
                        : receipt.state === "cancelled"
                          ? "Move cancelled. Continue on this computer."
                          : "Verifying native resume…"}
              </p>
            )}
            {pending && (
              <p className="text-xs text-muted-foreground">
                Request: {pending.requestId}. You can close this dialog and reopen it to check
                progress.
              </p>
            )}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {pending && !receipt && error?.includes("Unknown outgoing session move") && !busy && (
            <Button
              variant="outline"
              onClick={() => {
                localStorage.removeItem(storageKey(source));
                setPending(null);
                setError(null);
              }}
            >
              Edit destination
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          {pending && (
            <Button
              variant="outline"
              disabled={busy || receipt?.state === "committing"}
              onClick={() => void cancel()}
            >
              Cancel move
            </Button>
          )}
          {(!pending || error) && (
            <Button
              disabled={busy || !target || !accounts.some((entry) => entry.instanceId === account)}
              onClick={() => void submit()}
            >
              {busy ? "Requesting…" : pending ? "Retry" : "Move session"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
