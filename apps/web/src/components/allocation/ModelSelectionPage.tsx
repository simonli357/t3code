import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  defaultModelRoutingPolicy,
  MODEL_SCORING_RUBRIC,
  ModelRoutingRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  routingEffortOptionId,
  type EnvironmentId,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type AllocationOperation,
  type AllocationStart,
  type RoutingCell,
} from "@t3tools/contracts";
import { createAllocationCommands } from "@t3tools/client-runtime/state/provider-allocation";
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
  setModelCell,
  summarizeModelDraft,
  type ModelDraft,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  ModelCellEditor,
  ModelRoutingLegend,
  ModelRoutingMatrix,
  type ModelCellPosition,
} from "./ModelRoutingTable";

const commands = createAllocationCommands(connectionAtomRuntime);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
const group = "grid min-w-0 grid-cols-1 gap-3 rounded border p-3";
type Section = "test" | "policy" | "history" | "connection";

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
  const start = useAtomCommand(commands.start, { reportFailure: false });
  const environment = useEnvironment(environmentId);
  const connection = environment?.connection.phase ?? "offline";
  const navigate = useNavigate();
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [snapshot, setSnapshot] = useState<ModelRoutingSnapshot | null>(null);
  const [draft, setDraft] = useState<ModelDraft>(emptyModelDraft);
  const [driver, setDriver] = useState<ModelDriver>("codex");
  const [selected, setSelected] = useState<ModelCellPosition | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<Section, boolean>>({
    test: false,
    policy: false,
    history: false,
    connection: false,
  });
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ key: string; decision: ModelRoutingDecision } | null>(
    null,
  );
  const [request, setRequest] = useState<ModelRoutingRequest>(() => ({
    selection: "automatic",
    assignmentId: randomUUID(),
    threadId: ThreadId.make(randomUUID()),
    environmentId,
    allowedDrivers: [ProviderDriverKind.make("codex")],
    assessment: { difficulty: NaN, stakes: NaN, difficultyReason: "", stakesReason: "" },
  }));
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("Automatically selected assignment");
  const [prompt, setPrompt] = useState("");
  const [startAttempt, setStartAttempt] = useState<AllocationStart | null>(null);
  const startInput: AllocationStart | null = project
    ? { request, kind: "session", projectId: ProjectId.make(project), title, prompt }
    : null;
  const changedStart =
    startAttempt !== null && JSON.stringify(startAttempt) !== JSON.stringify(startInput);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [connectionState, setConnectionState] = useState({ phase: connection, epoch: 0 });
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
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
  const overrideEffortId = routingEffortOptionId(request.override?.driver ?? "codex");
  const overrideOptions = request.override?.options ?? [];
  const accounts =
    snapshot?.inventories
      .flatMap((i) => i.accounts)
      .filter((a) => a.environmentId === environmentId) ?? [];
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
  const unchangedDefault = useMemo(
    () =>
      policy !== null &&
      !modelCellChanges(defaultModelRoutingPolicy, policy).some((c) => c.driver === driver),
    [policy, driver],
  );
  const selectedCell = policy && selected ? modelCell(policy, driver, ...at(selected)) : null;
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
  const refresh = async (keepMessage = false) => {
    const epoch = ++generation.current;
    setPreview(null);
    const response = await call({ _tag: "modelSnapshot" }, keepMessage);
    if (epoch !== generation.current || !response?.modelSnapshot) return;
    const next = response.modelSnapshot;
    setSnapshot(next);
    setSnapshotEpoch(connectionState.epoch);
    setDraft((current) => receiveSavedModelPolicy(current, next.policy));
    if (!next.authorityAvailable)
      setMessage(
        "Coordinator or target is unavailable. Last-known values remain readable; reconnect through Provider allocation and refresh.",
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
      const response = await execute({ environmentId, input: { _tag: "modelSnapshot" } });
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      if (response._tag === "Success" && response.value.modelSnapshot) {
        const next = response.value.modelSnapshot;
        setSnapshot(next);
        setSnapshotEpoch(connectionState.epoch);
        setDraft((current) => receiveSavedModelPolicy(current, next.policy));
      } else
        setMessage("Model coordinator unavailable. Your changes are kept; reconnect and refresh.");
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch]);
  const showPreview = async () => {
    if (!policy) return;
    const previewRequest = startAttempt
      ? request
      : { ...request, policyVersion: snapshot?.policy.version };
    try {
      decodeRequest(previewRequest);
    } catch {
      setMessage("Supply integer scores from 0 to 10 and a concise reason for each axis.");
      return;
    }
    setRequest(previewRequest);
    const captured = modelPreviewKey(
      policy,
      previewRequest,
      `${connection}:${connectionState.epoch}`,
    );
    const response = await call({ _tag: "modelPreview", request: previewRequest, policy });
    if (response?.selection) setPreview({ key: captured, decision: response.selection });
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
      await refresh();
      setMessage(
        `Saved as version ${response.modelPolicy.version}. Existing assignments keep their choices.`,
      );
    } else if (response === null)
      // A conflict means a newer version exists: reload it so the page can offer the merge.
      await refresh(true);
  };
  const create = async () => {
    const input = startAttempt ?? startInput;
    if (!input) return;
    setBusy(true);
    setStartAttempt(input);
    const result = await start({
      environmentId,
      input,
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setPreview(null);
      setMessage(
        `${modelFailureMessage(result.cause)} Startup did not confirm. Retry the identical intent to reconcile its receipt, or choose a new assignment identity for changed work.`,
      );
      return;
    }
    // A confirmed refusal/legacy observation without a reservation did not bind
    // a startup intent. The owner may choose another account on these same IDs.
    if (
      result.value.state !== "submitted" &&
      !result.value.allocation?.reservation &&
      !result.value.selection?.allocation?.reservation
    )
      setStartAttempt(null);
    if (result.value.selection) setPreview({ key, decision: result.value.selection });
    if (result.value.state === "submitted")
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    else
      setMessage(
        result.value.state === "observation"
          ? "Observation mode: proposal recorded; no session started."
          : "No approved model/account can start. Inspect the decision.",
      );
  };
  const select = useCallback((cell: ModelCellPosition) => {
    setSelected(cell);
    setPendingModel(null);
  }, []);
  const toggle = (section: Section) => (value: boolean) =>
    setOpen((current) => ({ ...current, [section]: value }));
  const example = policy ? modelCellSummary(modelCell(policy, driver, 7, 8)) : "";
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
      <p className="text-sm text-muted-foreground">
        {draft.saved ? `Saved version ${draft.saved.version}` : "Saved table not loaded"} ·{" "}
        {ready
          ? "Coordinator connected"
          : "Coordinator not connected: showing the last known table"}{" "}
        ·{" "}
        {dirty
          ? `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`
          : "No unsaved changes"}
      </p>
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
            online={Boolean(ready)}
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
              disabled={busy || !ready || !dirty || stale}
              onClick={() => void save()}
            >
              Save table
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
        </div>
      ) : (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          The saved table has not loaded. Connect to this environment to view and edit it.
        </p>
      )}
      <Disclosure title="Test an assignment" open={open.test} onToggle={toggle("test")}>
        <fieldset className={group}>
          <legend>Assignment preview</legend>
          <p>{MODEL_SCORING_RUBRIC}</p>
          <label>
            <input
              type="checkbox"
              checked={Boolean(request.override)}
              onChange={(e) => {
                const { override: _previous, ...rest } = request;
                const base = policy ? modelCell(policy, driver, ...at(selected ?? ORIGIN)) : null;
                setRequest(
                  e.target.checked && base
                    ? {
                        ...rest,
                        override: {
                          driver: ProviderDriverKind.make(driver),
                          model: base.model,
                          options: [{ id: routingEffortOptionId(driver), value: base.effort }],
                          reason: "",
                        },
                      }
                    : rest,
                );
              }}
            />{" "}
            Exact user override
          </label>
          {request.override && (
            <div className={group}>
              <p>
                Exact instructions take precedence over the automatic allowlist. Conflicting
                provider or account constraints are reported without substitution.
              </p>
              <label>
                Override model
                <input
                  className={field}
                  value={request.override.model}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      override: { ...request.override!, model: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                Override effort
                <input
                  className={field}
                  value={String(
                    overrideOptions.find((o) => o.id === overrideEffortId)?.value ?? "",
                  )}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      override: {
                        ...request.override!,
                        options: overrideOptions.some((o) => o.id === overrideEffortId)
                          ? overrideOptions.map((o) =>
                              o.id === overrideEffortId ? { ...o, value: e.target.value } : o,
                            )
                          : [...overrideOptions, { id: overrideEffortId, value: e.target.value }],
                      },
                    })
                  }
                />
              </label>
              <p>
                Retained exact constraints:{" "}
                {overrideOptions
                  .filter((o) => o.id !== overrideEffortId)
                  .map((o) => `${o.id}: ${String(o.value)}`)
                  .join(", ") || "none"}
                . Editing effort preserves these options.
              </p>
              <label>
                Override reason
                <textarea
                  className={field}
                  maxLength={500}
                  value={request.override.reason}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      override: { ...request.override!, reason: e.target.value },
                    })
                  }
                />
              </label>
              <p>
                Override provider: {request.override.driver === "codex" ? "Codex" : "Claude"}. To
                choose another provider, clear the override, select its table tab and enable an
                override again.
              </p>
            </div>
          )}
          {request.reassessment && (
            <div className={group}>
              <p>
                Explicit reassessment starts a new session. The previous session keeps its model and
                native identity. Transport and installation failures alone do not justify
                escalation.
              </p>
              <label>
                Reassessment cause
                <select
                  className={field}
                  value={request.reassessment.cause}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      reassessment: {
                        ...request.reassessment!,
                        cause:
                          e.target.value === "scope-change"
                            ? "scope-change"
                            : "substantive-failure",
                      },
                    })
                  }
                >
                  <option value="scope-change">Scope change</option>
                  <option value="substantive-failure">Substantive failure</option>
                </select>
              </label>
              <label>
                Reassessment reason
                <textarea
                  className={field}
                  maxLength={500}
                  value={request.reassessment.reason}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      reassessment: { ...request.reassessment!, reason: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={request.reassessment.allowFreshProviderSession}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      reassessment: {
                        ...request.reassessment!,
                        allowFreshProviderSession: e.target.checked,
                      },
                    })
                  }
                />{" "}
                Permit a different provider family in the new session
              </label>
            </div>
          )}
          <label>
            Allowed providers
            <select
              className={field}
              value={request.allowedDrivers.join(",")}
              onChange={(e) =>
                setRequest({
                  ...request,
                  allowedDrivers: e.target.value.split(",").map((d) => ProviderDriverKind.make(d)),
                })
              }
            >
              <option value="codex">Codex</option>
              <option value="claudeAgent">Claude</option>
              <option value="codex,claudeAgent">Codex and Claude</option>
            </select>
          </label>
          <label>
            Account constraint
            <select
              className={field}
              value={request.explicitInstanceId ?? ""}
              onChange={(e) => {
                const { explicitInstanceId: _old, ...rest } = request;
                setRequest(
                  e.target.value
                    ? { ...rest, explicitInstanceId: ProviderInstanceId.make(e.target.value) }
                    : rest,
                );
              }}
            >
              <option value="">Any compatible account on this environment</option>
              {accounts.map((a) => (
                <option key={a.instanceId} value={a.instanceId}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {(["difficulty", "stakes"] as const).map((axis) => (
            <div key={axis} className="min-w-0 space-y-2">
              <label>
                {axis === "difficulty" ? "Difficulty" : "Stakes"} score
                <input
                  className={field}
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  value={Number.isFinite(request.assessment[axis]) ? request.assessment[axis] : ""}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      assessment: {
                        ...request.assessment,
                        [axis]: e.target.value === "" ? NaN : Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label>
                {axis === "difficulty" ? "Difficulty" : "Stakes"} reason
                <textarea
                  className={field}
                  maxLength={500}
                  value={request.assessment[`${axis}Reason`]}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      assessment: { ...request.assessment, [`${axis}Reason`]: e.target.value },
                    })
                  }
                />
              </label>
            </div>
          ))}
          <Button size="sm-multiline" disabled={busy || !ready} onClick={() => void showPreview()}>
            Preview exact selection
          </Button>
          {validPreview ? (
            <div aria-label="Selection preview">
              <p>
                {validPreview.rule}; policy version {validPreview.policyVersion}
              </p>
              <p>
                {validPreview.allocation
                  ? `${validPreview.allocation.decision.request.model} / ${validPreview.allocation.decision.request.options.map((o) => o.value).join(", ")}`
                  : "Unavailable"}
              </p>
              <p>
                Account:{" "}
                {accounts.find(
                  (a) => a.instanceId === validPreview.allocation?.decision.selectedInstanceId,
                )?.label ?? "No compatible account"}
              </p>
              {validPreview.profiles?.map((p) => (
                <p key={p.driver}>
                  {p.driver === "codex" ? "Codex" : "Claude"}: {p.model} /{" "}
                  {p.options.map((o) => o.value).join(", ")};{" "}
                  {p.eligible ? "compatible" : "outside constraints"}. {p.reason}
                </p>
              ))}
              {validPreview.reasons
                .filter((reason) => !validPreview.profiles?.some((p) => p.reason === reason))
                .map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
            </div>
          ) : (
            <p>Preview required after input, table or connection changes.</p>
          )}
        </fieldset>
        <fieldset className={group}>
          <legend>Start a new human assignment</legend>
          <p>
            Save the table first. Startup checks the exact catalog and starts the table&apos;s
            choice. Quota and pacing estimates remain advisory; provider errors remain visible.
          </p>
          <label>
            Project
            <select className={field} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Choose project</option>
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Assignment
            <textarea
              className={field}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <Button
            size="sm-multiline"
            disabled={
              busy ||
              !ready ||
              (!startAttempt && !validPreview) ||
              changedStart ||
              !project ||
              !prompt.trim() ||
              (!startAttempt && dirty)
            }
            onClick={() => void create()}
          >
            {startAttempt ? "Retry identical assignment" : "Start assignment"}
          </Button>
          <Button
            size="sm-multiline"
            disabled={busy}
            onClick={() => {
              setStartAttempt(null);
              setRequest({
                ...request,
                assignmentId: randomUUID(),
                threadId: ThreadId.make(randomUUID()),
              });
              setPreview(null);
            }}
          >
            New assignment identity
          </Button>
          {changedStart && (
            <p>
              The previous startup has a durable intent. Restore its inputs to retry, or choose a
              new assignment identity.
            </p>
          )}
        </fieldset>
      </Disclosure>
      <Disclosure
        title="Policy settings, versions and raw JSON"
        open={open.policy}
        onToggle={toggle("policy")}
      >
        {policy && (
          <label>
            Maximum explicit reassessments
            <input
              className={field}
              type="number"
              min={0}
              max={3}
              value={policy.maxReassessments}
              onChange={(e) =>
                setDraft((current) =>
                  editModelDraft(current, (p) => ({
                    ...p,
                    maxReassessments: Math.min(
                      3,
                      Math.max(0, Math.trunc(Number(e.target.value)) || 0),
                    ),
                  })),
                )
              }
            />
          </label>
        )}
        <div className="space-y-2">
          <p className="text-sm">
            Saved versions. Reverting restores that table as a new version
            {dirty ? "; save or discard your changes first" : ""}.
          </p>
          {snapshot?.policies.map((p) => (
            <div key={p.version}>
              <Button
                size="sm-multiline"
                disabled={busy || !ready || dirty}
                onClick={async () => {
                  const response = await call({
                    _tag: "modelRevert",
                    expectedVersion: snapshot.policy.version,
                    version: p.version,
                  });
                  if (response?.modelPolicy) {
                    setDraft(adoptModelPolicy(response.modelPolicy));
                    await refresh();
                  }
                }}
              >
                Revert version {p.version} as a new version
              </Button>
            </div>
          ))}
        </div>
        <p className="text-sm">Draft policy (read-only JSON)</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(policy, null, 2)}
        </pre>
      </Disclosure>
      <Disclosure
        title="Recent decisions (up to 50)"
        open={open.history}
        onToggle={toggle("history")}
      >
        <div className="space-y-3">
          {snapshot?.history.map((d) => (
            <article key={d.request.assignmentId} className={group}>
              <p>
                {new Date(d.at).toLocaleString()} · version {d.policyVersion}
              </p>
              <p>
                Difficulty {d.request.assessment.difficulty}:{" "}
                {d.request.assessment.difficultyReason}
              </p>
              <p>
                Stakes {d.request.assessment.stakes}: {d.request.assessment.stakesReason}
              </p>
              <p>
                {d.allocation?.decision.request.model ?? "Unavailable"}{" "}
                {d.allocation?.decision.request.options.map((o) => o.value).join(" / ")}
              </p>
              {d.reasons.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
              <Button
                size="sm-multiline"
                disabled={busy || d.request.environmentId !== environmentId}
                onClick={() => {
                  setStartAttempt(null);
                  setRequest({
                    ...d.request,
                    policyVersion: snapshot.policy.version,
                    assignmentId: randomUUID(),
                    threadId: ThreadId.make(randomUUID()),
                    reassessment: {
                      previousAssignmentId: d.request.assignmentId,
                      cause: "scope-change",
                      reason: "",
                      allowFreshProviderSession: false,
                    },
                  });
                  setPreview(null);
                  setOpen((current) => ({ ...current, test: true }));
                }}
              >
                Reassess as a new assignment
              </Button>
              <details>
                <summary>Decision details</summary>
                <pre className="whitespace-pre-wrap text-xs">
                  {JSON.stringify(
                    { assignmentId: d.request.assignmentId, reassessment: d.request.reassessment },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </article>
          ))}
        </div>
      </Disclosure>
      <Disclosure title="Connection" open={open.connection} onToggle={toggle("connection")}>
        <p className="text-sm">
          Table edits, tests and new assignments use the shared coordinator.{" "}
          {ready
            ? "It is connected."
            : "It is not ready; choose or reconnect the coordinator in Provider allocation."}{" "}
          Advisory account recommendations use the same coordinator.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void refresh()}>
            Refresh saved version
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/allocation" })}
          >
            Open Provider allocation
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}
const ORIGIN: ModelCellPosition = { difficulty: 0, stakes: 0 };
const at = (cell: ModelCellPosition) => [cell.difficulty, cell.stakes] as const;
