import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, TextInput, View } from "react-native";
import {
  EnvironmentId,
  WS_METHODS,
  type SessionOwnershipInput,
  type SessionOwnershipResult,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildSessionHierarchy,
  sessionKey,
  sessionRole,
} from "@t3tools/client-runtime/state/session-organization";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AppText } from "../../components/AppText";

const read = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "session-ownership:read",
  tag: WS_METHODS.sessionOwnershipRead,
});
const change = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "session-ownership:change",
  tag: WS_METHODS.sessionOwnershipChange,
});

/** Mounted only while editing, so sidebar rows never fetch relationships individually. */
export function SessionOrganizationSheet({
  thread,
  onClose,
}: {
  thread: EnvironmentThreadShell;
  onClose: () => void;
}) {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const hierarchy = useMemo(() => buildSessionHierarchy(threads), [threads]);
  const authority = EnvironmentId.make(
    thread.organization?.authorityEnvironmentId ??
      thread.organization?.owner?.environmentId ??
      thread.environmentId,
  );
  const readRelationship = useAtomCommand(read, { reportFailure: false });
  const changeRelationship = useAtomCommand(change, { reportFailure: false });
  const [relationship, setRelationship] = useState<SessionOwnershipResult | null>(null);
  const [pending, setPending] = useState<SessionOwnershipInput | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const label =
    environments.find((e) => e.environmentId === thread.environmentId)?.label ??
    thread.environmentId;
  const connected =
    environments.find((e) => e.environmentId === authority)?.connection.phase === "connected";
  useEffect(() => {
    let closed = false;
    if (connected)
      void readRelationship({ environmentId: authority, input: { threadId: thread.id } }).then(
        (result) => {
          if (closed) return;
          if (result._tag === "Success") setRelationship(result.value);
          else setMessage(String(squashAtomCommandFailure(result)));
        },
      );
    return () => {
      closed = true;
    };
  }, [readRelationship, authority, thread.id, connected]);
  const save = async (owner: EnvironmentThreadShell | null) => {
    if (!relationship || busy) return;
    const input =
      pending?.ownerThreadId === (owner?.id ?? null)
        ? pending
        : {
            clientRequestId: uuidv4(),
            threadId: thread.id,
            ownerThreadId: owner?.id ?? null,
            expectedOwnerThreadId: relationship.ownerThreadId,
            expectedRevision: relationship.revision,
          };
    setPending(input);
    setBusy(true);
    try {
      const result = await changeRelationship({ environmentId: authority, input });
      if (result._tag === "Success") {
        setRelationship(result.value);
        setPending(null);
        setMessage(
          owner
            ? `Master changed to ${owner.title}. Future reports go to this master.`
            : "This session is now independent.",
        );
      } else setMessage(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  const candidates = threads.filter(
    (candidate) =>
      candidate.environmentId === authority &&
      candidate.archivedAt === null &&
      sessionKey(candidate) !== sessionKey(thread) &&
      !hierarchy.path(sessionKey(candidate)).includes(sessionKey(thread)) &&
      candidate.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const currentOwner = relationship
    ? relationship.ownerThreadId
    : thread.organization?.owner?.threadId;
  const displayedRole = relationship
    ? relationship.ownerThreadId
      ? "Worker"
      : thread.organization?.workers.length
        ? "Master"
        : "Independent"
    : sessionRole(thread);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-center bg-backdrop px-6">
        <View className="max-h-[80%] rounded-3xl bg-screen p-5">
          <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
            Session organization
          </AppText>
          <AppText className="my-3">
            {thread.title} · {displayedRole} · {label}
          </AppText>
          <AppText>
            Current master:{" "}
            {currentOwner
              ? (threads.find((t) => t.id === currentOwner && t.environmentId === authority)
                  ?.title ?? currentOwner)
              : "Independent"}
          </AppText>
          <AppText className="my-2 text-sm">
            Its conversation and current work continue on {label}.
          </AppText>
          {!connected && (
            <AppText accessibilityRole="alert">
              The owning computer is offline. Its saved relationship is retained.
            </AppText>
          )}
          {message && (
            <AppText accessibilityRole="alert" className="my-2">
              {message}
            </AppText>
          )}
          <TextInput
            accessibilityLabel="Find a master session"
            placeholder="Find a master session"
            value={query}
            onChangeText={setQuery}
            className="my-3 rounded-xl bg-subtle p-3 text-foreground"
          />
          <FlatList
            data={candidates}
            keyExtractor={sessionKey}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <Pressable
                accessibilityRole="button"
                disabled={!relationship || busy || !connected}
                onPress={() => void save(null)}
                className="min-h-12 justify-center px-3"
              >
                <AppText>Make independent</AppText>
              </Pressable>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Assign to ${item.title}`}
                disabled={!relationship || busy || !connected}
                onPress={() => void save(item)}
                className="min-h-12 justify-center px-3"
              >
                <AppText>{item.title}</AppText>
              </Pressable>
            )}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onClose}
            className="mt-3 min-h-12 items-center justify-center rounded-xl bg-subtle"
          >
            <AppText>{busy ? "Saving…" : "Close"}</AppText>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
