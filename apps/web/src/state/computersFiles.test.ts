import { describe, expect, it } from "vite-plus/test";
import type { ComputerFile } from "@t3tools/contracts";
import {
  mergeFilePages,
  fileTypeOf,
  keepOffer,
  restoreOffer,
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
describe("merging requested pages", () => {
  it("combines shared archives and preserves local files and restore targets", () => {
    const records = mergeFilePages([
      source("a", "Alpha", true, [kept("/archive/result.csv"), file("/work/local.txt")]),
      source("b", "Beta", true, [kept("/archive/result.csv")]),
    ]);
    expect(records.map((record) => record.row.name)).toEqual(["local.txt", "result.csv"]);
    expect(records[1]?.copies.map((copy) => copy.computerId)).toEqual(["a", "b"]);
  });
  it("derives a type only from a file extension", () => {
    expect(fileTypeOf(file("/x/a.tar.gz"))).toBe("GZ");
    expect(fileTypeOf(file("/x/.gitignore"))).toBeNull();
    expect(fileTypeOf(file("/x/dir.d", { directory: true }))).toBeNull();
  });
});

describe("what a result offers", () => {
  const recordFor = (sources: SearchSource[]) => mergeFilePages(sources)[0]!;

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

it("labels work folders separately and preserves the backup verification time", () => {
  const result = mergeFilePages([
    source("a", "Alpha", true, [
      file("/jobs/task/outputs/a.csv", { area: "work", project: "Utility" }),
      kept("/archive/b.csv", { area: "archive", backup: "confirmed", backupVerifiedAt: 2000 }),
    ]),
  ]);
  expect(result[0]?.row.location).toBe("work-folder");
  expect(result[1]?.row.backup).toMatchObject({
    state: "confirmed",
    at: "1970-01-01T00:00:02.000Z",
  });
});
