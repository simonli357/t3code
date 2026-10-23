import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, View, TextInput } from "react-native";
import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  type AllocationSnapshot,
  type AllocationDecision,
} from "@t3tools/contracts";
import {
  createAllocationCommands,
  allocationSummary,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SettingsScreen } from "./components/SettingsScreen";

const commands = createAllocationCommands(connectionAtomRuntime);
export function SettingsAllocationRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const target = selectedTargets[0];
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const [snapshot, setSnapshot] = useState<AllocationSnapshot | null>(null);
  const [decision, setDecision] = useState<AllocationDecision | null>(null);
  const [model, setModel] = useState("");
  const [driver, setDriver] = useState("codex");
  const [effort, setEffort] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    if (!target) return;
    setBusy(true);
    const result = await execute({
      environmentId: target.environmentId,
      input: { _tag: "snapshot" },
    });
    if (result._tag === "Success" && result.value.snapshot) {
      setSnapshot(result.value.snapshot);
      setMessage("");
    } else setMessage("Allocation coordinator unavailable. Reconnect to refresh.");
    setBusy(false);
  };
  useEffect(() => {
    if (!target) return;
    let active = true;
    void execute({ environmentId: target.environmentId, input: { _tag: "snapshot" } }).then(
      (result) => {
        if (!active) return;
        if (result._tag === "Success" && result.value.snapshot) {
          setSnapshot(result.value.snapshot);
          setMessage("");
        } else setMessage("Allocation coordinator unavailable. Reconnect to refresh.");
      },
    );
    return () => {
      active = false;
    };
  }, [target, execute]);
  const preview = async () => {
    if (!target) return;
    setBusy(true);
    const result = await execute({
      environmentId: target.environmentId,
      input: {
        _tag: "preview",
        request: {
          assignmentId: "mobile-preview",
          environmentId: target.environmentId,
          threadId: ThreadId.make("mobile-preview"),
          driver: ProviderDriverKind.make(driver),
          model,
          options: effort
            ? [{ id: driver === "codex" ? "reasoningEffort" : "effort", value: effort }]
            : [],
        },
      },
    });
    if (result._tag === "Success" && result.value.result) setDecision(result.value.result.decision);
    else setMessage("Could not preview this assignment.");
    setBusy(false);
  };
  return (
    <SettingsScreen title="Provider allocation">
      <ScrollView contentContainerClassName="gap-4 p-4">
        <Text>{target?.label ?? "Choose a connected environment in Settings."}</Text>
        <Text>
          {snapshot
            ? `${snapshot.policy.mode} · policy ${snapshot.policy.version} · ${snapshot.authorityAvailable ? "coordinator ready" : "coordinator unavailable"}`
            : "No snapshot"}
        </Text>
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => void refresh()}>
          <Text className="text-primary">Refresh allocation</Text>
        </Pressable>
        {message ? <Text accessibilityRole="alert">{message}</Text> : null}
        <Text className="font-semibold">Try an assignment</Text>
        <TextInput
          accessibilityLabel="Provider driver"
          value={driver}
          onChangeText={setDriver}
          className="rounded border border-border p-2 text-foreground"
        />
        <TextInput
          accessibilityLabel="Exact model"
          placeholder="Exact model"
          value={model}
          onChangeText={setModel}
          className="rounded border border-border p-2 text-foreground"
        />
        <TextInput
          accessibilityLabel="Reasoning effort"
          placeholder="Reasoning effort (optional)"
          value={effort}
          onChangeText={setEffort}
          className="rounded border border-border p-2 text-foreground"
        />
        <Pressable
          disabled={busy || !model || !target}
          accessibilityRole="button"
          onPress={() => void preview()}
        >
          <Text className="text-primary">Preview account</Text>
        </Pressable>
        {decision ? (
          <View>
            <Text>
              {allocationSummary(decision).choice} · {decision.confidence} confidence
            </Text>
            <Text>{decision.reasons.join(" ")}</Text>
            {decision.candidates.map((c) => (
              <Text key={`${c.environmentId}:${c.instanceId}`}>
                {c.instanceId}: {c.eligible ? "eligible" : c.reasons.join(" ")}
              </Text>
            ))}
          </View>
        ) : null}
        {snapshot?.inventories.map((host) => (
          <View key={host.environmentId} className="gap-2">
            <Text className="font-semibold">
              {host.environmentId} ·{" "}
              {host.complete ? `${host.demand.length} ongoing` : "load unknown"}
            </Text>
            {host.accounts.map((a) => (
              <View key={a.instanceId} className="gap-1 rounded border border-border p-3">
                <Text>
                  {a.label} · {a.shortWindow}
                </Text>
                {a.windows.map((w) => (
                  <Text key={w.id}>
                    {w.label}: {w.usedPoints.toFixed(1)}% used · {w.samples} samples · reset{" "}
                    {w.resetsAt ?? "unknown"}
                  </Text>
                ))}
                <Text>{a.unavailableReason ?? "Available"}</Text>
              </View>
            ))}
          </View>
        ))}
        <Text>
          Native inspection shows current windows and proposed choices. Open the web allocation page
          for charts, policy tuning, temporary targets and new-session creation.
        </Text>
        {target?.displayUrl ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => {
              const url = new URL(target.displayUrl!);
              url.protocol =
                url.protocol === "wss:"
                  ? "https:"
                  : url.protocol === "ws:"
                    ? "http:"
                    : url.protocol;
              url.pathname = "/settings/allocation";
              url.search = `?environmentId=${encodeURIComponent(EnvironmentId.make(target.environmentId))}`;
              void Linking.openURL(url.toString());
            }}
          >
            <Text className="text-primary">Open allocation policy page</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
