import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Schema from "effect/Schema";
import {
  defaultModelFallback,
  defaultModelRoutingPolicy,
  modelFallback,
  modelLadder,
  workerChoice,
  workerChoiceRequest,
  MODEL_SCORING_RUBRIC,
  ModelRoutingRequest,
  ProviderDriverKind,
  ThreadId,
  type EnvironmentId,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type AllocationResponse,
  type AllocationOperation,
  type RoutingCell,
} from "@t3tools/contracts";
import { createAutosave } from "@t3tools/client-runtime/state/autosave";
import {
  allocationModelChoices,
  allocationOfflineMessage,
  allocationSaveFailure,
  createAllocationCommands,
  withModelLadderEdit,
} from "@t3tools/client-runtime/state/provider-allocation";
import {
  MODEL_DRIVERS,
  modelAutosaveRules,
  modelCatalog,
  modelCell,
  modelCellChanges,
  modelDriverLabel,
  modelFailureMessage,
  modelPreviewKey,
  resetModelTable,
  setAllowedModels,
  setModelCell,
  summarizeModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { FoldedSettingsSection } from "../settings/FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME } from "../settings/itemRows";
import { SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  ModelCellEditor,
  ModelFallbackEditor,
  ModelLadderEditor,
  ModelListEditor,
  ModelRoutingLegend,
  ModelRoutingMatrix,
  type ModelCellPosition,
} from "./ModelRoutingTable";
import { Hinted } from "./Hinted";
import { SaveState } from "./SaveState";

const commands = createAllocationCommands(connectionAtomRuntime);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
const block = `${ITEM_ROW_CLASSNAME} grid min-w-0 gap-3`;
/** Quick changes to the table are stored together, as one version. */
const TABLE_PAUSE = 1200;

export function ModelSelectionPage({ environmentId }: { environmentId: EnvironmentId }) {
  return <ModelEditor key={environmentId} environmentId={environmentId} />;
}
function ModelEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const environment = useEnvironment(environmentId);
  const connection = environment?.connection.phase ?? "offline";
  const [offline, setOffline] = useState<AllocationResponse["offline"]>();
  const [snapshot, setSnapshot] = useState<ModelRoutingSnapshot | null>(null);
  // The saved tables to go back to, newest first.
  const [versions, setVersions] = useState<readonly ModelRoutingPolicy[]>([]);
  // What every computer reports arrives after the saved table; the last known list stays offline.
  const [inventories, setInventories] = useState<ModelRoutingSnapshot["inventories"]>([]);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const remember = useCallback(
    (saved: ModelRoutingPolicy) =>
      setVersions((current) =>
        [saved, ...current.filter((p) => p.version !== saved.version)].slice(0, 20),
      ),
    [],
  );
  // Every change is stored as it is made; `draft` is what the page shows and how far it got.
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
        remember(result.value.modelPolicy);
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
  // Leaving the page stores an edit that is still waiting.
  useEffect(() => () => store.flush(), [store]);
  const [driver, setDriver] = useState<ModelDriver>("claudeAgent");
  const [selected, setSelected] = useState<ModelCellPosition | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ key: string; decision: ModelRoutingDecision } | null>(
    null,
  );
  // Blank is NaN. The task is tried as an agent's start would be, on the table shown.
  const [task, setTask] = useState({ difficulty: NaN, stakes: NaN, hours: NaN });
  const [ids] = useState(() => ({ assignmentId: randomUUID(), threadId: randomUUID() }));
  const request = workerChoiceRequest({
    difficulty: task.difficulty,
    stakes: task.stakes,
    ...(Number.isFinite(task.hours) ? { hours: task.hours } : {}),
    environmentId,
    driver: ProviderDriverKind.make(driver),
    assignmentId: ids.assignmentId,
    threadId: ThreadId.make(ids.threadId),
  });
  const mounted = useRef(true);
  const generation = useRef(0);
  const accountsRead = useRef(0);
  const [connectionState, setConnectionState] = useState({ phase: connection, epoch: 0 });
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
  const [failedEpoch, setFailedEpoch] = useState<number | null>(null);
  if (connectionState.phase !== connection)
    setConnectionState({ phase: connection, epoch: connectionState.epoch + 1 });
  const policy = offline ? (snapshot?.policy ?? null) : draft.policy;
  const key = modelPreviewKey(
    policy ?? defaultModelRoutingPolicy,
    request,
    `${connection}:${connectionState.epoch}`,
  );
  const validPreview = preview?.key === key && connection === "connected" ? preview.decision : null;
  const ready =
    snapshot?.authorityAvailable === true &&
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
  const catalog = useMemo(
    () => modelCatalog(inventories, environmentId, driver),
    [inventories, environmentId, driver],
  );
  const { editedCells } = useMemo(() => summarizeModelDraft(draft), [draft]);
  const unchangedDefault = useMemo(
    () =>
      policy !== null &&
      !modelCellChanges(defaultModelRoutingPolicy, policy).some((c) => c.driver === driver),
    [policy, driver],
  );
  const claudeChoices = useMemo(
    () => allocationModelChoices(inventories, "claudeAgent"),
    [inventories],
  );
  const fallback = policy ? modelFallback(policy) : null;
  const choice = validPreview ? workerChoice(validPreview) : null;
  const selectedCell = policy && selected ? modelCell(policy, driver, ...at(selected)) : null;
  const earlier = versions.filter((p) => p.version !== draft.saved?.version);
  // A change that is not stored yet, or could not be stored.
  const unsettled = draft.phase !== "idle" && draft.phase !== "saved";
  const stuck = draft.phase === "failed" || draft.phase === "conflict";
  const call = async (operation: AllocationOperation) => {
    const epoch = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await execute({ environmentId, input: operation });
      if (!mounted.current || epoch !== generation.current) return null;
      if (response._tag !== "Success") {
        setPreview(null);
        setMessage(modelFailureMessage(response.cause));
        return null;
      }
      return response.value;
    } finally {
      if (mounted.current && epoch === generation.current) setBusy(false);
    }
  };
  const receive = useCallback(
    (response: AllocationResponse, epoch: number) => {
      const next = response.modelSnapshot;
      setOffline(response.offline);
      setSnapshot(next ?? null);
      setSnapshotEpoch(epoch);
      setMessage("");
      if (next && !response.offline) store.receive(next.policy);
      setVersions(next?.policies ?? []);
    },
    [store, setSnapshotEpoch],
  );
  /** The accounts every computer reports; a slow computer delays only these. */
  const readAccounts = useCallback(async () => {
    const read = ++accountsRead.current;
    setAccounts("loading");
    const response = await execute({
      environmentId,
      input: { _tag: "modelSnapshot", part: "accounts" },
    });
    if (!mounted.current || read !== accountsRead.current) return;
    if (response._tag === "Success" && response.value.modelSnapshot) {
      setInventories(response.value.modelSnapshot.inventories);
      setAccounts("loaded");
    } else setAccounts("failed");
  }, [environmentId, execute]);
  const refresh = async () => {
    const epoch = ++generation.current;
    setPreview(null);
    const response = await call({ _tag: "modelSnapshot", part: "settings" });
    if (epoch !== generation.current) return;
    if (response) receive(response, connectionState.epoch);
    else setSnapshotEpoch(null);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const epoch = ++generation.current;
    // Defer dispatch so StrictMode's retired setup cannot send a duplicate read.
    void Promise.resolve().then(async () => {
      if (!active) return;
      setPreview(null);
      if (connection !== "connected") {
        setBusy(false);
        return;
      }
      setBusy(true);
      setMessage("");
      const response = await execute({
        environmentId,
        input: { _tag: "modelSnapshot", part: "settings" },
      });
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      // Only now: the server runs one database query at a time, and this computer's inventory
      // would otherwise hold up the saved values.
      void readAccounts();
      if (response._tag === "Success") {
        receive(response.value, connectionState.epoch);
      } else {
        setFailedEpoch(connectionState.epoch);
        setMessage("The saved table could not be read. Refresh to try again.");
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch, readAccounts, receive]);
  const tryTask = async () => {
    if (!policy) return;
    try {
      decodeRequest(request);
    } catch {
      setMessage(
        "Give difficulty and stakes as whole numbers from 0 to 10, and a job length of up to 168 hours.",
      );
      return;
    }
    const response = await call({ _tag: "modelPreview", request, policy });
    if (response?.selection) setPreview({ key, decision: response.selection });
  };
  const select = useCallback((cell: ModelCellPosition) => {
    setSelected(cell);
    setPendingModel(null);
  }, []);
  return (
    <div
      id="model-selection"
      className="flex w-full min-w-0 max-w-full flex-col gap-8 [overflow-wrap:anywhere] [&>*]:min-w-0"
    >
      {message && (
        <Alert variant="error">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {!loadingTable && connection !== "connected" && (
        <p role="status" className="text-sm text-muted-foreground">
          {policy
            ? "Not connected: showing the last known table."
            : "Not connected. The table appears once this computer connects."}
        </p>
      )}
      {offline && <p role="status">{allocationOfflineMessage(offline)}</p>}
      {!offline && connection === "connected" && snapshot && !snapshot.authorityAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          The computer that keeps this table is not reachable. Choose it under Provider allocation.
        </p>
      )}
      {draft.phase === "failed" && (
        <Alert variant="error">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{draft.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" disabled={Boolean(offline)} onClick={store.retry}>
              Try again
            </Button>
            <Button size="xs" variant="outline" onClick={() => store.resolve(false)}>
              Drop my change
            </Button>
          </AlertAction>
        </Alert>
      )}
      {draft.phase === "conflict" && (
        <Alert variant="warning">
          <AlertTitle>Changed elsewhere while you edited</AlertTitle>
          <AlertDescription>
            A cell or setting you changed was also changed on another computer or by an agent.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" disabled={Boolean(offline)} onClick={() => store.resolve(true)}>
              Keep mine
            </Button>
            <Button size="xs" variant="outline" onClick={() => store.resolve(false)}>
              Use theirs
            </Button>
          </AlertAction>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Saved with warnings</AlertTitle>
          <AlertDescription>
            {warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <SettingsSection
        title="Model by difficulty and stakes"
        headerAction={
          <div className="flex items-center gap-2">
            {!offline && (
              <SaveState
                phase={
                  loadingTable ? "loading" : connection !== "connected" ? "offline" : draft.phase
                }
              />
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={busy || connection !== "connected"}
              onClick={() => void refresh().then(readAccounts)}
            >
              Refresh
            </Button>
          </div>
        }
      >
        <div className={block}>
          <div role="tablist" aria-label="Provider model table" className="flex flex-wrap gap-2">
            {MODEL_DRIVERS.map((d) => (
              <Button
                key={d}
                role="tab"
                aria-selected={driver === d}
                variant={driver === d ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setDriver(d);
                  setPendingModel(null);
                }}
              >
                {modelDriverLabel(d)}
                {stuck && editedCells(d) > 0 && ` (${editedCells(d)} not saved)`}
              </Button>
            ))}
          </div>
          {policy && (
            <fieldset
              disabled={Boolean(offline)}
              role="tabpanel"
              aria-label={`${modelDriverLabel(driver)} table`}
              className="@container/matrix grid min-w-0 gap-3"
            >
              <ModelCellEditor
                driver={driver}
                position={selected}
                cell={selectedCell}
                catalog={catalog}
                allowed={policy[driver].allowedModels}
                online={ready}
                loadingAccounts={loadingAccounts}
                pendingModel={pendingModel}
                onPendingModel={setPendingModel}
                onChange={(cell: RoutingCell) => {
                  if (!selected) return;
                  setPendingModel(null);
                  store.edit(
                    (p) => setModelCell(p, driver, selected.difficulty, selected.stakes, cell),
                    TABLE_PAUSE,
                  );
                }}
              />
              <ModelRoutingMatrix
                driver={driver}
                policy={policy}
                baseline={draft.baseline}
                catalog={catalog}
                selected={selected}
                onSelect={select}
              />
              <ModelRoutingLegend driver={driver} policy={policy} />
            </fieldset>
          )}
        </div>
      </SettingsSection>
      {policy && (
        <fieldset disabled={Boolean(offline)} className="contents">
          <SettingsSection
            title="Claude ladder"
            headerAction={
              <Hinted
                hint="When the table's model is used up on every account, the worker gets the closest rung that has room."
                render={<span className="text-xs text-muted-foreground" />}
              >
                weakest first
              </Hinted>
            }
          >
            <ModelLadderEditor
              ladder={modelLadder(policy)}
              choices={claudeChoices}
              onEdit={(edit) => store.edit((p) => withModelLadderEdit(p, edit))}
            />
          </SettingsSection>
          <SettingsSection
            title="Fallback model"
            headerAction={
              <Switch
                size="sm"
                aria-label="Fallback model"
                checked={fallback !== null}
                onCheckedChange={(on) =>
                  store.edit((p) => ({ ...p, fallback: on ? defaultModelFallback : null }))
                }
              />
            }
          >
            <ModelFallbackEditor
              fallback={fallback}
              ladder={modelLadder(policy)}
              onChange={(next, typed) =>
                // A half-typed model ID must not become the fallback: it waits for the field.
                store.edit((p) => ({ ...p, fallback: next }), typed ? null : 0)
              }
              onCommit={store.flush}
            />
          </SettingsSection>
          <FoldedSettingsSection
            id="model-selection-models"
            title="Other model IDs"
            summary={`${modelDriverLabel(driver)}: ${policy[driver].allowedModels.length}`}
          >
            <ModelListEditor
              driver={driver}
              models={policy[driver].allowedModels}
              catalog={catalog}
              onChange={(models) => store.edit((p) => setAllowedModels(p, driver, models))}
            />
          </FoldedSettingsSection>
        </fieldset>
      )}
      <FoldedSettingsSection
        id="model-selection-try"
        title="Try a task"
        summary="which model and account it would get"
      >
        <div className={block}>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            {(
              [
                ["difficulty", "Difficulty (0–10)"],
                ["stakes", "Stakes (0–10)"],
                ["hours", "Job length (hours)"],
              ] as const
            ).map(([name, caption]) => (
              <label key={name} className="grid min-w-0 gap-1 text-sm">
                {name === "hours" ? (
                  caption
                ) : (
                  <Hinted hint={MODEL_SCORING_RUBRIC}>{caption}</Hinted>
                )}
                <input
                  className={field}
                  type="number"
                  min={0}
                  max={name === "hours" ? 168 : 10}
                  step={name === "hours" ? 0.5 : 1}
                  value={Number.isFinite(task[name]) ? String(task[name]) : ""}
                  onChange={(e) => {
                    const value = e.target.value === "" ? NaN : Number(e.target.value);
                    setTask((current) => ({ ...current, [name]: value }));
                  }}
                />
              </label>
            ))}
          </div>
          <div>
            <Button size="sm" disabled={busy || !ready} onClick={() => void tryTask()}>
              Try
            </Button>
          </div>
          {choice && (
            <div aria-label="Task result" className="space-y-1 text-sm">
              <p className="font-medium">
                {choice.chosen
                  ? `${accountLabel(environmentId, choice.chosen.instanceId)} · ${choice.chosen.model} / ${choice.chosen.effort ?? "default"}`
                  : choice.state === "drained"
                    ? `Used up until ${
                        choice.drainedUntil
                          ? new Date(choice.drainedUntil).toLocaleString()
                          : "an unknown time"
                      }`
                    : "No account can run it"}
              </p>
              <p>{choice.reason}</p>
            </div>
          )}
        </div>
      </FoldedSettingsSection>
      <FoldedSettingsSection
        id="model-selection-versions"
        title="Earlier versions"
        summary={draft.saved ? `now version ${draft.saved.version}` : null}
      >
        <div className={block}>
          <ul className="grid gap-2">
            {policy &&
              earlier.map((p) => {
                const cells = modelCellChanges(p, policy).length;
                return (
                  <li key={p.version} className="flex flex-wrap items-center gap-2 text-sm">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || !ready || unsettled}
                      onClick={async () => {
                        const response = await call({
                          _tag: "modelRevert",
                          expectedVersion: draft.saved?.version ?? p.version,
                          version: p.version,
                        });
                        if (response?.modelPolicy) {
                          store.adopt(response.modelPolicy);
                          remember(response.modelPolicy);
                        }
                      }}
                    >
                      Go back to version {p.version}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {cells === 0
                        ? "same cells as now"
                        : `${cells} ${cells === 1 ? "cell differs" : "cells differ"} from now`}
                    </span>
                  </li>
                );
              })}
            <li className="flex flex-wrap items-center gap-2 text-sm">
              <Button
                size="xs"
                variant="outline"
                disabled={!ready || !policy || unchangedDefault || unsettled}
                onClick={() => {
                  setPendingModel(null);
                  store.edit((p) => resetModelTable(p, driver));
                }}
              >
                Reset the {modelDriverLabel(driver)} table to the built-in one
              </Button>
            </li>
          </ul>
        </div>
      </FoldedSettingsSection>
      <FoldedSettingsSection
        id="model-selection-decisions"
        title="Recent decisions"
        summary={snapshot?.history.length ? `${snapshot.history.length}` : "none yet"}
      >
        {snapshot?.history.length ? (
          <ul className="[&>*+*]:border-t [&>*+*]:border-border/50">
            {snapshot.history.map((d) => {
              const decided = workerChoice(d);
              return (
                <li key={`${d.at}:${d.request.assignmentId}`} className={`${block} gap-1 text-sm`}>
                  <p className="font-medium">
                    {new Date(d.at).toLocaleString()} · difficulty {d.request.assessment.difficulty}{" "}
                    · stakes {d.request.assessment.stakes}
                  </p>
                  <p>
                    {decided.chosen
                      ? `${accountLabel(d.request.environmentId, decided.chosen.instanceId)} · ${decided.chosen.model} / ${decided.chosen.effort ?? "default"}`
                      : decided.state === "drained"
                        ? "Used up: nothing started"
                        : "No account: nothing started"}
                  </p>
                  {d.reasons.map((reason) => (
                    <p key={reason} className="text-xs text-muted-foreground">
                      {reason}
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={`${block} text-sm text-muted-foreground`}>No decisions recorded yet.</p>
        )}
      </FoldedSettingsSection>
    </div>
  );
}
const at = (cell: ModelCellPosition) => [cell.difficulty, cell.stakes] as const;
