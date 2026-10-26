import { BaseSessionCreateInput, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_BASE_PROMPT,
  retainBaseSubmission,
  readBaseSubmission,
  openBaseDestination,
} from "@t3tools/client-runtime/state/base-sessions";
import {
  CommandId,
  MessageId,
  WS_METHODS,
  type BaseSessionConfiguration,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useProjects } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { baseSubmissionStorage } from "../../state/base-submissions";
import { uuidv4 } from "../../lib/uuid";
import { AppText } from "../../components/AppText";

const decodeCreation = Schema.decodeSync(Schema.fromJsonString(BaseSessionCreateInput));
const encodeCreation = Schema.encodeSync(Schema.fromJsonString(BaseSessionCreateInput));

const createCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "base-sessions:create",
  tag: WS_METHODS.baseSessionsCreate,
});
const configurationCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "base-sessions:configuration",
  tag: WS_METHODS.baseSessionsConfiguration,
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
  const navigation = useNavigation();
  const [prompt, setPrompt] = useState(project?.basePrompt ?? DEFAULT_BASE_PROMPT);
  const [configuration, setConfiguration] = useState<BaseSessionConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const create = useAtomCommand(createCommand, { reportFailure: false });
  const metadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const readConfiguration = useAtomCommand(configurationCommand, { reportFailure: false });
  useEffect(() => {
    let disposed = false;
    void readConfiguration({
      environmentId: thread.environmentId,
      input: { projectId: thread.projectId },
    }).then((result) => {
      if (disposed) return;
      if (result._tag === "Failure") {
        setMessage(String(squashAtomCommandFailure(result)));
        return;
      }
      setConfiguration(result.value);
      if (!dirty.current && project?.basePrompt == null && result.value.configuredPrompt)
        setPrompt(result.value.configuredPrompt);
    });
    return () => {
      disposed = true;
    };
  }, [readConfiguration, thread.environmentId, thread.projectId, project?.basePrompt]);
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
          (destination) => navigation.navigate("Thread", { environmentId, threadId: destination }),
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
          (destination) => navigation.navigate("Thread", { environmentId, threadId: destination }),
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
              text: project.basePrompt ?? DEFAULT_BASE_PROMPT,
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
          (destination) => navigation.navigate("Thread", { environmentId, threadId: destination }),
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
  const button = (title: string, action: Parameters<typeof run>[0]) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => void run(action)}
      className="min-h-11 justify-center px-2"
    >
      <AppText>{title}</AppText>
    </Pressable>
  );
  return (
    <View className="my-3 gap-2">
      <AppText className="font-t3-semibold">Base session</AppText>
      <AppText>
        Normal Send forks this context and account. Initialize / refresh intentionally sends the
        saved project prompt here.
      </AppText>
      {button(thread.isBase ? "Remove Base designation" : "Use as Base", "designation")}
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
              navigation.navigate("Thread", {
                environmentId: thread.environmentId,
                threadId: candidate.threadId,
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
          dirty.current = true;
          setPrompt(value);
        }}
        className="min-h-16 rounded-lg border border-border p-2 text-foreground"
      />
      {button("Save prompt", "save")}
      {button("Reset to default", "reset")}
      {button("Create and initialize new Base", "create")}
      {thread.isBase && button("Initialize / refresh Base", "initialize")}
      {thread.isBase && (
        <View>
          <AppText>
            Check a previous task after an uncertain send. Discard its saved request only after
            checking the retained sessions; the next Send creates a new fork.
          </AppText>
          {button("Check previous task", "retry-task")}
          {button("Discard saved requests", "discard-task")}
        </View>
      )}
      {message && <AppText accessibilityRole="alert">{message}</AppText>}
    </View>
  );
}
