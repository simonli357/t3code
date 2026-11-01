import { DEFAULT_BASE_PROMPT } from "@t3tools/client-runtime/state/base-sessions";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";

export function ProjectBasePromptSettings({
  members,
}: {
  members: readonly { id: ProjectId; environmentId: EnvironmentId }[];
}) {
  const projects = useProjects();
  const selected = members.flatMap((member) =>
    projects.filter(
      (project) => project.id === member.id && project.environmentId === member.environmentId,
    ),
  );
  const saved = selected[0]?.basePrompt ?? DEFAULT_BASE_PROMPT;
  const mixed = selected.some((project) => (project.basePrompt ?? DEFAULT_BASE_PROMPT) !== saved);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const [message, setMessage] = useState<string | null>(null);
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: true });
  const save = async (prompt: string | null) => {
    if (saving || selected.length === 0) return;
    const startedRevision = revision.current;
    setSaving(true);
    setMessage(null);
    try {
      const results = await Promise.all(
        selected.map((project) =>
          update({
            environmentId: project.environmentId,
            input: { projectId: project.id, basePrompt: prompt },
          }),
        ),
      );
      if (results.every((result) => result._tag === "Success")) {
        if (revision.current === startedRevision) setDraft(null);
        setMessage("Saved. Used the next time a Base session is initialized or refreshed.");
      } else
        setMessage(
          "Some checkouts could not be updated. Your draft is retained; reconnect and save again.",
        );
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Base session prompt" id="base-session-prompt">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          The initialization prompt for this project’s Base sessions. Saving applies to the selected
          checkouts and does not send a message to existing sessions.
        </p>
        {mixed && (
          <p className="text-sm">
            Selected checkouts have different prompts. Save to use this prompt on each selected
            checkout.
          </p>
        )}
        <Textarea
          aria-label="Base session prompt"
          value={draft ?? saved}
          maxLength={12000}
          onChange={(event) => {
            revision.current++;
            setDraft(event.target.value);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={saving || selected.length === 0 || !(draft ?? saved).trim()}
            onClick={() => void save(draft ?? saved)}
          >
            Save prompt
          </Button>
          <Button
            variant="outline"
            disabled={saving || selected.length === 0}
            onClick={() => void save(DEFAULT_BASE_PROMPT)}
          >
            Use default
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Default: {DEFAULT_BASE_PROMPT}</p>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
