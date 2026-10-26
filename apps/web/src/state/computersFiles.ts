import type { ComputerFile } from "@t3tools/contracts";
import type {
  ActionAvailability,
  FileDetail,
  FileRow,
} from "../components/computers/computersViewModel";
import { iso, key } from "./computersView";

/** One computer's requested result pages. */
export interface SearchSource {
  readonly environmentId: string;
  readonly label: string;
  readonly online: boolean;
  readonly files: ReadonlyArray<ComputerFile>;
}

/** One computer that holds a result, and what its server says it can do with it. */
export interface FileCopy {
  readonly computerId: string;
  readonly computerName: string;
  readonly online: boolean;
  /** null when this computer's server did not say, which is never read as "yes". */
  readonly restorable: boolean | null;
  readonly unavailableReason: string | null;
}

/** A result row plus every computer that holds it: a kept archive entry can be reported by several. */
export interface FileRecord {
  readonly row: FileRow;
  readonly copies: ReadonlyArray<FileCopy>;
}

interface Held {
  readonly source: SearchSource;
  readonly file: ComputerFile;
}

const collator = new Intl.Collator(undefined, { numeric: true });

const isArchived = (file: ComputerFile) =>
  Boolean(file.area === "archive" || file.kept || file.reference);
const archiveKey = (file: ComputerFile) =>
  JSON.stringify(["archive", file.reference ?? "", file.path]);

export function fileTypeOf(file: ComputerFile): string | null {
  if (file.directory) return null;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1).toUpperCase() : null;
}

const copyOf = ({ source, file }: Held): FileCopy => ({
  computerId: source.environmentId,
  computerName: source.label,
  online: source.online,
  restorable: file.restorable ?? null,
  unavailableReason: file.restoreUnavailableReason ?? null,
});

function rowOf({ source, file }: Held, id: string): FileRow {
  return {
    id,
    name: file.name,
    kind: file.directory ? "folder" : "file",
    location: isArchived(file)
      ? "kept-archive"
      : file.area === "work"
        ? "work-folder"
        : file.area === "project" || file.project
          ? "project"
          : null,
    computerId: source.environmentId,
    // The computer whose server answered, so the name agrees with the Computer filter and with where
    // Restore is sent. Where the archived copy physically lives is in `backup.where`.
    computerName: source.label,
    path: file.path,
    projectName: file.project || null,
    fileType: fileTypeOf(file),
    sizeBytes: file.sizeBytes,
    modifiedAt: iso(file.modifiedAt),
    kept: file.kept ? { reason: file.kept.reason, keptAt: iso(file.kept.keptAt) } : null,
    backup:
      file.backup === "not-verified"
        ? { state: "not-verified" }
        : {
            state: file.backup,
            at: file.backup === "confirmed" ? iso(file.backupVerifiedAt) : null,
            where: file.reference,
          },
  };
}

/** The copy to name on a shared row: one on a computer that is reachable, else the first. */
const representative = (copies: ReadonlyArray<Held>) =>
  copies.find((copy) => copy.source.online) ?? copies[0]!;

const localId = (source: SearchSource, file: ComputerFile) => key(source.environmentId, file.path);

/** Merge only the requested pages, combining shared archive copies. */
export function mergeFilePages(sources: ReadonlyArray<SearchSource>): FileRecord[] {
  const records = new Map<string, Held[]>();
  for (const source of sources) {
    for (const file of source.files) {
      const id = isArchived(file) ? archiveKey(file) : localId(source, file);
      const copies = records.get(id);
      if (copies) copies.push({ source, file });
      else records.set(id, [{ source, file }]);
    }
  }
  return [...records]
    .map(([id, copies]) => ({
      row: rowOf(representative(copies), id),
      copies: copies.map(copyOf),
    }))
    .sort(
      (a, b) => collator.compare(a.row.name, b.row.name) || collator.compare(a.row.id, b.row.id),
    );
}

export function keepOffer(record: FileRecord): ActionAvailability {
  if (record.row.location === "kept-archive")
    return { available: false, reason: "This result is already in the archive" };
  return record.copies.some((copy) => copy.online)
    ? { available: true }
    : { available: false, reason: "Computer is offline" };
}

/** What Restore can offer for a result, from what each computer's own server reported about it. */
export function restoreOffer(record: FileRecord): {
  readonly restore: ActionAvailability;
  readonly restoreTargets: FileDetail["restoreTargets"];
} {
  const unavailable = (reason: string) => ({
    restore: { available: false, reason } as const,
    restoreTargets: [],
  });
  if (record.row.location !== "kept-archive")
    return unavailable("No copy of this file is in the kept archive");
  const able = record.copies.filter((copy) => copy.restorable === true);
  if (able.length === 0)
    return unavailable(
      record.copies.find((copy) => copy.unavailableReason)?.unavailableReason ??
        (record.copies.some((copy) => copy.restorable === null)
          ? "This computer’s T3 server did not say whether it can restore this file"
          : "Restore is not available for this file"),
    );
  if (!able.some((copy) => copy.online))
    return unavailable(
      able.length === 1
        ? `${able[0]!.computerName} is offline`
        : "Every computer that can restore this file is offline",
    );
  return {
    restore: { available: true },
    restoreTargets: able.map((copy) => ({
      computerId: copy.computerId,
      name: copy.computerName,
      online: copy.online,
    })),
  };
}
