import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function PersonalInstructionsSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["personalInstructions"]);
  const [draft, setDraft] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const text = draft ?? settings.personalInstructions.text;
  const disabled = connectedEnvironments.length === 0;
  return (
    <SettingsSection id="personal-instructions" title="Personal instructions">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          User-owned preferences for every session on the selected environments, starting with their
          next turn. Provider system and developer instructions still apply. Save the same reviewed
          text to all intended hosts using the environment selector; offline hosts need a later
          save. Editing alone does not activate a draft.
        </p>
        <p className="text-sm">
          {mixed
            ? "Selected environments differ."
            : settings.personalInstructions.enabled && settings.personalInstructions.text.trim()
              ? "Enabled"
              : "Disabled"}
        </p>
        <Textarea
          aria-label="Personal instruction text"
          maxLength={8000}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled}
            onClick={() => update({ personalInstructions: { enabled: false, text } })}
          >
            Save inactive
          </Button>
          <Button
            disabled={disabled || !text.trim()}
            onClick={() => update({ personalInstructions: { enabled: true, text } })}
          >
            Save and enable
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => update({ personalInstructions: { enabled: false } })}
          >
            Disable
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setDraft("");
              update({ personalInstructions: { enabled: false, text: "" } });
            }}
          >
            Clear
          </Button>
        </div>
        {scope.kind === "environment" && (
          <>
            <label htmlFor="personal-guide-path" className="text-sm">
              This host's canonical guide path (optional)
            </label>
            <Input
              id="personal-guide-path"
              value={guide ?? settings.personalInstructionsGuidePath}
              onChange={(event) => setGuide(event.target.value)}
              disabled={disabled}
            />
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                update({
                  personalInstructionsGuidePath: guide ?? settings.personalInstructionsGuidePath,
                })
              }
            >
              Save host path
            </Button>
          </>
        )}
        <p className="text-sm text-muted-foreground">
          Codex receives keyed application context as developer messages containing user
          preferences. Other providers receive user context on each turn; older snapshots remain in
          their history but are explicitly superseded. Submission is not evidence that an agent read
          or obeyed the instructions. Restore earlier text and save to roll back.
        </p>
      </div>
    </SettingsSection>
  );
}
