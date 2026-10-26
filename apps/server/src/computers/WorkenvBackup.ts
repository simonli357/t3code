import type { ComputerActivity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  fail,
  parseTime,
  type BackupProof,
  type KeepReceipt,
  type WorkenvConfig,
} from "./WorkenvConfig.ts";
import { openLibrary, verifyLibrary, type Library } from "./WorkenvLibrary.ts";
import { isPublished, type ReceiptFile } from "./Workenv.ts";

const HASH = /^[a-f0-9]{64}$/;
const RECEIPT_SCHEMA = "workenv-backup-receipt/2";
const RESTIC_REPOSITORY = "/data/work-backup/restic";
const LATEST_RECEIPT = "/var/lib/workenv/backup/latest.json";
const SERVICE = ["sudo", "-n", "systemctl", "start", "workenv-backup.service"];
const SNAPSHOTS = [
  "sudo",
  "-n",
  "env",
  `RESTIC_REPOSITORY=${RESTIC_REPOSITORY}`,
  "RESTIC_PASSWORD_FILE=/etc/workenv/restic/password",
  "RESTIC_CACHE_DIR=/var/cache/restic",
  "restic",
  "snapshots",
  "--json",
];

const unchangedMethod = (verified: string) =>
  `unchanged since ${verified.slice(0, 8)} per restic diff`;

/** Whether `proof` is a complete v2 backup proof for the bundle published at `writerPath`. */
export function proofIsComplete(proof: BackupProof, writerPath: string | undefined) {
  return (
    proof.schema === RECEIPT_SCHEMA &&
    proof.path === writerPath &&
    HASH.test(proof.snapshot_id) &&
    HASH.test(proof.content_verified_snapshot) &&
    HASH.test(proof.manifest_sha256) &&
    Boolean(proof.confirmed_at) &&
    ((proof.snapshot_id === proof.content_verified_snapshot &&
      proof.method === "snapshot content hashed against manifest") ||
      proof.method === unchangedMethod(proof.content_verified_snapshot))
  );
}

/**
 * The proof workenv itself recorded in the keep receipt. This is the recorded evidence, not a
 * fresh look at the library: it says what was confirmed when, and `retryBackups` re-checks it.
 */
export function recordedProof(receipt: KeepReceipt): BackupProof | null {
  const proof = receipt.backup_receipt;
  return isPublished(receipt) &&
    receipt.backup === "confirmed" &&
    proof &&
    proofIsComplete(proof, receipt.writer_path)
    ? proof
    : null;
}

export interface BackupVerification {
  readonly proof: BackupProof | null;
  readonly at: number;
}

const parseTimeValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value * 1000
    : typeof value === "string"
      ? parseTime(value)
      : null;

/** Uses the latest server check, including a negative one, before historical workenv evidence. */
export function backupEvidence(receipt: KeepReceipt, verified: BackupVerification | undefined) {
  if (verified)
    return verified.proof && proofIsComplete(verified.proof, receipt.writer_path)
      ? { proof: verified.proof, at: verified.at }
      : null;
  const proof = recordedProof(receipt);
  const at = proof ? parseTimeValue(proof.confirmed_at) : null;
  return proof && at !== null ? { proof, at } : null;
}

/** A published keep awaits verification when its required backup has no supporting evidence. */
export function backupWanted(
  config: WorkenvConfig,
  receipt: KeepReceipt,
  verified: BackupVerification | undefined,
) {
  return (
    isPublished(receipt) &&
    !backupEvidence(receipt, verified) &&
    Boolean(
      verified ||
      receipt.backup_required ||
      config.projects[receipt.project]?.keep?.backup_required ||
      receipt.backup_error ||
      receipt.backup === "pending",
    )
  );
}

export function backupActivity(
  file: ReceiptFile,
  verified: BackupVerification | undefined,
  wanted: boolean,
): ComputerActivity[] {
  const { receipt } = file;
  const evidence = backupEvidence(receipt, verified);
  if (!isPublished(receipt) || (!evidence && !wanted)) return [];
  return [
    {
      id: `backup:${file.key}`,
      kind: "backup",
      label: `Backup: ${receipt.reason}`,
      status: evidence ? "completed" : receipt.backup_error ? "failed" : "pending",
      updatedAt:
        evidence?.at ??
        verified?.at ??
        (receipt.published_at ? receipt.published_at * 1000 : (parseTime(receipt.created_at) ?? 0)),
      source: receipt.writer_path ?? null,
      detail: evidence
        ? `Verified in backup snapshot ${evidence.proof.snapshot_id.slice(0, 8)}${verified ? " by this server" : " by workenv"}.`
        : (receipt.backup_error ?? "No verified independent backup is recorded yet."),
      retryable: !evidence,
    },
  ];
}

const seconds = (value: string | number) =>
  typeof value === "number" ? value : Date.parse(value) / 1000;

const Snapshots = Schema.Array(Schema.Struct({ id: Schema.String }));
const Latest = Schema.Struct({
  schema: Schema.String,
  repository: Schema.String,
  snapshot_id: Schema.String,
  backup_finished: Schema.Union([Schema.String, Schema.Number]),
  confirmed_at: Schema.Union([Schema.String, Schema.Number]),
  items: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.String,
      manifest_sha256: Schema.optionalKey(Schema.String),
      content_verified_snapshot: Schema.optionalKey(Schema.String),
      method: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeSnapshots = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshots));
const decodeLatest = Schema.decodeUnknownEffect(Schema.fromJsonString(Latest));

/**
 * `MANIFEST.sha256` as the publisher writes it: one `<sha256>  payload/<name>` line per file
 * plus the bundle's README and manifest. It must list exactly what the keep receipt recorded.
 */
export function manifestListsSnapshot(
  text: string,
  snapshot: NonNullable<KeepReceipt["snapshot"]>,
) {
  const listed = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) return false;
    listed.set(match[2]!, match[1]!);
  }
  const files = Object.entries(snapshot).filter(([, entry]) => entry.type === "file");
  return (
    listed.size === files.length + 2 &&
    listed.has("README.md") &&
    listed.has("manifest.json") &&
    files.every(([name, entry]) => listed.get(`payload/${name}`) === entry.sha256)
  );
}

export interface BackupCheck {
  readonly proof: BackupProof | null;
  readonly reason: string | null;
}
type BackupReceipt = typeof Latest.Type;
/** A published bundle as it is now: where it is and the digest of its exact `MANIFEST.sha256`. */
interface Bundle {
  readonly writerPath: string;
  readonly sha256: string;
}

const readBundle = Effect.fn("WorkenvBackup.readBundle")(function* (
  library: Library,
  config: WorkenvConfig,
  file: ReceiptFile,
) {
  const { receipt } = file;
  const writerPath = receipt.writer_path;
  if (
    !isPublished(receipt) ||
    !receipt.snapshot ||
    !receipt.destination ||
    receipt.library_id !== config.keep.library_id ||
    receipt.library_root !== config.keep.library_root ||
    writerPath !== `${config.keep.library_root.replace(/\/+$/, "")}/${receipt.destination}`
  )
    return { reason: "The keep does not describe a published bundle of this library." };
  const manifest = yield* library.fetch(`${writerPath}/MANIFEST.sha256`).pipe(Effect.result);
  if (manifest._tag === "Failure")
    return { reason: `Cannot read the bundle's MANIFEST.sha256: ${manifest.failure.message}` };
  // The digest a backup is compared with is that of the file as it is now, and the file must
  // still describe exactly the bundle this keep published.
  if (!manifestListsSnapshot(manifest.success.text, receipt.snapshot))
    return { reason: "The bundle's MANIFEST.sha256 no longer matches the keep receipt." };
  return { bundle: { writerPath: writerPath!, sha256: manifest.success.sha256 } };
});

/**
 * workenv's own rule for releasing a required-backup bundle: the backup receipt lists the bundle
 * with status confirmed and the digest of its current MANIFEST.sha256, and the snapshot that
 * verified its content still exists.
 */
function confirmedBy(
  receipt: BackupReceipt,
  bundle: Bundle,
  snapshots: ReadonlySet<string>,
): BackupCheck {
  const items = receipt.items.filter((item) => item.path === bundle.writerPath);
  if (items.length !== 1)
    return {
      proof: null,
      reason: "The library backup does not include this published bundle yet.",
    };
  const item = items[0]!;
  const verified = item.content_verified_snapshot;
  if (item.status !== "confirmed" || item.manifest_sha256 !== bundle.sha256)
    return {
      proof: null,
      reason: "The library backup does not confirm the current bundle manifest.",
    };
  if (
    !verified ||
    !snapshots.has(verified) ||
    !(
      (verified === receipt.snapshot_id &&
        item.method === "snapshot content hashed against manifest") ||
      item.method === unchangedMethod(verified)
    )
  )
    return {
      proof: null,
      reason: "The library backup lacks verified content or its snapshot expired.",
    };
  return {
    proof: {
      schema: receipt.schema,
      snapshot_id: receipt.snapshot_id,
      content_verified_snapshot: verified,
      manifest_sha256: bundle.sha256,
      path: bundle.writerPath,
      method: item.method!,
      confirmed_at: receipt.confirmed_at,
    },
    reason: null,
  };
}

const usable = (receipt: BackupReceipt, snapshots: ReadonlySet<string>) =>
  receipt.schema === RECEIPT_SCHEMA &&
  receipt.repository === RESTIC_REPOSITORY &&
  Number.isFinite(seconds(receipt.backup_finished)) &&
  Number.isFinite(seconds(receipt.confirmed_at)) &&
  snapshots.has(receipt.snapshot_id);

/**
 * Receipts of earlier backups, newest first. The latest receipt covers only the last run, which
 * may have been limited to a few bundles; a receipt of an older snapshot that still exists is
 * evidence just the same, which the library's interface states as part of its release rule.
 */
const earlierReceipts = Effect.fn("WorkenvBackup.earlierReceipts")(function* (
  library: Library,
  latestPath: string,
  snapshots: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const folder = `${latestPath.slice(0, latestPath.lastIndexOf("/"))}/receipts`;
  const names = (yield* library.listFiles(folder))
    .filter((entry) => /^[0-9a-f]{8}\.json$/.test(entry.path))
    .toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
    .slice(0, 40)
    .map((entry) => entry.path);
  if (!names.length) return [];
  const staging = yield* fs
    .makeTempDirectory({ prefix: "t3-backup-receipts-" })
    .pipe(Effect.mapError((error) => fail(`Cannot stage backup receipts: ${error.message}`)));
  return yield* Effect.gen(function* () {
    yield* library.fetchFiles(
      folder,
      names,
      path.join(staging, "files"),
      path.join(staging, "list.txt"),
    );
    const receipts: BackupReceipt[] = [];
    for (const name of names) {
      const receipt = yield* fs
        .readFileString(path.join(staging, "files", name))
        .pipe(Effect.flatMap(decodeLatest), Effect.option);
      if (receipt._tag === "Some" && usable(receipt.value, snapshots)) receipts.push(receipt.value);
    }
    return receipts.toSorted((a, b) => seconds(b.confirmed_at) - seconds(a.confirmed_at));
  }).pipe(
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/**
 * Checks the library's backups against each bundle as it stands now, by the rule the library
 * itself publishes and apart from re-hashing every payload: the library identity, the backup
 * contract, snapshots that still exist, and the bundle's current `MANIFEST.sha256`, against the
 * latest backup receipt and then, for what that does not cover, earlier ones.
 */
export const verifyBackups = Effect.fn("WorkenvBackup.verify")(function* (
  library: Library,
  config: WorkenvConfig,
  files: readonly ReceiptFile[],
) {
  const contract = yield* verifyLibrary(library, config);
  if (
    contract.backup.receipt.schema !== RECEIPT_SCHEMA ||
    contract.backup.receipt.latest !== LATEST_RECEIPT ||
    !contract.backup.repository.startsWith(`${RESTIC_REPOSITORY} `)
  )
    return yield* fail(
      "The installed library backup contract differs from the one this server knows; review its new route first.",
    );
  const snapshots = new Set(
    (yield* library
      .administer(SNAPSHOTS)
      .pipe(
        Effect.flatMap((text) =>
          decodeSnapshots(text).pipe(
            Effect.mapError(() => fail("The backup snapshot list is not in the expected format.")),
          ),
        ),
      )).map((snapshot) => snapshot.id),
  );
  const latest = yield* library.read(contract.backup.receipt.latest).pipe(
    Effect.flatMap(decodeLatest),
    Effect.filterOrFail(
      (receipt) => usable(receipt, snapshots),
      () => fail("The latest backup receipt does not identify a completed, existing snapshot."),
    ),
    Effect.option,
  );
  const results = new Map<string, BackupCheck>();
  const bundles = new Map<string, Bundle>();
  yield* Effect.forEach(
    files,
    (file) =>
      readBundle(library, config, file).pipe(
        Effect.tap((read) =>
          Effect.sync(() => {
            if ("bundle" in read) {
              bundles.set(file.key, read.bundle);
              results.set(
                file.key,
                latest._tag === "Some"
                  ? confirmedBy(latest.value, read.bundle, snapshots)
                  : {
                      proof: null,
                      reason:
                        "No usable latest backup receipt identifies a completed, existing snapshot.",
                    },
              );
            } else results.set(file.key, { proof: null, reason: read.reason });
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
  const uncovered = [...bundles].filter(([key]) => !results.get(key)?.proof);
  if (uncovered.length) {
    // Evidence from earlier backups is a bonus: a library that cannot list them still answers.
    const earlier = yield* earlierReceipts(library, contract.backup.receipt.latest, snapshots).pipe(
      Effect.orElseSucceed(() => [] as BackupReceipt[]),
    );
    for (const [key, bundle] of uncovered)
      for (const receipt of earlier) {
        const check = confirmedBy(receipt, bundle, snapshots);
        if (check.proof) {
          results.set(key, check);
          break;
        }
      }
  }
  return results;
});

/**
 * Retry for published keeps without a confirmed backup. A backup that already covers a bundle
 * needs no new run, so the library's backup service is started only for what is still missing,
 * and the result is checked again afterwards: a service that returned says nothing about it.
 */
export const retryBackups = Effect.fn("WorkenvBackup.retry")(function* (
  config: WorkenvConfig,
  files: readonly ReceiptFile[],
) {
  const library = yield* openLibrary(config);
  const confirmed = new Map<string, BackupProof>();
  const reasons = new Map<string, string>();
  const absorb = (results: Map<string, BackupCheck>) => {
    for (const [key, check] of results) {
      if (check.proof) {
        confirmed.set(key, check.proof);
        reasons.delete(key);
      } else reasons.set(key, check.reason ?? "Not confirmed.");
    }
  };
  absorb(yield* verifyBackups(library, config, files));
  const missing = files.filter((file) => !confirmed.has(file.key));
  let started = false;
  let startFailure: string | null = null;
  if (missing.length) {
    started = true;
    const start = yield* library.administer(SERVICE).pipe(Effect.result);
    if (start._tag === "Failure") startFailure = start.failure.message;
    // Even a start that failed or timed out may have left a newer backup behind.
    absorb(yield* verifyBackups(library, config, missing));
  }
  return { confirmed, reasons, started, startFailure };
});
