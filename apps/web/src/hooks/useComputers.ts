import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { EnvironmentId } from "@t3tools/contracts";
import type { ComputerActionInput, ComputerInspectInput } from "@t3tools/contracts";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { formatEnvironmentQueryError } from "../state/query";
import { readComputerCache, writeComputerCache, type ComputerCache } from "../state/computersCache";
import { createComputerDetailReader } from "../state/computersDetail";
import { createComputersSync } from "../state/computersSync";
import {
  createCatalogMemo,
  findRecord,
  keepOffer,
  restoreOffer,
  searchFiles,
  type SearchSource,
} from "../state/computersFiles";
import {
  activityRow,
  failure,
  iso,
  key,
  online,
  panel,
  processList,
  searchCaveats,
} from "../state/computersView";
import { formatMoment } from "../components/computers/computersFormat";
import type {
  ActionState,
  ComputersActions,
  ComputersDetail,
  ComputersViewModel,
  ProcessFocus,
  SearchFilters,
} from "../components/computers/computersViewModel";
import { useClientSettings } from "./useSettings";

const POLL_MS = 10_000;
const DETAIL_POLL_MS = 5_000;
const RESULTS_PAGE_SIZE = 200;

const idle: ActionState = { status: "idle" };
const emptyCache: ComputerCache = {
  overview: null,
  files: null,
  activity: null,
  filesReadAt: null,
};

type Selection =
  | { kind: "disk"; computerId: string; diskId: string; path: string }
  | { kind: "processes"; computerId: string; focus: ProcessFocus }
  | { kind: "file"; fileId: string };
type Inspected = Exclude<Selection, { kind: "file" }>;
type FileActionKind = "keep" | "restore";
type FileActions = Readonly<Record<string, Partial<Record<FileActionKind, ActionState>>>>;

/** What a file's dialog shows when it is opened again: what is still being sent, not what already finished. */
function dropSettled(actions: FileActions, fileId: string): FileActions {
  const mine = actions[fileId];
  if (!mine) return actions;
  const pending = Object.fromEntries(
    Object.entries(mine).filter(([, state]) => state?.status === "submitting"),
  );
  return { ...actions, [fileId]: pending };
}

/**
 * The Computers page's data: every connected computer's saved snapshot, a search across their files,
 * and the keep, restore and retry actions. Reading and saving belong to `createComputersSync`; this
 * shapes what it holds into the view model and routes what the person asks for.
 */
export function useComputers(): { model: ComputersViewModel; actions: ComputersActions } {
  const { environments: connections, isReady } = useEnvironments();
  const environments = useMemo(
    () =>
      [...connections].sort(
        (a, b) => a.label.localeCompare(b.label) || a.environmentId.localeCompare(b.environmentId),
      ),
    [connections],
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const readCommand = useAtomCommand(serverEnvironment.computerRead, { reportFailure: false });
  const actCommand = useAtomCommand(serverEnvironment.computerAction, { reportFailure: false });

  const read = useCallback(
    async (environmentId: EnvironmentId, input: ComputerInspectInput) => {
      const result = await readCommand({ environmentId, input });
      if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      return result.value;
    },
    [readCommand],
  );
  const sync = useMemo(
    () =>
      createComputersSync({ read, loadCache: readComputerCache, saveCache: writeComputerCache }),
    [read],
  );
  const { snapshots, errors, cacheErrors } = useSyncExternalStore(sync.subscribe, sync.getState);

  const knownKey = environments.map((env) => env.environmentId).join(",");
  const onlineKey = environments
    .filter(online)
    .map((env) => env.environmentId)
    .join(",");
  const onlineIds = useMemo(
    () =>
      onlineKey
        .split(",")
        .filter(Boolean)
        .map((id) => EnvironmentId.make(id)),
    [onlineKey],
  );
  useEffect(() => sync.start(), [sync]);
  useEffect(() => {
    void sync.loadOffline(knownKey.split(",").filter(Boolean));
  }, [sync, knownKey]);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void sync.refresh(onlineIds);
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [sync, onlineIds]);

  // ── Search ────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({
    projectId: null,
    computerId: null,
    fileType: null,
  });
  const [limit, setLimit] = useState(RESULTS_PAGE_SIZE);
  // Typing stays responsive while a large saved index is searched behind it.
  const searchedQuery = useDeferredValue(query);
  const catalogOf = useMemo(() => createCatalogMemo(), []);
  const sources = useMemo(
    (): SearchSource[] =>
      environments.map((env) => ({
        environmentId: env.environmentId,
        label: env.label,
        online: online(env),
        files: snapshots[env.environmentId]?.files?.files ?? [],
      })),
    [environments, snapshots],
  );
  const catalog = catalogOf(sources);
  const request = useMemo(
    () => ({ words: searchedQuery.toLowerCase().split(/\s+/).filter(Boolean), ...filters }),
    [searchedQuery, filters],
  );
  const searching = Boolean(
    searchedQuery.trim() || filters.projectId || filters.computerId || filters.fileType,
  );
  const found = useMemo(
    () => (searching ? searchFiles(catalog, request, limit) : null),
    [searching, catalog, request, limit],
  );
  const formatTime = useMemo(
    () => (value: string) => formatMoment(value, Date.now(), timestampFormat) ?? value,
    [timestampFormat],
  );
  const caveats = environments.flatMap((env) =>
    searchCaveats(
      env,
      snapshots[env.environmentId] ?? emptyCache,
      [errors[env.environmentId] ?? null, cacheErrors[env.environmentId] ?? null],
      formatTime,
    ).map((message) => ({ computerName: env.label, message })),
  );
  const projectOptions = useMemo(
    () =>
      [
        ...new Set(
          environments.flatMap((env) => snapshots[env.environmentId]?.files?.projects ?? []),
        ),
      ]
        .sort()
        .map((value) => ({ value, label: value })),
    [environments, snapshots],
  );

  // ── Details ───────────────────────────────────────────────────────────────
  const [selection, setSelection] = useState<Selection | null>(null);
  const [inspected, setInspected] = useState<{
    result: Awaited<ReturnType<typeof read>> | null;
    error: string | null;
  }>({ result: null, error: null });
  const [fileActions, setFileActions] = useState<FileActions>({});
  const detailReader = useMemo(
    () =>
      createComputerDetailReader(
        read,
        (result) => setInspected({ result, error: null }),
        (error) =>
          setInspected((old) => (old.result ? old : { result: null, error: failure(error) })),
      ),
    [read],
  );
  useEffect(() => () => detailReader.invalidate(), [detailReader]);
  const readDetail = (target: Inspected, refresh: boolean) =>
    detailReader.request(
      EnvironmentId.make(target.computerId),
      target.kind === "disk"
        ? { section: "folders", path: target.path, ...(refresh ? { refresh: true } : {}) }
        : { section: "processes" },
    );
  const watched = selection && selection.kind !== "file" ? selection : null;
  const pollDetail = useEffectEvent(() => {
    if (watched && document.visibilityState === "visible") void readDetail(watched, false);
  });
  const watching = watched !== null;
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => pollDetail(), DETAIL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [watching]);

  const select = (next: Selection | null, refresh = false) => {
    detailReader.invalidate();
    setInspected({ result: null, error: null });
    setSelection(next);
    if (next && next.kind !== "file") void readDetail(next, refresh);
  };

  const fileRecord = useMemo(
    () => (selection?.kind === "file" ? findRecord(catalog, selection.fileId) : null),
    [catalog, selection],
  );
  let detail: ComputersDetail | null = null;
  if (selection?.kind === "disk") {
    const slash = selection.path.includes("\\") ? "\\" : "/";
    const trimmed = selection.path.replace(/[\\/]$/, "");
    const parent = trimmed.slice(0, trimmed.lastIndexOf(slash) + 1);
    const { result, error } = inspected;
    detail = {
      ...selection,
      breakdown: error
        ? { status: "error", message: error }
        : !result
          ? { status: "loading" }
          : {
              status: "ready",
              data: {
                path: selection.path,
                parentPath: parent && parent !== selection.path ? parent : null,
                scopeBytes: null,
                measuredAt: iso(result.sampledAt),
                notice: result.errors.join("; ") || null,
                folders: result.files.map((file) => ({
                  path: file.path,
                  name: file.name,
                  kind: file.directory ? "folder" : "file",
                  sizeBytes: file.sizeBytes,
                  note:
                    file.sizeComplete === false
                      ? file.sizeBytes === null
                        ? "Size could not be measured."
                        : "At least this size; the scan stopped before the end."
                      : null,
                  openable: file.directory,
                })),
              },
            },
    };
  } else if (selection?.kind === "processes") {
    const { result, error } = inspected;
    const computer = environments.find((env) => env.environmentId === selection.computerId);
    detail = {
      ...selection,
      processes: error
        ? { status: "error", message: error }
        : !result || !computer
          ? { status: "loading" }
          : {
              status: "ready",
              data: processList(
                computer,
                result,
                snapshots[computer.environmentId]?.activity?.activities ?? [],
              ),
            },
    };
  } else if (selection?.kind === "file") {
    detail = {
      ...selection,
      keepState: fileActions[selection.fileId]?.keep ?? idle,
      restoreState: fileActions[selection.fileId]?.restore ?? idle,
      file: fileRecord
        ? {
            status: "ready",
            data: { ...fileRecord.row, keep: keepOffer(fileRecord), ...restoreOffer(fileRecord) },
          }
        : {
            status: "error",
            message: "This file is no longer in the saved index. Refresh the search.",
          },
    };
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [retryFailures, setRetryFailures] = useState<Readonly<Record<string, string>>>({});

  const perform = async (environmentId: EnvironmentId, input: ComputerActionInput) => {
    const result = await actCommand({ environmentId, input });
    if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
    // Accepted is not finished: read again once the current read ends so its activity row appears.
    void sync.refresh([environmentId], { queue: true });
    return result.value.activity;
  };
  const fileAction = async (
    kind: FileActionKind,
    fileId: string,
    send: () => Promise<{ label: string }>,
  ) => {
    if (fileActions[fileId]?.[kind]?.status === "submitting") return;
    const record = (state: ActionState) =>
      setFileActions((old) => ({ ...old, [fileId]: { ...old[fileId], [kind]: state } }));
    record({ status: "submitting" });
    try {
      const activity = await send();
      record({
        status: "done",
        message: `Request accepted: ${activity.label}. Follow its result in Activity.`,
      });
    } catch (error) {
      record({ status: "failed", message: failure(error) });
    }
  };

  const actions: ComputersActions = {
    onRefresh: () => {
      setRefreshing(true);
      void sync.refresh(onlineIds, { force: true }).finally(() => setRefreshing(false));
      if (watched) void readDetail(watched, true);
    },
    onQueryChange: (value) => {
      setQuery(value);
      setLimit(RESULTS_PAGE_SIZE);
    },
    onFiltersChange: (value) => {
      setFilters(value);
      setLimit(RESULTS_PAGE_SIZE);
    },
    onLoadMoreResults: () => setLimit((value) => value + RESULTS_PAGE_SIZE),
    onOpenDisk: (target) => {
      const again =
        selection?.kind === "disk" &&
        selection.computerId === target.computerId &&
        selection.diskId === target.diskId;
      select({ kind: "disk", ...target, path: target.diskId }, again);
    },
    onOpenFolder: (path) => {
      if (selection?.kind === "disk") select({ ...selection, path });
    },
    onOpenProcesses: (target) => select({ kind: "processes", ...target }),
    onOpenFile: (fileId) => {
      setFileActions((old) => dropSettled(old, fileId));
      select({ kind: "file", fileId });
    },
    onCloseDetail: () => select(null),
    onKeep: ({ fileId, reason }) => {
      const target = findRecord(catalog, fileId);
      const copy = target?.copies.find((candidate) => candidate.online);
      void fileAction("keep", fileId, async () => {
        if (!target || !copy) throw new Error("No reachable computer holds this file.");
        return perform(EnvironmentId.make(copy.computerId), {
          action: "keep",
          path: target.row.path,
          reason,
        });
      });
    },
    onRestore: ({ fileId, computerId, destination }) => {
      const target = findRecord(catalog, fileId);
      const copy = target?.copies.find((candidate) => candidate.computerId === computerId);
      void fileAction("restore", fileId, async () => {
        if (!target || !copy?.online || copy.restorable !== true)
          throw new Error("That computer cannot restore this file right now.");
        return perform(EnvironmentId.make(computerId), {
          action: "restore",
          path: target.row.path,
          destination,
        });
      });
    },
    onRetryActivity: (activityId) => {
      const target = environments
        .flatMap((env) =>
          (snapshots[env.environmentId]?.activity?.activities ?? []).map((activity) => ({
            env,
            activity,
          })),
        )
        .find(({ env, activity }) => key(env.environmentId, activity.id) === activityId);
      if (!target || retrying.has(activityId)) return;
      setRetrying((old) => new Set(old).add(activityId));
      setRetryFailures(({ [activityId]: _cleared, ...rest }) => rest);
      void perform(
        target.env.environmentId,
        target.activity.kind === "backup"
          ? { action: "backup", requestId: target.activity.id }
          : { action: "retry", requestId: target.activity.id },
      )
        .catch((error) => setRetryFailures((old) => ({ ...old, [activityId]: failure(error) })))
        .finally(() =>
          setRetrying((old) => {
            const next = new Set(old);
            next.delete(activityId);
            return next;
          }),
        );
    },
  };

  const activityRows = useMemo(
    () =>
      environments
        .flatMap((env) =>
          (snapshots[env.environmentId]?.activity?.activities ?? []).map((activity) =>
            activityRow(env, activity),
          ),
        )
        .sort((a, b) => ((a.updatedAt ?? "") < (b.updatedAt ?? "") ? 1 : -1))
        .map((row) => {
          const failed = retryFailures[row.id];
          if (retrying.has(row.id)) return { ...row, retry: { state: "in-flight" as const } };
          return failed
            ? {
                ...row,
                failureReason: [row.failureReason, `Retry failed: ${failed}`]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : row;
        }),
    [environments, snapshots, retrying, retryFailures],
  );

  return {
    actions,
    model: {
      computers: isReady
        ? {
            status: "ready",
            data: environments.map((env) =>
              panel(
                env,
                snapshots[env.environmentId] ?? emptyCache,
                errors[env.environmentId] ?? cacheErrors[env.environmentId] ?? null,
              ),
            ),
          }
        : { status: "loading" },
      search: {
        query,
        filters,
        projectOptions,
        computerOptions: environments.map((env) => ({
          value: env.environmentId,
          label: env.label,
        })),
        fileTypeOptions: catalog.fileTypes.map((value) => ({ value, label: value })),
        results: searching
          ? query !== searchedQuery || !found
            ? { status: "loading" }
            : {
                status: "ready",
                rows: found.records.map((record) => record.row),
                totalCount: found.total,
                hasMore: found.total > found.records.length,
                loadingMore: false,
                caveats,
              }
          : { status: "idle" },
      },
      activity: { status: "ready", data: activityRows },
      detail,
      refreshing,
    },
  };
}
