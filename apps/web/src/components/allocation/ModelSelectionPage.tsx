import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  defaultModelRoutingPolicy,
  MODEL_SCORE_BANDS,
  MODEL_SCORING_RUBRIC,
  ModelRoutingRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  type EnvironmentId,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
  type ModelRoutingDecision,
  type AllocationOperation,
  type AllocationStart,
  type RoutingTable,
} from "@t3tools/contracts";
import { createAllocationCommands } from "@t3tools/client-runtime/state/provider-allocation";
import {
  modelPreviewKey,
  modelProfileLabel,
  modelFailureMessage,
} from "@t3tools/client-runtime/state/model-routing";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";

const commands = createAllocationCommands(connectionAtomRuntime);
const decodeRequest = Schema.decodeUnknownSync(ModelRoutingRequest);
const profileIds = [1, 2, 3, 4, 5, 6] as const;
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
const group = "grid min-w-0 grid-cols-1 gap-3 rounded border p-3";
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
  const [policy, setPolicy] = useState<ModelRoutingPolicy>(defaultModelRoutingPolicy);
  const [driver, setDriver] = useState<"codex" | "claudeAgent">("codex");
  const [row, setRow] = useState(0);
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
  if (connectionState.phase !== connection)
    setConnectionState({ phase: connection, epoch: connectionState.epoch + 1 });
  const key = modelPreviewKey(policy, request, `${connection}:${connectionState.epoch}`);
  const validPreview = preview?.key === key && connection === "connected" ? preview.decision : null;
  const ready = snapshot?.authorityAvailable && connection === "connected";
  const table = policy[driver];
  const accounts =
    snapshot?.inventories
      .flatMap((i) => i.accounts)
      .filter((a) => a.environmentId === environmentId) ?? [];
  const models = [
    ...new Set(
      accounts.filter((a) => a.driver === driver).flatMap((a) => a.models.map((m) => m.slug)),
    ),
  ].sort();
  const updateTable = (change: Partial<RoutingTable>) =>
    setPolicy((p) => ({ ...p, [driver]: { ...p[driver], ...change } }));
  const call = async (operation: AllocationOperation) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await execute({ environmentId, input: operation });
      if (!mounted.current) return null;
      if (response._tag !== "Success") {
        setPreview(null);
        setMessage(
          `${modelFailureMessage(response.cause)} Your draft is retained. Reconnect, refresh the saved version, review differences and preview again.`,
        );
        return null;
      }
      return response.value;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const refresh = async (replaceDraft = false) => {
    const epoch = ++generation.current;
    setPreview(null);
    const response = await call({ _tag: "modelSnapshot" });
    if (epoch !== generation.current || !response?.modelSnapshot) return;
    setSnapshot(response.modelSnapshot);
    if (replaceDraft) setPolicy(response.modelSnapshot.policy);
    if (!response.modelSnapshot.authorityAvailable)
      setMessage(
        "Coordinator or target is unavailable. Last-known values remain readable; reconnect through Provider allocation and refresh.",
      );
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void execute({ environmentId, input: { _tag: "modelSnapshot" } }).then((response) => {
      if (!active) return;
      setBusy(false);
      if (response._tag === "Success" && response.value.modelSnapshot) {
        setSnapshot(response.value.modelSnapshot);
        setPolicy((current) =>
          current === defaultModelRoutingPolicy ? response.value.modelSnapshot!.policy : current,
        );
      } else
        setMessage("Model coordinator unavailable. Your draft is retained; reconnect and refresh.");
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute]);
  const showPreview = async () => {
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
    if (!snapshot) return;
    const response = await call({
      _tag: "modelPolicy",
      expectedVersion: snapshot.policy.version,
      policy,
    });
    if (response?.modelPolicy) {
      setPolicy(response.modelPolicy);
      await refresh(true);
      setMessage("Policy saved as a new version. Existing assignments keep their decisions.");
    }
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
          : "No approved profile/account can start. Inspect the decision.",
      );
  };
  return (
    <div
      id="model-selection"
      className="w-full min-w-0 max-w-full space-y-5 [overflow-wrap:anywhere]"
    >
      <h1 className="text-xl font-semibold">Model selection</h1>
      <p>
        Choose exact models and reasoning for new assignments. Account admission uses Provider
        allocation on the same coordinator. Profile numbers are references, not a cost or capability
        ranking.
      </p>
      <p>{MODEL_SCORING_RUBRIC}</p>
      <p role="status">{message}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm-multiline" disabled={busy} onClick={() => void refresh()}>
          Refresh saved version; keep draft
        </Button>
        <Button
          size="sm-multiline"
          disabled={busy || !snapshot}
          onClick={() => {
            setPolicy(snapshot!.policy);
            setPreview(null);
          }}
        >
          Discard draft
        </Button>
        <Button
          size="sm-multiline"
          disabled={busy}
          onClick={() =>
            setPolicy({ ...defaultModelRoutingPolicy, version: snapshot?.policy.version ?? 0 })
          }
        >
          Restore defaults in draft
        </Button>
      </div>
      <p>
        Saved version {snapshot?.policy.version ?? "unavailable"}; draft based on version{" "}
        {policy.version}.{" "}
        {ready ? "Coordinator connected." : "Disconnected or uncoordinated; draft retained."}
      </p>
      {snapshot && policy.version !== snapshot.policy.version && (
        <details>
          <summary>Compare draft with saved policy</summary>
          <pre className="whitespace-pre-wrap text-xs">
            {JSON.stringify(snapshot.policy, null, 2)}
          </pre>
        </details>
      )}
      <div role="tablist" aria-label="Provider model policy" className="flex flex-wrap gap-2">
        {(["codex", "claudeAgent"] as const).map((d) => (
          <Button
            key={d}
            role="tab"
            aria-selected={driver === d}
            size="sm"
            onClick={() => setDriver(d)}
          >
            {d === "codex" ? "Codex" : "Claude"}
          </Button>
        ))}
      </div>
      <fieldset className={group}>
        <legend>Approved automatic models</legend>
        {[...new Set([...models, ...table.allowedModels, "gpt-6-luna"])].map((model) => (
          <label key={model} className="min-w-0">
            <input
              type="checkbox"
              checked={table.allowedModels.includes(model)}
              disabled={/luna|haiku|fable/i.test(model)}
              onChange={(e) =>
                updateTable({
                  allowedModels: e.target.checked
                    ? [...table.allowedModels, model]
                    : table.allowedModels.filter((m) => m !== model),
                })
              }
            />{" "}
            {model}
            {/luna|haiku|fable/i.test(model)
              ? " — excluded"
              : !models.includes(model)
                ? " — unavailable in this target catalog"
                : ""}
          </label>
        ))}
      </fieldset>
      <fieldset className={group}>
        <legend>Reusable profiles</legend>
        {table.profiles.map((profile, i) => (
          <div key={profileIds[i]} className={group}>
            <h3>
              Profile {i + 1}: {modelProfileLabel(profile)}
            </h3>
            <label>
              Profile {i + 1} model
              <select
                className={field}
                value={profile.model}
                onChange={(e) =>
                  updateTable({
                    profiles: table.profiles.map((p, n) =>
                      n === i ? { ...p, model: e.target.value } : p,
                    ),
                  })
                }
              >
                {[...new Set([profile.model, ...table.allowedModels])].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Profile {i + 1} effort
              <select
                className={field}
                value={profile.effort}
                onChange={(e) =>
                  updateTable({
                    profiles: table.profiles.map((p, n) =>
                      n === i ? { ...p, effort: e.target.value } : p,
                    ),
                  })
                }
              >
                {[
                  ...new Set([
                    profile.effort,
                    ...accounts
                      .filter((a) => a.driver === driver)
                      .flatMap((a) =>
                        a.models
                          .filter((m) => m.slug === profile.model)
                          .flatMap(
                            (m) =>
                              m.capabilities?.optionDescriptors?.flatMap((o) =>
                                o.type === "select" &&
                                o.id === (driver === "codex" ? "reasoningEffort" : "effort")
                                  ? o.options.map((v) => v.id)
                                  : [],
                              ) ?? [],
                          ),
                      ),
                  ]),
                ].map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </label>
            <label>
              Profile {i + 1} capability alternative
              <select
                className={field}
                value={table.alternatives[i]![0] ?? ""}
                onChange={(e) =>
                  updateTable({
                    alternatives: table.alternatives.map((a, n) =>
                      n === i ? (e.target.value ? [Number(e.target.value)] : []) : a,
                    ),
                  })
                }
              >
                <option value="">Unavailable; no alternative</option>
                {table.profiles.map((p, n) =>
                  n === i ? null : (
                    <option value={n + 1} key={profileIds[n]}>
                      {n + 1}: {modelProfileLabel(p)}
                    </option>
                  ),
                )}
              </select>
            </label>
            {table.alternatives[i]!.length > 1 && (
              <p>
                Configured order:{" "}
                {table.alternatives[i]!.map(
                  (id) => `${id}: ${modelProfileLabel(table.profiles[id - 1]!)}`,
                ).join(" → ")}
                . Selecting an alternative replaces this list.
              </p>
            )}
          </div>
        ))}
      </fieldset>
      <fieldset className={group}>
        <legend>Difficulty × stakes table</legend>
        <label>
          Difficulty row
          <select className={field} value={row} onChange={(e) => setRow(Number(e.target.value))}>
            {MODEL_SCORE_BANDS.map((band, i) => (
              <option key={band} value={i}>
                {band}
              </option>
            ))}
          </select>
        </label>
        {MODEL_SCORE_BANDS.map((band, column) => (
          <label key={band}>
            Stakes {band}
            <span className="block">
              {modelProfileLabel(table.profiles[table.grid[row]![column]! - 1]!)}
            </span>
            <select
              className={field}
              value={table.grid[row]![column]}
              onChange={(e) =>
                updateTable({
                  grid: table.grid.map((r, i) =>
                    i === row ? r.map((id, j) => (j === column ? Number(e.target.value) : id)) : r,
                  ),
                })
              }
            >
              {table.profiles.map((p, i) => (
                <option key={profileIds[i]} value={i + 1}>
                  {i + 1}: {modelProfileLabel(p)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <label>
        Maximum explicit reassessments
        <input
          className={field}
          type="number"
          min={0}
          max={3}
          value={policy.maxReassessments}
          onChange={(e) => setPolicy({ ...policy, maxReassessments: Number(e.target.value) })}
        />
      </label>
      <fieldset className={group}>
        <legend>Assignment preview</legend>
        <label>
          <input
            type="checkbox"
            checked={Boolean(request.override)}
            onChange={(e) => {
              const { override: _previous, ...rest } = request;
              setRequest(
                e.target.checked
                  ? {
                      ...rest,
                      override: {
                        driver: ProviderDriverKind.make(driver),
                        model: table.profiles[0]!.model,
                        options: [
                          {
                            id: driver === "codex" ? "reasoningEffort" : "effort",
                            value: table.profiles[0]!.effort,
                          },
                        ],
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
              Exact instructions take precedence over the automatic allowlist. Conflicting provider
              or account constraints are reported without substitution.
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
                value={String(request.override.options[0]?.value ?? "")}
                onChange={(e) =>
                  setRequest({
                    ...request,
                    override: {
                      ...request.override!,
                      options: [
                        {
                          id: request.override!.driver === "codex" ? "reasoningEffort" : "effort",
                          value: e.target.value,
                        },
                      ],
                    },
                  })
                }
              />
            </label>
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
              choose another provider, clear the override, select its policy tab and enable an
              override again.
            </p>
          </div>
        )}
        {request.reassessment && (
          <div className={group}>
            <p>
              Explicit reassessment starts a new session. The previous session keeps its model and
              native identity. Transport and installation failures alone do not justify escalation.
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
                        e.target.value === "scope-change" ? "scope-change" : "substantive-failure",
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
            <option value="">Any eligible account on this environment</option>
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
              {validPreview.rule}; policy version {validPreview.policyVersion};{" "}
              {validPreview.selectedProfile === null
                ? "No automatic profile"
                : `profile ${validPreview.selectedProfile}`}
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
              )?.label ?? "No eligible account"}
            </p>
            {validPreview.profiles?.map((p) => (
              <p key={p.driver}>
                {p.driver === "codex" ? "Codex" : "Claude"}: {p.model} /{" "}
                {p.options.map((o) => o.value).join(", ")} ?{" "}
                {p.eligible ? "eligible" : "unavailable"}. {p.reason}
              </p>
            ))}
            {validPreview.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        ) : (
          <p>Preview required after input, policy or connection changes.</p>
        )}
      </fieldset>
      <Button
        disabled={busy || !ready || !validPreview}
        size="sm-multiline"
        onClick={() => void save()}
      >
        Save new policy version
      </Button>
      <fieldset className={group}>
        <legend>Start a new human assignment</legend>
        <p>
          Save the draft first. Startup rechecks current catalog and quota availability. Observation
          mode records a proposal without starting.
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
          <textarea className={field} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
            (!startAttempt && JSON.stringify(policy) !== JSON.stringify(snapshot?.policy))
          }
          onClick={() => void create()}
        >
          {startAttempt ? "Retry identical assignment" : "Start with selected profile"}
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
            The previous startup has a durable intent. Restore its inputs to retry, or choose a new
            assignment identity.
          </p>
        )}
      </fieldset>
      <details>
        <summary>Previous policies</summary>
        <div className="space-y-2">
          {snapshot?.policies.map((p) => (
            <div key={p.version}>
              <Button
                size="sm-multiline"
                disabled={busy || !ready}
                onClick={async () => {
                  const response = await call({
                    _tag: "modelRevert",
                    expectedVersion: snapshot.policy.version,
                    version: p.version,
                  });
                  if (response?.modelPolicy) await refresh(true);
                }}
              >
                Revert version {p.version} as a new version
              </Button>
            </div>
          ))}
        </div>
      </details>
      <details>
        <summary>Recent decisions (up to 50)</summary>
        <div className="space-y-3">
          {snapshot?.history.map((d) => (
            <article key={d.request.assignmentId} className={group}>
              <p>
                {new Date(d.at).toLocaleString()} · version {d.policyVersion} · profile{" "}
                {d.selectedProfile ?? "none"}
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
      </details>
    </div>
  );
}
