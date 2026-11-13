import { useEffect, useMemo, useRef, useState } from "react";
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
  MODEL_SCORING_RUBRIC,
  modelFallback,
  modelLadder,
  ModelRoutingRequest,
  ProviderDriverKind,
  ThreadId,
  type AllocationOperation,
  type EnvironmentId,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type ModelRoutingPolicy,
  workerChoice,
} from "@t3tools/contracts";
import {
  MODEL_DRIVERS,
  acknowledgeModelSave,
  discardModelDraft,
  editModelDraft,
  emptyModelDraft,
  modelCatalog,
  modelCell,
  modelCellChanges,
  modelCellSummary,
  modelDriverLabel,
  modelEditorUrl,
  modelFailureMessage,
  modelPreviewKey,
  modelProfileLabel,
  rebaseModelDraft,
  receiveSavedModelPolicy,
  resetModelTable,
  setModelCell,
  summarizeModelDraft,
  type ModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import {
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
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(emptyModelDraft);
  const [driver, setDriver] = useState<ModelDriver>("codex");
  const [selected, setSelected] = useState<ModelCellPosition | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [alternativeOpen, setAlternativeOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [rung, setRung] = useState({ model: "", effort: "" });
  const [assessment, setAssessment] = useState({ difficulty: NaN, stakes: NaN });
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
  const policy = draft.policy;
  const request: ModelRoutingRequest = {
    selection: "automatic",
    assignmentId: "mobile-model-preview",
    threadId: ThreadId.make("mobile-model-preview"),
    environmentId,
    allowedDrivers: [ProviderDriverKind.make(driver)],
    assessment,
    ...(snapshot ? { policyVersion: snapshot.policy.version } : {}),
  };
  const key = modelPreviewKey(
    policy ?? defaultModelRoutingPolicy,
    request,
    `${connection}:${connectionState.epoch}`,
  );
  const choice =
    preview?.key === key && connection === "connected" ? workerChoice(preview.decision) : null;
  const ladder = policy ? modelLadder(policy) : [];
  const fallback = policy ? modelFallback(policy) : null;
  const edit = (update: (policy: ModelRoutingPolicy) => ModelRoutingPolicy) =>
    setDraft((current) => editModelDraft(current, update));
  const ready =
    snapshot?.authorityAvailable &&
    connection === "connected" &&
    snapshotEpoch === connectionState.epoch;
  const editorUrl = modelEditorUrl(target?.displayUrl ?? null, environmentId);
  const catalog = useMemo(
    () => modelCatalog(snapshot?.inventories ?? [], environmentId, driver),
    [snapshot, environmentId, driver],
  );
  const {
    dirty,
    stale,
    count: changeCount,
    editedCells,
  } = useMemo(() => summarizeModelDraft(draft), [draft]);
  const at = (p: ModelDraft["policy"]) =>
    p && selected ? modelCell(p, driver, selected.difficulty, selected.stakes) : null;
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
      const result = await execute({ environmentId, input: { _tag: "modelSnapshot" } });
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      if (result._tag === "Success" && result.value.modelSnapshot) {
        const next = result.value.modelSnapshot;
        setSnapshot(next);
        setSnapshotEpoch(connectionState.epoch);
        setDraft((current) => receiveSavedModelPolicy(current, next.policy));
        setMessage("");
      } else setMessage("Coordinator unavailable. Reconnect and refresh; your changes are kept.");
    });
    return () => {
      active = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch]);
  const call = async (input: AllocationOperation, keepMessage = false) => {
    const epoch = generation.current;
    setBusy(true);
    if (!keepMessage) setMessage("");
    try {
      const result = await execute({ environmentId, input });
      if (epoch !== generation.current) return null;
      if (result._tag !== "Success") {
        setPreview(null);
        setMessage(
          `${modelFailureMessage(result.cause)} Your changes are kept; reconnect, refresh the saved version and try again.`,
        );
        return null;
      }
      return result.value;
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const refresh = async (keepMessage = false) => {
    const epoch = ++generation.current;
    setPreview(null);
    const result = await call({ _tag: "modelSnapshot" }, keepMessage);
    if (epoch !== generation.current || !result?.modelSnapshot) return;
    const next = result.modelSnapshot;
    setSnapshot(next);
    setSnapshotEpoch(connectionState.epoch);
    setDraft((current) => receiveSavedModelPolicy(current, next.policy));
  };
  const save = async () => {
    if (!policy || !draft.baseline) return;
    const epoch = generation.current;
    setWarnings([]);
    const result = await call({
      _tag: "modelPolicy",
      expectedVersion: draft.baseline.version,
      policy,
    });
    if (epoch !== generation.current) return;
    if (!result?.modelPolicy) {
      // A conflict means a newer version exists: reload it so the page can offer the merge.
      if (result === null) await refresh(true);
      return;
    }
    setDraft((current) => acknowledgeModelSave(current, policy, result.modelPolicy!));
    setPendingModel(null);
    await refresh();
    setMessage(`Saved as version ${result.modelPolicy.version}.`);
    setWarnings(result.warnings ?? []);
  };
  const example = policy ? modelCellSummary(modelCell(policy, driver, 7, 8)) : "";
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
      <Text>{target?.label ?? "Selected environment"}</Text>
      <Text>
        Columns are an assignment&apos;s difficulty and rows its stakes, each scored 0–10; a cell is
        the model and reasoning it gets. Example: difficulty 7 with stakes 8 gets{" "}
        {example || "the choice shown in that cell"}.
      </Text>
      <Text>{message}</Text>
      {warnings.map((warning) => (
        <Text key={warning} className="text-warning-foreground">
          {warning}
        </Text>
      ))}
      <Text className="text-foreground-muted">
        {draft.saved ? `Saved version ${draft.saved.version}` : "Saved table not loaded"} ·{" "}
        {ready
          ? "Coordinator connected"
          : "Coordinator not connected: showing the last known table"}{" "}
        ·{" "}
        {dirty
          ? `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`
          : "No unsaved changes"}
      </Text>
      {stale && draft.saved && draft.baseline && (
        <View className="gap-2 rounded border border-warning-border p-3">
          <Text className="text-warning-foreground">
            Version {draft.saved.version} was saved while you were editing. Your edits are based on
            version {draft.baseline.version}.
          </Text>
          <Action
            label={`Keep my edits on version ${draft.saved.version}`}
            onPress={() => setDraft(rebaseModelDraft)}
            disabled={busy}
          />
          <Action label="Discard my edits" onPress={() => setDraft(discardModelDraft)} />
        </View>
      )}
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
              {editedCells(d) > 0 ? ` (${editedCells(d)} edited)` : ""}
            </Text>
          </Pressable>
        ))}
      </View>
      {policy ? (
        <>
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
              cell={at(policy)}
              saved={at(draft.baseline)}
              catalog={catalog}
              alternativeOpen={alternativeOpen}
              onAlternativeOpen={setAlternativeOpen}
              pendingModel={pendingModel}
              onPendingModel={setPendingModel}
              onChange={(cell) => {
                if (!selected) return;
                setPendingModel(null);
                setDraft((current) =>
                  editModelDraft(current, (p) =>
                    setModelCell(p, driver, selected.difficulty, selected.stakes, cell),
                  ),
                );
              }}
            />
          </View>
          <View className="flex-row flex-wrap gap-4">
            <Action
              label="Save table"
              onPress={() => void save()}
              disabled={
                busy ||
                !ready ||
                !dirty ||
                stale ||
                (fallback !== null && !(fallback.model && fallback.effort))
              }
            />
            <Action
              label="Discard changes"
              onPress={() => {
                setDraft(discardModelDraft);
                setPendingModel(null);
              }}
              disabled={busy || !dirty}
            />
            <Action
              label={`Reset ${modelDriverLabel(driver)} to defaults`}
              onPress={() => {
                setDraft((current) => editModelDraft(current, (p) => resetModelTable(p, driver)));
                setPendingModel(null);
              }}
              disabled={
                busy ||
                !modelCellChanges(defaultModelRoutingPolicy, policy).some(
                  (c) => c.driver === driver,
                )
              }
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
          <Text className="font-t3-medium">Claude ladder</Text>
          <Text className="text-foreground-muted">
            Weakest first. When the wanted model is used up on every account, a worker gets the
            closest rung that has room.
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
            <Text className="flex-1 font-t3-medium">Fallback when no Claude rung has room</Text>
            <ThemedSwitch
              accessibilityLabel="Fallback when no Claude rung has room"
              value={fallback !== null}
              onValueChange={(on) =>
                edit((p) => ({ ...p, fallback: on ? defaultModelFallback : null }))
              }
            />
          </View>
          {fallback && (
            <>
              <TextInput
                accessibilityLabel="Fallback model"
                placeholder="Model ID"
                autoCapitalize="none"
                autoCorrect={false}
                className={field}
                value={fallback.model}
                onChangeText={(model) =>
                  edit((p) => ({ ...p, fallback: { ...fallback, model: model.trim() } }))
                }
              />
              <TextInput
                accessibilityLabel="Fallback effort"
                placeholder="Effort"
                autoCapitalize="none"
                autoCorrect={false}
                className={field}
                value={fallback.effort}
                onChangeText={(effort) =>
                  edit((p) => ({ ...p, fallback: { ...fallback, effort: effort.trim() } }))
                }
              />
              <Text className="text-foreground-muted">
                Used only when the wanted rung is below:
              </Text>
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
        </>
      ) : (
        <Text className="text-foreground-muted">
          The saved table has not loaded. Connect to this environment to view and edit it.
        </Text>
      )}
      <Action
        label={testOpen ? "Hide: Test an assignment" : "Test an assignment"}
        onPress={() => setTestOpen(!testOpen)}
      />
      {testOpen && (
        <View className="gap-3">
          <Text>{MODEL_SCORING_RUBRIC}</Text>
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
            </View>
          ))}
          <Action
            label="Preview exact selection"
            onPress={() => {
              if (!policy) return;
              try {
                decodeRequest(request);
              } catch {
                setMessage("Use integer scores 0–10.");
                return;
              }
              const captured = key;
              void call({ _tag: "modelPreview", request, policy }).then((result) => {
                if (result?.selection) setPreview({ key: captured, decision: result.selection });
              });
            }}
            disabled={busy || !ready}
          />
          {choice ? (
            <View className="gap-2">
              <Text>
                {choice.chosen
                  ? `${choice.chosen.model} / ${choice.chosen.effort ?? "default"}${
                      choice.wanted ? ` (wanted ${choice.wanted})` : ""
                    }`
                  : choice.state === "drained"
                    ? `Used up until ${choice.drainedUntil ? new Date(choice.drainedUntil).toLocaleString() : "an unknown reset"}`
                    : "No account can run it"}
              </Text>
              <Text>{choice.reason}</Text>
              {choice.accounts.map((line) => (
                <Text key={line} className="text-foreground-muted">
                  {line}
                </Text>
              ))}
            </View>
          ) : (
            <Text>Preview again after table, assessment or connection changes.</Text>
          )}
        </View>
      )}
      <Action
        label={historyOpen ? "Hide: Recent decisions" : "Recent decisions"}
        onPress={() => setHistoryOpen(!historyOpen)}
      />
      {historyOpen &&
        snapshot?.history.slice(0, 10).map((d) => (
          <View key={d.request.assignmentId} className="gap-2">
            <Text>
              Version {d.policyVersion}; {d.allocation?.decision.request.model ?? "unavailable"}
            </Text>
            <Text>
              Difficulty {d.request.assessment.difficulty} · stakes {d.request.assessment.stakes}
            </Text>
          </View>
        ))}
      <Action label="Refresh saved version" onPress={() => void refresh()} disabled={busy} />
      <Text className="text-foreground-muted">
        Table edits and tests use the same coordinator as web and desktop. New human-session
        startup, reassessments, version reverts and the raw policy are in the web editor. Agents use
        the shared managed startup service and read the same saved table.
      </Text>
      {editorUrl ? (
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(editorUrl)}>
          <Text className="text-primary">Open Model selection web editor</Text>
        </Pressable>
      ) : (
        <Text>
          This relay or SSH connection has no direct web address. Open this custom build&apos;s web
          client, connect the same environment, then choose Settings → Model selection.
        </Text>
      )}
    </ScrollView>
  );
}
