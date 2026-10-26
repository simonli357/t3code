import { DEFAULT_BASE_PROMPT } from "@t3tools/client-runtime/state/base-sessions";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

export function ProjectBasePromptSettings({ members }: { members: readonly EnvironmentProject[] }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const [message, setMessage] = useState<string | null>(null);
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: true });
  const saved = members[0]?.basePrompt ?? DEFAULT_BASE_PROMPT;
  const mixed = members.some((member) => (member.basePrompt ?? DEFAULT_BASE_PROMPT) !== saved);
  const save = async (prompt: string | null) => {
    if (saving || members.length === 0) return;
    const startedRevision = revision.current;
    setSaving(true);
    setMessage(null);
    try {
      const results = await Promise.all(
        members.map((member) =>
          update({
            environmentId: member.environmentId,
            input: { projectId: member.id, basePrompt: prompt },
          }),
        ),
      );
      if (results.every((result) => result._tag === "Success")) {
        if (revision.current === startedRevision) setDraft(null);
        setMessage("Saved for the next Base initialization or refresh.");
      } else
        setMessage(
          "Some checkouts were not updated. Reconnect and save again; your draft is retained.",
        );
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Base session prompt">
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          Initialization prompt for this project’s Base sessions on the selected computers. Saving
          does not message existing sessions.
        </Text>
        {mixed && (
          <Text className="text-sm text-foreground-muted">
            Selected checkouts have different prompts. Save to use this prompt on all selected
            checkouts.
          </Text>
        )}
        <AppTextInput
          accessibilityLabel="Base session prompt"
          multiline
          value={draft ?? saved}
          maxLength={12000}
          className="min-h-28 rounded-xl bg-background p-3 text-base text-foreground"
          onChangeText={(text) => {
            revision.current++;
            setDraft(text);
          }}
        />
        <View className="flex-row flex-wrap gap-5">
          <Pressable
            accessibilityRole="button"
            disabled={saving || !(draft ?? saved).trim()}
            onPress={() => void save(draft ?? saved)}
          >
            <Text className="text-base text-primary">Save prompt</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void save(DEFAULT_BASE_PROMPT)}
          >
            <Text className="text-base text-primary">Use default</Text>
          </Pressable>
        </View>
        <Text className="text-sm text-foreground-muted">Default: {DEFAULT_BASE_PROMPT}</Text>
        {message && (
          <Text accessibilityRole="alert" className="text-sm text-foreground">
            {message}
          </Text>
        )}
      </View>
    </SettingsSection>
  );
}
