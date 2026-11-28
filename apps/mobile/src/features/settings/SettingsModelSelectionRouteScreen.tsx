import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  View,
  TextInput,
  type ScrollViewInstance,
} from "react-native";
import * as Schema from "effect/Schema";
import {
  defaultModelFallback,
  defaultModelRoutingPolicy,
  modelFallback,
  modelLadder,
  ModelRoutingRequest,
  ProviderDriverKind,
  ThreadId,
  type AllocationResponse,
  type AllocationOperation,
  type EnvironmentId,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type ModelRoutingPolicy,
  workerChoice,
  workerChoiceRequest,
} from "@t3tools/contracts";
import { createAutosave, type AutosaveState } from "@t3tools/client-runtime/state/autosave";
import {
  MODEL_DRIVERS,
  modelAutosaveRules,
  modelCatalog,
  modelCell,
  modelDriverLabel,
  modelEditorUrl,
  modelFailureMessage,
  modelPreviewKey,
  modelProfileLabel,
  setModelCell,
  summarizeModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import {
  allocationOfflineMessage,
  allocationSaveFailure,
  createAllocationCommands,
  withModelLadderEdit,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SettingsScreen } from "./components/SettingsScreen";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { useEnvironments } from "../../state/environments";
import {
  Action,
  Chip,
  ModelCellEditor,
  ModelRoutingLegend,
  ModelRoutingMatrix,
  type ModelCellPosition,
} from "./ModelRoutingTable";
const commands = createAllocationCommands(connectionAtomRuntime);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const field = "rounded border border-border bg-background p-2 text-foreground";
/** Quick changes to the table are stored together, as one version. */
const TABLE_PAUSE = 1200;
const SAVE_STATE = {
  idle: "Changes save automatically",
  editing: "Not saved yet",
  saving: "Saving…",
  saved: "Saved",
  failed: "Not saved",
  conflict: "Not saved",
} satisfies Record<AutosaveState<unknown>["phase"], string>;

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
  const [offline, setOffline] = useState<AllocationResponse["offline"]>();
  const [snapshot, setSnapshot] = useState<ModelRoutingSnapshot | null>(null);
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
  const [failedEpoch, setFailedEpoch] = useState<number | null>(null);
  // What every computer reports arrives after the saved table; the last known list stays offline.
  const [inventories, setInventories] = useState<ModelRoutingSnapshot["inventories"]>([]);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  const accountsRead = useRef(0);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  // Every change is stored as it is made; `draft` is what the screen shows and how far it got.
  const [store] = useState(() =>
    createAutosave<ModelRoutingPolicy>({
      ...modelAutosaveRules,
      save: async (policy, baseline) => {
        const result = await execute({
          environmentId,
          input: { _tag: "modelPolicy", expectedVersion: baseline.version, policy },
        });
        if (result._tag !== "Success") return allocationSaveFailure(result.cause);
        if (!result.value.modelPolicy) return allocationSaveFailure(undefined);
        setWarnings(result.value.warnings ?? []);
        return { saved: result.value.modelPolicy };
      },
      read: async () => {
        const result = await execute({
          environmentId,
          input: { _tag: "modelSnapshot", part: "settings" },
        });
        return result._tag === "Success" && !result.value.offline
          ? (result.value.modelSnapshot?.policy ?? null)
          : null;
      },
    }),
  );
  const draft = useSyncExternalStore(store.subscribe, store.getState);
  // Leaving the screen stores an edit that is still waiting.
  useEffect(() => () => store.flush(), [store]);
  const [driver, setDriver] = useState<ModelDriver>("claudeAgent");
  const [selected, setSelected] = useState<ModelCellPosition | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [alternativeOpen, setAlternativeOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rung, setRung] = useState({ model: "", effort: "" });
  // Blank is NaN. The task is tried as an agent's start would be, on the table shown.
  const [task, setTask] = useState({ difficulty: NaN, stakes: NaN, hours: NaN });
  const [preview, setPreview] = useState<{ key: string; decision: ModelRoutingDecision } | null>(
    null,
  );
  const generation = useRef(0);
  // The table can be taller than the screen, so a pick brings the editor above it into view.
  const scroller = useRef<ScrollViewInstance>(null);
  const viewport = useRef({ offset: 0, height: 0 });
  const editorBox = useRef({ y: 0, height: 0 });
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => {
      const { offset, height } = viewport.current;
      const { y, height: size } = editorBox.current;
      if (y < offset || y + size > offset + height)
        scroller.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  const policy = offline ? (snapshot?.policy ?? null) : draft.policy;
  const request = workerChoiceRequest({
    difficulty: task.difficulty,
    stakes: task.stakes,
    ...(Number.isFinite(task.hours) ? { hours: task.hours } : {}),
    environmentId,
    driver: ProviderDriverKind.make(driver),
    assignmentId: "mobile-model-preview",
    threadId: ThreadId.make("mobile-model-preview"),
  });
  const key = modelPreviewKey(
    policy ?? defaultModelRoutingPolicy,
    request,
    `${connection}:${connectionState.epoch}`,
  );
  const choice =
    preview?.key === key && connection === "connected" ? workerChoice(preview.decision) : null;
  const ladder = policy ? modelLadder(policy) : [];
  const fallback = policy ? modelFallback(policy) : null;
  const edit: typeof store.edit = (...args) => {
    if (!offline) store.edit(...args);
  };
  const stuck = draft.phase === "failed" || draft.phase === "conflict";
  const ready =
    snapshot?.authorityAvailable &&
    connection === "connected" &&
    snapshotEpoch === connectionState.epoch;
  // Only a real disconnection or a failed read is reported as one; until then it is loading.
  const loadingTable =
    connection === "connecting" ||
    (connection === "connected" &&
      snapshotEpoch !== connectionState.epoch &&
      failedEpoch !== connectionState.epoch);
  const loadingAccounts =
    accounts === "loading" && (connection === "connected" || connection === "connecting");
  const accountLabel = (host: string, instanceId: string) =>
    inventories
      .find((i) => i.environmentId === host)
      ?.accounts.find((a) => a.instanceId === instanceId)?.label ?? instanceId;
  const editorUrl = modelEditorUrl(target?.displayUrl ?? null, environmentId);
  const catalog = useMemo(
    () => modelCatalog(inventories, environmentId, driver),
    [inventories, environmentId, driver],
  );
  const { editedCells } = useMemo(() => summarizeModelDraft(draft), [draft]);
  const receive = useCallback(
    (response: AllocationResponse, epoch: number) => {
      const next = response.modelSnapshot;
      setOffline(response.offline);
      setSnapshot(next ?? null);
      setSnapshotEpoch(epoch);
      setMessage("");
      if (next && !response.offline) store.receive(next.policy);
    },
    [store, setSnapshotEpoch],
  );
  /** The accounts every computer reports; a slow computer delays only these. */
  const readAccounts = useCallback(async () => {
    const read = ++accountsRead.current;
    setAccounts("loading");
    const result = await execute({
      environmentId,
      input: { _tag: "modelSnapshot", part: "accounts" },
    });
    if (read !== accountsRead.current) return;
    if (result._tag === "Success" && result.value.modelSnapshot) {
      setInventories(result.value.modelSnapshot.inventories);
      setAccounts("loaded");
    } else setAccounts("failed");
  }, [environmentId, execute]);
  useEffect(() => {
    let active = true;
    const epoch = ++generation.current;
    // Deferred so React's effect replay cannot send a duplicate read.
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (connection !== "connected") {
        setBusy(false);
        return;
      }
      setBusy(true);
      const result = await execute({
        environmentId,
        input: { _tag: "modelSnapshot", part: "settings" },
      });
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      // Only now: the server runs one database query at a time, and this computer's inventory
      // would otherwise hold up the saved values.
      void readAccounts();
      if (result._tag === "Success") {
        receive(result.value, connectionState.epoch);
      } else {
        setFailedEpoch(connectionState.epoch);
        setMessage("The saved table could not be read. Refresh to try again.");
      }
    });
    return () => {
      active = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch, readAccounts, receive]);
  const call = async (input: AllocationOperation) => {
    const epoch = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const result = await execute({ environmentId, input });
      if (epoch !== generation.current) return null;
      if (result._tag !== "Success") {
        setPreview(null);
        setMessage(modelFailureMessage(result.cause));
        return null;
      }
      return result.value;
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const refresh = async () => {
    const epoch = ++generation.current;
    setPreview(null);
    const result = await call({ _tag: "modelSnapshot", part: "settings" });
    if (epoch !== generation.current) return;
    if (result) receive(result, connectionState.epoch);
    else setSnapshotEpoch(null);
  };
  return (
    <ScrollView
      ref={scroller}
      contentContainerClassName="gap-4 p-4"
      scrollEventThrottle={64}
      onScroll={(event) => {
        viewport.current.offset = event.nativeEvent.contentOffset.y;
      }}
      onLayout={(event) => {
        viewport.current.height = event.nativeEvent.layout.height;
      }}
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text
          accessibilityRole="summary"
          className={stuck ? "text-danger-foreground" : "text-foreground-muted"}
        >
          {loadingTable
            ? "Loading…"
            : connection !== "connected"
              ? `Not connected${draft.saved ? ": showing the last known table" : ""}`
              : offline
                ? "Read only"
                : SAVE_STATE[draft.phase]}
          {accounts === "failed" ? " · accounts not read" : ""}
        </Text>
        <Action
          label="Refresh"
          onPress={() => void refresh().then(readAccounts)}
          disabled={busy || connection !== "connected"}
        />
      </View>
      {message ? <Text accessibilityRole="alert">{message}</Text> : null}
      {offline ? <Text accessibilityRole="alert">{allocationOfflineMessage(offline)}</Text> : null}
      {!offline && connection === "connected" && snapshot && !snapshot.authorityAvailable ? (
        <Text accessibilityRole="alert">The computer that keeps this table is not reachable.</Text>
      ) : null}
      {draft.phase === "failed" && (
        <View accessibilityRole="alert" className="gap-2 rounded border border-border p-3">
          <Text className="text-danger-foreground">Not saved</Text>
          <Text>{draft.error}</Text>
          <View className="flex-row gap-4">
            <Action label="Try again" disabled={Boolean(offline)} onPress={store.retry} />
            <Action label="Drop my change" onPress={() => store.resolve(false)} />
          </View>
        </View>
      )}
      {draft.phase === "conflict" && (
        <View accessibilityRole="alert" className="gap-2 rounded border border-warning-border p-3">
          <Text className="text-warning-foreground">Changed elsewhere while you edited</Text>
          <View className="flex-row gap-4">
            <Action
              label="Keep mine"
              disabled={Boolean(offline)}
              onPress={() => store.resolve(true)}
            />
            <Action label="Use theirs" onPress={() => store.resolve(false)} />
          </View>
        </View>
      )}
      {warnings.map((warning) => (
        <Text key={warning} className="text-warning-foreground">
          {warning}
        </Text>
      ))}
      <View className="flex-row flex-wrap gap-2" accessibilityRole="tablist">
        {MODEL_DRIVERS.map((d) => (
          <Pressable
            key={d}
            accessibilityRole="tab"
            accessibilityState={{ selected: driver === d }}
            onPress={() => {
              setDriver(d);
              setPendingModel(null);
            }}
            className={`rounded-full border px-4 py-2 ${driver === d ? "border-primary bg-primary" : "border-border"}`}
          >
            <Text className={driver === d ? "text-primary-foreground" : "text-foreground"}>
              {modelDriverLabel(d)}
              {stuck && editedCells(d) > 0 ? ` (${editedCells(d)} not saved)` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      {policy ? (
        <View
          className="gap-4"
          pointerEvents={offline ? "none" : "auto"}
          accessibilityState={{ disabled: Boolean(offline) }}
        >
          <View
            onLayout={(event) => {
              editorBox.current = {
                y: event.nativeEvent.layout.y,
                height: event.nativeEvent.layout.height,
              };
            }}
          >
            <ModelCellEditor
              driver={driver}
              position={selected}
              cell={
                selected ? modelCell(policy, driver, selected.difficulty, selected.stakes) : null
              }
              catalog={catalog}
              alternativeOpen={alternativeOpen}
              onAlternativeOpen={setAlternativeOpen}
              loadingAccounts={loadingAccounts}
              pendingModel={pendingModel}
              onPendingModel={setPendingModel}
              onChange={(cell) => {
                if (!selected) return;
                setPendingModel(null);
                edit(
                  (p) => setModelCell(p, driver, selected.difficulty, selected.stakes, cell),
                  TABLE_PAUSE,
                );
              }}
            />
          </View>
          <ModelRoutingMatrix
            driver={driver}
            policy={policy}
            baseline={draft.baseline}
            catalog={catalog}
            selected={selected}
            onSelect={(cell) => {
              setSelected(cell);
              setPendingModel(null);
            }}
          />
          <ModelRoutingLegend driver={driver} policy={policy} />
          <Text className="font-t3-medium">
            Claude ladder <Text className="text-foreground-muted">weakest first</Text>
          </Text>
          {ladder.map((r, index) => (
            <View key={modelProfileLabel(r)} className="flex-row flex-wrap gap-4">
              <Text className="flex-1">
                {index + 1}. {modelProfileLabel(r)}
              </Text>
              <Action
                label="Up"
                disabled={index === 0}
                onPress={() =>
                  edit((p) => withModelLadderEdit(p, { type: "move", index, delta: -1 }))
                }
              />
              <Action
                label="Down"
                disabled={index === ladder.length - 1}
                onPress={() =>
                  edit((p) => withModelLadderEdit(p, { type: "move", index, delta: 1 }))
                }
              />
              <Action
                label="Remove"
                onPress={() => edit((p) => withModelLadderEdit(p, { type: "remove", index }))}
              />
            </View>
          ))}
          <TextInput
            accessibilityLabel="New rung model"
            placeholder="Model ID"
            autoCapitalize="none"
            autoCorrect={false}
            className={field}
            value={rung.model}
            onChangeText={(model) => setRung({ ...rung, model: model.trim() })}
          />
          <TextInput
            accessibilityLabel="New rung effort"
            placeholder="Effort"
            autoCapitalize="none"
            autoCorrect={false}
            className={field}
            value={rung.effort}
            onChangeText={(effort) => setRung({ ...rung, effort: effort.trim() })}
          />
          <Action
            label="Add as strongest rung"
            disabled={
              !rung.model ||
              !rung.effort ||
              ladder.some((r) => modelProfileLabel(r) === modelProfileLabel(rung))
            }
            onPress={() => {
              edit((p) => withModelLadderEdit(p, { type: "add", rung }));
              setRung({ model: "", effort: "" });
            }}
          />
          <View className="flex-row items-center justify-between gap-4">
            <Text className="flex-1 font-t3-medium">Fallback model</Text>
            <ThemedSwitch
              accessibilityLabel="Fallback model"
              value={fallback !== null}
              onValueChange={(on) =>
                edit((p) => ({ ...p, fallback: on ? defaultModelFallback : null }))
              }
            />
          </View>
          {fallback && (
            <>
              {/* A half-typed model ID must not become the fallback: it waits for its field. */}
              <TextInput
                accessibilityLabel="Fallback model ID"
                placeholder="Model ID"
                autoCapitalize="none"
                autoCorrect={false}
                className={field}
                value={fallback.model}
                onChangeText={(model) =>
                  edit((p) => ({ ...p, fallback: { ...fallback, model: model.trim() } }), null)
                }
                onEndEditing={store.flush}
              />
              <TextInput
                accessibilityLabel="Fallback effort"
                placeholder="Effort"
                autoCapitalize="none"
                autoCorrect={false}
                className={field}
                value={fallback.effort}
                onChangeText={(effort) =>
                  edit((p) => ({ ...p, fallback: { ...fallback, effort: effort.trim() } }), null)
                }
                onEndEditing={store.flush}
              />
              <Text className="text-foreground-muted">Used below rung</Text>
              <View className="flex-row flex-wrap gap-2">
                {(ladder.some((r) => modelProfileLabel(r) === modelProfileLabel(fallback.below))
                  ? ladder
                  : [fallback.below, ...ladder]
                ).map((r) => (
                  <Chip
                    key={modelProfileLabel(r)}
                    label={modelProfileLabel(r)}
                    active={modelProfileLabel(r) === modelProfileLabel(fallback.below)}
                    onPress={() =>
                      edit((p) => ({
                        ...p,
                        fallback: { ...fallback, below: { model: r.model, effort: r.effort } },
                      }))
                    }
                  />
                ))}
              </View>
            </>
          )}
        </View>
      ) : null}
      <Action
        label={taskOpen ? "Hide: Try a task" : "Try a task"}
        onPress={() => setTaskOpen(!taskOpen)}
      />
      {taskOpen && (
        <View className="gap-3">
          {(
            [
              ["difficulty", "Difficulty (0–10)"],
              ["stakes", "Stakes (0–10)"],
              ["hours", "Job length (hours)"],
            ] as const
          ).map(([name, caption]) => (
            <View key={name} className="gap-2">
              <Text>{caption}</Text>
              <TextInput
                accessibilityLabel={caption}
                className={field}
                keyboardType={name === "hours" ? "decimal-pad" : "number-pad"}
                value={Number.isFinite(task[name]) ? String(task[name]) : ""}
                onChangeText={(value) => setTask({ ...task, [name]: value ? Number(value) : NaN })}
              />
            </View>
          ))}
          <Action
            label="Try"
            onPress={() => {
              if (!policy) return;
              try {
                decodeRequest(request);
              } catch {
                setMessage(
                  "Give difficulty and stakes as whole numbers from 0 to 10, and a job length of up to 168 hours.",
                );
                return;
              }
              const captured = key;
              void call({ _tag: "modelPreview", request, policy }).then((result) => {
                if (result?.selection) setPreview({ key: captured, decision: result.selection });
              });
            }}
            disabled={busy || !ready}
          />
          {choice && (
            <View className="gap-2">
              <Text>
                {choice.chosen
                  ? `${accountLabel(environmentId, choice.chosen.instanceId)} · ${choice.chosen.model} / ${choice.chosen.effort ?? "default"}`
                  : choice.state === "drained"
                    ? `Used up until ${choice.drainedUntil ? new Date(choice.drainedUntil).toLocaleString() : "an unknown reset"}`
                    : "No account can run it"}
              </Text>
              <Text>{choice.reason}</Text>
            </View>
          )}
        </View>
      )}
      <Action
        label={historyOpen ? "Hide: Recent decisions" : "Recent decisions"}
        onPress={() => setHistoryOpen(!historyOpen)}
      />
      {historyOpen &&
        (snapshot?.history.length ? (
          snapshot.history.slice(0, 10).map((d) => {
            const decided = workerChoice(d);
            return (
              <View key={`${d.at}:${d.request.assignmentId}`} className="gap-1">
                <Text className="font-t3-medium">
                  {new Date(d.at).toLocaleString()} · difficulty {d.request.assessment.difficulty} ·
                  stakes {d.request.assessment.stakes}
                </Text>
                <Text>
                  {decided.chosen
                    ? `${accountLabel(d.request.environmentId, decided.chosen.instanceId)} · ${decided.chosen.model} / ${decided.chosen.effort ?? "default"}`
                    : decided.state === "drained"
                      ? "Used up: nothing started"
                      : "No account: nothing started"}
                </Text>
                {d.reasons.map((reason) => (
                  <Text key={reason} className="text-foreground-muted">
                    {reason}
                  </Text>
                ))}
              </View>
            );
          })
        ) : (
          <Text className="text-foreground-muted">No decisions recorded yet.</Text>
        ))}
      {editorUrl ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(editorUrl)}>
          <Text className="text-primary">Earlier versions: open the web editor</Text>
        </Pressable>
      ) : (
        <Text className="text-foreground-muted">Earlier versions are in the web client.</Text>
      )}
    </ScrollView>
  );
}
