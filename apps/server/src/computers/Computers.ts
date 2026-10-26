import * as NodeCrypto from "node:crypto";
import {
  COMPUTER_CAPACITY_MAX_DISKS,
  ComputerActivity,
  ComputerFile,
  ComputerOperationError,
  type ComputerActionInput,
  type ComputerCapacity,
  type ComputerInspection,
  type ComputerInspectInput,
  type HostResourcesSnapshot,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { buildArchive, fromLibraryManifest, toSource, type Archive } from "./Archive.ts";
import {
  indexableRoots,
  indexFiles,
  mergeSorted,
  searchFiles,
  sortFiles,
} from "./ComputerFiles.ts";
import { disks, folders, processes } from "./ComputerTelemetry.ts";
import {
  keepActivity,
  isPublished,
  newReceiptCache,
  readReceipts,
  restoreKeep,
  restoreDestination,
  retryProblem,
  runHandoff,
  runKeep,
  type ReceiptFile,
} from "./Workenv.ts";
import { listNames, writeJson } from "./ComputerStore.ts";
import { decodeCatalogFile, loadCatalog, newCatalog, refreshCatalog } from "./LibraryCatalog.ts";
import { isWithin } from "./paths.ts";
import { readHandoffs, readJobs } from "./WorkenvActivity.ts";
import {
  backupActivity,
  backupWanted,
  retryBackups,
  type BackupVerification,
} from "./WorkenvBackup.ts";
import {
  BackupProof,
  decodeReceipt,
  fail,
  loadWorkenv,
  messageOf,
  operationError,
  type WorkenvConfig,
} from "./WorkenvConfig.ts";
import type { Launched } from "./WorkenvProcesses.ts";

const Index = Schema.Struct({
  files: Schema.Array(ComputerFile),
  indexedAt: Schema.Number,
  errors: Schema.Array(Schema.String),
});
const VerifiedBackup = Schema.Struct({
  id: Schema.String,
  proof: Schema.NullOr(BackupProof),
  at: Schema.Number,
});
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(Index));
const decodeActivity = Schema.decodeUnknownEffect(Schema.fromJsonString(ComputerActivity));
const decodeVerified = Schema.decodeUnknownEffect(Schema.fromJsonString(VerifiedBackup));
const encodeActionKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Keeps and the library catalog are re-read this often, or when asked to refresh. */
const REFRESH_AFTER_MS = 15 * 60_000;
/** Receipts, jobs and handoffs are cached briefly: clients poll and many may be connected. */
const RECEIPTS_TTL_MS = 2_000;
const ACTIVITY_TTL_MS = 10_000;
/** Disks and folder sizes are measured, not read: clients poll, so one measurement serves them for a while. */
const MEASUREMENT_TTL_MS = 30_000;
const FOLDER_LISTINGS_KEPT = 16;
const ACTION_LIMIT = 200;
const PROOF_LIMIT = 5_000;

export class Computers extends Context.Service<
  Computers,
  {
    readonly inspect: (
      input: ComputerInspectInput,
    ) => Effect.Effect<ComputerInspection, ComputerOperationError>;
    readonly act: (
      input: ComputerActionInput,
    ) => Effect.Effect<{ activity: ComputerActivity }, ComputerOperationError>;
    /**
     * A small, current reading for choosing where new work runs; never fails, because a part that
     * cannot be read is reported as missing. `workPath` is where the work would be written.
     */
    readonly capacity: (input?: {
      readonly workPath?: string | undefined;
    }) => Effect.Effect<ComputerCapacity>;
  }
>()("t3/computers/Computers") {}

/** What a finished action reports; the service turns it into the stored activity. */
interface Outcome {
  readonly status: "completed" | "failed";
  readonly detail: string | null;
}
/** A validated action, ready to run. Anything that can be refused up front is refused here. */
interface Plan<R> {
  readonly kind: "transfer" | "backup" | "restore";
  readonly label: string;
  readonly source: string | null;
  /** Only one request with this key runs at a time. */
  readonly key: string;
  readonly destinationKey?: string;
  readonly run: Effect.Effect<Outcome, ComputerOperationError, R>;
}

const interrupted: Outcome = {
  status: "failed",
  detail:
    "Interrupted when the server stopped before a result was recorded. Check the workenv receipts before retrying.",
};
const failed = (detail: string): Outcome => ({
  status: "failed",
  detail,
});
const actionFailureDetail = (kind: ComputerActivity["kind"], detail: string | null) => {
  const instruction =
    kind === "backup"
      ? "Use the native workenv backup row in Activity to retry."
      : kind === "transfer"
        ? "Use the native workenv transfer or handoff row in Activity to retry."
        : null;
  return instruction && !detail?.endsWith(instruction)
    ? `${detail ?? "Action failed."} ${instruction}`
    : detail;
};
const basename = (value: string) => value.split(/[\\/]/).findLast(Boolean) ?? value;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig,
    host = yield* HostResources.HostResources,
    projectQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path,
    platform = yield* HostProcessPlatform,
    scope = yield* Scope.Scope;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
  >();
  const directory = path.join(config.stateDir, "computers");
  const actionsDirectory = path.join(directory, "actions"),
    proofsDirectory = path.join(directory, "proofs"),
    catalogDirectory = path.join(directory, "catalog"),
    indexPath = path.join(directory, "files.json");

  const catalog = newCatalog();
  const activeKeys = new Set<string>(),
    destinations = new Set<string>(),
    activeIds = new Set<string>();
  const normalizeKey = (filename: string) => {
    const normalized = path.normalize(filename).replace(/[\\/]+$/, "") || path.parse(filename).root;
    return platform === "win32" ? normalized.toLowerCase().replaceAll("\\", "/") : normalized;
  };
  const persist = writeJson,
    readNames = listNames;

  for (const folder of [directory, actionsDirectory, proofsDirectory, catalogDirectory]) {
    yield* fs.makeDirectory(folder, { recursive: true });
    for (const name of yield* readNames(folder, ".tmp"))
      yield* fs.remove(path.join(folder, name), { force: true }).pipe(Effect.ignore);
  }

  // --- state loaded at startup ---------------------------------------------------------------
  const startupErrors: string[] = [];
  let index: typeof Index.Type = { files: [], errors: [], indexedAt: 0 };
  let indexVersion = 0;
  if (yield* fs.exists(indexPath))
    yield* fs.readFileString(indexPath).pipe(
      Effect.flatMap(decodeIndex),
      Effect.tap((value) =>
        Effect.sync(() => {
          index = {
            ...value,
            files: sortFiles(
              value.files.map((file) => ({
                ...file,
                area: file.area ?? "project",
                backupVerifiedAt:
                  file.backup === "confirmed" ? (file.backupVerifiedAt ?? null) : null,
              })),
            ),
          };
          indexVersion++;
        }),
      ),
      Effect.catch((cause) =>
        Effect.sync(() => {
          startupErrors.push(`Cannot load the file index: ${messageOf(cause)}`);
        }),
      ),
    );

  // A record still marked running belongs to a server that stopped before it finished.
  const loadedActions: ComputerActivity[] = [];
  for (const name of yield* readNames(actionsDirectory, ".json")) {
    const file = path.join(actionsDirectory, name);
    yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeActivity),
      Effect.flatMap((activity) =>
        Effect.gen(function* () {
          const recovering = activity.status === "running" || activity.status === "pending";
          const status = recovering ? "failed" : activity.status;
          const recovered: ComputerActivity = {
            ...activity,
            status,
            detail:
              status === "failed"
                ? actionFailureDetail(
                    activity.kind,
                    recovering ? interrupted.detail : activity.detail,
                  )
                : activity.detail,
            retryable: false,
          };
          if (recovering || activity.retryable || recovered.detail !== activity.detail)
            yield* persist(file, recovered);
          loadedActions.push(recovered);
        }),
      ),
      Effect.catch((cause) =>
        Effect.sync(() => {
          startupErrors.push(`Cannot load the record of action ${name}: ${messageOf(cause)}`);
        }),
      ),
    );
  }
  const newestFirst = loadedActions.toSorted((a, b) => b.updatedAt - a.updatedAt);
  // Only the newest records are kept: older ones leave the disk too, so the folder stays bounded.
  for (const surplus of newestFirst.slice(ACTION_LIMIT))
    yield* fs
      .remove(path.join(actionsDirectory, `${surplus.id}.json`), { force: true })
      .pipe(Effect.ignore);
  const actions = yield* Ref.make<ReadonlyArray<ComputerActivity>>(
    newestFirst.slice(0, ACTION_LIMIT),
  );
  const verified = new Map<string, BackupVerification>();
  let verifiedVersion = 0;
  // --- actions ---------------------------------------------------------------------------------
  const saveErrors = new Map<string, string>();
  const find = (id: string) =>
    Ref.get(actions).pipe(Effect.map((list) => list.find((activity) => activity.id === id)));
  const save = Effect.fn("Computers.saveAction")(function* (id: string) {
    const activity = yield* find(id);
    if (activity) yield* persist(path.join(actionsDirectory, `${id}.json`), activity);
  });
  const update = (id: string, patch: Partial<ComputerActivity>) =>
    Ref.update(actions, (list) =>
      list.map((activity) => (activity.id === id ? { ...activity, ...patch } : activity)),
    );
  /** The newest finished actions are kept; older records leave the list and the disk. */
  const prune = Effect.gen(function* () {
    const list = yield* Ref.get(actions);
    const finished = list.filter((activity) => !activeIds.has(activity.id));
    const surplus = finished.slice(ACTION_LIMIT);
    if (!surplus.length) return;
    const gone = new Set(surplus.map((activity) => activity.id));
    yield* Ref.set(
      actions,
      list.filter((activity) => !gone.has(activity.id)),
    );
    for (const activity of surplus) {
      saveErrors.delete(activity.id);
      yield* fs
        .remove(path.join(actionsDirectory, `${activity.id}.json`), { force: true })
        .pipe(Effect.ignore);
    }
  });
  const finish = (id: string, outcome: Outcome) =>
    Effect.gen(function* () {
      const activity = yield* find(id);
      activeIds.delete(id);
      yield* update(id, {
        status: outcome.status,
        detail:
          activity && outcome.status === "failed"
            ? actionFailureDetail(activity.kind, outcome.detail)
            : outcome.detail,
        retryable: false,
        updatedAt: yield* Clock.currentTimeMillis,
      });
      yield* save(id).pipe(
        Effect.retry({ times: 2 }),
        Effect.matchEffect({
          onSuccess: () => Effect.sync(() => saveErrors.delete(id)),
          // The result stays correct in memory; on disk the record still says running, which a
          // restart would turn into "interrupted". Say so until the record is written.
          onFailure: (cause) =>
            Effect.sync(() => {
              saveErrors.set(id, `Cannot save the result of an action: ${messageOf(cause)}`);
            }),
        }),
      );
      yield* prune;
      resetCaches();
    });

  /** The workenv configuration, re-read on every request; its stamp tells when the archive must be rebuilt. */
  let configStamp = "";
  const load = Effect.gen(function* () {
    const result = yield* loadWorkenv();
    configStamp = result.stamp;
    return result;
  });

  // --- workenv state, read once per change -------------------------------------------------
  const requestReceipts = newReceiptCache(),
    publishedReceipts = newReceiptCache();
  let localAt = Number.NEGATIVE_INFINITY;
  let local: {
    requests: ReceiptFile[];
    published: ReceiptFile[];
    errors: string[];
    state: string;
  } | null = null;
  let activityAt = Number.NEGATIVE_INFINITY;
  let activityCache: {
    jobs: ComputerActivity[];
    launched: Launched[];
    workRoots: { path: string; project: string; area: "work" }[];
    handoffs: ComputerActivity[];
    errors: string[];
  } | null = null;
  const resetCaches = () => {
    localAt = Number.NEGATIVE_INFINITY;
    activityAt = Number.NEGATIVE_INFINITY;
  };
  const readLocal = Effect.fn("Computers.readLocal")(function* (workenv: WorkenvConfig) {
    const now = yield* Clock.currentTimeMillis;
    if (local && local.state === workenv.state && now - localAt < RECEIPTS_TTL_MS) return local;
    const requests = yield* readReceipts(
      path.join(workenv.state, "keep", "requests"),
      requestReceipts,
    );
    const published = yield* readReceipts(
      path.join(workenv.state, "keep", "receipts"),
      publishedReceipts,
    );
    local = {
      requests: requests.receipts,
      published: published.receipts,
      errors: requests.errors,
      state: workenv.state,
    };
    localAt = now;
    return local;
  });
  const readActivity = Effect.fn("Computers.readActivity")(function* (workenv: WorkenvConfig) {
    const now = yield* Clock.currentTimeMillis;
    if (activityCache && now - activityAt < ACTIVITY_TTL_MS) return activityCache;
    const jobs = yield* readJobs(workenv);
    const handoffs = yield* readHandoffs(workenv);
    activityCache = {
      jobs: jobs.activities,
      launched: jobs.launched,
      workRoots: jobs.workRoots,
      handoffs: handoffs.activities,
      errors: [...jobs.errors, ...handoffs.errors],
    };
    activityAt = now;
    return activityCache;
  });

  // --- the kept archive: this computer's receipts plus the library's own manifests -------------
  let catalogAttemptedAt = 0,
    cataloging = false,
    catalogErrors: string[] = [];
  // Both file lists are kept in `sortFiles` order and merged only when one of them changes, so a
  // page of the list is a slice however many clients page through it.
  let archiveState: {
    signature: string;
    archive: Archive;
    sorted: readonly ComputerFile[];
    builtAt: number;
  } | null = null;
  let merged: { key: string; files: readonly ComputerFile[] } = { key: "", files: [] };

  const currentArchive = Effect.fn("Computers.archive")(function* (workenv: WorkenvConfig) {
    const files = yield* readLocal(workenv);
    const signature = [
      requestReceipts.version,
      publishedReceipts.version,
      catalog.version,
      verifiedVersion,
      platform,
      configStamp,
    ].join("|");
    if (archiveState?.signature === signature) return archiveState;
    const sources = [
      ...files.requests.map((file) => toSource("request", file.key, file.file, file.receipt)),
      ...files.published.map((file) => toSource("receipt", file.key, file.file, file.receipt)),
      ...[...catalog.entries.values()].map((entry) => entry.source),
    ];
    const archive = buildArchive(sources, { config: workenv, platform, verified });
    archiveState = {
      signature,
      archive,
      sorted: sortFiles(archive.files),
      builtAt: yield* Clock.currentTimeMillis,
    };
    return archiveState;
  });

  const referencedProofs = () =>
    new Set([
      ...(local?.requests ?? []).map((file) => file.receipt.id),
      ...(local?.published ?? []).map((file) => file.receipt.id),
      ...[...catalog.entries.values()].map((entry) => entry.source.receipt.id),
    ]);
  let prunedProofs = "";
  const proofSignature = () =>
    [requestReceipts.version, publishedReceipts.version, catalog.version, verifiedVersion].join(
      "|",
    );
  const pruneProofs = Effect.gen(function* () {
    if (prunedProofs === proofSignature()) return;
    const referenced = referencedProofs();
    const retained = new Set(
      [...verified]
        .filter(([id]) => referenced.has(id))
        .toSorted((a, b) => b[1].at - a[1].at)
        .slice(0, PROOF_LIMIT)
        .map(([id]) => id),
    );
    for (const id of verified.keys())
      if (!retained.has(id)) {
        verified.delete(id);
        verifiedVersion++;
        yield* fs.remove(path.join(proofsDirectory, `${id}.json`), { force: true });
      }
    prunedProofs = proofSignature();
  });
  const initialWorkenv = yield* load;
  if (initialWorkenv.config) {
    yield* readLocal(initialWorkenv.config);
    yield* loadCatalog(catalog, catalogDirectory, initialWorkenv.config);
  }
  const referenced = referencedProofs();
  for (const name of (yield* readNames(proofsDirectory, ".json")).sort()) {
    const file = path.join(proofsDirectory, name);
    if (
      !/^[0-9a-f]{32}\.json$/.test(name) ||
      !referenced.has(name.slice(0, -5)) ||
      verified.size >= PROOF_LIMIT
    ) {
      yield* fs.remove(file, { force: true });
      continue;
    }
    yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeVerified),
      Effect.filterOrFail(
        (record) => record.id === name.slice(0, -5),
        () => fail("The proof record does not match its filename."),
      ),
      Effect.tap((record) =>
        Effect.sync(() => {
          if (record.id === name.slice(0, -5)) {
            verified.set(record.id, { proof: record.proof, at: record.at });
            verifiedVersion++;
          }
        }),
      ),
      Effect.catch(() => fs.remove(file, { force: true })),
    );
  }

  // --- inspection --------------------------------------------------------------------------------
  const history: HostResourcesSnapshot[] = [];
  let indexing = false,
    indexAttemptedAt = 0;
  const folderListings = new Map<
    string,
    { at: number; rows: readonly ComputerFile[]; notices: readonly string[] }
  >();
  let diskList: { at: number; disks: ComputerInspection["disks"] } | null = null;
  /** One measurement serves every client and agent that asks within `MEASUREMENT_TTL_MS`. */
  const readDisks = Effect.fn("Computers.readDisks")(function* (at: number) {
    if (diskList && at - diskList.at < MEASUREMENT_TTL_MS) return diskList;
    const read = yield* disks();
    diskList = { at, disks: read };
    return diskList;
  });

  const projectRoots = Effect.fn("Computers.projectRoots")(function* (
    workenv: WorkenvConfig | null,
  ) {
    const projects = yield* projectQuery.getProjectShells().pipe(
      Effect.map((shells) =>
        shells.map((shell) => ({ path: shell.workspaceRoot, project: shell.title })),
      ),
      Effect.orElseSucceed(() => [] as { path: string; project: string }[]),
    );
    const workRoots = workenv ? (yield* readActivity(workenv)).workRoots : [];
    return indexableRoots(
      platform,
      [
        ...projects,
        ...workRoots,
        ...Object.entries(workenv?.projects ?? {}).map(([project, entry]) => ({
          path: entry.source,
          project,
        })),
      ],
      workenv?.keep.library_root,
      (root) => path.parse(root).root,
    );
  });

  const inspect = Effect.fn("Computers.inspect")(function* (input: ComputerInspectInput) {
    const sampledAt = yield* Clock.currentTimeMillis;
    const resources = input.section === "overview" ? yield* host.read : null;
    if (resources && history.at(-1)?.sampledAt !== resources.sampledAt) {
      history.push(resources);
      if (history.length > 120) history.shift();
    }
    const base: ComputerInspection = {
      sampledAt,
      resources,
      history: [...history],
      disks: [],
      files: [],
      totalFiles: 0,
      indexedAt: index.indexedAt || null,
      indexing,
      projects: [],
      processes: [],
      activities: [],
      errors: [...startupErrors, ...saveErrors.values()],
    };
    if (input.section === "processes") {
      const { config: workenv } = yield* load;
      const launched = workenv ? (yield* readActivity(workenv)).launched : [];
      return { ...base, processes: yield* processes(launched) };
    }
    if (input.section === "folders") {
      if (!input.path) return yield* fail("Select a disk or folder first.");
      const known = folderListings.get(input.path);
      const listing =
        known && !input.refresh && sampledAt - known.at < MEASUREMENT_TTL_MS
          ? known
          : yield* folders(input.path).pipe(
              Effect.tap((fresh) =>
                Effect.sync(() => {
                  folderListings.delete(input.path!);
                  folderListings.set(input.path!, { at: sampledAt, ...fresh });
                  // Oldest listings go first, so the cache stays small.
                  for (const key of folderListings.keys()) {
                    if (folderListings.size <= FOLDER_LISTINGS_KEPT) break;
                    folderListings.delete(key);
                  }
                }),
              ),
            );
      return {
        ...base,
        files: listing.rows,
        totalFiles: listing.rows.length,
        errors: [...base.errors, ...listing.notices],
      };
    }
    const { config: workenv, error: workenvError } = yield* load;
    const roots = yield* projectRoots(workenv);
    const projectNames = [...new Set(roots.map((root) => root.project))].sort();
    const withError = workenvError ? [...base.errors, workenvError] : base.errors;
    if (input.section === "overview") {
      // Disks are the one part of the overview that depends on the platform: without them the
      // computer still shows its CPU, memory and projects, and says why.
      const read = yield* readDisks(sampledAt).pipe(Effect.result);
      if (read._tag === "Failure")
        return {
          ...base,
          projects: projectNames,
          errors: [...withError, `Disks could not be read: ${read.failure.message}`],
        };
      return { ...base, disks: read.success.disks, projects: projectNames, errors: withError };
    }
    if (input.section === "activity") {
      const rows: ComputerActivity[] = [...(yield* Ref.get(actions))];
      const errors = [...withError];
      if (workenv) {
        const files = yield* readLocal(workenv);
        yield* pruneProofs;
        const extra = yield* readActivity(workenv);
        errors.push(...files.errors, ...extra.errors);
        for (const file of files.requests) {
          const published = isPublished(file.receipt);
          rows.push(
            keepActivity(
              file,
              published ||
                (yield* fs.exists(file.receipt.source).pipe(Effect.orElseSucceed(() => false))),
            ),
            ...backupActivity(
              file,
              verified.get(file.receipt.id ?? ""),
              backupWanted(workenv, file.receipt, verified.get(file.receipt.id ?? "")),
            ),
          );
        }
        rows.push(...extra.handoffs, ...extra.jobs);
      }
      return { ...base, activities: rows.toSorted((a, b) => b.updatedAt - a.updatedAt), errors };
    }
    // files
    const refresh = Boolean(input.refresh);
    const stale = (at: number) => !at || sampledAt - at > REFRESH_AFTER_MS;
    // A failing index is not retried on every request: attempts follow the same refresh interval.
    if (!indexing && (refresh || (stale(index.indexedAt) && stale(indexAttemptedAt)))) {
      indexing = true;
      indexAttemptedAt = sampledAt;
      yield* indexFiles(roots, workenv ? [workenv.state, config.stateDir] : [config.stateDir]).pipe(
        Effect.tap((next) => persist(indexPath, next)),
        Effect.tap((next) =>
          Effect.sync(() => {
            index = { ...next, files: sortFiles(next.files) };
            indexVersion++;
          }),
        ),
        Effect.catch((cause) =>
          Effect.sync(() => {
            index = { ...index, errors: [`File indexing failed: ${messageOf(cause)}`] };
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            indexing = false;
          }),
        ),
        Effect.provideContext(context),
        Effect.forkIn(scope),
      );
    }
    if (workenv && !cataloging && (refresh || stale(catalogAttemptedAt))) {
      cataloging = true;
      catalogAttemptedAt = sampledAt;
      yield* refreshCatalog(catalog, workenv, { cache: catalogDirectory, staging: directory }).pipe(
        Effect.tap(() => pruneProofs),
        Effect.tap((problems) =>
          Effect.sync(() => {
            catalogErrors = problems;
          }),
        ),
        Effect.catch((cause) =>
          Effect.sync(() => {
            catalogErrors = [`The library catalog is unavailable: ${messageOf(cause)}`];
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            cataloging = false;
          }),
        ),
        Effect.provideContext(context),
        Effect.forkIn(scope),
      );
    }
    if (workenv) {
      yield* readLocal(workenv);
      yield* pruneProofs;
    }
    const state = workenv ? yield* currentArchive(workenv) : null;
    const mergedKey = `${indexVersion}|${state?.signature ?? ""}`;
    if (merged.key !== mergedKey)
      merged = { key: mergedKey, files: mergeSorted(index.files, state?.sorted ?? []) };
    const found = searchFiles(merged.files, input);
    return {
      ...base,
      files: found.files,
      totalFiles: found.total,
      projects: projectNames,
      indexedAt: Math.max(index.indexedAt, state?.builtAt ?? 0) || null,
      indexing: indexing || cataloging,
      errors: [
        ...withError,
        ...index.errors,
        ...catalogErrors,
        ...(local?.errors ?? []),
        ...(state?.archive.truncated
          ? ["The kept archive is larger than can be searched; the oldest files are not listed."]
          : []),
      ],
    };
  });

  const capacity = Effect.fn("Computers.capacity")(function* (input?: {
    readonly workPath?: string | undefined;
  }) {
    const resources = yield* host.read;
    const now = yield* Clock.currentTimeMillis;
    const measured = yield* readDisks(now).pipe(Effect.result);
    const known = measured._tag === "Success" ? measured.success.disks : [];
    const workPath = input?.workPath;
    // The disk that holds the work is the most specific mount above it.
    const work = workPath
      ? known
          .filter((disk) => isWithin(platform, disk.path, workPath))
          .toSorted((a, b) => b.path.length - a.path.length)[0]
      : undefined;
    const largest = known
      .toSorted((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, COMPUTER_CAPACITY_MAX_DISKS);
    const { config: workenv } = yield* load;
    const rows = workenv
      ? yield* readActivity(workenv).pipe(
          Effect.map((activity) => activity.jobs),
          Effect.orElseSucceed(() => null),
        )
      : null;
    return {
      sampledAt: Math.min(
        resources.sampledAt,
        measured._tag === "Success" ? measured.success.at : resources.sampledAt,
      ),
      os:
        platform === "win32"
          ? "windows"
          : platform === "linux" || platform === "darwin"
            ? platform
            : "unknown",
      resources,
      disks:
        work && !largest.includes(work)
          ? [...largest.slice(0, COMPUTER_CAPACITY_MAX_DISKS - 1), work]
          : largest,
      workDisk: work?.path ?? null,
      jobs: rows && {
        active: rows.filter((job) => job.status === "active" || job.status === "running").length,
        running: rows.filter((job) => job.status === "running").length,
      },
      notices:
        measured._tag === "Failure" ? [`Disks could not be read: ${measured.failure.message}`] : [],
    } satisfies ComputerCapacity;
  });

  // --- actions ---------------------------------------------------------------------------------
  type Requirements = FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner;

  const recordBackups = (
    files: readonly ReceiptFile[],
    confirmed: ReadonlyMap<string, BackupProof>,
  ) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const problems: string[] = [];
      for (const file of files) {
        const proof = confirmed.get(file.key) ?? null;
        const id = file.receipt.id;
        if (!id || !/^[0-9a-f]{32}$/.test(id)) continue;
        const saved = yield* persist(path.join(proofsDirectory, `${id}.json`), {
          id,
          proof,
          at,
        }).pipe(Effect.result);
        // Kept in memory even when it cannot be saved: the check did happen.
        verified.set(id, { proof, at });
        verifiedVersion++;
        if (saved._tag === "Failure") problems.push(messageOf(saved.failure));
      }
      yield* pruneProofs;
      return problems;
    }).pipe(Effect.mapError(operationError));

  const backupPlan = Effect.fn("Computers.backupPlan")(function* (
    workenv: WorkenvConfig,
    requestId: string | undefined,
  ) {
    const local = yield* readLocal(workenv);
    const requests = [
      ...new Map(
        [...local.published, ...local.requests].map((file) => [file.receipt.id ?? file.key, file]),
      ).values(),
    ];
    const asKey = requestId?.replace(/^backup:/, "");
    let selected = asKey
      ? requests.find(
          (file) => isPublished(file.receipt) && (file.key === asKey || file.receipt.id === asKey),
        )
      : undefined;
    if (asKey && !selected) {
      const entry = [...catalog.entries.values()].find(
        (entry) => entry.source.receipt.id === asKey,
      );
      if (entry) {
        const cached = yield* fs
          .readFileString(entry.source.file)
          .pipe(Effect.flatMap(decodeCatalogFile), Effect.mapError(operationError));
        selected = {
          key: asKey,
          file: entry.source.file,
          modifiedAt: entry.listing.modifiedAt,
          receipt: fromLibraryManifest(workenv, cached.receipt, cached.reference),
        };
      }
    }
    if (requestId !== undefined && (!selected || !isPublished(selected.receipt)))
      return yield* fail("Select a published keep to verify its backup.");
    const target = selected?.key;
    const targets = selected
      ? [selected]
      : requests.filter((file) =>
          backupWanted(workenv, file.receipt, verified.get(file.receipt.id ?? "")),
        );
    if (!targets.length) return yield* fail("No published keep is waiting for a backup.");
    return {
      kind: "backup",
      label: target ? `Verify backup of ${targets[0]!.receipt.reason}` : "Verify library backups",
      source: null,
      key: `backup:${target ?? "*"}`,
      run: Effect.gen(function* () {
        const result = yield* retryBackups(workenv, targets).pipe(
          Effect.onError(() => recordBackups(targets, new Map()).pipe(Effect.ignore)),
        );
        const problems = yield* recordBackups(targets, result.confirmed);
        const missing = targets.filter((file) => !result.confirmed.has(file.key));
        const saved = problems.length ? ` (the result could not be saved: ${problems[0]})` : "";
        if (!missing.length)
          return {
            status: "completed",
            detail: `Backup confirmed for ${targets.length} keep${targets.length === 1 ? "" : "s"}${result.started ? " after starting the library backup" : ""}${saved}.`,
          } satisfies Outcome;
        const reasons = [...new Set(missing.map((file) => result.reasons.get(file.key)))]
          .filter(Boolean)
          .slice(0, 2)
          .join(" ");
        return failed(
          `Confirmed ${targets.length - missing.length} of ${targets.length}. ${reasons}${
            result.startFailure ? ` Starting the library backup failed: ${result.startFailure}` : ""
          }${saved}`,
        );
      }),
    } satisfies Plan<Requirements>;
  });

  const plan = Effect.fn("Computers.plan")(function* (input: ComputerActionInput) {
    const { config: workenv, error: workenvError } = yield* load;
    if (!workenv)
      return yield* fail(workenvError ?? "Workenv is not installed/configured on this computer.");
    if (input.action === "backup") return yield* backupPlan(workenv, input.requestId);
    if (input.action === "keep") {
      if (
        !input.path ||
        !path.isAbsolute(input.path) ||
        !input.reason?.trim() ||
        /[\r\n]/.test(input.reason)
      )
        return yield* fail("Keep requires an absolute path and a one-line reason.");
      const [source, reason] = [input.path, input.reason.trim()];
      return {
        kind: "transfer",
        label: `Keep ${basename(source)}`,
        source,
        key: encodeActionKey(["keep", normalizeKey(source), reason]),
        run: runKeep(source, reason),
      } satisfies Plan<Requirements>;
    }
    if (input.action === "retry") {
      const id = input.requestId ?? "";
      if (id.startsWith("handoff:")) {
        const found = (yield* readHandoffs(workenv)).receipts.find(
          (entry) => `handoff:${entry.key}` === id,
        );
        const handoff = found?.handoff;
        if (
          !handoff ||
          handoff.role === "receiver" ||
          handoff.version !== 2 ||
          handoff.status === "delivered" ||
          handoff.status === "cancelled" ||
          !path.isAbsolute(handoff.source) ||
          !(yield* fs.exists(handoff.source).pipe(Effect.orElseSucceed(() => false)))
        )
          return yield* fail("This handoff is not retryable or no longer available.");
        return {
          kind: "transfer",
          label: `Retry handoff ${basename(handoff.destination.path)}`,
          source: handoff.source,
          key: id,
          run: runHandoff(handoff.source, handoff.destination.host, handoff.destination.path),
        } satisfies Plan<Requirements>;
      }
      const file = (yield* readLocal(workenv)).requests.find((entry) => entry.key === id);
      if (!file) return yield* fail("This transfer is no longer available.");
      // A published keep can only be waiting for its backup: its source is not needed and may be
      // long gone. Only an unpublished keep goes back through workenv's own keep.
      if (isPublished(file.receipt)) return yield* backupPlan(workenv, id);
      const { receipt } = file;
      if (
        receipt.status === "cancelled" ||
        !(yield* fs.exists(receipt.source).pipe(Effect.orElseSucceed(() => false)))
      )
        return yield* fail(
          "This keep cannot be retried: it is cancelled or its source no longer exists.",
        );
      const jobs = (yield* readActivity(workenv)).jobs;
      const problem = retryProblem(
        workenv,
        receipt,
        platform,
        jobs.flatMap((job) => (job.label === receipt.project && job.source ? [job.source] : [])),
      );
      if (problem) return yield* fail(problem);
      return {
        kind: "transfer",
        label: `Retry keep ${receipt.reason}`,
        source: receipt.source,
        key: `retry:${id}`,
        run: runKeep(receipt.source, receipt.reason),
      } satisfies Plan<Requirements>;
    }
    // restore
    if (!input.destination || !input.path)
      return yield* fail("Select a retained file and an empty destination folder.");
    const selected = input.path;
    const destination = (yield* restoreDestination(input.destination)).path;
    const bundle = (yield* currentArchive(workenv)).archive.bundles.find((entry) =>
      selected.startsWith(`${entry.writerPath}/payload/`),
    );
    if (!bundle)
      return yield* fail("This file is not part of a kept archive known to this computer.");
    const receipt = yield* fs.readFileString(bundle.file).pipe(
      Effect.flatMap((text) =>
        bundle.origin === "library"
          ? decodeCatalogFile(text).pipe(
              Effect.map((cached) =>
                fromLibraryManifest(workenv, cached.receipt, cached.reference),
              ),
            )
          : decodeReceipt(text),
      ),
      Effect.mapError(() => fail("The keep receipt of this archive cannot be read.")),
    );
    return {
      kind: "restore",
      label: `Restore ${basename(selected)}`,
      source: selected,
      key: encodeActionKey(["restore", selected, normalizeKey(destination)]),
      destinationKey: normalizeKey(destination),
      run: restoreKeep(workenv, receipt, selected, destination, directory).pipe(
        Effect.mapError(operationError),
        Effect.as({
          status: "completed",
          detail: "File restored and its SHA-256 verified.",
        } satisfies Outcome),
      ),
    } satisfies Plan<Requirements>;
  });

  const act = Effect.fn("Computers.act")(function* (input: ComputerActionInput) {
    const planned: Plan<Requirements> = yield* plan(input);
    const activity: ComputerActivity = {
      id: NodeCrypto.randomUUID(),
      kind: planned.kind,
      label: planned.label,
      status: planned.kind === "transfer" ? "pending" : "running",
      updatedAt: yield* Clock.currentTimeMillis,
      detail:
        planned.kind === "transfer"
          ? "The native workenv receipt reports transfer progress."
          : null,
      source: planned.source,
      retryable: false,
    };
    // Recording the action, starting it and giving it to the server's scope are one step: a
    // caller that goes away in between must not leave a record of work nobody is doing.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const conflict = yield* Effect.sync(() => {
          if (planned.destinationKey && destinations.has(planned.destinationKey))
            return "That restore destination is already being written.";
          if (activeKeys.has(planned.key)) return "That action is already running.";
          activeKeys.add(planned.key);
          if (planned.destinationKey) destinations.add(planned.destinationKey);
          activeIds.add(activity.id);
          return null;
        });
        if (conflict) return yield* fail(conflict);
        const release = Effect.sync(() => {
          activeKeys.delete(planned.key);
          if (planned.destinationKey) destinations.delete(planned.destinationKey);
          activeIds.delete(activity.id);
        });
        let handedOff = false;
        yield* Effect.gen(function* () {
          yield* persist(path.join(actionsDirectory, `${activity.id}.json`), activity);
          yield* Ref.update(actions, (list) => [activity, ...list]);
          yield* restore(
            planned.run.pipe(
              Effect.catch((error) => Effect.succeed(failed(error.message))),
              Effect.catchDefect((defect) =>
                Effect.succeed(failed(`Unexpected error: ${messageOf(defect)}`)),
              ),
              Effect.onInterrupt(() => finish(activity.id, interrupted)),
              Effect.flatMap((outcome) => finish(activity.id, outcome)),
              Effect.ensuring(release),
              Effect.provideContext(context),
            ),
          ).pipe(Effect.forkIn(scope));
          handedOff = true;
        }).pipe(Effect.ensuring(Effect.suspend(() => (handedOff ? Effect.void : release))));
      }),
    );
    return { activity };
  });

  return Computers.of({
    inspect: (input) =>
      inspect(input).pipe(Effect.provideContext(context), Effect.mapError(operationError)),
    act: (input) =>
      act(input).pipe(Effect.provideContext(context), Effect.mapError(operationError)),
    capacity: (input) => capacity(input).pipe(Effect.provideContext(context)),
  });
});

export const layer = Layer.effect(Computers, make);
