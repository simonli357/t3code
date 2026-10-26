import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function SessionWorkspaceSettings() {
  const { scope } = useSettingsScope();
  if (scope.kind === "all")
    return (
      <SettingsSection id="session-workspaces" title="Session workspaces">
        <p className="p-4 text-sm text-muted-foreground">
          Select one machine to configure its agent work root.
        </p>
      </SettingsSection>
    );
  return scope.kind === "environment" ? <WorkspaceForm key={scope.environmentId} /> : null;
}

function WorkspaceForm() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const [root, setRoot] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [args, setArgs] = useState<string | null>(null);
  const executable = command ?? settings.workspaceLifecycleCommand?.executable ?? "";
  const argumentsText = args ?? JSON.stringify(settings.workspaceLifecycleCommand?.args ?? []);
  let parsedArgs: string[] | null = null;
  try {
    const value: unknown = JSON.parse(argumentsText);
    if (Array.isArray(value) && value.every((item): item is string => typeof item === "string"))
      parsedArgs = value;
  } catch {
    /* Keep the user's draft until it is valid. */
  }
  return (
    <SettingsSection id="session-workspaces" title="Session workspaces">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Give new sessions a separate Git worktree and folders for temporary files, builds, caches,
          downloads, outputs and evidence on this machine. Existing sessions keep their workspace.
          Clearing the root disables this for future sessions. Retention belongs to your external
          lifecycle tool.
        </p>
        <label className="text-sm" htmlFor="agent-work-root">
          Agent work root (absolute path)
        </label>
        <Input
          id="agent-work-root"
          value={root ?? settings.agentWorkRoot}
          onChange={(event) => setRoot(event.target.value)}
        />
        <label className="text-sm" htmlFor="workspace-lifecycle-command">
          Lifecycle registration executable (optional)
        </label>
        <Input
          id="workspace-lifecycle-command"
          value={executable}
          onChange={(event) => setCommand(event.target.value)}
        />
        <label className="text-sm" htmlFor="workspace-lifecycle-args">
          Arguments (JSON array)
        </label>
        <Textarea
          id="workspace-lifecycle-args"
          value={argumentsText}
          onChange={(event) => setArgs(event.target.value)}
        />
        {parsedArgs === null && (
          <p role="alert" className="text-sm text-destructive">
            Enter a JSON array of strings.
          </p>
        )}
        <Button
          disabled={connectedEnvironments.length === 0 || parsedArgs === null}
          onClick={() =>
            update({
              agentWorkRoot: (root ?? settings.agentWorkRoot).trim(),
              workspaceLifecycleCommand: executable.trim()
                ? { executable: executable.trim(), args: parsedArgs! }
                : null,
            })
          }
        >
          Save workspace settings
        </Button>
      </div>
    </SettingsSection>
  );
}
