import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type SessionOwnershipResult,
  type SessionOwnershipInput,
} from "@t3tools/contracts";
import {
  buildSessionHierarchy,
  sessionKey,
  sessionRole,
} from "@t3tools/client-runtime/state/session-organization";
import {
  squashAtomCommandFailure,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadShell, useThreadShells, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { environmentServerConfigsAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
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

const readOwnership = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "session-ownership:read",
  tag: WS_METHODS.sessionOwnershipRead,
});
const changeOwnership = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "session-ownership:change",
  tag: WS_METHODS.sessionOwnershipChange,
});
const dialog = create<{ source: ScopedThreadRef | null }>(() => ({ source: null }));
export const openSessionOrganization = (source: ScopedThreadRef) => dialog.setState({ source });
const close = () => dialog.setState({ source: null });
export function SessionOrganizationDialogHost() {
  const source = dialog((state) => state.source);
  return source ? (
    <SessionOrganizationDialog key={`${source.environmentId}:${source.threadId}`} source={source} />
  ) : null;
}
function SessionOrganizationDialog({ source }: { source: ScopedThreadRef }) {
  const thread = useThreadShell(source);
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const read = useAtomCommand(readOwnership, { reportFailure: false });
  const [relationship, setRelationship] = useState<SessionOwnershipResult | null>(null);
  const change = useAtomCommand(changeOwnership, { reportFailure: false });
  const hierarchy = useMemo(() => buildSessionHierarchy(threads), [threads]);
  const ownerRef = thread?.organization?.owner;
  const authorityEnvironment = EnvironmentId.make(
    thread?.organization?.authorityEnvironmentId ?? ownerRef?.environmentId ?? source.environmentId,
  );
  const currentOwner = relationship ? relationship.ownerThreadId : ownerRef?.threadId;
  const owner = currentOwner
    ? threads.find((t) => t.environmentId === authorityEnvironment && t.id === currentOwner)
    : null;
  const [destination, setDestination] = useState<string>(ownerRef?.threadId ?? "independent");
  const [pending, setPending] = useState<SessionOwnershipInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const connected =
    environments.find((e) => e.environmentId === authorityEnvironment)?.connection.phase ===
    "connected";
  const label = (environment: string) =>
    environments.find((e) => e.environmentId === environment)?.label ?? environment;
  const candidates = threads.filter(
    (candidate) =>
      candidate.environmentId === authorityEnvironment &&
      candidate.archivedAt === null &&
      !(candidate.id === source.threadId && candidate.environmentId === source.environmentId) &&
      !hierarchy.path(sessionKey(candidate)).includes(thread ? sessionKey(thread) : ""),
  );
  useEffect(() => {
    let disposed = false;
    if (connected)
      void read({ environmentId: authorityEnvironment, input: { threadId: source.threadId } }).then(
        (outcome) => {
          if (disposed) return;
          if (outcome._tag === "Success") {
            setRelationship(outcome.value);
            setDestination(outcome.value.ownerThreadId ?? "independent");
          } else setError(String(squashAtomCommandFailure(outcome)));
        },
      );
    return () => {
      disposed = true;
    };
  }, [read, authorityEnvironment, source.threadId, connected]);
  const submit = async () => {
    if (!thread?.organization || !relationship || busy) return;
    const input = pending ?? {
      clientRequestId: randomUUID(),
      threadId: source.threadId,
      ownerThreadId: destination === "independent" ? null : ThreadId.make(destination),
      expectedOwnerThreadId: relationship.ownerThreadId,
      expectedRevision: relationship.revision,
    };
    setPending(input);
    setBusy(true);
    setError(null);
    try {
      const outcome = await change({ environmentId: authorityEnvironment, input });
      if (outcome._tag === "Success") {
        setRelationship(outcome.value);
        setResult(
          outcome.value.ownerThreadId === null
            ? "This session is now independent."
            : `Master: ${candidates.find((t) => t.id === outcome.value.ownerThreadId)?.title ?? outcome.value.ownerThreadId}. Future reports go to this master.`,
        );
        setPending(null);
      } else setError(String(squashAtomCommandFailure(outcome)));
    } finally {
      setBusy(false);
    }
  };
  const displayedRole = relationship
    ? relationship.ownerThreadId
      ? "Worker"
      : thread?.organization?.workers.length
        ? "Master"
        : "Independent"
    : thread
      ? (sessionRole(thread) ?? "Role unavailable")
      : "Unavailable";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Session organization</DialogTitle>
          <DialogDescription>
            Assign a master, transfer ownership, or make this session independent. Its conversation
            and current work continue on {label(source.environmentId)}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              {thread?.title} · {displayedRole}
              <br />
              {currentOwner
                ? `Current master: ${owner?.title ?? currentOwner} · ${label(authorityEnvironment)}`
                : "No current master"}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="session-master">Master</Label>
              <Select
                value={destination}
                onValueChange={(value) => {
                  setDestination(value ?? "independent");
                  setPending(null);
                  setResult(null);
                }}
                disabled={busy}
              >
                <SelectTrigger id="session-master">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="independent">Independent</SelectItem>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title} ·{" "}
                      {projects.find(
                        (p) =>
                          p.id === candidate.projectId &&
                          p.environmentId === candidate.environmentId,
                      )?.title ?? candidate.projectId}{" "}
                      · {label(candidate.environmentId)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {!connected && (
              <p role="status" className="text-sm">
                The owning computer is offline. Its saved relationship is retained; reconnect to
                change it.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {result && (
              <p role="status" className="text-sm">
                {result}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Close
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy ||
              !relationship ||
              !connected ||
              result !== null ||
              configs.get(authorityEnvironment)?.environment.capabilities.sessionOrganization !==
                true
            }
          >
            {busy ? "Saving…" : pending ? "Retry change" : "Save relationship"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
