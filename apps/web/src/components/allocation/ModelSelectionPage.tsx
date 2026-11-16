import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import {
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
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type AllocationOperation,
  type RoutingCell,
} from "@t3tools/contracts";
import {
  allocationModelChoices,
  createAllocationCommands,
  withModelLadderEdit,
} from "@t3tools/client-runtime/state/provider-allocation";
import {
  MODEL_DRIVERS,
  acknowledgeModelSave,
  adoptModelPolicy,
  discardModelDraft,
  editModelDraft,
  emptyModelDraft,
  modelCatalog,
  modelCell,
  modelCellChanges,
  modelCellSummary,
  modelDriverLabel,
  modelFailureMessage,
  modelPreviewKey,
  rebaseModelDraft,
  receiveSavedModelPolicy,
  resetModelTable,
  setAllowedModels,
  setModelCell,
  summarizeModelDraft,
  type ModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  ModelCellEditor,
  ModelFallbackEditor,
  ModelLadderEditor,
  ModelListEditor,
  ModelRoutingLegend,
  ModelRoutingMatrix,
  type ModelCellPosition,
} from "./ModelRoutingTable";

const commands = createAllocationCommands(connectionAtomRuntime);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
type Section = "task" | "versions" | "history";

/** A collapsed section keeps its contents unmounted until opened; state lives in the page. */
function Disclosure(props: {
  title: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details open={props.open} className="rounded-md border px-3 py-2">
      <summary
        className="cursor-pointer text-sm font-medium"
        onClick={(event) => {
          event.preventDefault();
          props.onToggle(!props.open);
        }}
      >
        {props.title}
      </summary>
      {props.open && <div className="mt-3 space-y-4">{props.children}</div>}
    </details>
  );
}

export function ModelSelectionPage({ environmentId }: { environmentId: EnvironmentId }) {
  return <ModelEditor key={environmentId} environmentId={environmentId} />;
}
function ModelEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const environment = useEnvironment(environmentId);
  const connection = environment?.connection.phase ?? "offline";
  const [snapshot, setSnapshot] = useState<ModelRoutingSnapshot | null>(null);
  // What every computer reports arrives after the saved table; the last known list stays offline.
  const [inventories, setInventories] = useState<ModelRoutingSnapshot["inventories"]>([]);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  const [draft, setDraft] = useState<ModelDraft>(emptyModelDraft);
  const [driver, setDriver] = useState<ModelDriver>("claudeAgent");
  const [selected, setSelected] = useState<ModelCellPosition | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<Section, boolean>>({
    task: false,
    versions: false,
    history: false,
  });
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<readonly string[]>([]);
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
  const policy = draft.policy;
  const key = modelPreviewKey(
    policy ?? defaultModelRoutingPolicy,
    request,
    `${connection}:${connectionState.epoch}`,
  );
  const validPreview = preview?.key === key && connection === "connected" ? preview.decision : null;
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
  const catalog = useMemo(
    () => modelCatalog(inventories, environmentId, driver),
    [inventories, environmentId, driver],
  );
  const {
    dirty,
    stale,
    count: changeCount,
    editedCells,
  } = useMemo(() => summarizeModelDraft(draft), [draft]);
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
  const earlier = snapshot?.policies.filter((p) => p.version !== snapshot.policy.version) ?? [];
  const call = async (operation: AllocationOperation, keepMessage = false) => {
    const epoch = generation.current;
    setBusy(true);
    if (!keepMessage) setMessage("");
    try {
      const response = await execute({ environmentId, input: operation });
      if (!mounted.current || epoch !== generation.current) return null;
      if (response._tag !== "Success") {
        setPreview(null);
        setMessage(
          `${modelFailureMessage(response.cause)} Your changes are kept. Reconnect, refresh the saved version and try again.`,
        );
        return null;
      }
      return response.value;
    } finally {
      if (mounted.current && epoch === generation.current) setBusy(false);
    }
  };
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
  const refresh = async (keepMessage = false) => {
    const epoch = ++generation.current;
    setPreview(null);
    const response = await call({ _tag: "modelSnapshot", part: "settings" }, keepMessage);
    if (epoch !== generation.current || !response?.modelSnapshot) return;
    const next = response.modelSnapshot;
    setSnapshot(next);
    setSnapshotEpoch(connectionState.epoch);
    setDraft((current) => receiveSavedModelPolicy(current, next.policy));
    if (!next.authorityAvailable)
      setMessage(
        "No coordinator is connected. Last-known values remain readable; choose one under Provider allocation and refresh.",
      );
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
      if (response._tag === "Success" && response.value.modelSnapshot) {
        const next = response.value.modelSnapshot;
        setSnapshot(next);
        setSnapshotEpoch(connectionState.epoch);
        setDraft((current) => receiveSavedModelPolicy(current, next.policy));
      } else {
        setFailedEpoch(connectionState.epoch);
        setMessage("Model coordinator unavailable. Your changes are kept; reconnect and refresh.");
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch, readAccounts]);
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
  const save = async () => {
    if (!policy || !draft.baseline) return;
    const epoch = generation.current;
    const response = await call({
      _tag: "modelPolicy",
      expectedVersion: draft.baseline.version,
      policy,
    });
    if (!mounted.current || epoch !== generation.current) return;
    if (response?.modelPolicy) {
      setDraft((current) => acknowledgeModelSave(current, policy, response.modelPolicy!));
      setPendingModel(null);
      setWarnings(response.warnings ?? []);
      await refresh();
      setMessage(
        `Saved as version ${response.modelPolicy.version}. Existing assignments keep their choices.`,
      );
    } else if (response === null)
      // A conflict means a newer version exists: reload it so the page can offer the merge.
      await refresh(true);
  };
  const select = useCallback((cell: ModelCellPosition) => {
    setSelected(cell);
    setPendingModel(null);
  }, []);
  const toggle = (section: Section) => (value: boolean) =>
    setOpen((current) => ({ ...current, [section]: value }));
  const example = policy ? modelCellSummary(modelCell(policy, driver, 7, 8)) : "";
  const status = [
    draft.saved
      ? `Saved version ${draft.saved.version}`
      : loadingTable
        ? "Loading the saved table…"
        : "Saved table not loaded",
    ready
      ? "Coordinator connected"
      : loadingTable
        ? null
        : connection !== "connected"
          ? `Not connected${draft.saved ? ": showing the last known table" : ""}`
          : `Coordinator unavailable${draft.saved ? ": showing the last known table" : ""}`,
    draft.saved
      ? dirty
        ? `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`
        : "No unsaved changes"
      : null,
    loadingAccounts ? "Loading accounts…" : accounts === "failed" ? "Accounts not read" : null,
  ].filter(Boolean);
  return (
    <div
      id="model-selection"
      className="w-full min-w-0 max-w-full space-y-4 [overflow-wrap:anywhere]"
    >
      <h1 className="text-xl font-semibold">Model selection</h1>
      <p className="text-sm">
        Columns are an assignment&apos;s difficulty and rows its stakes, each scored 0–10; a cell is
        the model and reasoning it gets. Example: difficulty 7 with stakes 8 gets{" "}
        {example || "the choice shown in that cell"}.
      </p>
      <p role="status" className="text-sm">
        {message}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">{status.join(" · ")}</p>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || connection !== "connected"}
          onClick={() => void refresh().then(readAccounts)}
        >
          Refresh
        </Button>
      </div>
      {stale && draft.saved && draft.baseline && (
        <Alert variant="warning">
          <AlertTitle>Version {draft.saved.version} was saved while you were editing</AlertTitle>
          <AlertDescription>
            <span>
              Your edits are based on version {draft.baseline.version}. Keep them on top of the
              newer table, or discard them, before saving.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => setDraft(rebaseModelDraft)}>
                Keep my edits on version {draft.saved.version}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setDraft(discardModelDraft)}
              >
                Discard my edits
              </Button>
            </span>
          </AlertDescription>
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
            {editedCells(d) > 0 && ` (${editedCells(d)} edited)`}
          </Button>
        ))}
      </div>
      {policy ? (
        <div role="tabpanel" aria-label={`${modelDriverLabel(driver)} table`} className="space-y-4">
          <ModelCellEditor
            driver={driver}
            position={selected}
            cell={selectedCell}
            saved={
              selected && draft.baseline ? modelCell(draft.baseline, driver, ...at(selected)) : null
            }
            catalog={catalog}
            allowed={policy[driver].allowedModels}
            online={Boolean(ready)}
            loadingAccounts={loadingAccounts}
            pendingModel={pendingModel}
            onPendingModel={setPendingModel}
            onChange={(cell: RoutingCell) => {
              if (!selected) return;
              setPendingModel(null);
              setDraft((current) =>
                editModelDraft(current, (p) =>
                  setModelCell(p, driver, selected.difficulty, selected.stakes, cell),
                ),
              );
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                !ready ||
                !dirty ||
                stale ||
                (fallback !== null && !(fallback.model && fallback.effort))
              }
              onClick={() => void save()}
            >
              Save changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !dirty}
              onClick={() => {
                setDraft(discardModelDraft);
                setPendingModel(null);
              }}
            >
              Discard changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || unchangedDefault}
              onClick={() => {
                setDraft((current) => editModelDraft(current, (p) => resetModelTable(p, driver)));
                setPendingModel(null);
              }}
            >
              Reset {modelDriverLabel(driver)} to defaults
            </Button>
          </div>
          <ModelRoutingMatrix
            driver={driver}
            policy={policy}
            baseline={draft.baseline}
            catalog={catalog}
            selected={selected}
            onSelect={select}
          />
          <ModelRoutingLegend driver={driver} policy={policy} />
          <ModelListEditor
            driver={driver}
            models={policy[driver].allowedModels}
            catalog={catalog}
            onChange={(models) =>
              setDraft((current) =>
                editModelDraft(current, (p) => setAllowedModels(p, driver, models)),
              )
            }
          />
          <ModelLadderEditor
            ladder={modelLadder(policy)}
            choices={claudeChoices}
            onEdit={(edit) =>
              setDraft((current) => editModelDraft(current, (p) => withModelLadderEdit(p, edit)))
            }
          />
          <ModelFallbackEditor
            fallback={fallback}
            ladder={modelLadder(policy)}
            onChange={(next) =>
              setDraft((current) => editModelDraft(current, (p) => ({ ...p, fallback: next })))
            }
          />
        </div>
      ) : (
        !loadingTable && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {connection === "connected"
              ? "The saved table could not be read. Refresh to try again."
              : "The saved table has not loaded. Connect to this environment to view and edit it."}
          </p>
        )
      )}
      <Disclosure title="Try a task" open={open.task} onToggle={toggle("task")}>
        <p className="text-sm text-muted-foreground">{MODEL_SCORING_RUBRIC}</p>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          {(
            [
              ["difficulty", "Difficulty (0–10)"],
              ["stakes", "Stakes (0–10)"],
              ["hours", "Job length (hours)"],
            ] as const
          ).map(([name, caption]) => (
            <label key={name} className="grid min-w-0 gap-1 text-sm">
              {caption}
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
        <Button size="sm" disabled={busy || !ready} onClick={() => void tryTask()}>
          Try
        </Button>
        {choice && (
          <div aria-label="Task result" className="space-y-1 text-sm">
            <p className="font-medium">
              {choice.chosen
                ? `${accountLabel(environmentId, choice.chosen.instanceId)} · ${choice.chosen.model} / ${choice.chosen.effort ?? "default"}`
                : choice.state === "drained"
                  ? `Drained until ${
                      choice.drainedUntil
                        ? new Date(choice.drainedUntil).toLocaleString()
                        : "an unknown time"
                    }`
                  : "No account can run it"}
            </p>
            <p>{choice.reason}</p>
          </div>
        )}
      </Disclosure>
      <Disclosure title="Earlier versions" open={open.versions} onToggle={toggle("versions")}>
        {earlier.length ? (
          <div className="space-y-2">
            <p className="text-sm">
              Reverting saves that table again as a new version
              {dirty ? "; save or discard your changes first" : ""}.
            </p>
            <div className="flex flex-wrap gap-2">
              {earlier.map((p) => (
                <Button
                  key={p.version}
                  size="sm"
                  variant="outline"
                  disabled={busy || !ready || dirty}
                  onClick={async () => {
                    const response = await call({
                      _tag: "modelRevert",
                      expectedVersion: snapshot!.policy.version,
                      version: p.version,
                    });
                    if (response?.modelPolicy) {
                      setDraft(adoptModelPolicy(response.modelPolicy));
                      await refresh();
                    }
                  }}
                >
                  Revert to version {p.version}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No earlier saved versions.</p>
        )}
      </Disclosure>
      <Disclosure title="Recent decisions" open={open.history} onToggle={toggle("history")}>
        {snapshot?.history.length ? (
          <ul className="space-y-2">
            {snapshot.history.map((d) => {
              const decided = workerChoice(d);
              return (
                <li
                  key={`${d.at}:${d.request.assignmentId}`}
                  className="rounded border p-2 text-sm"
                >
                  <p className="font-medium">
                    {new Date(d.at).toLocaleString()} · difficulty {d.request.assessment.difficulty}{" "}
                    · stakes {d.request.assessment.stakes}
                  </p>
                  <p>
                    {decided.chosen
                      ? `${accountLabel(d.request.environmentId, decided.chosen.instanceId)} · ${decided.chosen.model} / ${decided.chosen.effort ?? "default"}`
                      : decided.state === "drained"
                        ? "Drained: nothing started"
                        : "No account: nothing started"}
                  </p>
                  {d.reasons.map((reason) => (
                    <p key={reason} className="text-muted-foreground">
                      {reason}
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
        )}
      </Disclosure>
    </div>
  );
}
const at = (cell: ModelCellPosition) => [cell.difficulty, cell.stakes] as const;
