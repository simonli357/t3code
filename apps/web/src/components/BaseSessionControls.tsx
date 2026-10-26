import { BaseSessionCreateInput, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type BaseSessionConfiguration } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { useNavigate } from "@tanstack/react-router";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useState, useRef, useEffect } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_BASE_PROMPT,
  retainBaseSubmission,
  readBaseSubmission,
  openBaseDestination,
} from "@t3tools/client-runtime/state/base-sessions";
import { CommandId, MessageId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

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
  const navigate = useNavigate();
  const readConfiguration = useAtomCommand(configurationCommand, { reportFailure: false });
  const [configuration, setConfiguration] = useState<BaseSessionConfiguration | null>(null);
  const dirty = useRef(false);
  const [prompt, setPrompt] = useState(project?.basePrompt ?? DEFAULT_BASE_PROMPT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const create = useAtomCommand(createCommand, { reportFailure: false });
  const metadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const start = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
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
        const key = `t3code:base-submission:${environmentId}:${thread.id}`;
        const storage = {
          read: async () => localStorage.getItem(key),
          write: async (value: string) => {
            localStorage.setItem(key, value);
          },
          clear: async () => {
            localStorage.removeItem(key);
          },
        };
        if (action === "discard-task") {
          await storage.clear();
          localStorage.removeItem(`t3code:base-initialize:${environmentId}:${thread.id}`);
          localStorage.removeItem(`${environmentId}:${project.id}:create-base`);

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
            navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, destination)),
            }),
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
        const storage = {
          read: async () => localStorage.getItem(`${environmentId}:${project.id}:create-base`),
          write: async (value: string) => {
            localStorage.setItem(`${environmentId}:${project.id}:create-base`, value);
          },
          clear: async () => {
            localStorage.removeItem(`${environmentId}:${project.id}:create-base`);
          },
        };
        const saved = await storage.read();
        const input = saved
          ? decodeCreation(saved)
          : {
              clientRequestId: randomUUID(),
              threadId: ThreadId.make(randomUUID()),
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
            navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, destination)),
            }),
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
            : "Base saved. Normal Send will create an independent fork.",
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
        const key = `t3code:base-initialize:${environmentId}:${thread.id}`;
        const storage = {
          read: async () => localStorage.getItem(key),
          write: async (value: string) => {
            localStorage.setItem(key, value);
          },
          clear: async () => {
            localStorage.removeItem(key);
          },
        };
        const input =
          (await readBaseSubmission(storage)) ??
          (await retainBaseSubmission(storage, {
            commandId: CommandId.make(randomUUID()),
            createdAt: new Date().toISOString(),
            threadId: thread.id,
            initializeBase: true,
            message: {
              messageId: MessageId.make(randomUUID()),
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
          (destination) =>
            navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, destination)),
            }),
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
    <div className="flex flex-col gap-2 border-t pt-3">
      <p className="text-sm font-medium">Base session</p>
      <p className="text-sm text-muted-foreground">
        Normal Send creates a fork with this session’s context and account. Initialize / refresh
        intentionally sends the saved project prompt here.
      </p>
      <div>
        <Button variant="outline" disabled={busy} onClick={() => void run("designation")}>
          {thread.isBase ? "Remove Base designation" : "Use as Base"}
        </Button>
      </div>
      {configuration?.warning && (
        <p role="alert" className="text-sm">
          {configuration.warning}
        </p>
      )}
      {configuration?.candidates.some((c) => c.threadId === thread.id) && (
        <p className="text-sm">
          Configured account base. Use as Base adopts this exact session and preserves its
          conversation.
        </p>
      )}
      {configuration?.candidates
        .filter((c) => c.threadId !== thread.id)
        .map((candidate) => (
          <div key={candidate.threadId}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onNavigate();
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(thread.environmentId, candidate.threadId),
                  ),
                });
              }}
            >
              Open configured {candidate.title}
            </Button>
          </div>
        ))}
      <Label htmlFor="base-project-prompt">Project base initialization prompt</Label>
      <Textarea
        id="base-project-prompt"
        value={prompt}
        onChange={(event) => {
          dirty.current = true;
          setPrompt(event.target.value);
        }}
        disabled={busy}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void run("save")}>
          Save prompt
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run("reset")}>
          Reset to default
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void run("create")}>
          Create and initialize new Base
        </Button>
        {thread.isBase && (
          <Button disabled={busy} onClick={() => void run("initialize")}>
            Initialize / refresh Base
          </Button>
        )}
      </div>
      {thread.isBase && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Check a previous task after a failed or uncertain send. Discard its saved request only
            after checking the retained sessions; the next Send creates a new fork.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void run("retry-task")}>
              Check previous task
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => void run("discard-task")}>
              Discard saved requests
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
