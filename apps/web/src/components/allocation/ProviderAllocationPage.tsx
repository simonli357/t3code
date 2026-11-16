import { useCallback, useEffect, useRef, useState } from "react";
import {
  EnvironmentId,
  MAX_MEMORY_KILL_HOLD_MINUTES,
  MAX_START_SETTLE_MINUTES,
  defaultAllocationPolicy,
  type AllocationPolicy,
  type AllocationOperation,
  type AllocationSnapshot,
  type AllocationResponse,
} from "@t3tools/contracts";
import {
  createAllocationCommands,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { AllocationControls } from "./AllocationControls";
import { Button } from "../ui/button";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationCommands(connectionAtomRuntime);
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";

export function ProviderAllocationPage({ environmentId }: { environmentId: EnvironmentId }) {
  return <AllocationEditor key={environmentId} environmentId={environmentId} />;
}

function AllocationEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const execute = useAtomCommand(commands.execute, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const connection = useEnvironment(environmentId)?.connection.phase ?? "offline";
  const [connectionState, setConnectionState] = useState({ phase: connection, epoch: 0 });
  if (connectionState.phase !== connection)
    setConnectionState({ phase: connection, epoch: connectionState.epoch + 1 });
  const [snapshotEpoch, setSnapshotEpoch] = useState<number | null>(null);
  const [failedEpoch, setFailedEpoch] = useState<number | null>(null);
  const generation = useRef(0);
  const accountsRead = useRef(0);
  const mounted = useRef(true);
  const hydrated = useRef(false);
  // The saved settings, then what every computer reports: the settings never wait for it.
  const [settings, setSettings] = useState<AllocationSnapshot | null>(null);
  const [reported, setReported] = useState<AllocationSnapshot | null>(null);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  const snapshot = settings && {
    ...settings,
    inventories: reported?.inventories ?? [],
    runways: reported?.runways ?? settings.runways,
    notices: reported?.notices ?? [],
  };
  const [readAt, setReadAt] = useState(0);
  const ready = connection === "connected" && snapshotEpoch === connectionState.epoch;
  const live = connection === "connected" || connection === "connecting";
  const loadingSettings =
    connection === "connecting" ||
    (connection === "connected" &&
      snapshotEpoch !== connectionState.epoch &&
      failedEpoch !== connectionState.epoch);
  const [policy, setPolicy] = useState<AllocationPolicy>(defaultAllocationPolicy);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [coordinator, setCoordinator] = useState<string>(environmentId);
  const [connections, setConnections] = useState<AllocationResponse["connections"]>();
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
  /** Accounts, limits and workers from every computer; a slow computer delays only these. */
  const readAccounts = useCallback(async () => {
    const read = ++accountsRead.current;
    setAccounts("loading");
    const result = await execute({ environmentId, input: { _tag: "snapshot", part: "accounts" } });
    if (!mounted.current || read !== accountsRead.current) return;
    if (result._tag === "Success" && result.value.snapshot) {
      setReported(result.value.snapshot);
      setReadAt(Date.now());
      setAccounts("loaded");
    } else setAccounts("failed");
  }, [environmentId, execute]);
  const receive = useCallback((next: AllocationSnapshot, epoch: number) => {
    setSettings(next);
    setReadAt((current) => current || Date.now());
    setSnapshotEpoch(epoch);
  }, []);
  const load = async (replaceDraft = false) => {
    const epoch = ++generation.current;
    const [topology, response] = await Promise.all([
      execute({ environmentId, input: { _tag: "connections" } }),
      call({ _tag: "snapshot", part: "settings" }),
    ]);
    if (!mounted.current || epoch !== generation.current) return;
    void readAccounts();
    if (topology._tag === "Success" && topology.value.connections)
      setConnections(topology.value.connections);
    if (!response?.snapshot) return;
    receive(response.snapshot, connectionState.epoch);
    if (replaceDraft || !hydrated.current) setPolicy(response.snapshot.policy);
    hydrated.current = true;
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const epoch = ++generation.current;
    void Promise.resolve().then(async () => {
      if (!active) return;
      if (connection !== "connected") {
        setBusy(false);
        return;
      }
      setBusy(true);
      setError("");
      const [topology, result] = await Promise.all([
        execute({ environmentId, input: { _tag: "connections" } }),
        execute({ environmentId, input: { _tag: "snapshot", part: "settings" } }),
      ]);
      if (!active || epoch !== generation.current) return;
      setBusy(false);
      // Only now: the server runs one database query at a time, and this computer's inventory
      // would otherwise hold up the saved settings.
      void readAccounts();
      if (topology._tag === "Success" && topology.value.connections) {
        setConnections(topology.value.connections);
        if (!hydrated.current)
          setCoordinator(topology.value.connections.coordinatorEnvironmentId ?? environmentId);
      }
      if (result._tag === "Success" && result.value.snapshot) {
        receive(result.value.snapshot, connectionState.epoch);
        if (!hydrated.current) {
          setPolicy((current) =>
            current === defaultAllocationPolicy ? result.value.snapshot!.policy : current,
          );
          hydrated.current = true;
        }
      } else {
        setFailedEpoch(connectionState.epoch);
        setError("Allocation coordinator unavailable. Reconnect and refresh.");
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch, readAccounts, receive]);
  const coordinatorChoices = connections?.environments ?? [
    { environmentId, label: "This environment" },
  ];
  const inRange = (value: number | null | undefined, max: number) =>
    value == null || (Number.isFinite(value) && value >= 0 && value <= max);
  const canSave =
    policy.version === snapshot?.policy.version &&
    inRange(policy.closeMarginPoints, 50) &&
    inRange(policy.longWaitHours, 168) &&
    inRange(policy.workerMemoryGiB, 256) &&
    inRange(policy.minFreeMemoryGiB, 256) &&
    inRange(policy.startSettleMinutes, MAX_START_SETTLE_MINUTES) &&
    inRange(policy.sessionReserveGiB, 16) &&
    inRange(policy.memoryKillHoldMinutes, MAX_MEMORY_KILL_HOLD_MINUTES) &&
    (policy.accountCaps ?? []).every(
      (cap) => inRange(cap.weeklyPercent, 100) && inRange(cap.fiveHourPercent, 100),
    );
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
  return (
    <div className="flex w-full min-w-0 flex-col gap-6 [overflow-wrap:anywhere] [&>*]:min-w-0 [&_label]:grid [&_label]:min-w-0 [&_label]:grid-cols-1 [&_label]:gap-1 [&_fieldset]:min-w-0">
      <header>
        <h1 className="text-xl font-semibold">Provider allocation</h1>
        <p className="text-sm text-muted-foreground">
          A worker starts on the account with the most room for its job, accounts within their daily
          goal first. Only hard caps, real limits and the workers switch block an account.
        </p>
      </header>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!ready && (loadingSettings || connection !== "connected") && (
        <p role="status" className="text-sm text-muted-foreground">
          {loadingSettings
            ? snapshot
              ? "Refreshing saved settings…"
              : "Loading saved settings…"
            : snapshot
              ? "Not connected: last-known settings are read-only. Unsaved changes are retained."
              : "Not connected. Connect this environment to view and edit its settings."}
        </p>
      )}
      {ready && !snapshot?.authorityAvailable && (
        <p role="status">
          Settings are read-only until a coordinator is connected. Choose one under Coordinator
          below.
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
        accounts={accounts === "loading" && !live ? "offline" : accounts}
        disabled={busy || !ready || !snapshot?.authorityAvailable}
        onChange={setPolicy}
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
        <summary className="cursor-pointer font-medium">Coordinator</summary>
        <div className="mt-4 grid min-w-0 gap-3">
          <p className="text-sm text-muted-foreground">
            One computer keeps these settings for every linked computer and decides each start. It
            is this computer or a linked one, and must be reachable to connect.
          </p>
          <div className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label>
              Computer
              <select
                className={field}
                disabled={busy || !connections}
                value={coordinator}
                onChange={(e) => setCoordinator(e.target.value)}
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
                  setSettings(null);
                  setReported(null);
                  await load();
                }
              }}
            >
              Connect coordinator
            </Button>
          </div>
          {ready && (
            <p className="text-sm">
              {snapshot?.authorityAvailable
                ? `Connected · settings version ${snapshot.policy.version}`
                : "No coordinator is connected yet."}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
