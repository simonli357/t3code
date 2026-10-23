import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, View, TextInput } from "react-native";
import * as Schema from "effect/Schema";
import {
  defaultModelRoutingPolicy,
  MODEL_SCORING_RUBRIC,
  MODEL_SCORE_BANDS,
  ModelRoutingPolicy,
  ModelRoutingRequest,
  ProviderDriverKind,
  ThreadId,
  type AllocationOperation,
  type EnvironmentId,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
} from "@t3tools/contracts";
import {
  modelEditorUrl,
  modelProfileLabel,
  modelPreviewKey,
  modelFailureMessage,
} from "@t3tools/client-runtime/state/model-routing";
import { createAllocationCommands } from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SettingsScreen } from "./components/SettingsScreen";
import { useEnvironments } from "../../state/environments";
const commands = createAllocationCommands(connectionAtomRuntime);
const decodePolicy = Schema.decodeUnknownSync(ModelRoutingPolicy);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const profileIds = [1, 2, 3, 4, 5, 6] as const;
const field = "rounded border border-border bg-background p-2 text-foreground";

export function SettingsModelSelectionRouteScreen() {
  const { selectedTargets, selectedIds } = useSettingsEnvironmentFilter();
  // Keep the chosen environment mounted across temporary disconnects, preserving drafts.
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const id =
    selectedIds?.size === 0
      ? null
      : selected && (selectedIds === null || selectedIds.has(selected))
        ? selected
        : (selectedTargets[0]?.environmentId ?? selected);
  if (id !== selected) setSelected(id);
  return (
    <SettingsScreen title="Model selection">
      {id ? (
        <ModelEditor key={id} environmentId={id} />
      ) : (
        <Text>Select an environment in Settings.</Text>
      )}
    </SettingsScreen>
  );
}
function ModelEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const target = useEnvironments().environments.find((e) => e.environmentId === environmentId);
  const connection = target?.connection.phase ?? "offline";
  const [connectionState, setConnectionState] = useState({ phase: connection, epoch: 0 });
  if (connectionState.phase !== connection)
    setConnectionState({ phase: connection, epoch: connectionState.epoch + 1 });
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<ModelRoutingSnapshot | null>(null);
  const [policy, setPolicy] = useState<ModelRoutingPolicy>(defaultModelRoutingPolicy);
  const [driver, setDriver] = useState<"codex" | "claudeAgent">("codex");
  const [row, setRow] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [assessment, setAssessment] = useState({
    difficulty: NaN,
    stakes: NaN,
    difficultyReason: "",
    stakesReason: "",
  });
  const [preview, setPreview] = useState<{ key: string; decision: ModelRoutingDecision } | null>(
    null,
  );
  const request: ModelRoutingRequest = {
    selection: "automatic",
    assignmentId: "mobile-model-preview",
    threadId: ThreadId.make("mobile-model-preview"),
    environmentId,
    allowedDrivers: [ProviderDriverKind.make(driver)],
    assessment,
    ...(snapshot ? { policyVersion: snapshot.policy.version } : {}),
  };
  const key = modelPreviewKey(policy, request, `${connection}:${connectionState.epoch}`);
  const decision = preview?.key === key && connection === "connected" ? preview.decision : null;
  const table = policy[driver];
  const ready = snapshot?.authorityAvailable && connection === "connected";
  const editorUrl = modelEditorUrl(target?.displayUrl ?? null, environmentId);
  const models = [
    ...new Set(
      snapshot?.inventories
        .flatMap((i) => i.accounts)
        .filter((a) => a.environmentId === environmentId && a.driver === driver)
        .flatMap((a) => a.models.map((m) => m.slug)) ?? [],
    ),
  ];
  useEffect(() => {
    let active = true;
    void execute({ environmentId, input: { _tag: "modelSnapshot" } }).then((result) => {
      if (!active) return;
      setBusy(false);
      if (result._tag === "Success" && result.value.modelSnapshot) {
        setSnapshot(result.value.modelSnapshot);
        setPolicy((current) =>
          current === defaultModelRoutingPolicy ? result.value.modelSnapshot!.policy : current,
        );
      } else setMessage("Coordinator unavailable. Reconnect and refresh; your draft is retained.");
    });
    return () => {
      active = false;
    };
  }, [environmentId, execute]);
  const call = async (input: AllocationOperation) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await execute({ environmentId, input });
      if (result._tag !== "Success") {
        setPreview(null);
        setMessage(
          `${modelFailureMessage(result.cause)} Draft retained; reconnect, refresh the saved version and preview again.`,
        );
        return null;
      }
      return result.value;
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setPreview(null);
    const result = await call({ _tag: "modelSnapshot" });
    if (result?.modelSnapshot) setSnapshot(result.modelSnapshot);
  };
  const action = (label: string, onPress: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}>
      <Text className={disabled ? "text-muted-foreground" : "text-primary"}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <Text>{target?.label ?? "Selected environment"}</Text>
      <Text>{MODEL_SCORING_RUBRIC}</Text>
      <Text>{message}</Text>
      <Text>
        Saved version {snapshot?.policy.version ?? "unknown"}; draft based on {policy.version}.{" "}
        {ready ? "Coordinator connected" : "Unavailable; draft retained"}.
      </Text>
      {action("Refresh saved version; keep draft", () => void refresh(), busy)}
      {action(
        "Discard draft",
        () => {
          if (snapshot) setPolicy(snapshot.policy);
          setPreview(null);
        },
        busy || !snapshot,
      )}
      {action(
        "Restore defaults in draft",
        () => setPolicy({ ...defaultModelRoutingPolicy, version: snapshot?.policy.version ?? 0 }),
        busy,
      )}
      <View className="flex-row flex-wrap gap-4">
        {(["codex", "claudeAgent"] as const).map((d) => (
          <Pressable
            key={d}
            accessibilityRole="tab"
            accessibilityState={{ selected: driver === d }}
            onPress={() => setDriver(d)}
          >
            <Text>{d === "codex" ? "Codex" : "Claude"}</Text>
          </Pressable>
        ))}
      </View>
      <Text>Approved automatic models (Luna, Haiku and Fable are excluded)</Text>
      {[...new Set([...models, ...table.allowedModels])].map((model) => (
        <Pressable
          key={model}
          accessibilityRole="checkbox"
          accessibilityState={{
            checked: table.allowedModels.includes(model),
            disabled: /luna|haiku|fable/i.test(model),
          }}
          disabled={/luna|haiku|fable/i.test(model)}
          onPress={() =>
            setPolicy({
              ...policy,
              [driver]: {
                ...table,
                allowedModels: table.allowedModels.includes(model)
                  ? table.allowedModels.filter((m) => m !== model)
                  : [...table.allowedModels, model],
              },
            })
          }
        >
          <Text>
            {table.allowedModels.includes(model) ? "Approved: " : "Not approved: "}
            {model}
            {models.includes(model) ? "" : " (unavailable in target catalog)"}
          </Text>
        </Pressable>
      ))}
      <Text>
        Reusable profiles. Enter an advertised model and effort; the coordinator validates edits.
      </Text>
      {profileIds.map((id) => {
        const p = table.profiles[id - 1]!;
        return (
          <View key={id} className="gap-2 rounded border border-border p-3">
            <Text>
              Profile {id}: {modelProfileLabel(p)}
            </Text>
            <TextInput
              accessibilityLabel={`Profile ${id} model`}
              className={field}
              value={p.model}
              onChangeText={(model) =>
                setPolicy({
                  ...policy,
                  [driver]: {
                    ...table,
                    profiles: table.profiles.map((v, i) => (i === id - 1 ? { ...v, model } : v)),
                  },
                })
              }
            />
            <TextInput
              accessibilityLabel={`Profile ${id} effort`}
              className={field}
              value={p.effort}
              onChangeText={(effort) =>
                setPolicy({
                  ...policy,
                  [driver]: {
                    ...table,
                    profiles: table.profiles.map((v, i) => (i === id - 1 ? { ...v, effort } : v)),
                  },
                })
              }
            />
            <Text>
              Capability alternative profile number (blank means unavailable). Configured order:{" "}
              {table.alternatives[id - 1]!.join(", ") || "none"}.
            </Text>
            <TextInput
              accessibilityLabel={`Profile ${id} alternative`}
              className={field}
              keyboardType="number-pad"
              value={table.alternatives[id - 1]![0]?.toString() ?? ""}
              onChangeText={(value) =>
                setPolicy({
                  ...policy,
                  [driver]: {
                    ...table,
                    alternatives: table.alternatives.map((v, i) =>
                      i === id - 1 ? (value ? [Number(value)] : []) : v,
                    ),
                  },
                })
              }
            />
          </View>
        );
      })}
      <Text>Difficulty row</Text>
      <View className="flex-row flex-wrap gap-4">
        {MODEL_SCORE_BANDS.map((band, i) => (
          <Pressable
            key={band}
            accessibilityRole="button"
            accessibilityState={{ selected: row === i }}
            onPress={() => setRow(i)}
          >
            <Text>{band}</Text>
          </Pressable>
        ))}
      </View>
      {MODEL_SCORE_BANDS.map((band, column) => {
        const id = table.grid[row]![column]!;
        const p = table.profiles[id - 1];
        return (
          <View key={band} className="gap-2">
            <Text>
              Stakes {band}: {p ? modelProfileLabel(p) : "Choose profile 1?6"}
            </Text>
            <TextInput
              accessibilityLabel={`Stakes ${band} profile number`}
              className={field}
              keyboardType="number-pad"
              value={Number.isFinite(id) ? String(id) : ""}
              onChangeText={(value) =>
                setPolicy({
                  ...policy,
                  [driver]: {
                    ...table,
                    grid: table.grid.map((r, i) =>
                      i === row ? r.map((v, j) => (j === column ? Number(value) : v)) : r,
                    ),
                  },
                })
              }
            />
          </View>
        );
      })}
      <Text>Assignment preview</Text>
      {(["difficulty", "stakes"] as const).map((axis) => (
        <View key={axis} className="gap-2">
          <Text>{axis}</Text>
          <TextInput
            accessibilityLabel={`${axis} score`}
            className={field}
            keyboardType="number-pad"
            value={Number.isFinite(assessment[axis]) ? String(assessment[axis]) : ""}
            onChangeText={(value) =>
              setAssessment({ ...assessment, [axis]: value ? Number(value) : NaN })
            }
          />
          <TextInput
            accessibilityLabel={`${axis} reason`}
            className={field}
            multiline
            maxLength={500}
            value={assessment[`${axis}Reason`]}
            onChangeText={(value) => setAssessment({ ...assessment, [`${axis}Reason`]: value })}
          />
        </View>
      ))}
      {action(
        "Preview exact selection",
        () => {
          try {
            decodePolicy(policy);
            decodeRequest(request);
          } catch {
            setMessage(
              "Use scores 0?10 with reasons, six valid profiles, and profile references 1?6.",
            );
            return;
          }
          const captured = key;
          void call({ _tag: "modelPreview", request, policy }).then((result) => {
            if (result?.selection) setPreview({ key: captured, decision: result.selection });
          });
        },
        busy || !ready,
      )}
      {decision ? (
        <View className="gap-2">
          <Text>
            {decision.rule}; version {decision.policyVersion}
          </Text>
          {decision.profiles.map((p) => (
            <Text key={p.driver}>
              {p.model} / {p.options.map((o) => o.value).join(", ")}:{" "}
              {p.eligible ? "eligible" : "unavailable"}
            </Text>
          ))}
          {decision.reasons.map((reason) => (
            <Text key={reason}>{reason}</Text>
          ))}
        </View>
      ) : (
        <Text>Preview again after policy, assessment or connection changes.</Text>
      )}
      {action(
        "Save new policy version",
        () => {
          if (!snapshot) return;
          void call({ _tag: "modelPolicy", expectedVersion: snapshot.policy.version, policy }).then(
            (result) => {
              if (result?.modelPolicy) {
                setPolicy(result.modelPolicy);
                setSnapshot({ ...snapshot, policy: result.modelPolicy });
                setPreview(null);
              }
            },
          );
        },
        busy || !ready || !decision,
      )}
      <Text>Recent decisions</Text>
      {snapshot?.history.slice(0, 10).map((d) => (
        <View key={d.request.assignmentId} className="gap-2">
          <Text>
            Version {d.policyVersion}; profile {d.selectedProfile ?? "none"};{" "}
            {d.allocation?.decision.request.model ?? "unavailable"}
          </Text>
          <Text>
            Difficulty {d.request.assessment.difficulty}: {d.request.assessment.difficultyReason}
          </Text>
          <Text>
            Stakes {d.request.assessment.stakes}: {d.request.assessment.stakesReason}
          </Text>
        </View>
      ))}
      <Text>
        Native preview and policy editing use the same coordinator as web and desktop. New
        human-session startup and reassessment history controls are in the web editor. Agents use
        the shared managed startup service.
      </Text>
      {editorUrl ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(editorUrl)}>
          <Text className="text-primary">Open Model selection web editor</Text>
        </Pressable>
      ) : (
        <Text>
          This relay or SSH connection has no direct web address. Open this custom build's web
          client, connect the same environment, then choose Settings ? Model selection.
        </Text>
      )}
    </ScrollView>
  );
}
