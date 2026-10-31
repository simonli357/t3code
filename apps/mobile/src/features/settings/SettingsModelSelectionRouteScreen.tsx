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
  defaultModelRoutingPolicy,
  MODEL_SCORING_RUBRIC,
  ModelRoutingRequest,
  ProviderDriverKind,
  ThreadId,
  type AllocationOperation,
  type EnvironmentId,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
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
  rebaseModelDraft,
  receiveSavedModelPolicy,
  resetModelTable,
  setModelCell,
  summarizeModelDraft,
  type ModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import { createAllocationAtoms } from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/ui/AppText";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SettingsScreen } from "./components/SettingsScreen";
import { useEnvironments } from "../../state/environments";
import {
  Action,
  ModelCellEditor,
  ModelRoutingLegend,
  ModelRoutingMatrix,
  type ModelCellPosition,
} from "./ModelRoutingTable";
const commands = createAllocationAtoms(connectionAtomRuntime);
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
  const [assessment, setAssessment] = useState({
    difficulty: NaN,
    stakes: NaN,
    difficultyReason: "",
    stakesReason: "",
  });
  const [preview, setPreview] = useState<{ key: string; decision: ModelRoutingDecision } | null>(
    null,
  );
  const generation = useRef(0);
  // The table can be taller than the screen, so a pick brings the editor above it into view.
  const scroller = useRef<ScrollViewInstance>(null);
  const viewport = useRef({ offset: 0, height: 0 });
  const editorBox = useRef({ y: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the native editor into view after a table selection.
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
  const decision = preview?.key === key && connection === "connected" ? preview.decision : null;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads model routing when the computer connection changes.
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
    const result = await execute({ environmentId, input }).catch(() => null);
    if (epoch !== generation.current) return null;
    setBusy(false);
    if (result?._tag !== "Success") {
      setPreview(null);
      setMessage(
        result
          ? `${modelFailureMessage(result.cause)} Your changes are kept; reconnect, refresh the saved version and try again.`
          : "The request failed unexpectedly. Your changes are kept. Reconnect and try again.",
      );
      return null;
    }
    return result.value;
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
              disabled={busy || !ready || !dirty || stale}
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
              <TextInput
                accessibilityLabel={`${axis} reason`}
                className={field}
                multiline
                maxLength={500}
                value={
                  axis === "difficulty" ? assessment.difficultyReason : assessment.stakesReason
                }
                onChangeText={(value) => {
                  if (axis === "difficulty")
                    setAssessment({ ...assessment, difficultyReason: value });
                  else setAssessment({ ...assessment, stakesReason: value });
                }}
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
                setMessage("Use integer scores 0–10 with a reason for each.");
                return;
              }
              const captured = key;
              void call({ _tag: "modelPreview", request, policy }).then((result) => {
                if (result?.selection) setPreview({ key: captured, decision: result.selection });
              });
            }}
            disabled={busy || !ready}
          />
          {decision ? (
            <View className="gap-2">
              <Text>
                {decision.rule}; version {decision.policyVersion}
              </Text>
              {decision.profiles.map((p) => (
                <Text key={p.driver}>
                  {p.model} / {p.options.map((o) => o.value).join(", ")}:{" "}
                  {p.eligible ? "compatible" : "outside constraints"}
                </Text>
              ))}
              {decision.reasons.map((reason) => (
                <Text key={reason}>{reason}</Text>
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
              Difficulty {d.request.assessment.difficulty}: {d.request.assessment.difficultyReason}
            </Text>
            <Text>
              Stakes {d.request.assessment.stakes}: {d.request.assessment.stakesReason}
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
