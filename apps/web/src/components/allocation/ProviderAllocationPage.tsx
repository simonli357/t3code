import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  EnvironmentId,
  defaultAllocationPolicy,
  type AllocationPolicy,
  type AllocationOperation,
  type AllocationSnapshot,
  type AllocationResponse,
} from "@t3tools/contracts";
import { createAutosave } from "@t3tools/client-runtime/state/autosave";
import {
  allocationAutosaveRules,
  allocationPolicyChanges,
  allocationSaveFailure,
  createAllocationCommands,
  type AllocationAccountRow,
} from "@t3tools/client-runtime/state/provider-allocation";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironment } from "../../state/environments";
import { AllocationControls } from "./AllocationControls";
import { SaveState } from "./SaveState";
import { FoldedSettingsSection } from "../settings/FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME } from "../settings/itemRows";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { serverEnvironment } from "../../state/server";

const commands = createAllocationCommands(connectionAtomRuntime);
const field =
  "block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
const none: ReadonlySet<string> = new Set();

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
  const chosen = useRef(false);
  // The saved settings, then what every computer reports: the settings never wait for it.
  const [settings, setSettings] = useState<AllocationSnapshot | null>(null);
  const [reported, setReported] = useState<AllocationSnapshot | null>(null);
  const [accounts, setAccounts] = useState<"loading" | "loaded" | "failed">("loading");
  // Every change is stored as it is made; `saving` is what the page shows and how far it got.
  const [store] = useState(() =>
    createAutosave<AllocationPolicy>({
      ...allocationAutosaveRules,
      save: async (policy, baseline) => {
        const result = await execute({
          environmentId,
          input: { _tag: "policy", input: { expectedVersion: baseline.version, policy } },
        });
        if (result._tag !== "Success") return allocationSaveFailure(result.cause);
        return result.value.policy
          ? { saved: result.value.policy }
          : allocationSaveFailure(undefined);
      },
      read: async () => {
        const result = await execute({
          environmentId,
          input: { _tag: "snapshot", part: "settings" },
        });
        return result._tag === "Success" ? (result.value.snapshot?.policy ?? null) : null;
      },
    }),
  );
  const saving = useSyncExternalStore(store.subscribe, store.getState);
  // Leaving the page stores an edit that is still waiting.
  useEffect(() => () => store.flush(), [store]);
  const policy = saving.policy ?? defaultAllocationPolicy;
  const snapshot = settings && {
    ...settings,
    policy: saving.saved ?? settings.policy,
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workersNotSaved, setWorkersNotSaved] = useState(none);
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
        setError("The computer that keeps these settings did not answer. Refresh to try again.");
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
  const receive = useCallback(
    (next: AllocationSnapshot, epoch: number) => {
      setSettings(next);
      setReadAt((current) => current || Date.now());
      setSnapshotEpoch(epoch);
      store.receive(next.policy);
    },
    [store],
  );
  const load = async () => {
    const epoch = ++generation.current;
    const [topology, response] = await Promise.all([
      execute({ environmentId, input: { _tag: "connections" } }),
      call({ _tag: "snapshot", part: "settings" }),
    ]);
    if (!mounted.current || epoch !== generation.current) return;
    void readAccounts();
    if (topology._tag === "Success" && topology.value.connections)
      setConnections(topology.value.connections);
    if (response?.snapshot) receive(response.snapshot, connectionState.epoch);
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
        // The choice follows the stored one until he changes it.
        if (!chosen.current)
          setCoordinator(topology.value.connections.coordinatorEnvironmentId ?? environmentId);
      }
      if (result._tag === "Success" && result.value.snapshot)
        receive(result.value.snapshot, connectionState.epoch);
      else {
        setFailedEpoch(connectionState.epoch);
        setError("The computer that keeps these settings did not answer. Reconnect and refresh.");
      }
    });
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
    };
  }, [environmentId, execute, connection, connectionState.epoch, readAccounts, receive]);
  // A daily goal changes each account's budget so far, which the accounts report.
  const stored = useRef<AllocationPolicy | null>(null);
  useEffect(() => {
    const [before, after] = [stored.current, saving.saved];
    stored.current = after;
    if (
      before &&
      after &&
      [...allocationPolicyChanges(before, after)].some((part) => part.startsWith("goal:"))
    )
      void readAccounts();
  }, [saving.saved, readAccounts]);
  const coordinatorChoices = connections?.environments ?? [
    { environmentId, label: "This computer" },
  ];
  const keeper = coordinatorChoices.find(
    (choice) => choice.environmentId === connections?.coordinatorEnvironmentId,
  );
  /** Each computer keeps its own list of accounts that workers may not use. */
  const setWorkers = async (row: AllocationAccountRow, enabled: boolean) => {
    const failed = (value: boolean) =>
      setWorkersNotSaved((current) => {
        const next = new Set(current);
        if (value) next.add(row.key);
        else next.delete(row.key);
        return next;
      });
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
                  row.members.includes(account) ? !enabled : account.availableForWorkers === false,
                )
                .map((account) => account.instanceId),
            },
          },
        }),
      ),
    );
    if (!mounted.current) return;
    failed(!results.every((result) => result._tag === "Success"));
    // Whatever was stored shows once every computer has reported again.
    void readAccounts();
  };
  const editable = ready && snapshot?.authorityAvailable === true;
  const stuck = saving.phase === "failed" || saving.phase === "conflict";
  return (
    <div className="flex w-full min-w-0 flex-col gap-8 [overflow-wrap:anywhere] [&>*]:min-w-0">
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {snapshot && !loadingSettings && connection !== "connected" && (
        <p className="text-sm text-muted-foreground">
          Not connected: showing the last known settings. They can be changed once this computer
          reconnects.
        </p>
      )}
      {ready && !snapshot?.authorityAvailable && (
        <p className="text-sm text-muted-foreground">
          These settings cannot be changed until the computer that keeps them is reachable. Choose
          it under Settings computer below.
        </p>
      )}
      {saving.phase === "failed" && (
        <Alert variant="error">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            {saving.error} The values marked &quot;Not saved&quot; are not in effect.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={store.retry}>
              Try again
            </Button>
            <Button size="xs" variant="outline" onClick={() => store.resolve(false)}>
              Drop my change
            </Button>
          </AlertAction>
        </Alert>
      )}
      {saving.phase === "conflict" && (
        <Alert variant="warning">
          <AlertTitle>Changed elsewhere while you edited</AlertTitle>
          <AlertDescription>
            A value you changed was also changed on another computer or by an agent. Yours is not
            saved yet.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" onClick={() => store.resolve(true)}>
              Keep mine
            </Button>
            <Button size="xs" variant="outline" onClick={() => store.resolve(false)}>
              Use theirs
            </Button>
          </AlertAction>
        </Alert>
      )}
      <AllocationControls
        policy={policy}
        snapshot={snapshot}
        now={readAt}
        accounts={accounts === "loading" && !live ? "offline" : accounts}
        disabled={!editable}
        notSaved={
          stuck && saving.saved && saving.policy
            ? allocationPolicyChanges(saving.saved, saving.policy)
            : none
        }
        workersNotSaved={workersNotSaved}
        status={
          <div className="flex items-center gap-2">
            <SaveState
              phase={
                loadingSettings ? "loading" : connection !== "connected" ? "offline" : saving.phase
              }
            />
            <Button
              size="xs"
              variant="outline"
              disabled={busy || connection !== "connected"}
              onClick={() => void load()}
            >
              Refresh
            </Button>
          </div>
        }
        onEdit={store.edit}
        onFlush={store.flush}
        onWorkersChange={(row, enabled) => void setWorkers(row, enabled)}
      />
      <FoldedSettingsSection
        id="allocation-settings-computer"
        title="Settings computer"
        summary={
          keeper
            ? `${keeper.label} keeps these settings`
            : ready
              ? "No computer keeps these settings yet"
              : null
        }
      >
        <div className={`${ITEM_ROW_CLASSNAME} grid min-w-0 gap-3`}>
          <p className="text-xs text-muted-foreground">
            One computer keeps these settings for every linked computer and picks the account for
            each start. It must be reachable from this one.
          </p>
          <div className="grid min-w-0 grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="grid min-w-0 gap-1 text-sm">
              Computer
              <select
                className={field}
                disabled={busy || !connections}
                value={coordinator}
                onChange={(e) => {
                  chosen.current = true;
                  setCoordinator(e.target.value);
                }}
              >
                {coordinatorChoices.map((e) => (
                  <option key={e.environmentId} value={e.environmentId}>
                    {e.label}
                    {e.environmentId === environmentId ? " (this computer)" : ""}
                  </option>
                ))}
                {!coordinatorChoices.some((e) => e.environmentId === coordinator) && (
                  <option value={coordinator}>Previously chosen computer (not linked)</option>
                )}
              </select>
            </label>
            <Button
              size="sm"
              disabled={busy || connection !== "connected" || !coordinator || !connections}
              onClick={async () => {
                if (await call({ _tag: "connect", coordinatorEnvironmentId: coordinator })) {
                  setSettings(null);
                  setReported(null);
                  await load();
                }
              }}
            >
              Use this computer
            </Button>
          </div>
        </div>
      </FoldedSettingsSection>
    </div>
  );
}
