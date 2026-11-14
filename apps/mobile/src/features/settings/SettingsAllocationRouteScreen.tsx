import { useEffect, useState } from "react";

import { Linking, Pressable, ScrollView, View, TextInput } from "react-native";

import {
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  EnvironmentId,
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationDecision,
} from "@t3tools/contracts";

import {
  createAllocationCommands,
  allocationAccountOrder,
  allocationAccountRows,
  allocationSummary,
  allocationAccountLabel,
  withAllocationAccountGoal,
  withAllocationAccountMoved,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";

import { connectionAtomRuntime } from "../../connection/runtime";

import { useAtomCommand } from "../../state/use-atom-command";

import { AppText as Text } from "../../components/AppText";

import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

import { SettingsScreen } from "./components/SettingsScreen";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationCommands(connectionAtomRuntime);
const points = (value: number) => Number(value.toFixed(2)).toString();
const dollars = (value: number) => `$${Math.round(value).toLocaleString()}`;
const field = "rounded border border-border p-2 text-foreground";

export function SettingsAllocationRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();

  const target = selectedTargets[0];

  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const [snapshot, setSnapshot] = useState<AllocationSnapshot | null>(null);
  // When the snapshot was read: reading ages and end times are judged against it.
  const [now, setNow] = useState(0);

  const [decision, setDecision] = useState<AllocationDecision | null>(null);

  // Unsaved edits: the preference order, and the two numbers as typed.
  const [draft, setDraft] = useState<AllocationPolicy | null>(null);
  const [numbers, setNumbers] = useState<{ closeMarginPoints?: string; longWaitHours?: string }>(
    {},
  );
  // Daily goals as typed, by account row; blank uses the provider's default.
  const [goals, setGoals] = useState<Record<string, string>>({});

  const [model, setModel] = useState("");

  const [driver, setDriver] = useState("codex");

  const [effort, setEffort] = useState("");

  const [message, setMessage] = useState("");

  const [busy, setBusy] = useState(false);

  const [advanced, setAdvanced] = useState(false);

  const [showOthers, setShowOthers] = useState(false);

  const refresh = async () => {
    if (!target) return;

    setBusy(true);

    const result = await execute({
      environmentId: target.environmentId,

      input: { _tag: "snapshot" },
    });

    if (result._tag === "Success" && result.value.snapshot) {
      setSnapshot(result.value.snapshot);
      setNow(Date.now());

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
          setNow(Date.now());

          setMessage("");
        } else setMessage("Allocation coordinator unavailable. Reconnect to refresh.");
      },
    );

    return () => {
      active = false;
    };
  }, [target, execute]);

  const policy = draft ?? snapshot?.policy;
  const rows = snapshot && policy ? allocationAccountRows(snapshot, policy, now) : [];
  const ordered = policy
    ? allocationAccountOrder(
        rows.filter((row) => !row.other),
        policy,
      )
    : [];
  const others = rows.filter((row) => row.other);
  const editable = snapshot?.accountOrderSupported === true && snapshot.authorityAvailable;
  const goalsEditable = editable && snapshot?.runways !== undefined;
  const dirty = draft !== null || Object.keys(numbers).length > 0 || Object.keys(goals).length > 0;
  const numberFields = [
    {
      key: "closeMarginPoints",
      label: "Closeness margin (%)",
      help: "Accounts whose room is within this percent of the best account's count as close; among those the preference order decides.",
      fallback: DEFAULT_CLOSE_MARGIN_POINTS,
    },
    {
      key: "longWaitHours",
      label: "Long wait (hours)",
      help: "A worker that hits a limit waits for a reset within this time; a longer wait changes its model.",
      fallback: DEFAULT_LONG_WAIT_HOURS,
    },
  ] as const;

  const save = async () => {
    if (!target || !policy) return;
    const values = numberFields.map((f) => Number(numbers[f.key] ?? policy[f.key] ?? f.fallback));
    if (
      numbers.closeMarginPoints === "" ||
      numbers.longWaitHours === "" ||
      values.some(Number.isNaN)
    ) {
      setMessage("Enter a number for the margin and the long wait.");
      return;
    }
    let next: AllocationPolicy = {
      ...policy,
      closeMarginPoints: values[0]!,
      longWaitHours: values[1]!,
    };
    for (const row of rows) {
      const typed = goals[row.key];
      if (typed === undefined) continue;
      const goal = typed.trim() === "" ? undefined : Number(typed);
      if (goal !== undefined && !(goal >= 0 && goal <= 100)) {
        setMessage(`Enter a daily goal between 0 and 100 for ${row.label}, or leave it blank.`);
        return;
      }
      next = withAllocationAccountGoal(next, row, goal);
    }
    setBusy(true);
    const result = await execute({
      environmentId: target.environmentId,
      input: {
        _tag: "policy",
        input: { expectedVersion: policy.version, policy: next },
      },
    });
    if (result._tag === "Success" && result.value.policy) {
      setDraft(null);
      setNumbers({});
      setGoals({});
      await refresh();
    } else {
      setMessage("Could not save. Check the numbers, refresh and retry.");
      setBusy(false);
    }
  };

  const accountRow = (row: AllocationAccountRow, position?: number) => (
    <View key={row.key} className="gap-1 rounded border border-border p-3">
      <Text className="font-semibold">
        {position === undefined ? "" : `${position + 1}. `}
        {row.label} · {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
        {row.plan ? ` ${row.plan}` : ""} · {row.hosts.join(", ")}
      </Text>
      {position !== undefined && editable && (
        <View className="flex-row gap-4">
          {([-1, 1] as const).map((delta) => (
            <Pressable
              key={delta}
              accessibilityRole="button"
              accessibilityLabel={`Move ${row.label} ${delta < 0 ? "up" : "down"}`}
              disabled={busy || position + delta < 0 || position + delta >= ordered.length}
              onPress={() => setDraft(withAllocationAccountMoved(policy!, ordered, row.key, delta))}
            >
              <Text className="text-primary">{delta < 0 ? "Move up" : "Move down"}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {row.windows.length ? (
        row.windows.map((w) => {
          const runway = row.runway?.windows.find((r) => r.id === w.id);
          return (
            <Text key={w.id}>
              {w.label}: {points(w.usedPercent)}% used · resets{" "}
              {w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "unknown"} · read {w.age} ago
              {runway?.sizeDollars != null
                ? ` · holds about ${dollars(runway.sizeDollars)}${runway.source === "estimated" ? " (estimated)" : ""}`
                : ""}
              {runway?.goalPercent != null
                ? ` · goal ${Math.round(runway.goalPercent)}% by now`
                : ""}
            </Text>
          );
        })
      ) : (
        <Text>
          {row.capSource === "unsupported"
            ? "No subscription quota"
            : row.capSource === "probeFailed"
              ? "Quota read failed"
              : "No verified quota reading"}
        </Text>
      )}
      {row.runway && row.windows.length > 0 ? <Text>{row.runway.line}</Text> : null}
      <Text>Workers now: {row.workers}</Text>
      <View className="gap-1">
        <Text>
          Daily goal (% of the week a day)
          {row.goal && !row.goal.own ? ` · provider default ${points(row.goal.percentPerDay)}` : ""}
        </Text>
        <TextInput
          accessibilityLabel={`Daily goal for ${row.label}`}
          keyboardType="decimal-pad"
          editable={goalsEditable}
          placeholder={row.goal ? points(row.goal.percentPerDay) : "Off"}
          value={goals[row.key] ?? (row.goal?.own ? String(row.goal.percentPerDay) : "")}
          onChangeText={(value) => setGoals({ ...goals, [row.key]: value })}
          className={field}
        />
      </View>
      {row.supportsCaps && row.cap ? (
        <Text>
          Hard cap week {row.cap.weeklyPercent === null ? "off" : `${row.cap.weeklyPercent}%`}
          {row.driver === "claudeAgent"
            ? ` · 5h ${row.cap.fiveHourPercent === null ? "off" : `${row.cap.fiveHourPercent}%`}`
            : ""}{" "}
          · stops{" "}
          {[row.cap.stopWorkers ? "workers" : "", row.cap.stopMasters ? "masters" : ""]
            .filter(Boolean)
            .join(" and ") || "nothing"}
        </Text>
      ) : null}
      {row.instances.map((instance) => (
        <View key={instance.environmentId} className="flex-row items-center justify-between">
          <Text>Available for workers on {instance.computer}</Text>
          <ThemedSwitch
            accessibilityLabel={`Available for workers: ${row.label} on ${instance.computer}`}
            value={instance.workersEnabled}
            disabled={busy}
            onValueChange={async (checked) => {
              setBusy(true);
              const result = await updateSettings({
                environmentId: EnvironmentId.make(instance.environmentId),
                input: {
                  patch: {
                    workerDisabledInstanceIds: (
                      snapshot?.inventories.find(
                        (host) => host.environmentId === instance.environmentId,
                      )?.accounts ?? []
                    )
                      .filter((account) =>
                        account.instanceId === instance.instanceId
                          ? !checked
                          : account.availableForWorkers === false,
                      )
                      .map((account) => account.instanceId),
                  },
                },
              });
              if (result._tag === "Success") await refresh();
              else {
                setMessage("Could not save worker availability. Reconnect and retry.");
                setBusy(false);
              }
            }}
          />
        </View>
      ))}
    </View>
  );

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
          A worker goes to the account with the most room for its job, accounts within their daily
          goal first. A daily goal only changes which account is recommended: it never stops, queues
          or changes a start, and a pinned account over its goal starts normally. Only hard caps,
          real limits and switched-off accounts block.
        </Text>
        <Text>{target?.label ?? "Choose a connected environment in Settings."}</Text>
        <Text>
          {snapshot
            ? `Policy ${snapshot.policy.version} · ${snapshot.authorityAvailable ? "coordinator ready" : "coordinator unavailable"}`
            : "No snapshot"}
        </Text>
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => void refresh()}>
          <Text className="text-primary">Refresh allocation</Text>
        </Pressable>
        {message ? <Text accessibilityRole="alert">{message}</Text> : null}
        {snapshot && (
          <View className="gap-4">
            <Text className="font-semibold">Accounts, most preferred first</Text>
            <Text>
              {editable
                ? "The order decides only between accounts whose room is close. Hard caps are edited in the web settings page."
                : "This coordinator cannot save the order, margin or long wait yet."}
            </Text>
            {ordered.map(accountRow)}
            {others.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showOthers }}
                onPress={() => setShowOthers(!showOthers)}
              >
                <Text className="text-primary">Other accounts ({others.length})</Text>
              </Pressable>
            )}
            {showOthers && others.map((row) => accountRow(row))}
            {policy &&
              numberFields.map((f) => (
                <View key={f.key} className="gap-1">
                  <Text className="font-semibold">{f.label}</Text>
                  <Text>{f.help}</Text>
                  <TextInput
                    accessibilityLabel={f.label}
                    keyboardType="decimal-pad"
                    editable={editable}
                    value={numbers[f.key] ?? String(policy[f.key] ?? f.fallback)}
                    onChangeText={(value) => setNumbers({ ...numbers, [f.key]: value })}
                    className={field}
                  />
                </View>
              ))}
            {policy && (
              <View className="flex-row items-center justify-between">
                <Text>Fable workers</Text>
                <ThemedSwitch
                  accessibilityLabel="Fable workers"
                  value={policy.fableWorkers !== false}
                  disabled={busy || !goalsEditable}
                  onValueChange={(fableWorkers) => setDraft({ ...policy, fableWorkers })}
                />
              </View>
            )}
            <Text>
              Off: no worker runs on Fable; a table cell or pin naming Fable starts from the nearest
              rung without it.
            </Text>
            {policy && (
              <View className="flex-row items-center justify-between">
                <Text>Fable mode</Text>
                <ThemedSwitch
                  accessibilityLabel="Fable mode"
                  value={policy.fableOnly === true}
                  disabled={busy || !goalsEditable}
                  onValueChange={(fableOnly) => setDraft({ ...policy, fableOnly })}
                />
              </View>
            )}
            <Text>Workers use only Fable low, medium or high.</Text>
            {snapshot.learned ? (
              <View className="gap-1">
                <Text className="font-semibold">Learned numbers</Text>
                {snapshot.learned.costs.map((c) => (
                  <Text key={`${c.driver}:${c.model}:${c.effort}:${c.kind}`}>
                    {c.model} / {c.effort ?? "default"} {c.kind}: ${c.dollarsPerHour.toFixed(2)} an
                    hour at {Math.round(c.contextTokens / 1000)}k context · {c.samples} turns ·{" "}
                    {c.measuredShare === undefined ? c.source : `thin: ${c.basis}`}
                  </Text>
                ))}
                {snapshot.learned.limits.map((l) => (
                  <Text key={`${l.key}:${l.windowId}`}>
                    {l.label} {l.windowLabel}: holds about {dollars(100 / l.percentPerDollar)} ·
                    outside use {points(l.backgroundPercentPerHour)}% an hour · {l.samples} reading
                    pairs · {l.source}
                    {l.basis ? ` from ${l.basis}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            {dirty && (
              <View className="flex-row gap-4">
                <Pressable disabled={busy} accessibilityRole="button" onPress={() => void save()}>
                  <Text className="text-primary">Save</Text>
                </Pressable>
                <Pressable
                  disabled={busy}
                  accessibilityRole="button"
                  onPress={() => {
                    setDraft(null);
                    setNumbers({});
                    setGoals({});
                  }}
                >
                  <Text className="text-primary">Discard changes</Text>
                </Pressable>
              </View>
            )}
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

              className={field}
            />
            <TextInput
              accessibilityLabel="Reasoning effort"

              placeholder="Reasoning effort (optional)"

              value={effort}

              onChangeText={setEffort}

              className={field}
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
                    : allocationSummary(decision).choice}
                </Text>
                <Text>{decision.reasons[0]}</Text>
                {decision.candidates.map((c) => (
                  <Text key={`${c.environmentId}:${c.instanceId}`}>
                    {c.line ??
                      `${allocationAccountLabel(snapshot, c.environmentId, c.instanceId)}: ${
                        c.eligible ? "Compatible" : c.reasons.join(" ")
                      }`}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        )}
        <Text>Open the web page to edit hard caps.</Text>
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
