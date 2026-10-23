import type { ComputerFile } from "@t3tools/contracts";
import type {
  ActionAvailability,
  FileDetail,
  FileRow,
} from "../components/computers/computersViewModel";
import { iso, key } from "./computersView";

/** One computer's saved file list, as the search sees it. */
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

export interface SearchRequest {
  /** Lower case; every word must appear in the path (or, for kept files, the reason). */
  readonly words: ReadonlyArray<string>;
  readonly projectId: string | null;
  readonly computerId: string | null;
  /** As shown on a row, such as "PDF". */
  readonly fileType: string | null;
}

interface Held {
  readonly source: SearchSource;
  readonly file: ComputerFile;
}

/** What the search needs from every saved list, found in one pass so typing never rescans for it. */
export interface FileCatalog {
  readonly sources: ReadonlyArray<SearchSource>;
  /** Kept archive entries by identity, each with every computer that reported it. */
  readonly archive: ReadonlyMap<string, ReadonlyArray<Held>>;
  readonly fileTypes: ReadonlyArray<string>;
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

/** What one saved list contributes to a catalog, found once however many times the page rebuilds it. */
const summaries = new WeakMap<
  ReadonlyArray<ComputerFile>,
  { readonly archived: ComputerFile[]; readonly types: Set<string> }
>();

function summarize(files: ReadonlyArray<ComputerFile>) {
  let summary = summaries.get(files);
  if (!summary) {
    summary = { archived: [], types: new Set() };
    for (const file of files) {
      const type = fileTypeOf(file);
      if (type !== null) summary.types.add(type);
      if (isArchived(file)) summary.archived.push(file);
    }
    summaries.set(files, summary);
  }
  return summary;
}

export function createCatalog(sources: ReadonlyArray<SearchSource>): FileCatalog {
  const archive = new Map<string, Held[]>();
  const fileTypes = new Set<string>();
  for (const source of sources) {
    const { archived, types } = summarize(source.files);
    for (const type of types) fileTypes.add(type);
    for (const file of archived) {
      const identity = archiveKey(file);
      const copies = archive.get(identity);
      if (copies) copies.push({ source, file });
      else archive.set(identity, [{ source, file }]);
    }
  }
  return { sources, archive, fileTypes: [...fileTypes].sort(collator.compare) };
}

const sameSources = (a: ReadonlyArray<SearchSource>, b: ReadonlyArray<SearchSource>) =>
  a.length === b.length &&
  a.every(
    (source, index) =>
      source.environmentId === b[index]!.environmentId &&
      source.label === b[index]!.label &&
      source.online === b[index]!.online &&
      source.files === b[index]!.files,
  );

/**
 * A `createCatalog` that returns the same catalog while the sources are the same lists, so a page that
 * rebuilds its sources on every poll does not search again for an answer that cannot have changed.
 */
export function createCatalogMemo() {
  let last: FileCatalog | null = null;
  return (sources: ReadonlyArray<SearchSource>) => {
    if (!last || !sameSources(last.sources, sources)) last = createCatalog(sources);
    return last;
  };
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

function recordOf(catalog: FileCatalog, hit: Held): FileRecord {
  if (!isArchived(hit.file))
    return { row: rowOf(hit, localId(hit.source, hit.file)), copies: [copyOf(hit)] };
  const identity = archiveKey(hit.file);
  const copies = catalog.archive.get(identity) ?? [hit];
  return { row: rowOf(representative(copies), identity), copies: copies.map(copyOf) };
}

const order = (a: Held, b: Held) =>
  collator.compare(a.file.name, b.file.name) ||
  collator.compare(a.file.path, b.file.path) ||
  collator.compare(a.source.label, b.source.label) ||
  collator.compare(a.source.environmentId, b.source.environmentId);

function textMatches(file: ComputerFile, words: ReadonlyArray<string>) {
  if (words.length === 0) return true;
  const haystack = (file.kept ? `${file.path}\n${file.kept.reason}` : file.path).toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * The first `limit` matches by name, and how many there are in all. One pass over the saved lists keeps
 * only the best `limit` hits, so a computer with a hundred thousand files costs a scan, not a sort.
 * A kept archive entry reported by several computers is one match, found through any of them.
 */
export function searchFiles(
  catalog: FileCatalog,
  request: SearchRequest,
  limit: number,
): { readonly records: FileRecord[]; readonly total: number } {
  const best: Held[] = [];
  let total = 0;
  const consider = (hit: Held) => {
    total += 1;
    if (limit <= 0) return;
    // The largest retained match is the heap root; replacing it costs log(limit).
    if (best.length < limit) {
      let index = best.length;
      best.push(hit);
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (order(best[parent]!, hit) >= 0) break;
        best[index] = best[parent]!;
        index = parent;
      }
      best[index] = hit;
    } else if (order(hit, best[0]!) < 0) {
      let index = 0;
      while (index * 2 + 1 < best.length) {
        let child = index * 2 + 1;
        if (child + 1 < best.length && order(best[child + 1]!, best[child]!) > 0) child++;
        if (order(hit, best[child]!) >= 0) break;
        best[index] = best[child]!;
        index = child;
      }
      best[index] = hit;
    }
  };
  const accepts = (file: ComputerFile) =>
    (!request.projectId || file.project === request.projectId) &&
    (!request.fileType || fileTypeOf(file) === request.fileType) &&
    textMatches(file, request.words);

  for (const source of catalog.sources) {
    if (request.computerId && source.environmentId !== request.computerId) continue;
    for (const file of source.files) {
      if (!isArchived(file) && accepts(file)) consider({ source, file });
    }
  }
  for (const copies of catalog.archive.values()) {
    if (
      request.computerId &&
      !copies.some((copy) => copy.source.environmentId === request.computerId)
    )
      continue;
    const first = copies[0]!;
    if (accepts(first.file)) consider(representative(copies));
  }
  return { records: best.sort(order).map((hit) => recordOf(catalog, hit)), total };
}

/** The record a row id names, or null once no computer lists it any more. */
export function findRecord(catalog: FileCatalog, id: string): FileRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed[0] === "archive") {
    const copies = catalog.archive.get(id);
    return copies ? recordOf(catalog, representative(copies)) : null;
  }
  const source = catalog.sources.find((candidate) => candidate.environmentId === parsed[0]);
  const file = source?.files.find(
    (candidate) => candidate.path === parsed[1] && !isArchived(candidate),
  );
  return source && file ? recordOf(catalog, { source, file }) : null;
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
