import { useEffect, useState } from "react";

import { Linking, Pressable, ScrollView, View, TextInput } from "react-native";

import {
  EnvironmentId,
  defaultAllocationPolicy,
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type AllocationSnapshot,
  type AllocationDecision,
} from "@t3tools/contracts";

import {
  createAllocationAtoms,
  allocationCurveFields,
  allocationAccountGroups,
  allocationAccountCap,
  allocationSubscriptionCapSource,
  allocationSupportsSubscriptionCaps,
  allocationSummary,
  allocationAccountLabel,
} from "@t3tools/client-runtime/state/provider-allocation";

import { connectionAtomRuntime } from "../../connection/runtime";

import { useAtomCommand } from "../../state/use-atom-command";

import { AppText as Text } from "../../components/ui/AppText";

import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

import { SettingsScreen } from "./components/SettingsScreen";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationAtoms(connectionAtomRuntime);

export function SettingsAllocationRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();

  const target = selectedTargets[0];

  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const [snapshot, setSnapshot] = useState<AllocationSnapshot | null>(null);

  const [decision, setDecision] = useState<AllocationDecision | null>(null);

  const [model, setModel] = useState("");

  const [driver, setDriver] = useState("codex");

  const [effort, setEffort] = useState("");

  const [message, setMessage] = useState("");

  const [busy, setBusy] = useState(false);

  const [advanced, setAdvanced] = useState(false);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the coordinator snapshot when the selected computer changes.
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
        <Text>
          Recommendations only. Quota and pacing warnings do not prevent an explicit Start; provider
          errors remain visible.
        </Text>
        <Text>{target?.label ?? "Choose a connected environment in Settings."}</Text>
        <Text>
          {snapshot
            ? `Advisory · policy ${snapshot.policy.version} · ${snapshot.authorityAvailable ? "coordinator ready" : "coordinator unavailable"}`
            : "No snapshot"}
        </Text>
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => void refresh()}>
          <Text className="text-primary">Refresh allocation</Text>
        </Pressable>
        {message ? <Text accessibilityRole="alert">{message}</Text> : null}
        {snapshot && (
          <View className="gap-4">
            <Text className="font-semibold">Usage budgets · current / default</Text>
            <Text>
              Read-only on native mobile. Edit these numbers in the web settings page. Estimates
              remain advisory.
            </Text>
            {(["codex", "claude"] as const).map((family) => (
              <View key={family} className="gap-2 rounded border border-border p-3">
                <Text className="font-semibold">{family === "codex" ? "Codex" : "Claude"}</Text>
                {allocationCurveFields.map((field) => (
                  <Text key={field.key}>
                    {field.label}:{" "}
                    {snapshot.policy[family].preset === "sustainable" &&
                    ["dailyPoints", "burstPoints", "burstHours"].includes(field.key)
                      ? "Derived per cycle"
                      : snapshot.policy[family].preset === "aggressive17" &&
                          field.key === "dailyPoints"
                        ? 17
                        : snapshot.policy[family].preset === "aggressive17" &&
                            ["burstPoints", "burstHours"].includes(field.key)
                          ? 0
                          : snapshot.policy[family][field.key]}{" "}
                    / {defaultAllocationPolicy[family][field.key]} {field.unit}
                  </Text>
                ))}
              </View>
            ))}
            <Text className="font-semibold">Account preferences</Text>
            <Text>
              Weights favor close choices within the account preference margin. The tightest
              projected budget headroom ranks accounts. Explicit valid choices always win.
            </Text>
            <Text>
              Account preference margin: {snapshot.policy.hysteresisPoints} / default{" "}
              {defaultAllocationPolicy.hysteresisPoints} points. The previous account gets this
              margin too. Edit in the web settings page.
            </Text>
            {allocationAccountGroups(snapshot, snapshot.policy).map((account) => (
              <Text key={account.key}>
                {account.label} · {PROVIDER_DISPLAY_NAMES[account.driver] ?? account.driver}: weight{" "}
                {account.weight} / default 50 · {account.share.toFixed(1)}% family share ·{" "}
                {account.hosts.join(", ")}
              </Text>
            ))}
            <Text className="font-semibold">Hard usage caps</Text>
            <Text>
              Hard caps are enforced by the server for workers and masters on this account. Edit
              thresholds and stop actions in the web settings page.
            </Text>
            {allocationAccountGroups(snapshot, snapshot.policy).map((account) => {
              const cap = allocationAccountCap(snapshot.policy, account.key);
              const capSource = allocationSubscriptionCapSource(account.members);
              if (!allocationSupportsSubscriptionCaps(account.members))
                return (
                  <Text key={`cap:${account.key}`}>
                    {account.label}:{" "}
                    {capSource === "unsupported"
                      ? "subscription quota is unsupported"
                      : "subscription quota source is not verified"}
                    ; hard caps are inactive.
                  </Text>
                );
              return (
                <Text key={`cap:${account.key}`}>
                  {account.label}: weekly{" "}
                  {cap?.weeklyPercent === null || cap?.weeklyPercent === undefined
                    ? "disabled"
                    : `${cap.weeklyPercent}%`}
                  {account.driver === "claudeAgent"
                    ? ` · Claude 5-hour ${
                        cap?.fiveHourPercent === null || cap?.fiveHourPercent === undefined
                          ? "disabled"
                          : `${cap.fiveHourPercent}%`
                      }`
                    : ""}
                  {cap
                    ? ` · stop workers ${cap.stopWorkers ? "on" : "off"} · stop masters ${cap.stopMasters ? "on" : "off"}`
                    : ""}
                  {capSource === "probeFailed"
                    ? " · quota read failed; reached caps stay enforced"
                    : ""}
                </Text>
              );
            })}
          </View>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced(!advanced)}
        >
          <Text className="text-primary">Advanced assignment simulator</Text>
        </Pressable>
        {advanced && (
          <View className="gap-3">
            <Text className="font-semibold">Try an assignment</Text>
            <View accessibilityLabel="Provider" className="flex-row flex-wrap gap-3">
              {[
                ...new Set(
                  snapshot?.inventories

                    .find((i) => i.environmentId === target?.environmentId)

                    ?.accounts.map((a) => a.driver) ?? [],
                ),
              ].map((kind) => (
                <Pressable
                  key={kind}

                  accessibilityRole="radio"

                  accessibilityState={{ selected: driver === kind }}

                  onPress={() => {
                    setDriver(kind);

                    setModel("");

                    setEffort("");

                    setDecision(null);
                  }}
                >
                  <Text className="text-primary">
                    {PROVIDER_DISPLAY_NAMES[kind] ?? "Other provider"}
                  </Text>
                </Pressable>
              ))}
            </View>
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
                  {decision.selectedInstanceId
                    ? allocationAccountLabel(
                        snapshot,
                        decision.request.environmentId,
                        decision.selectedInstanceId,
                      )
                    : allocationSummary(decision).choice}{" "}
                  · {decision.confidence} confidence
                </Text>
                <Text>{decision.reasons.join(" ")}</Text>
                {decision.candidates.map((c) => (
                  <Text key={`${c.environmentId}:${c.instanceId}`}>
                    {allocationAccountLabel(snapshot, c.environmentId, c.instanceId)}:{" "}
                    {c.eligible ? "Compatible" : c.reasons.join(" ")}
                    {c.warnings?.length ? ` - Warnings: ${c.warnings.join(" ")}` : ""}
                    {c.windows.map((w) =>
                      w.budgetHeadroomPoints === undefined ? null : (
                        <Text key={w.id}>
                          {"\n"}
                          {w.id}: observed {w.actualPoints.toFixed(1)} + running{" "}
                          {w.runningForecastPoints?.toFixed(1)} + queued/reserved{" "}
                          {w.queuedForecastPoints?.toFixed(1)} + incoming{" "}
                          {w.incomingForecastPoints?.toFixed(1)} + aggregate/reading-age allowance{" "}
                          {w.unobservedForecastPoints?.toFixed(1)}; budget{" "}
                          {w.budgetPoints?.toFixed(1)}, projected budget headroom{" "}
                          {w.budgetHeadroomPoints.toFixed(1)}
                          {w.budgetHeadroomPoints ===
                          Math.min(
                            ...c.windows.map((v) => v.budgetHeadroomPoints ?? v.headroomPoints),
                          )
                            ? " (limiting)"
                            : ""}
                          .
                        </Text>
                      ),
                    )}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        )}
        {snapshot?.inventories.map((host) => (
          <View key={host.environmentId} className="gap-2">
            <Text className="font-semibold">
              {host.environmentLabel ??
                (host.environmentId === target?.environmentId
                  ? target.label
                  : "Linked environment")}{" "}
              · {host.complete ? `${host.demand.length} ongoing` : "load unknown"}
            </Text>
            {host.accounts.map((a) => (
              <View key={a.instanceId} className="gap-1 rounded border border-border p-3">
                <Text>
                  {a.label} · {a.shortWindow}
                </Text>
                <View className="flex-row items-center justify-between">
                  <Text>Available for workers</Text>
                  <ThemedSwitch
                    accessibilityLabel={`Available for workers: ${a.label}`}
                    value={a.availableForWorkers !== false}
                    disabled={busy}
                    onValueChange={async (checked) => {
                      setBusy(true);
                      const result = await updateSettings({
                        environmentId: EnvironmentId.make(host.environmentId),
                        input: {
                          patch: {
                            workerDisabledInstanceIds: host.accounts
                              .filter((account) =>
                                account.instanceId === a.instanceId
                                  ? !checked
                                  : account.availableForWorkers === false,
                              )
                              .map((account) => account.instanceId),
                          },
                        },
                      }).catch(() => null);
                      setBusy(false);
                      if (result?._tag === "Success") await refresh();
                      else setMessage("Could not save worker availability. Reconnect and retry.");
                    }}
                  />
                </View>
                {a.windows.map((w) => (
                  <Text key={w.id}>
                    {w.label}: {w.usedPoints.toFixed(1)}% used · {w.samples} samples · reset{" "}
                    {w.resetsAt ?? "unknown"} · burn{" "}
                    {w.ratePointsPerHour === null
                      ? "Not enough data"
                      : `${w.ratePointsPerHour.toFixed(2)} allowance points/hour`}{" "}
                    ·{" "}
                    {w.rateAgeMinutes === null
                      ? "age unknown"
                      : `${w.rateAgeMinutes.toFixed(1)} minutes old at last refresh`}
                  </Text>
                ))}
                <Text>
                  {a.unavailableReason
                    ? `Observed warning: ${a.unavailableReason}`
                    : "No observed warning"}
                </Text>
              </View>
            ))}
          </View>
        ))}
        <Text>
          Native inspection shows saved budgets, account preferences and usage. Per-model allowance
          burn is not attributable from mixed account traffic. Open the web page to edit settings,
          inspect model samples and manage temporary targets.
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
