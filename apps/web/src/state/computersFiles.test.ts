import { describe, expect, it } from "vite-plus/test";
import type { ComputerFile } from "@t3tools/contracts";
import {
  createCatalog,
  createCatalogMemo,
  fileTypeOf,
  findRecord,
  keepOffer,
  restoreOffer,
  searchFiles,
  type SearchRequest,
  type SearchSource,
} from "./computersFiles";

const file = (path: string, extra: Partial<ComputerFile> = {}): ComputerFile => ({
  path,
  name: path.split("/").at(-1)!,
  project: "",
  sizeBytes: 10,
  modifiedAt: 1000,
  directory: false,
  backup: "not-verified",
  reference: null,
  ...extra,
});
const kept = (path: string, extra: Partial<ComputerFile> = {}) =>
  file(path, {
    backup: "published",
    reference: "sftp://archive/bundle/README.md",
    kept: { reason: "Accepted drawings", keptAt: 2000 },
    restorable: true,
    ...extra,
  });
const source = (
  environmentId: string,
  label: string,
  online: boolean,
  files: ComputerFile[],
): SearchSource => ({ environmentId, label, online, files });
const nothing: SearchRequest = { words: [], projectId: null, computerId: null, fileType: null };
const names = (records: ReadonlyArray<{ row: { name: string } }>) =>
  records.map((record) => record.row.name);

describe("searching saved files", () => {
  const catalog = createCatalog([
    source("a", "Alpha", true, [
      file("/work/gamma.pdf", { project: "Utility" }),
      file("/work/alpha.txt", { project: "Utility" }),
      file("/work/delta.STEP", { project: "Scandy" }),
    ]),
    source("b", "Beta", false, [file("/home/beta.pdf")]),
  ]);

  it("returns the first matches by name and still counts every match", () => {
    const result = searchFiles(catalog, nothing, 2);
    expect(names(result.records)).toEqual(["alpha.txt", "beta.pdf"]);
    expect(result.total).toBe(4);
  });

  it("requires every word to appear in the path, whatever its case", () => {
    expect(names(searchFiles(catalog, { ...nothing, words: ["work", "pdf"] }, 10).records)).toEqual(
      ["gamma.pdf"],
    );
    expect(names(searchFiles(catalog, { ...nothing, words: ["step"] }, 10).records)).toEqual([
      "delta.STEP",
    ]);
  });

  it("filters by project, computer and file type", () => {
    expect(names(searchFiles(catalog, { ...nothing, projectId: "Utility" }, 10).records)).toEqual([
      "alpha.txt",
      "gamma.pdf",
    ]);
    expect(names(searchFiles(catalog, { ...nothing, computerId: "b" }, 10).records)).toEqual([
      "beta.pdf",
    ]);
    expect(names(searchFiles(catalog, { ...nothing, fileType: "PDF" }, 10).records)).toEqual([
      "beta.pdf",
      "gamma.pdf",
    ]);
    expect(catalog.fileTypes).toEqual(["PDF", "STEP", "TXT"]);
  });

  it("derives a file type only from a real extension", () => {
    expect(fileTypeOf(file("/x/archive.tar.gz"))).toBe("GZ");
    expect(fileTypeOf(file("/x/.gitignore"))).toBeNull();
    expect(fileTypeOf(file("/x/Makefile"))).toBeNull();
    expect(fileTypeOf(file("/x/ends."))).toBeNull();
    expect(fileTypeOf(file("/x/dir.d", { directory: true }))).toBeNull();
  });

  it("keeps the same catalog while the saved lists are the same, so a poll does not search again", () => {
    const memo = createCatalogMemo();
    const files = [file("/x/one.txt")];
    const first = memo([source("a", "Alpha", true, files)]);
    expect(memo([source("a", "Alpha", true, files)])).toBe(first);
    expect(memo([source("a", "Alpha", false, files)])).not.toBe(first);
    expect(memo([source("a", "Alpha", true, [...files])])).not.toBe(first);
  });
});

describe("kept archive entries", () => {
  const entry = "/srv/library/bundle/payload/result.csv";
  const both = createCatalog([
    source("a", "Alpha", false, [kept(entry)]),
    source("b", "Beta", true, [kept(entry), file("/b/local.txt")]),
  ]);

  it("lists an entry that two computers report once, named by a computer that is online", () => {
    const result = searchFiles(both, { ...nothing, words: ["result"] }, 10);
    expect(result.total).toBe(1);
    expect(result.records[0]!.row).toMatchObject({
      computerId: "b",
      computerName: "Beta",
      location: "kept-archive",
      backup: { state: "published" },
      kept: { reason: "Accepted drawings" },
    });
    expect(result.records[0]!.copies.map((copy) => copy.computerId)).toEqual(["a", "b"]);
  });

  it("finds an entry through any computer that reports it, and searches its reason", () => {
    expect(searchFiles(both, { ...nothing, computerId: "a" }, 10).total).toBe(1);
    expect(searchFiles(both, { ...nothing, computerId: "b" }, 10).total).toBe(2);
    expect(searchFiles(both, { ...nothing, words: ["drawings"] }, 10).total).toBe(1);
  });

  it("finds a row again by its id, and not once no computer lists it", () => {
    const archived = searchFiles(both, { ...nothing, words: ["result"] }, 10).records[0]!;
    expect(findRecord(both, archived.row.id)?.row.path).toBe(entry);
    const local = searchFiles(both, { ...nothing, words: ["local"] }, 10).records[0]!;
    expect(findRecord(both, local.row.id)?.row.path).toBe("/b/local.txt");
    expect(findRecord(createCatalog([]), archived.row.id)).toBeNull();
    expect(findRecord(both, "not json")).toBeNull();
  });
});

describe("what a result offers", () => {
  const recordFor = (sources: SearchSource[], word = "") =>
    searchFiles(createCatalog(sources), { ...nothing, words: word ? [word] : [] }, 1).records[0]!;

  it("offers restore from each computer that says it can, marking the ones that are offline", () => {
    const record = recordFor([
      source("a", "Alpha", false, [kept("/lib/x/payload/f.bin")]),
      source("b", "Beta", true, [kept("/lib/x/payload/f.bin")]),
      source("c", "Gamma", true, [kept("/lib/x/payload/f.bin", { restorable: false })]),
    ]);
    expect(restoreOffer(record)).toEqual({
      restore: { available: true },
      restoreTargets: [
        { computerId: "a", name: "Alpha", online: false },
        { computerId: "b", name: "Beta", online: true },
      ],
    });
  });

  it("gives the server's own reason when it cannot restore", () => {
    const record = recordFor([
      source("a", "Alpha", true, [
        kept("/lib/x/payload/f.bin", {
          restorable: false,
          restoreUnavailableReason: "Archive hash metadata is missing.",
        }),
      ]),
    ]);
    expect(restoreOffer(record).restore).toEqual({
      available: false,
      reason: "Archive hash metadata is missing.",
    });
  });

  it("does not read a server that said nothing as a yes", () => {
    const { restorable: _notReported, ...unreported } = kept("/lib/x/payload/f.bin");
    const record = recordFor([source("a", "Alpha", true, [unreported])]);
    expect(restoreOffer(record)).toMatchObject({
      restore: { available: false },
      restoreTargets: [],
    });
  });

  it("explains an offline computer, and offers nothing for a file that is not in the archive", () => {
    const offline = recordFor([source("a", "Alpha", false, [kept("/lib/x/payload/f.bin")])]);
    expect(restoreOffer(offline).restore).toEqual({ available: false, reason: "Alpha is offline" });
    const local = recordFor([source("a", "Alpha", true, [file("/work/plain.txt")])]);
    expect(restoreOffer(local).restore.available).toBe(false);
  });

  it("offers keep only for a file on a reachable computer that is not already archived", () => {
    expect(keepOffer(recordFor([source("a", "Alpha", true, [file("/work/plain.txt")])]))).toEqual({
      available: true,
    });
    expect(keepOffer(recordFor([source("a", "Alpha", false, [file("/work/plain.txt")])]))).toEqual({
      available: false,
      reason: "Computer is offline",
    });
    expect(
      keepOffer(recordFor([source("a", "Alpha", true, [kept("/lib/x/payload/f.bin")])])),
    ).toEqual({ available: false, reason: "This result is already in the archive" });
  });
});

it("keeps numeric ordering and exact totals when loading more from a large reverse-ordered index", () => {
  const files = Array.from({ length: 10_000 }, (_, index) =>
    file(`/work/item${10_000 - index}.txt`),
  );
  const catalog = createCatalog([source("a", "Alpha", true, files)]);
  for (const limit of [0, 200, 5_000, 10_001]) {
    const result = searchFiles(catalog, nothing, limit);
    expect(result.total).toBe(10_000);
    expect(names(result.records)).toEqual(
      Array.from({ length: Math.min(limit, 10_000) }, (_, index) => `item${index + 1}.txt`),
    );
  }
});

it("labels work folders separately and preserves the backup verification time", () => {
  const catalog = createCatalog([
    source("a", "Alpha", true, [
      file("/jobs/task/outputs/a.csv", { area: "work", project: "Utility" }),
      kept("/archive/b.csv", { area: "archive", backup: "confirmed", backupVerifiedAt: 2000 }),
    ]),
  ]);
  const result = searchFiles(catalog, nothing, 10);
  expect(result.records[0]?.row.location).toBe("work-folder");
  expect(result.records[1]?.row.backup).toMatchObject({
    state: "confirmed",
    at: "1970-01-01T00:00:02.000Z",
  });
});
