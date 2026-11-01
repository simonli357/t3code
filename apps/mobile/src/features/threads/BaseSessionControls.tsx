import { useEnvironmentQuery } from "../../state/query";
import { BaseSessionCreateInput, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_BASE_PROMPT,
  retainBaseSubmission,
  readBaseSubmission,
  openBaseDestination,
} from "@t3tools/client-runtime/state/base-sessions";
import { CommandId, MessageId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { baseSubmissionStorage } from "../../state/base-submissions";
import { uuidv4 } from "../../lib/uuid";
import { AppText } from "../../components/ui/AppText";

const decodeCreation = Schema.decodeSync(Schema.fromJsonString(BaseSessionCreateInput));
const encodeCreation = Schema.encodeSync(Schema.fromJsonString(BaseSessionCreateInput));

const createCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "base-sessions:create",
  tag: WS_METHODS.baseSessionsCreate,
});
const configurationQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "base-sessions:configuration",
  tag: WS_METHODS.baseSessionsConfiguration,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
export function BaseSessionControls({
  thread,
  onNavigate,
}: {
  thread: EnvironmentThreadShell;
  onNavigate: () => void;
}) {
  const project = useProjects().find(
    (p) => p.id === thread.projectId && p.environmentId === thread.environmentId,
  );
  const selectDetail = useSelectWorkspaceDetail();
  const query = useEnvironmentQuery(
    configurationQuery({
      environmentId: thread.environmentId,
      input: { projectId: thread.projectId },
    }),
  );
  const configuration = query.data;
  const [promptDraft, setPrompt] = useState<string | null>(null);
  const prompt =
    promptDraft ?? project?.basePrompt ?? configuration?.configuredPrompt ?? DEFAULT_BASE_PROMPT;
  const [busy, setBusy] = useState(false);
  const [actionMessage, setMessage] = useState<string | null>(null);
  const message = actionMessage ?? query.error;
  const inFlight = useRef(false);
  const create = useAtomCommand(createCommand, { reportFailure: false });
  const metadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const run = async (
    action:
      | "designation"
      | "save"
      | "reset"
      | "initialize"
      | "create"
      | "retry-task"
      | "discard-task",
  ) => {
    if (inFlight.current || !project) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const environmentId = thread.environmentId;
      if (action === "retry-task" || action === "discard-task") {
        const storage = baseSubmissionStorage(`${environmentId}:${thread.id}`);
        if (action === "discard-task") {
          await storage.clear();
          await baseSubmissionStorage(`initialize:${environmentId}:${thread.id}`).clear();
          await baseSubmissionStorage(`${environmentId}:${project.id}:create-base`).clear();

          setMessage(
            "Saved requests discarded. The next Send or initialization is a new request; previous sessions are retained.",
          );
          return;
        }
        const input = await readBaseSubmission(storage);
        if (!input) {
          setMessage("There is no saved task request.");
          return;
        }
        await openBaseDestination(
          storage,
          async () => {
            const result = await start({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            if (!result.value.threadId || result.value.threadId === thread.id)
              throw new Error("No independent fork was confirmed.");
            return result.value.threadId;
          },
          (destination) =>
            selectDetail({ name: "Thread", params: { environmentId, threadId: destination } }),
        );
        // Inspection retains the task for the original composer's acknowledgement.
        onNavigate();
      } else if (action === "create") {
        if (project.basePrompt == null && configuration?.configuredPrompt) {
          const adopted = await updateProject({
            environmentId,
            input: { projectId: project.id, basePrompt: configuration.configuredPrompt },
          });
          if (adopted._tag === "Failure") throw squashAtomCommandFailure(adopted);
        }
        const storage = baseSubmissionStorage(`${environmentId}:${project.id}:create-base`);
        const saved = await storage.read();
        const input = saved
          ? decodeCreation(saved)
          : {
              clientRequestId: uuidv4(),
              threadId: ThreadId.make(uuidv4()),
              projectId: project.id,
              createdAt: new Date().toISOString(),
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            };
        if (!saved) await storage.write(encodeCreation(input));
        await openBaseDestination(
          storage,
          async () => {
            const result = await create({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            if (result.value.threadId !== input.threadId)
              throw new Error("The server did not confirm the created Base.");
            return input.threadId;
          },
          (destination) =>
            selectDetail({ name: "Thread", params: { environmentId, threadId: destination } }),
        );
        await storage.clear();
        onNavigate();
      } else if (action === "designation") {
        if (!thread.isBase && project.basePrompt == null && configuration?.configuredPrompt) {
          const adopted = await updateProject({
            environmentId,
            input: {
              projectId: project.id,
              basePrompt: prompt.trim() || configuration.configuredPrompt,
            },
          });
          if (adopted._tag === "Failure") throw squashAtomCommandFailure(adopted);
        }
        const result = await metadata({
          environmentId,
          input: { threadId: thread.id, isBase: !thread.isBase },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setMessage(
          thread.isBase
            ? "Base designation removed."
            : "Base saved. Normal Send creates an independent fork.",
        );
      } else if (action === "save" || action === "reset") {
        const text = action === "reset" ? DEFAULT_BASE_PROMPT : prompt.trim();
        if (!text) throw new Error("Enter a base initialization prompt.");
        const result = await updateProject({
          environmentId,
          input: { projectId: project.id, basePrompt: text },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        setPrompt(text);
        setMessage("Project prompt saved. Nothing was sent.");
      } else {
        const storage = baseSubmissionStorage(`initialize:${environmentId}:${thread.id}`);
        const input =
          (await readBaseSubmission(storage)) ??
          (await retainBaseSubmission(storage, {
            commandId: CommandId.make(uuidv4()),
            createdAt: new Date().toISOString(),
            threadId: thread.id,
            initializeBase: true,
            message: {
              messageId: MessageId.make(uuidv4()),
              role: "user",
              text: project.basePrompt ?? configuration?.configuredPrompt ?? DEFAULT_BASE_PROMPT,
              attachments: [],
            },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          }));
        await openBaseDestination(
          storage,
          async () => {
            const result = await start({ environmentId, input });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            if (result.value.threadId !== input.threadId)
              throw new Error("The server did not confirm Base initialization.");
            return input.threadId;
          },
          (destination) =>
            selectDetail({ name: "Thread", params: { environmentId, threadId: destination } }),
        );
        setMessage("Base initialization started using the saved project prompt.");
        await storage.clear();
        onNavigate();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="my-3 gap-2">
      <AppText className="font-t3-semibold">Base session</AppText>
      <AppText>
        Normal Send forks this context and account. Initialize / refresh intentionally sends the
        saved project prompt here.
      </AppText>
      <BaseActionButton
        title={thread.isBase ? "Remove Base designation" : "Use as Base"}
        disabled={busy}
        onPress={() => void run("designation")}
      />
      {configuration?.warning && (
        <AppText accessibilityRole="alert">{configuration.warning}</AppText>
      )}
      {configuration?.candidates
        .filter((c) => c.threadId !== thread.id)
        .map((candidate) => (
          <Pressable
            key={candidate.threadId}
            accessibilityRole="button"
            className="min-h-11 justify-center px-2"
            onPress={() => {
              onNavigate();
              selectDetail({
                name: "Thread",
                params: {
                  environmentId: thread.environmentId,
                  threadId: candidate.threadId,
                },
              });
            }}
          >
            <AppText>Open configured {candidate.title}</AppText>
          </Pressable>
        ))}
      <AppText>Project base initialization prompt</AppText>
      <TextInput
        accessibilityLabel="Project base initialization prompt"
        multiline
        value={prompt}
        editable={!busy}
        onChangeText={(value) => {
          setPrompt(value);
        }}
        className="min-h-16 rounded-lg border border-border p-2 text-foreground"
      />
      <BaseActionButton title={"Save prompt"} disabled={busy} onPress={() => void run("save")} />
      <BaseActionButton
        title={"Reset to default"}
        disabled={busy}
        onPress={() => void run("reset")}
      />
      <BaseActionButton
        title={"Create and initialize new Base"}
        disabled={busy}
        onPress={() => void run("create")}
      />
      {thread.isBase && (
        <BaseActionButton
          title="Initialize / refresh Base"
          disabled={busy}
          onPress={() => void run("initialize")}
        />
      )}
      {thread.isBase && (
        <View>
          <AppText>
            Check a previous task after an uncertain send. Discard its saved request only after
            checking the retained sessions; the next Send creates a new fork.
          </AppText>
          <BaseActionButton
            title={"Check previous task"}
            disabled={busy}
            onPress={() => void run("retry-task")}
          />
          <BaseActionButton
            title={"Discard saved requests"}
            disabled={busy}
            onPress={() => void run("discard-task")}
          />
        </View>
      )}
      {message && <AppText accessibilityRole="alert">{message}</AppText>}
    </View>
  );
}

function BaseActionButton({
  title,
  disabled,
  onPress,
}: {
  title: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center px-2"
    >
      <AppText>{title}</AppText>
    </Pressable>
  );
}
