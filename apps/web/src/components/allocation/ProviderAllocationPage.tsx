import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  ThreadId,
  defaultAllocationPolicy,
  type AllocationPolicy,
  type AllocationDecision,
  type AllocationOperation,
  type AllocationRequest,
  type AllocationSnapshot,
  type AllocationResponse,
} from "@t3tools/contracts";
import {
  createAllocationCommands,
  allocationPreviewKey,
  allocationSummary,
  allocationAccountLabel,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { AllocationControls } from "./AllocationControls";
import { Button } from "../ui/button";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationCommands(connectionAtomRuntime);
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-CA", { timeZone: "America/Toronto" }) : "Unknown";
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";

export function ProviderAllocationPage({ environmentId }: { environmentId: EnvironmentId }) {
  return <AllocationEditor key={environmentId} environmentId={environmentId} />;
}

function AllocationEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const start = useAtomCommand(commands.start, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const connection = useEnvironment(environmentId)?.connection.phase ?? "offline";
  const [connectionState, setConnectionState] = useState({ phase: connection, epoch: 0 });
  if (connectionState.phase !== connection)
    setConnectionState({ phase: connection, epoch: connectionState.epoch + 1 });
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const hydrated = useRef(false);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<AllocationSnapshot | null>(null);
  const [readAt, setReadAt] = useState(0);
  const ready = connection === "connected" && snapshotEpoch === connectionState.epoch;
  const [policy, setPolicy] = useState<AllocationPolicy>(defaultAllocationPolicy);
  const [decision, setDecision] = useState<AllocationDecision | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [coordinator, setCoordinator] = useState<string>(environmentId);
  const [connections, setConnections] = useState<AllocationResponse["connections"]>();
  const [request, setRequest] = useState<AllocationRequest>(() => ({
    assignmentId: randomUUID(),
    threadId: ThreadId.make(randomUUID()),
    environmentId,
    driver: ProviderDriverKind.make("codex"),
    model: "",
    options: [],
  }));
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("Allocated session");
  const call = async (operation: AllocationOperation) => {
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await execute({ environmentId, input: operation });
      if (!mounted.current || epoch !== generation.current) return null;
      if (result._tag !== "Success") {
        setError(
          "Request failed. The coordinator may be unavailable, or a newer policy was saved. Reload before retrying.",
        );
        return null;
      }
      return result.value;
    } finally {
      if (mounted.current && epoch === generation.current) setBusy(false);
    }
  };
  const load = async (replaceDraft = false) => {
    const epoch = ++generation.current;
    setPreviewKey(null);
    const topology = await execute({ environmentId, input: { _tag: "connections" } });
    if (!mounted.current || epoch !== generation.current) return;
    if (topology._tag === "Success" && topology.value.connections)
      setConnections(topology.value.connections);
    const response = await call({ _tag: "snapshot" });
    if (epoch !== generation.current || !response?.snapshot) return;
    setSnapshot(response.snapshot);
    setReadAt(Date.now());
    setSnapshotEpoch(connectionState.epoch);
    if (replaceDraft || !hydrated.current) setPolicy(response.snapshot.policy);
    hydrated.current = true;
    setPreviewKey(null);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const epoch = ++generation.current;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setPreviewKey(null);
      if (connection !== "connected") {
        setBusy(false);
        return;
      }
      setBusy(true);
      setError("");
      const [topology, result] = await Promise.all([
        execute({ environmentId, input: { _tag: "connections" } }),
        execute({ environmentId, input: { _tag: "snapshot" } }),
      ]);
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      if (topology._tag === "Success" && topology.value.connections) {
        setConnections(topology.value.connections);
        if (!hydrated.current)
          setCoordinator(topology.value.connections.coordinatorEnvironmentId ?? environmentId);
      }
      if (result._tag === "Success" && result.value.snapshot) {
        setSnapshot(result.value.snapshot);
        setReadAt(Date.now());
        setSnapshotEpoch(connectionState.epoch);
        if (!hydrated.current) {
          setPolicy((current) =>
            current === defaultAllocationPolicy ? result.value.snapshot!.policy : current,
          );
          hydrated.current = true;
        }
      } else setError("Allocation coordinator unavailable. Reconnect and refresh.");
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch]);
  const environmentLabel = (id: string) =>
    connections?.environments.find((e) => e.environmentId === id)?.label ??
    snapshot?.inventories.find((i) => i.environmentId === id)?.environmentLabel ??
    (id === environmentId ? "This environment" : "Disconnected environment");
  const coordinatorChoices = connections?.environments ?? [
    { environmentId, label: "This environment" },
  ];
  const accountLabel = (host: string, instance: string) =>
    allocationAccountLabel(snapshot, host, instance);
  const accounts =
    snapshot?.inventories
      .flatMap((i) => i.accounts)
      .filter((a) => a.environmentId === environmentId) ?? [];
  const drivers = [...new Set(accounts.map((a) => a.driver))];
  const models = [
    ...new Map(
      accounts
        .filter((a) => a.driver === request.driver)
        .flatMap((a) => a.models)
        .map((m) => [m.slug, m]),
    ).values(),
  ];
  const model = models.find((m) => m.slug === request.model);
  const inRange = (value: number | null | undefined, max: number) =>
    value == null || (Number.isFinite(value) && value >= 0 && value <= max);
  const previewCurrent = previewKey === allocationPreviewKey(policy, request);
  const canSave =
    policy.version === snapshot?.policy.version &&
    inRange(policy.closeMarginPoints, 50) &&
    inRange(policy.longWaitHours, 168) &&
    (policy.accountCaps ?? []).every(
      (cap) => inRange(cap.weeklyPercent, 100) && inRange(cap.fiveHourPercent, 100),
    );
  const preview = async () => {
    const response = await call({ _tag: "preview", request, policy });
    if (response?.result) {
      setDecision(response.result.decision);
      setPreviewKey(allocationPreviewKey(policy, request));
    }
  };
  const save = async () => {
    const response = await call({
      _tag: "policy",
      input: { expectedVersion: policy.version, policy },
    });
    if (response?.policy) {
      setNotice("Settings saved.");
      setPolicy(response.policy);
      await load();
    }
  };
  /** Each computer keeps its own list of accounts that workers may not use. */
  const setWorkers = async (row: AllocationAccountRow, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      const results = await Promise.all(
        [...new Set(row.instances.map((instance) => instance.environmentId))].map((host) =>
          updateSettings({
            environmentId: EnvironmentId.make(host),
            input: {
              patch: {
                workerDisabledInstanceIds: (
                  snapshot?.inventories.find((i) => i.environmentId === host)?.accounts ?? []
                )
                  .filter((account) =>
                    row.members.includes(account)
                      ? !enabled
                      : account.availableForWorkers === false,
                  )
                  .map((account) => account.instanceId),
              },
            },
          }),
        ),
      );
      if (results.every((result) => result._tag === "Success")) await load();
      else setError("Could not save worker availability. Reconnect and retry.");
    } finally {
      setBusy(false);
    }
  };
  const startSession = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await start({
        environmentId,
        input: { request, kind: "session", projectId: ProjectId.make(projectId), title, prompt },
      });
      if (result._tag !== "Success") {
        setError(
          "Startup did not confirm success. Keep these IDs and retry to reconcile; inspect the allocation history.",
        );
        return;
      }
      setDecision(result.value.allocation?.decision ?? null);
      if (result.value.state === "submitted")
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: result.value.threadId },
        });
      else
        setNotice(
          result.value.state === "observation"
            ? "Observation recorded. No session was started."
            : "No account matches the requested profile and constraints.",
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex w-full min-w-0 flex-col gap-6 [overflow-wrap:anywhere] [&>*]:min-w-0 [&_label]:grid [&_label]:min-w-0 [&_label]:grid-cols-1 [&_label]:gap-1 [&_fieldset]:min-w-0">
      <header>
        <h1 className="text-xl font-semibold">Provider allocation</h1>
        <p className="text-sm text-muted-foreground">
          A worker starts on the account with the most room. Hard caps and the workers switch block
          an account.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!ready && (
        <p role="status" className="text-sm text-muted-foreground">
          {snapshot
            ? "Offline or refreshing: last-known settings are read-only. Unsaved changes are retained."
            : "Loading saved settings. Connect an environment to edit."}
        </p>
      )}
      {ready && !snapshot?.authorityAvailable && (
        <p role="status">
          Settings are read-only until a coordinator is connected. Open Advanced connection below to
          connect.
        </p>
      )}
      {snapshot && policy.version !== snapshot.policy.version && (
        <p role="alert">
          Newer settings are available. Your draft is retained; reload saved settings before editing
          the new version.
        </p>
      )}
      <AllocationControls
        policy={policy}
        snapshot={snapshot}
        now={readAt}
        disabled={busy || !ready || !snapshot?.authorityAvailable}
        onChange={(next) => {
          setPolicy(next);
          setPreviewKey(null);
        }}
        onWorkersChange={(row, enabled) => void setWorkers(row, enabled)}
      />
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button
          size="sm-multiline"
          disabled={busy || !ready || !canSave || !snapshot?.authorityAvailable}
          onClick={() => void save()}
        >
          Save settings
        </Button>
        <Button
          size="sm-multiline"
          variant="outline"
          disabled={busy || !ready || !snapshot?.authorityAvailable}
          onClick={() => {
            setPolicy({
              ...defaultAllocationPolicy,
              version: policy.version,
              coordinatorEnvironmentId: policy.coordinatorEnvironmentId,
              mode: policy.mode,
            });
            setPreviewKey(null);
            setNotice("Defaults restored in your draft. Save settings to apply.");
          }}
        >
          Reset to defaults
        </Button>
        <Button
          size="sm-multiline"
          variant="outline"
          disabled={busy || connection !== "connected"}
          onClick={() => void load(true)}
        >
          Reload saved settings
        </Button>
      </div>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">
          Advanced connection, assignment simulator and diagnostics
        </summary>
        <div className="mt-4 grid min-w-0 gap-4">
          {snapshot && (
            <details>
              <summary>Coverage and limitations</summary>
              {[...new Set(snapshot.notices)].map((n) => (
                <p key={n} className="text-sm">
                  {n}
                </p>
              ))}
            </details>
          )}
          <div className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label>
              Coordinator
              <select
                className={field}
                disabled={busy || !connections}
                value={coordinator}
                onChange={(e) => {
                  setCoordinator(e.target.value);
                  setPreviewKey(null);
                }}
              >
                {coordinatorChoices.map((e) => (
                  <option key={e.environmentId} value={e.environmentId}>
                    {e.label}
                    {e.environmentId === environmentId ? " (this environment)" : ""}
                  </option>
                ))}
                {!coordinatorChoices.some((e) => e.environmentId === coordinator) && (
                  <option value={coordinator}>Previously selected environment (not linked)</option>
                )}
              </select>
            </label>
            <Button
              size="sm-multiline"
              disabled={busy || connection !== "connected" || !coordinator || !connections}
              onClick={async () => {
                if (await call({ _tag: "connect", coordinatorEnvironmentId: coordinator })) {
                  setSnapshot(null);
                  setPreviewKey(null);
                  await load();
                }
              }}
            >
              Connect coordinator
            </Button>
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The coordinator is this computer or a linked one, and must be reachable to connect.
          </p>
          <details>
            <summary>Advanced connection details</summary>
            <p>Execution environment ID: {environmentId}</p>
            <p>Selected coordinator ID: {coordinator}</p>
          </details>
          <p className="text-sm">
            {ready && snapshot?.authorityAvailable
              ? `Coordinator ready · policy ${snapshot.policy.version}`
              : "Coordinator not ready. Choose this environment or a linked coordinator before managed startup."}
          </p>
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">Try this assignment</h2>
            {decision && !previewCurrent && (
              <p className="text-sm">Settings or assignment changed; preview again.</p>
            )}
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label>
                Provider
                <select
                  className={field}
                  value={request.driver}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      driver: ProviderDriverKind.make(e.target.value),
                      model: "",
                      options: [],
                    })
                  }
                >
                  {drivers.map((d) => (
                    <option key={d} value={d}>
                      {PROVIDER_DISPLAY_NAMES[d] ?? "Other provider"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model
                <select
                  className={field}
                  value={request.model}
                  onChange={(e) => setRequest({ ...request, model: e.target.value, options: [] })}
                >
                  <option value="">Choose model</option>
                  {models.map((m) => (
                    <option key={m.slug}>{m.slug}</option>
                  ))}
                </select>
              </label>
              {model?.capabilities?.optionDescriptors?.map((o) => (
                <label key={o.id}>
                  {o.label}
                  <select
                    className={field}
                    value={String(request.options.find((s) => s.id === o.id)?.value ?? "")}
                    onChange={(e) =>
                      setRequest({
                        ...request,
                        options: [
                          ...request.options.filter((s) => s.id !== o.id),
                          ...(e.target.value === ""
                            ? []
                            : [
                                {
                                  id: o.id,
                                  value:
                                    o.type === "boolean"
                                      ? e.target.value === "true"
                                      : e.target.value,
                                },
                              ]),
                        ],
                      })
                    }
                  >
                    <option value="">Provider default</option>
                    {o.type === "boolean" ? (
                      <>
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </>
                    ) : (
                      o.options.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              ))}
              <label>
                Explicit account
                <select
                  className={field}
                  value={request.explicitInstanceId ?? ""}
                  onChange={(e) => {
                    const { explicitInstanceId: _, ...rest } = request;
                    setRequest(
                      e.target.value
                        ? { ...rest, explicitInstanceId: ProviderInstanceId.make(e.target.value) }
                        : rest,
                    );
                  }}
                >
                  <option value="">Let allocation choose</option>
                  {accounts
                    .filter((a) => a.driver === request.driver)
                    .map((a) => (
                      <option key={a.instanceId} value={a.instanceId}>
                        {a.label}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <Button
              size="sm-multiline"
              disabled={busy || !ready || !request.model}
              onClick={() => void preview()}
            >
              Preview account
            </Button>
            {decision && (
              <DecisionView
                decision={decision}
                accountLabel={accountLabel}
                environmentLabel={environmentLabel}
              />
            )}
            <details>
              <summary>Start a new session with this assignment</summary>
              <div className="mt-3 grid min-w-0 grid-cols-1 gap-3">
                <label>
                  Project
                  <select
                    className={field}
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    <option value="">Choose project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Title
                  <input
                    className={field}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label>
                  Task
                  <textarea
                    className={field}
                    rows={3}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>
                <Button
                  size="sm-multiline"
                  disabled={busy || !ready || !request.model || !projectId || !prompt || !title}
                  onClick={() => void startSession()}
                >
                  Request allocation and start
                </Button>
                <p className="text-xs text-muted-foreground">
                  Preview starts nothing; Start submits this model on the chosen account.
                </p>
              </div>
            </details>
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Reservations</h2>
            <p className="text-sm">
              Capacity stays reserved until the session completes, is stopped or is cancelled.
            </p>
            {snapshot?.reservations
              .filter((r) => ["reserved", "starting", "consumed"].includes(r.state))
              .map((r) => (
                <div
                  key={r.assignmentId}
                  className="grid min-w-0 grid-cols-1 items-center gap-3 rounded border p-2 text-sm"
                >
                  <span>
                    {accountLabel(r.request.environmentId, r.instanceId)} · {r.request.model} ·{" "}
                    {environmentLabel(r.request.environmentId)} ·{" "}
                    {r.state === "consumed" ? "running" : r.state} · unused lease expires{" "}
                    {time(r.expiresAt)}
                  </span>
                  {r.state === "reserved" && (
                    <Button
                      size="sm-multiline"
                      variant="outline"
                      disabled={busy || !ready}
                      onClick={async () => {
                        if (
                          await call({
                            _tag: "lifecycle",
                            input: {
                              assignmentId: r.assignmentId,
                              environmentId: r.request.environmentId,
                              threadId: r.request.threadId,
                              action: "release",
                            },
                          })
                        )
                          await load();
                      }}
                    >
                      Cancel unused reservation
                    </Button>
                  )}
                </div>
              ))}
          </section>
          <section>
            <h2 className="font-semibold">Decision history</h2>
            {snapshot?.history.slice(0, 20).map((d) => (
              <details
                key={`${d.at}:${d.request.assignmentId}:${d.policyVersion}`}
                className="my-2 rounded border p-2"
              >
                <summary>
                  {time(d.at)} ·{" "}
                  {d.selectedInstanceId
                    ? accountLabel(d.request.environmentId, d.selectedInstanceId)
                    : d.outcome}{" "}
                  · policy {d.policyVersion}
                </summary>
                <DecisionView
                  decision={d}
                  accountLabel={accountLabel}
                  environmentLabel={environmentLabel}
                />
              </details>
            ))}
          </section>
        </div>
      </details>
    </div>
  );
}
function DecisionView({
  decision,
  accountLabel,
  environmentLabel,
}: {
  decision: AllocationDecision;
  accountLabel: (host: string, instance: string) => string;
  environmentLabel: (host: string) => string;
}) {
  const summary = allocationSummary(decision);
  return (
    <div className="rounded border p-3">
      <p className="font-medium">
        {decision.selectedInstanceId
          ? accountLabel(decision.request.environmentId, decision.selectedInstanceId)
          : decision.outcome === "wait"
            ? `Drained until ${time(decision.waitUntil)}`
            : "No account"}
      </p>
      <p>{summary.reason}</p>
      {decision.candidates.map((c) => (
        <p key={`${c.environmentId}:${c.instanceId}`} className="text-sm">
          {c.line ??
            `${accountLabel(c.environmentId, c.instanceId)} · ${environmentLabel(c.environmentId)}: ${c.reasons.join(" ")}`}
        </p>
      ))}
    </div>
  );
}
