import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  ThreadId,
  AllocationPolicy,
  defaultAllocationPolicy,
  type AllocationDecision,
  type AllocationOperation,
  type AllocationRequest,
  type AllocationSnapshot,
  type AllocationResponse,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  createAllocationCommands,
  allocationPreviewKey,
  allocationChartPoints,
  allocationSummary,
  allocationAccountLabel,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { AllocationControls, AllocationAnalytics } from "./AllocationControls";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationCommands(connectionAtomRuntime);
const decodePolicy = Schema.decodeUnknownSync(AllocationPolicy);
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
  const [overrides, setOverrides] = useState("[]");
  const [overrideAccount, setOverrideAccount] = useState("");
  const [overrideWindow, setOverrideWindow] = useState("");
  const [useBy, setUseBy] = useState("");
  const [expires, setExpires] = useState("");
  const [resetPlan, setResetPlan] = useState<"possible" | "planned" | "manual-confirmed">(
    "possible",
  );
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
    setSnapshotEpoch(connectionState.epoch);
    if (replaceDraft || !hydrated.current) {
      setPolicy(response.snapshot.policy);
      setOverrides(JSON.stringify(response.snapshot.policy.overrides, null, 2));
    }
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
        setSnapshotEpoch(connectionState.epoch);
        if (!hydrated.current) {
          setPolicy((current) =>
            current === defaultAllocationPolicy ? result.value.snapshot!.policy : current,
          );
          setOverrides((current) =>
            current === "[]"
              ? JSON.stringify(result.value.snapshot!.policy.overrides, null, 2)
              : current,
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
  const overrideSource = snapshot?.inventories
    .flatMap((i) => i.accounts)
    .find((a) => a.accountKey === overrideAccount);
  const addOverride = () => {
    try {
      const source = overrideSource?.windows.find((w) => w.id === overrideWindow);
      if (!source || !expires) throw new Error("Missing window or expiry");
      const value = decodePolicy({
        ...policy,
        overrides: [
          ...JSON.parse(overrides),
          {
            accountKey: overrideAccount,
            windowId: overrideWindow,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(expires).toISOString(),
            baselineUsedPoints: source.usedPoints,
            ...(useBy ? { useBy: new Date(useBy).toISOString() } : {}),
            resetPlan,
          },
        ],
      });
      setOverrides(JSON.stringify(value.overrides, null, 2));
      setPreviewKey(null);
    } catch {
      setError("Choose an account, window and valid expiry before adding a temporary target.");
    }
  };
  const draft = () => decodePolicy({ ...policy, overrides: JSON.parse(overrides) });
  let previewCurrent = false;
  let canSave = false;
  try {
    previewCurrent = previewKey === allocationPreviewKey(draft(), request);
    const capsValid = (policy.accountCaps ?? []).every(
      (cap) =>
        (cap.weeklyPercent === null ||
          (Number.isFinite(cap.weeklyPercent) &&
            cap.weeklyPercent >= 0 &&
            cap.weeklyPercent <= 100)) &&
        (cap.fiveHourPercent === null ||
          (Number.isFinite(cap.fiveHourPercent) &&
            cap.fiveHourPercent >= 0 &&
            cap.fiveHourPercent <= 100)),
    );
    canSave =
      policy.version === snapshot?.policy.version &&
      policy.defaultHours <= policy.maxForecastHours &&
      capsValid;
  } catch {
    /* Validation appears when preview is requested. */
  }
  const preview = async () => {
    try {
      const next = draft();
      const response = await call({ _tag: "preview", request, policy: next });
      if (response?.result) {
        setDecision(response.result.decision);
        setPreviewKey(allocationPreviewKey(next, request));
      }
    } catch {
      setError("Check policy numbers, dates, and temporary override JSON.");
    }
  };
  const save = async () => {
    try {
      const response = await call({
        _tag: "policy",
        input: { expectedVersion: policy.version, policy: draft() },
      });
      if (response?.policy) {
        setNotice("Settings saved.");
        setPolicy(response.policy);
        setOverrides(JSON.stringify(response.policy.overrides, null, 2));
        await load();
      }
    } catch {
      setError("Check the highlighted numeric ranges and temporary targets before saving.");
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
          Tune advisory budgets and account preferences, plus optional hard caps that stop work.
          Advisory estimates never veto a valid explicit account choice; an active hard cap does.
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
        disabled={busy || !ready || !snapshot?.authorityAvailable}
        onChange={(next) => {
          setPolicy(next);
          setPreviewKey(null);
        }}
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
              accountWeights: [],
            });
            setOverrides("[]");
            setPreviewKey(null);
            setNotice(
              "Defaults restored in your draft. Save settings to apply; recommendations remain advisory.",
            );
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
      {policy.defaultHours > policy.maxForecastHours && (
        <p role="alert">Default forecast duration must fit within the forecast horizon.</p>
      )}
      <AllocationAnalytics snapshot={snapshot} policy={snapshot?.policy ?? policy} />
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
              <p className="text-sm">
                Quota history and charts are retained only for accounts already opted into usage
                measurements. Shared accounts retain allocation choices and reservation metadata.
              </p>
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
            Choose this computer or a linked environment from Connections. Linked environments may
            be offline; the connection must succeed before their coordinator can be used.
          </p>
          <details>
            <summary>Advanced connection details</summary>
            <p>Execution environment ID: {environmentId}</p>
            <p>Selected coordinator ID: {coordinator}</p>
          </details>
          <p className="text-sm">
            {ready && snapshot?.authorityAvailable
              ? `Coordinator ready · policy ${snapshot.policy.version} · advisory`
              : "Coordinator not ready. Choose this environment or a linked coordinator before managed startup."}
          </p>
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">Try this assignment</h2>
            {decision && !previewCurrent && (
              <p className="text-sm">
                Settings or assignment changed; preview again for a current recommendation.
              </p>
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
              <label>
                Expected hours
                <input
                  className={field}
                  type="number"
                  min="0.01"
                  max="168"
                  value={request.expectedHours ?? 1}
                  onChange={(e) =>
                    setRequest({ ...request, expectedHours: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <Button
              size="sm-multiline"
              disabled={busy || !ready || !request.model}
              onClick={() => void preview()}
            >
              Preview assignment and policy
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
                  Preview starts nothing. Start submits your chosen profile, even with advisory
                  warnings. Actual provider errors remain visible. Existing sessions, forks and
                  retries retain their selection.
                </p>
              </div>
            </details>
          </section>
          <section className="flex flex-col gap-4">
            <h2 className="font-semibold">Temporary targets</h2>
            <details>
              <summary>Temporary targets and reset plans</summary>
              <div className="my-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <label>
                  Account
                  <select
                    className={field}
                    value={overrideAccount}
                    onChange={(e) => {
                      setOverrideAccount(e.target.value);
                      setOverrideWindow("");
                    }}
                  >
                    <option value="">Choose account</option>
                    {[
                      ...new Map(
                        snapshot?.inventories
                          .flatMap((i) => i.accounts)
                          .filter((a) => a.accountKey)
                          .map((a) => [a.accountKey, a]) ?? [],
                      ).values(),
                    ].map((a) => (
                      <option key={a.accountKey} value={a.accountKey!}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Allowance window
                  <select
                    className={field}
                    value={overrideWindow}
                    onChange={(e) => setOverrideWindow(e.target.value)}
                  >
                    <option value="">Choose window</option>
                    {overrideSource?.windows.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Use allowance by (local time)
                  <input
                    className={field}
                    type="datetime-local"
                    value={useBy}
                    onChange={(e) => setUseBy(e.target.value)}
                  />
                </label>
                <label>
                  Override expires (local time)
                  <input
                    className={field}
                    type="datetime-local"
                    value={expires}
                    onChange={(e) => setExpires(e.target.value)}
                  />
                </label>
                <label>
                  Reset plan
                  <select
                    className={field}
                    value={resetPlan}
                    onChange={(e) => setResetPlan(e.target.value as typeof resetPlan)}
                  >
                    <option value="possible">Possible, unconfirmed</option>
                    <option value="planned">Planned, unconfirmed</option>
                    <option value="manual-confirmed">Manual reset reported</option>
                  </select>
                </label>
                <Button size="sm-multiline" variant="outline" onClick={addOverride}>
                  Add temporary target
                </Button>
              </div>
              <p className="my-2 text-sm">
                Reset plans never replenish quota or change the normal reset schedule. Provider
                readings must confirm replenishment. Targets expire automatically.
              </p>
              <details>
                <summary>Advanced override values and removal</summary>
                <label>
                  Temporary overrides (JSON)
                  <textarea
                    className={`${field} w-full font-mono`}
                    rows={7}
                    value={overrides}
                    onChange={(e) => setOverrides(e.target.value)}
                  />
                </label>
                <Button size="sm-multiline" variant="outline" onClick={() => setOverrides("[]")}>
                  End all temporary targets on save
                </Button>
              </details>
              {policy.overrides.map((o) => (
                <div
                  key={`${o.accountKey}:${o.windowId}:${o.createdAt}`}
                  className="my-2 rounded border p-2 text-sm"
                >
                  <p>
                    {o.windowId} ·{" "}
                    {snapshot?.inventories
                      .flatMap((i) => i.accounts)
                      .find((a) => a.accountKey === o.accountKey)?.label ?? "Unavailable account"}
                  </p>
                  <p>
                    Use by {time(o.useBy ?? null)}; expires {time(o.expiresAt)}.{" "}
                    {o.resetPlan === "manual-confirmed"
                      ? "Manual reset reported; provider confirmation is still required."
                      : `${o.resetPlan ?? "No"} reset plan; unconfirmed.`}
                  </p>
                </div>
              ))}
            </details>
          </section>
          <section className="flex flex-col gap-4">
            <h2 className="font-semibold">Accounts and allowance windows</h2>
            {snapshot?.inventories.map((host) => (
              <div key={host.environmentId}>
                <h3>
                  {environmentLabel(host.environmentId)} ·{" "}
                  {host.complete ? "load observed" : "load unknown"}
                </h3>
                {host.accounts.map((a) => (
                  <article key={a.instanceId} className="my-3 rounded border p-3">
                    <h4 className="font-medium">
                      {a.label} · {PROVIDER_DISPLAY_NAMES[a.driver] ?? "Other provider"}
                    </h4>
                    <label>
                      Available for workers
                      <Switch
                        checked={a.availableForWorkers !== false}
                        disabled={busy || !ready}
                        onCheckedChange={async (checked) => {
                          setBusy(true);
                          setError("");
                          try {
                            const result = await updateSettings({
                              environmentId: EnvironmentId.make(host.environmentId),
                              input: {
                                patch: {
                                  workerDisabledInstanceIds: host.accounts
                                    .filter((account) =>
                                      account.instanceId === a.instanceId
                                        ? !checked
                                        : account.availableForWorkers === false,
                                    )
                                    .map((account) => account.instanceId),
                                },
                              },
                            });
                            if (result._tag === "Success") await load();
                            else
                              setError("Could not save worker availability. Reconnect and retry.");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      />
                    </label>
                    <p className="text-xs">
                      Short window:{" "}
                      {a.shortWindow === "known-absent"
                        ? "none reported in complete read"
                        : a.shortWindow}{" "}
                      ·{" "}
                      {
                        host.demand.filter((d) =>
                          a.accountKey !== null
                            ? d.accountKey === a.accountKey
                            : d.instanceId === a.instanceId,
                        ).length
                      }{" "}
                      ongoing ·{" "}
                      {
                        snapshot.reservations.filter(
                          (r) =>
                            (a.accountKey !== null
                              ? r.accountKey === a.accountKey
                              : r.request.environmentId === a.environmentId &&
                                r.instanceId === a.instanceId) &&
                            ["reserved", "starting"].includes(r.state),
                        ).length
                      }{" "}
                      pending
                    </p>
                    <details>
                      <summary>Advanced account details</summary>
                      <p>Account identity: {a.accountKey ?? "unknown"}</p>
                      <p>Provider instance ID: {a.instanceId}</p>
                      <p>Environment ID: {host.environmentId}</p>
                      {a.shortWindowAbsentCheckedAt && (
                        <p>Complete window read: {time(a.shortWindowAbsentCheckedAt)}</p>
                      )}
                    </details>
                    {a.unavailableReason && <p>Observed warning: {a.unavailableReason}</p>}
                    {a.windows.map((w) => {
                      const points = a.accountKey
                        ? allocationChartPoints(snapshot, a.accountKey, w.id)
                        : [];
                      return (
                        <div key={w.id} className="mt-3">
                          <p>
                            {w.label}: {w.usedPoints.toFixed(1)}% used · reset {time(w.resetsAt)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Read {time(w.checkedAt)} · {w.samples} quota samples ·{" "}
                            {w.ratePointsPerHour === null
                              ? "rate unknown"
                              : `${w.ratePointsPerHour.toFixed(2)} points/hour`}{" "}
                            ·{" "}
                            {w.rateAgeMinutes === null
                              ? "rate age unknown"
                              : `${w.rateAgeMinutes.toFixed(1)} min old`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Prediction error:{" "}
                            {w.predictionErrorPointsPerHour == null
                              ? "insufficient comparable samples"
                              : `${w.predictionErrorPointsPerHour.toFixed(2)} points/hour`}
                            . Model/effort/context profile: {a.profileSamples} comparable turns.
                          </p>
                          <progress
                            className="w-full"
                            max={100}
                            value={w.usedPoints}
                            aria-label={`${w.label} actual usage`}
                          />
                          {points.length > 1 && (
                            <svg
                              viewBox="0 0 400 100"
                              className="h-24 w-full"
                              role="img"
                              aria-label="Observed actual usage (solid) and policy target (dashed) over decision history"
                            >
                              <polyline
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                points={points
                                  .map((p) => `${p.xPercent * 4},${100 - p.actual}`)
                                  .join(" ")}
                              />
                              <polyline
                                fill="none"
                                stroke="currentColor"
                                strokeDasharray="5 4"
                                points={points
                                  .map((p) => `${p.xPercent * 4},${100 - p.target}`)
                                  .join(" ")}
                              />
                            </svg>
                          )}
                        </div>
                      );
                    })}
                    {a.resetCredits && (
                      <p className="mt-2 text-xs">
                        Banked resets: {a.resetCredits.count}; next expiry{" "}
                        {time(a.resetCredits.expiresAt)}. {a.resetCredits.scope}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Reservations</h2>
            <p className="text-sm">
              Starting and running capacity remains protected until an execution receipt confirms
              completion. Stop or cancel the session to release it.
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
          : summary.choice}{" "}
        · {summary.confidence} confidence
      </p>
      <p>{summary.reason}</p>
      <p className="text-sm">
        {summary.eligible} compatible / {summary.excluded} outside constraints
      </p>
      {decision.candidates.map((c) => (
        <details key={`${c.environmentId}:${c.instanceId}`}>
          <summary>
            {accountLabel(c.environmentId, c.instanceId)} · {environmentLabel(c.environmentId)}:{" "}
            {c.eligible ? "compatible" : "outside constraints"}
          </summary>
          <p className="text-sm">{c.reasons.join(" ")}</p>
          {(c.warnings?.length ?? 0) > 0 && (
            <p className="text-sm">Warnings: {c.warnings!.join(" ")}</p>
          )}
          {c.windows.map((w) => (
            <p key={w.id} className="text-xs">
              {w.id}: actual {w.actualPoints.toFixed(1)} / target {w.targetPoints.toFixed(1)};
              forecast {w.forecastPoints.toFixed(1)} points, remaining headroom{" "}
              {w.headroomPoints.toFixed(1)}.
              {w.budgetHeadroomPoints !== undefined && (
                <>
                  {" "}
                  Running {w.runningForecastPoints?.toFixed(1)}, queued/reserved{" "}
                  {w.queuedForecastPoints?.toFixed(1)}, incoming{" "}
                  {w.incomingForecastPoints?.toFixed(1)}, aggregate/reading-age allowance{" "}
                  {w.unobservedForecastPoints?.toFixed(1)}; budget {w.budgetPoints?.toFixed(1)},
                  projected budget headroom {w.budgetHeadroomPoints.toFixed(1)}
                  {w.budgetHeadroomPoints ===
                  Math.min(...c.windows.map((v) => v.budgetHeadroomPoints ?? v.headroomPoints))
                    ? " (limiting)"
                    : ""}
                  .
                </>
              )}
            </p>
          ))}
        </details>
      ))}
    </div>
  );
}
