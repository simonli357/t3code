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

export function GlobalInstructionsSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["globalInstructions"]);
  const [draft, setDraft] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  const text = draft ?? settings.globalInstructions.text;
  const disabled = connectedEnvironments.length === 0;
  return (
    <SettingsSection id="global-instructions" title="Global instructions">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Instructions for all sessions on the selected environments, effective next turn. Editing
          does not enable them. Offline environments need a later save.
        </p>
        <p className="text-sm">
          {mixed
            ? "Selected environments differ."
            : settings.globalInstructions.enabled && settings.globalInstructions.text.trim()
              ? "Enabled"
              : "Disabled"}
        </p>
        <Textarea
          aria-label="Global instruction text"
          maxLength={8000}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled}
            onClick={() => update({ globalInstructions: { enabled: false, text } })}
          >
            Save inactive
          </Button>
          <Button
            disabled={disabled || !text.trim()}
            onClick={() => update({ globalInstructions: { enabled: true, text } })}
          >
            Save and enable
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => update({ globalInstructions: { enabled: false } })}
          >
            Disable
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setDraft("");
              update({ globalInstructions: { enabled: false, text: "" } });
            }}
          >
            Clear
          </Button>
        </div>
        {scope.kind === "environment" && (
          <>
            <label htmlFor="global-guide-path" className="text-sm">
              Guide path on this environment (optional)
            </label>
            <Input
              id="global-guide-path"
              value={guide ?? settings.globalInstructionsGuidePath}
              onChange={(event) => setGuide(event.target.value)}
              disabled={disabled}
            />
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                update({
                  globalInstructionsGuidePath: guide ?? settings.globalInstructionsGuidePath,
                })
              }
            >
              Save guide path
            </Button>
          </>
        )}
        <p className="text-sm text-muted-foreground">
          Provider system and developer instructions still apply. Submission does not prove
          instructions were read or followed. Restore earlier text to roll back.
        </p>
      </div>
    </SettingsSection>
  );
}
