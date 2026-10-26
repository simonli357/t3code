import type { ComputerFile } from "@t3tools/contracts";
import { configProblem, memberPlatformProblem, routeProblem, snapshotProblem } from "./Workenv.ts";
import { backupEvidence, type BackupVerification } from "./WorkenvBackup.ts";
import { parseTime, type KeepReceipt, type WorkenvConfig } from "./WorkenvConfig.ts";

/** Searching more archive files than this would cost the server more than it helps anyone. */
const ARCHIVE_ROW_LIMIT = 400_000;

/**
 * A published bundle known to this computer, from a keep receipt or from the library's own
 * manifest, reduced to what listing it needs. The full receipt, with every archive member's
 * hash, stays in `file` and is read again only to restore.
 */
export interface ArchiveSource {
  readonly origin: "request" | "receipt" | "library";
  readonly key: string;
  readonly file: string;
  readonly receipt: Omit<KeepReceipt, "snapshot">;
  readonly members: ReadonlyArray<readonly [name: string, bytes: number | null]>;
  readonly snapshotProblem: string | null;
}
export interface ArchiveBundle {
  readonly id: string;
  readonly origin: ArchiveSource["origin"];
  readonly file: string;
  readonly writerPath: string;
}
export interface Archive {
  readonly bundles: readonly ArchiveBundle[];
  readonly files: readonly ComputerFile[];
  readonly truncated: boolean;
}

export function toSource(
  origin: ArchiveSource["origin"],
  key: string,
  file: string,
  receipt: KeepReceipt,
): ArchiveSource {
  const { snapshot, ...rest } = receipt;
  return {
    origin,
    key,
    file,
    receipt: rest,
    members: Object.entries(snapshot ?? {}).flatMap(([name, entry]) =>
      entry.type === "file" ? [[name, entry.bytes ?? null] as const] : [],
    ),
    snapshotProblem: snapshotProblem(receipt),
  };
}

/**
 * A bundle's `manifest.json` is its receipt as it was when the library published it: the same
 * fields, but no `writer_path` and a status of its own. Its presence in the library is what
 * makes it published.
 */
export function fromLibraryManifest(
  config: WorkenvConfig,
  manifest: KeepReceipt,
  reference: string | null,
): KeepReceipt {
  return {
    ...manifest,
    status: "published",
    ...(reference ? { reference } : {}),
    ...(manifest.destination
      ? { writer_path: `${config.keep.library_root.replace(/\/+$/, "")}/${manifest.destination}` }
      : {}),
  };
}

const PRECEDENCE = { request: 0, receipt: 1, library: 2 } as const;

export function buildArchive(
  sources: readonly ArchiveSource[],
  context: {
    readonly config: WorkenvConfig;
    readonly platform: NodeJS.Platform;
    readonly verified: ReadonlyMap<string, BackupVerification>;
  },
): Archive {
  const { config, platform, verified } = context;
  const chosen = new Map<string, ArchiveSource>();
  for (const source of sources) {
    const { id, status, writer_path: writerPath, superseded } = source.receipt;
    if (!id || status !== "published" || !writerPath) continue;
    // A superseded request record points at a bundle a newer one replaced; its own receipt
    // file in workenv's receipts folder is the one that describes it.
    if (superseded && source.origin === "request") continue;
    const previous = chosen.get(id);
    if (!previous || PRECEDENCE[source.origin] < PRECEDENCE[previous.origin])
      chosen.set(id, source);
  }
  const bundles: ArchiveBundle[] = [];
  const files: ComputerFile[] = [];
  let truncated = false;
  for (const [id, source] of chosen) {
    const { receipt } = source;
    const writerPath = receipt.writer_path!;
    const evidence = backupEvidence(receipt, verified.get(id));
    const bundleProblem =
      configProblem(config, receipt) ?? routeProblem(config) ?? source.snapshotProblem;
    const kept = {
      reason: receipt.reason,
      keptAt: receipt.published_at ? receipt.published_at * 1000 : parseTime(receipt.created_at),
    };
    const reference = receipt.reference ?? `${writerPath}/README.md`;
    const computer = receipt.library_ssh ?? receipt.origin?.host ?? null;
    bundles.push({ id, origin: source.origin, file: source.file, writerPath });
    for (const [name, bytes] of source.members) {
      if (files.length >= ARCHIVE_ROW_LIMIT) {
        truncated = true;
        break;
      }
      const problem = bundleProblem ?? memberPlatformProblem(name, platform);
      files.push({
        path: `${writerPath}/payload/${name}`,
        name: name.slice(name.lastIndexOf("/") + 1),
        project: receipt.project,
        area: "archive",
        sizeBytes: bytes,
        modifiedAt: null,
        directory: false,
        backup: evidence ? "confirmed" : "published",
        backupVerifiedAt: evidence?.at ?? null,
        reference,
        restorable: problem === null,
        restoreUnavailableReason: problem,
        location: writerPath,
        computer,
        kept,
      });
    }
  }
  return { bundles, files, truncated };
}
