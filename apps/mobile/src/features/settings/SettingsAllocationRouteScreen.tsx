import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { Linking, Pressable, ScrollView, View, TextInput } from "react-native";

import {
  DEFAULT_CLOSE_MARGIN_POINTS,
  DEFAULT_LONG_WAIT_HOURS,
  DEFAULT_MEMORY_KILL_HOLD_MINUTES,
  DEFAULT_SESSION_RESERVE_GIB,
  DEFAULT_MIN_FREE_MEMORY_GIB,
  DEFAULT_START_SETTLE_MINUTES,
  DEFAULT_WORKER_MEMORY_GIB,
  EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type AllocationPolicy,
  type AllocationSnapshot,
} from "@t3tools/contracts";

import { createAutosave, type AutosaveState } from "@t3tools/client-runtime/state/autosave";
import {
  createAllocationCommands,
  allocationAccountOrder,
  allocationAccountRows,
  allocationAutosaveRules,
  allocationPolicyChanges,
  allocationSaveFailure,
  withAllocationAccountFableMode,
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

type Target = ReturnType<typeof useSettingsEnvironmentFilter>["selectedTargets"][number];

const commands = createAllocationCommands(connectionAtomRuntime);
const points = (value: number) => Number(value.toFixed(2)).toString();
const dollars = (value: number) => `$${Math.round(value).toLocaleString()}`;
const field = "w-20 rounded border border-border px-2 py-1 text-foreground";
/** How long typing may pause before a number is stored. */
const TYPING_PAUSE = 1000;
const SAVE_STATE = {
  idle: "Changes save automatically",
  editing: "Not saved yet",
  saving: "Saving…",
  saved: "Saved",
  failed: "Not saved",
  conflict: "Not saved",
} satisfies Record<AutosaveState<unknown>["phase"], string>;
/** The numbers of the ranking, and the five behind which computer a new worker starts on. */
const RULES = [
  {
    key: "closeMarginPoints",
    label: "Close-call margin",
    unit: "%",
    initial: DEFAULT_CLOSE_MARGIN_POINTS,
  },
  {
    key: "longWaitHours",
    label: "Wait for a reset",
    unit: "hours",
    initial: DEFAULT_LONG_WAIT_HOURS,
  },
] as const;
const COMPUTER_RULES = [
  {
    key: "workerMemoryGiB",
    label: "Worker memory",
    unit: "GiB",
    initial: DEFAULT_WORKER_MEMORY_GIB,
  },
  {
    key: "startSettleMinutes",
    label: "Start settle time",
    unit: "minutes",
    initial: DEFAULT_START_SETTLE_MINUTES,
  },
  {
    key: "sessionReserveGiB",
    label: "Session reserve",
    unit: "GiB",
    initial: DEFAULT_SESSION_RESERVE_GIB,
  },
  {
    key: "minFreeMemoryGiB",
    label: "Minimum free memory",
    unit: "GiB",
    initial: DEFAULT_MIN_FREE_MEMORY_GIB,
  },
  {
    key: "memoryKillHoldMinutes",
    label: "Memory kill hold",
    unit: "minutes",
    initial: DEFAULT_MEMORY_KILL_HOLD_MINUTES,
  },
] as const;
type Rule = (typeof RULES)[number] | (typeof COMPUTER_RULES)[number];

export function SettingsAllocationRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const target = selectedTargets[0];
  return (
    <SettingsScreen title="Provider allocation">
      {target ? (
        <AllocationEditor key={target.environmentId} target={target} />
      ) : (
        <Text className="p-4">Choose a connected environment in Settings.</Text>
      )}
    </SettingsScreen>
  );
}

function AllocationEditor({ target }: { target: Target }) {
  const environmentId = target.environmentId;
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  // The saved settings, then what every computer reports: the settings never wait for it.
  const [settings, setSettings] = useState<AllocationSnapshot | null>(null);
  const [reported, setReported] = useState<AllocationSnapshot | null>(null);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  // When the accounts were read: reading ages and resets are judged against it.
  const [now, setNow] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A number as typed, while its field has the focus: "4." must stay "4." until it is "4.5".
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  // Every change is stored as it is made; `saving` is what the screen shows and how far it got.
  const [store] = useState(() =>
    createAutosave<AllocationPolicy>({
      ...allocationAutosaveRules,
      save: async (policy, baseline) => {
        const result = await execute({
          environmentId,
          input: { _tag: "policy", input: { expectedVersion: baseline.version, policy } },
        });
        if (result._tag !== "Success") return allocationSaveFailure(result.cause);
        return result.value.policy
          ? { saved: result.value.policy }
          : allocationSaveFailure(undefined);
      },
      read: async () => {
        const result = await execute({
          environmentId,
          input: { _tag: "snapshot", part: "settings" },
        });
        return result._tag === "Success" ? (result.value.snapshot?.policy ?? null) : null;
      },
    }),
  );
  const saving = useSyncExternalStore(store.subscribe, store.getState);
  // Leaving the screen stores an edit that is still waiting.
  useEffect(() => () => store.flush(), [store]);
  const policy = saving.policy;
  const snapshot = settings && {
    ...settings,
    policy: saving.saved ?? settings.policy,
    inventories: reported?.inventories ?? [],
    runways: reported?.runways ?? settings.runways,
  };

  /**
   * Reads the saved settings, then the accounts; `isActive` drops a stale answer. The server runs
   * one database query at a time, so reading the accounts first would hold up the settings.
   */
  const read = useCallback(
    (isActive: () => boolean) =>
      execute({ environmentId, input: { _tag: "snapshot", part: "settings" } }).then((result) => {
        if (!isActive()) return;
        if (result._tag === "Success" && result.value.snapshot) {
          setSettings(result.value.snapshot);
          store.receive(result.value.snapshot.policy);
          setNow((current) => current || Date.now());
          setMessage("");
        } else setMessage("The computer that keeps these settings did not answer.");
        void execute({ environmentId, input: { _tag: "snapshot", part: "accounts" } }).then(
          (accounts) => {
            if (!isActive()) return;
            if (accounts._tag === "Success" && accounts.value.snapshot) {
              setReported(accounts.value.snapshot);
              setNow(Date.now());
              setAccounts("loaded");
            } else setAccounts("failed");
          },
        );
      }),
    [environmentId, execute, store],
  );
  const refresh = async () => {
    setBusy(true);
    setAccounts("loading");
    await read(() => true);
    setBusy(false);
  };
  useEffect(() => {
    let active = true;
    void read(() => active);
    return () => {
      active = false;
    };
  }, [read]);

  const rows = snapshot && policy ? allocationAccountRows(snapshot, policy, now) : [];
  const usable = rows.filter((row) => !row.other);
  const ordered = policy ? allocationAccountOrder(usable, policy) : [];
  const others = rows.filter((row) => row.other);
  const editable = snapshot?.accountOrderSupported === true && snapshot.authorityAvailable;
  const goalsEditable = editable && snapshot?.runways !== undefined;
  const stuck = saving.phase === "failed" || saving.phase === "conflict";
  // What is shown but not stored, as `allocationPolicyChanges` names it.
  const notSaved =
    stuck && saving.saved && policy
      ? allocationPolicyChanges(saving.saved, policy)
      : new Set<string>();
  const unsaved = <Text className="text-danger-foreground">Not saved</Text>;
  const toggle = (section: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  const fold = (section: string, title: string, children: () => ReactNode) => (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open.has(section) }}
        onPress={() => toggle(section)}
      >
        <Text className="text-primary">{title}</Text>
      </Pressable>
      {open.has(section) ? children() : null}
    </View>
  );
  /** A number that is stored a moment after the typing stops, or when its field is left. */
  const numberInput = (input: {
    id: string;
    label: string;
    value: number | undefined;
    placeholder?: string;
    editable: boolean | undefined;
    onChange: (value: number | undefined) => void;
  }) => (
    <TextInput
      accessibilityLabel={input.label}
      keyboardType="decimal-pad"
      editable={input.editable === true}
      placeholder={input.placeholder}
      value={
        typed[input.id] ??
        (input.value === undefined || Number.isNaN(input.value) ? "" : String(input.value))
      }
      onChangeText={(text) => {
        setTyped((current) => ({ ...current, [input.id]: text }));
        input.onChange(text.trim() === "" ? undefined : Number(text));
      }}
      onEndEditing={() => {
        setTyped(({ [input.id]: _left, ...rest }) => rest);
        store.flush();
      }}
      className={field}
    />
  );
  const rule = (item: Rule) => (
    <View key={item.key} className="gap-1">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1">{item.label}</Text>
        {numberInput({
          id: item.key,
          label: item.label,
          value: policy?.[item.key] ?? item.initial,
          editable,
          onChange: (value = Number.NaN) =>
            store.edit((current) => ({ ...current, [item.key]: value }), TYPING_PAUSE),
        })}
        <Text className="w-14 text-foreground-muted">{item.unit}</Text>
      </View>
      {notSaved.has(item.key) ? unsaved : null}
    </View>
  );

  const accountRow = (row: AllocationAccountRow, position?: number) => (
    <View key={row.key} className="gap-2 rounded border border-border p-3">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1">
          <Text className="font-semibold">
            {position === undefined ? "" : `${position + 1}. `}
            {row.label}
          </Text>
          <Text className="text-foreground-muted">
            {PROVIDER_DISPLAY_NAMES[row.driver] ?? row.driver}
            {row.plan ? ` ${row.plan}` : ""} · {row.hosts.join(", ")}
          </Text>
        </View>
        {position !== undefined && editable
          ? ([-1, 1] as const).map((delta) => (
              <Pressable
                key={delta}
                accessibilityRole="button"
                accessibilityLabel={`Move ${row.label} ${delta < 0 ? "up" : "down"}`}
                disabled={position + delta < 0 || position + delta >= ordered.length}
                onPress={() =>
                  store.edit((current) =>
                    withAllocationAccountMoved(current, usable, row.key, delta),
                  )
                }
              >
                <Text className="px-2 text-primary">{delta < 0 ? "▲" : "▼"}</Text>
              </Pressable>
            ))
          : null}
      </View>
      {position !== undefined && notSaved.has("accountOrder") ? unsaved : null}
      {row.windows.map((w) => (
        <View key={w.id} className="flex-row gap-3">
          <Text className="flex-1">{w.label}</Text>
          <Text className="font-semibold">{Math.round(w.usedPercent * 10) / 10}%</Text>
          <Text className="w-28 text-foreground-muted">
            {w.resetIn ?? "no reset time"}
            {w.stale ? " · old" : ""}
          </Text>
        </View>
      ))}
      {row.notice ? (
        <Text className={row.windows.length ? "text-warning-foreground" : "text-foreground-muted"}>
          {row.notice}
        </Text>
      ) : null}
      {row.instances.map((instance) => (
        <View key={instance.environmentId} className="flex-row items-center justify-between">
          <Text>
            Workers on {instance.computer}
            {row.workers > 0 ? ` · ${row.workers} running` : ""}
          </Text>
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
                setMessage(`Workers on ${instance.computer} for ${row.label}: not saved.`);
                setBusy(false);
              }
            }}
          />
        </View>
      ))}
      {row.fableMode !== null ? (
        <View className="flex-row items-center justify-between">
          <Text>Fable mode</Text>
          <ThemedSwitch
            accessibilityLabel={`Fable mode: ${row.label}`}
            value={row.fableMode}
            disabled={!goalsEditable}
            onValueChange={(on) =>
              store.edit((current) => withAllocationAccountFableMode(current, snapshot, row, on))
            }
          />
        </View>
      ) : null}
      {row.fableMode !== null && (notSaved.has("fableAccounts") || notSaved.has("fableOnly"))
        ? unsaved
        : null}
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1">Daily goal</Text>
        {numberInput({
          id: `goal:${row.key}`,
          label: `Daily goal for ${row.label}`,
          value: row.goal?.own ? row.goal.percentPerDay : undefined,
          placeholder: row.goal ? points(row.goal.percentPerDay) : "Off",
          editable: goalsEditable,
          onChange: (value) =>
            store.edit((current) => withAllocationAccountGoal(current, row, value), TYPING_PAUSE),
        })}
        <Text className="w-14 text-foreground-muted">%</Text>
      </View>
      {row.keys.some((key) => notSaved.has(`goal:${key}`)) ? unsaved : null}
      {row.supportsCaps && row.cap ? (
        <Text className="text-foreground-muted">
          Hard cap week {row.cap.weeklyPercent === null ? "off" : `${row.cap.weeklyPercent}%`}
          {row.driver === "claudeAgent"
            ? ` · 5h ${row.cap.fiveHourPercent === null ? "off" : `${row.cap.fiveHourPercent}%`}`
            : ""}{" "}
          · stops{" "}
          {[row.cap.stopWorkers ? "workers" : "", row.cap.stopMasters ? "masters" : ""]
            .filter(Boolean)
            .join(" and ") || "nobody"}
        </Text>
      ) : null}
    </View>
  );

  return (
    <ScrollView contentContainerClassName="gap-4 p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text
          accessibilityRole="summary"
          className={stuck ? "text-danger-foreground" : "text-foreground-muted"}
        >
          {snapshot ? SAVE_STATE[saving.phase] : message ? "Not loaded" : "Loading…"}
        </Text>
        <Pressable disabled={busy} accessibilityRole="button" onPress={() => void refresh()}>
          <Text className="text-primary">Refresh</Text>
        </Pressable>
      </View>
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      {snapshot && !snapshot.authorityAvailable ? (
        <Text accessibilityRole="alert">
          The computer that keeps these settings is not reachable.
        </Text>
      ) : null}
      {saving.phase === "failed" ? (
        <View accessibilityRole="alert" className="gap-2 rounded border border-border p-3">
          <Text className="text-danger-foreground">Not saved</Text>
          <Text>{saving.error}</Text>
          <View className="flex-row gap-4">
            <Pressable accessibilityRole="button" onPress={store.retry}>
              <Text className="text-primary">Try again</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => store.resolve(false)}>
              <Text className="text-primary">Drop my change</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {saving.phase === "conflict" ? (
        <View accessibilityRole="alert" className="gap-2 rounded border border-border p-3">
          <Text className="text-warning-foreground">Changed elsewhere while you edited</Text>
          <View className="flex-row gap-4">
            <Pressable accessibilityRole="button" onPress={() => store.resolve(true)}>
              <Text className="text-primary">Keep mine</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => store.resolve(false)}>
              <Text className="text-primary">Use theirs</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {snapshot && policy ? (
        <View className="gap-4">
          <Text className="font-semibold">Accounts</Text>
          {snapshot.accountOrderSupported !== true ? (
            <Text className="text-warning-foreground">
              The computer that keeps these settings needs an update before they can be edited.
            </Text>
          ) : null}
          {rows.length === 0 ? (
            <Text className="text-foreground-muted">
              {accounts === "loading"
                ? "Loading accounts…"
                : accounts === "failed"
                  ? "Accounts could not be read."
                  : "No accounts reported."}
            </Text>
          ) : null}
          {ordered.map(accountRow)}
          {others.length > 0
            ? fold("others", `Other accounts (${others.length})`, () =>
                others.map((row) => accountRow(row)),
              )
            : null}
          <Text className="font-semibold">Rules</Text>
          {RULES.map(rule)}
          <View className="gap-1">
            <View className="flex-row items-center justify-between">
              <Text>Fable workers</Text>
              <ThemedSwitch
                accessibilityLabel="Fable workers"
                value={policy.fableWorkers !== false}
                disabled={!goalsEditable}
                onValueChange={(fableWorkers) =>
                  store.edit((current) => ({ ...current, fableWorkers }))
                }
              />
            </View>
            {notSaved.has("fableWorkers") ? unsaved : null}
          </View>
          {fold("computer", "Computer for a new worker", () => COMPUTER_RULES.map(rule))}
          {snapshot.learned
            ? fold("learned", "Learned numbers", () => (
                <View className="gap-1">
                  {snapshot.learned!.costs.map((c) => (
                    <Text key={`${c.driver}:${c.model}:${c.effort}:${c.kind}`}>
                      {c.model} / {c.effort ?? "default"} {c.kind}: ${c.dollarsPerHour.toFixed(2)}{" "}
                      an hour at {Math.round(c.contextTokens / 1000)}k context · {c.samples} turns ·{" "}
                      {c.measuredShare === undefined ? c.source : `thin: ${c.basis}`}
                    </Text>
                  ))}
                  {snapshot.learned!.limits.map((l) => (
                    <Text key={`${l.key}:${l.windowId}`}>
                      {l.label} {l.windowLabel}: holds about {dollars(100 / l.percentPerDollar)} ·
                      outside use {points(l.backgroundPercentPerHour)}% an hour · {l.samples}{" "}
                      reading pairs · {l.source}
                      {l.basis ? ` from ${l.basis}` : ""}
                    </Text>
                  ))}
                </View>
              ))
            : null}
        </View>
      ) : null}
      {target.displayUrl ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            const url = new URL(target.displayUrl!);
            url.protocol =
              url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
            url.pathname = "/settings/allocation";
            url.search = `?environmentId=${encodeURIComponent(EnvironmentId.make(environmentId))}`;
            void Linking.openURL(url.toString());
          }}
        >
          <Text className="text-primary">Edit hard caps on the web page</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
