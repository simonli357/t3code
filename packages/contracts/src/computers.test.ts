import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ComputerActivity,
  ComputerFile,
  ComputerInspectInput,
  StorageEntry,
  StorageVolume,
} from "./computers.ts";

const decodeFile = Schema.decodeUnknownSync(ComputerFile);
const decodeEntry = Schema.decodeUnknownSync(StorageEntry);
const decodeActivity = Schema.decodeUnknownSync(ComputerActivity);
const decodeVolume = Schema.decodeUnknownSync(StorageVolume);
const decodeInput = Schema.decodeUnknownSync(ComputerInspectInput);
const encodeFile = Schema.encodeSync(ComputerFile);
const encodeEntry = Schema.encodeSync(StorageEntry);

const file = {
  path: "/library/bundle/payload/report.txt",
  name: "report.txt",
  project: "t3",
  sizeBytes: 8,
  modifiedAt: null,
  directory: false,
  reference: null,
};
const entry = {
  id: "archive:1",
  group: "archives",
  title: "Evidence",
  subtitle: null,
  host: "alpha",
  local: true,
  location: "/library/bundle",
  disk: null,
  size: { bytes: 8, complete: true, measuredAt: null, basis: "manifest" },
  ram: [],
  notes: [],
};
const archive = {
  collection: null,
  project: "t3",
  source: null,
  createdAt: null,
  retention: null,
  files: 1,
};

describe("library backups, retired", () => {
  it("still decodes what a server from before the removal sends", () => {
    decodeFile({
      ...file,
      backup: "confirmed",
      backupVerifiedAt: 2000,
    });
    decodeEntry({
      ...entry,
      archive: {
        ...archive,
        backup: "confirmed",
        backupVerifiedAt: 2000,
        backupSnapshot: "bf674190",
      },
    });
    decodeEntry({
      ...entry,
      id: "backup:library",
      group: "backups",
      backup: {
        kind: "repository",
        repository: "/data/backup",
        snapshots: null,
        covered: 1,
        expected: 1,
        verifiedAt: 2000,
        retention: null,
        independent: true,
      },
    });
    decodeActivity({
      id: "backup:k",
      kind: "backup",
      label: "Backup: Evidence",
      status: "completed",
      updatedAt: 2000,
      detail: null,
      source: null,
      retryable: false,
    });
    decodeVolume({
      id: "/data",
      label: "data",
      mountPaths: ["/data"],
      filesystem: null,
      device: null,
      role: "data",
      capacityBytes: null,
      usedBytes: null,
      availableBytes: null,
      reserveBytes: null,
      headroomBytes: null,
      holds: ["backup"],
      measuredAt: null,
    });
  });

  it("still accepts the backups group a client from before the removal asks for", () => {
    expect(decodeInput({ section: "holdings", groups: ["backups"] }).groups).toEqual(["backups"]);
  });

  it("keeps the keys such a client requires through encoding", () => {
    expect(encodeFile({ ...file, backup: "not-verified" })).toMatchObject({
      backup: "not-verified",
    });
    const legacy = { backup: "published", backupVerifiedAt: null, backupSnapshot: null };
    expect(
      encodeEntry({
        ...decodeEntry(entry),
        archive: { ...archive, ...legacy },
      }).archive,
    ).toMatchObject(legacy);
  });
});
