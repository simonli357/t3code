import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  WS_METHODS,
  type SessionMoveInput,
  type SessionMoveResult,
} from "@t3tools/contracts";
import { Alert } from "react-native";
import { useMemo } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";

const requestMove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "native-session-move:request",
  tag: WS_METHODS.sessionMovesRequest,
});
const readMove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "native-session-move:status",
  tag: WS_METHODS.sessionMovesStatus,
});
const pending = new Map<string, SessionMoveInput>();

export function useNativeSessionMove(thread: EnvironmentThreadShell) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const request = useAtomCommand(requestMove, { reportFailure: false });
  const status = useAtomCommand(readMove, { reportFailure: false });
  const current = configs.get(thread.environmentId);
  const provider = current?.providers.find(
    (entry) => entry.instanceId === thread.modelSelection.instanceId,
  );
  const supported =
    current?.environment.capabilities.nativeSessionMoves &&
    (provider?.driver === "codex" || provider?.driver === "claudeAgent");
  const key = `${thread.environmentId}:${thread.id}`;
  const choices = supported
    ? projects.filter((project) => {
        const config = configs.get(project.environmentId);
        return (
          project.environmentId !== thread.environmentId &&
          config?.environment.capabilities.nativeSessionMoves === true &&
          config.providers.some(
            (entry) =>
              entry.instanceId === thread.modelSelection.instanceId &&
              entry.driver === provider.driver &&
              entry.enabled &&
              entry.auth.status === "authenticated" &&
              entry.models.some((model) => model.slug === thread.modelSelection.model),
          )
        );
      })
    : [];
  const show = (value: SessionMoveResult) => {
    if (value.state === "complete" || value.state === "cancelled") pending.delete(key);
    Alert.alert(
      value.state === "complete"
        ? "Session moved"
        : value.state === "cancelled"
          ? "Move cancelled"
          : "Session move",
      value.error ??
        (value.state === "complete"
          ? "Open the conversation on the destination computer. Its full native context has been retained."
          : value.state === "queued"
            ? "The move will begin after the current work finishes."
            : value.state === "cancelled"
              ? "Continue on the original computer."
              : "Copying and verifying the session…"),
      value.state === "complete" || value.state === "cancelled"
        ? [{ text: "OK" }]
        : [
            { text: "Close", style: "cancel" },
            { text: "Check progress", onPress: () => void check() },
            ...(value.state !== "committing"
              ? [{ text: "Cancel move", onPress: () => void check(true) }]
              : []),
          ],
    );
  };
  const check = async (cancel = false) => {
    const result = await status({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, cancel },
    });
    if (result._tag === "Success") show(result.value);
    else Alert.alert("Session move", String(squashAtomCommandFailure(result)));
  };
  const onAction = (id: string) => {
    if (id === "native-move-status") {
      void check();
      return;
    }
    const destination = choices.find(
      (entry) => `native-move:${entry.environmentId}:${entry.id}` === id,
    );
    if (!destination) return;
    Alert.alert(
      "Move session?",
      "The full conversation and native context will continue on the selected computer with the same provider. The move waits for current work. Terminal processes stay where they are.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Move",
          onPress: () => {
            const input = pending.get(key) ?? {
              requestId: CommandId.make(uuidv4()),
              threadId: thread.id,
              environment: destination.environmentId,
              projectId: destination.id,
            };
            pending.set(key, input);
            void request({ environmentId: thread.environmentId, input }).then((result) => {
              if (result._tag === "Success") show(result.value);
              else
                Alert.alert(
                  "Could not request move",
                  String(squashAtomCommandFailure(result)) +
                    ". Check move progress before retrying.",
                );
            });
          },
        },
      ],
    );
  };
  const menuItems = useMemo<MenuAction[]>(
    () =>
      supported
        ? [
            {
              id: "native-move",
              title: "Move to computer…",
              image: "desktopcomputer",
              subactions: [
                ...choices.map((entry) => ({
                  id: `native-move:${entry.environmentId}:${entry.id}`,
                  title: `${environments.find((environment) => environment.environmentId === entry.environmentId)?.label ?? entry.environmentId} · ${entry.title}`,
                })),
                { id: "native-move-status", title: "Check move progress" },
              ],
            },
          ]
        : [],
    [supported, choices, environments],
  );
  return { menuItems, onAction };
}
