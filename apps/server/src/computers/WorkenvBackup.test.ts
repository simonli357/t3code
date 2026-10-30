import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../processRunner.ts";
import {
  backupActivity,
  backupWanted,
  manifestListsSnapshot,
  proofIsComplete,
  recordedProof,
  retryBackups,
  verifyBackups,
} from "./WorkenvBackup.ts";
import { openLibrary } from "./WorkenvLibrary.ts";
import type { ReceiptFile } from "./Workenv.ts";
import type { BackupProof, KeepReceipt } from "./WorkenvConfig.ts";
import {
  SNAPSHOT,
  fromJson,
  interfaceJson,
  latestReceipt,
  makeBundle,
  output,
  scriptedLibrary,
  toJson,
  workenvConfig,
} from "./testSupport.ts";

const LATEST = "/var/lib/workenv/backup/latest.json";
const bundle = makeBundle({
  id: "1".repeat(32),
  files: { "report.txt": "selected", "other.txt": "other" },
});
const file = (receipt: KeepReceipt = bundle.receipt): ReceiptFile => ({
  key: "k".repeat(24),
  file: "/state/keep/requests/k.json",
  modifiedAt: 1,
  receipt,
});
const proof = (overrides: Partial<BackupProof> = {}): BackupProof => ({
  schema: "workenv-backup-receipt/2",
  snapshot_id: SNAPSHOT,
  content_verified_snapshot: SNAPSHOT,
  manifest_sha256: bundle.manifestSha256,
  path: bundle.writerPath,
  method: "snapshot content hashed against manifest",
  confirmed_at: "2026-10-22T07:50:42-04:00",
  ...overrides,
});

describe("recorded backup proof", () => {
  it("accepts only a complete v2 proof for the published bundle", () => {
    expect(proofIsComplete(proof(), bundle.writerPath)).toBe(true);
    expect(proofIsComplete(proof({ path: "/library/elsewhere" }), bundle.writerPath)).toBe(false);
    expect(proofIsComplete(proof({ method: "trust me" }), bundle.writerPath)).toBe(false);
    expect(proofIsComplete(proof({ snapshot_id: "short" }), bundle.writerPath)).toBe(false);
    const earlier = "b".repeat(64);
    expect(
      proofIsComplete(
        proof({
          content_verified_snapshot: earlier,
          method: `unchanged since ${earlier.slice(0, 8)} per restic diff`,
        }),
        bundle.writerPath,
      ),
    ).toBe(true);
  });
  it("shows what is waiting for a backup, and only that", () => {
    const config = workenvConfig();
    const confirmed = {
      ...bundle.receipt,
      backup: "confirmed",
      backup_receipt: proof(),
      backup_error: null,
    };
    expect(recordedProof(confirmed)).not.toBeNull();
    expect(backupWanted(config, confirmed, undefined)).toBe(false);
    expect(backupWanted(config, bundle.receipt, undefined)).toBe(true);
    // This server's own verification counts, and so does a project that does not require backups.
    expect(backupWanted(config, bundle.receipt, { proof: proof(), at: 1 })).toBe(false);
    const optional = {
      ...bundle.receipt,
      backup_required: false,
      backup: "not verified",
      backup_error: null,
    };
    expect(
      backupWanted(
        { ...config, projects: { t3: { source: "/s", keep: { audience: "private" } } } },
        optional,
        undefined,
      ),
    ).toBe(false);
    expect(backupActivity(file(optional), undefined, false)).toEqual([]);
    const [row] = backupActivity(file(), undefined, true);
    expect(row).toMatchObject({
      kind: "backup",
      status: "failed",
      retryable: true,
      id: `backup:${"k".repeat(24)}`,
    });
    const [done] = backupActivity(file(), { proof: proof(), at: 1_792_000_500_000 }, false);
    expect(done).toMatchObject({
      status: "completed",
      retryable: false,
      updatedAt: 1_792_000_500_000,
    });
    expect(done!.detail).toContain("by this server");
  });
  it("accepts MANIFEST.sha256 only when it lists exactly the receipt's files", () => {
    const text = bundle.files[`${bundle.writerPath}/MANIFEST.sha256`]!;
    const snapshot = bundle.receipt.snapshot!;
    expect(manifestListsSnapshot(text, snapshot)).toBe(true);
    expect(manifestListsSnapshot(`${text}${"e".repeat(64)}  payload/extra.txt\n`, snapshot)).toBe(
      false,
    );
    expect(manifestListsSnapshot(text.replace(/^[a-f0-9]{64}/, "f".repeat(64)), snapshot)).toBe(
      false,
    );
    expect(
      manifestListsSnapshot(
        text
          .split("\n")
          .filter((line) => !line.endsWith("README.md"))
          .join("\n"),
        snapshot,
      ),
    ).toBe(false);
    expect(manifestListsSnapshot("not a manifest", snapshot)).toBe(false);
  });
});

it.layer(NodeServices.layer)("verifying the library backup", (it) => {
  const library = (
    extra: Record<string, string> = {},
    admin?: Parameters<typeof scriptedLibrary>[1]["admin"],
    listings?: Parameters<typeof scriptedLibrary>[1]["listings"],
  ) =>
    Effect.gen(function* () {
      const scripted = scriptedLibrary(yield* FileSystem.FileSystem, {
        ...(listings ? { listings } : {}),
        files: {
          "/etc/library-interface.json": interfaceJson(),
          [LATEST]: latestReceipt([bundle]),
          ...bundle.files,
          ...extra,
        },
        admin:
          admin ??
          ((command) =>
            command.includes("restic") && command.includes("snapshots")
              ? output(toJson([{ id: SNAPSHOT }]))
              : output("", 1, "unexpected")),
      });
      return scripted;
    });
  const verify = (
    scripted: ReturnType<typeof scriptedLibrary>,
    receipt: KeepReceipt = bundle.receipt,
    config = workenvConfig(),
  ) =>
    Effect.gen(function* () {
      const opened = yield* openLibrary(config).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, scripted.runner),
      );
      return yield* verifyBackups(opened, config, [file(receipt)]).pipe(Effect.result);
    });

  it.effect("confirms a bundle the latest backup covers, against its current manifest", () =>
    Effect.gen(function* () {
      const scripted = yield* library();
      const result = yield* verify(scripted);
      expect(result._tag).toBe("Success");
      const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
      expect(check?.reason).toBeNull();
      expect(check?.proof).toMatchObject({
        snapshot_id: SNAPSHOT,
        manifest_sha256: bundle.manifestSha256,
        path: bundle.writerPath,
        method: "snapshot content hashed against manifest",
      });
      // The snapshot list comes from the library host, over the pinned ssh route, as one fixed command.
      const ssh = scripted.calls.find((call) => call.command === "ssh");
      // The same command workenv's own library helper runs to list the snapshots that still exist.
      expect(ssh?.args.at(-1)).toBe(
        "sudo -n env RESTIC_REPOSITORY=/data/work-backup/restic RESTIC_PASSWORD_FILE=/etc/workenv/restic/password RESTIC_CACHE_DIR=/var/cache/restic restic snapshots --json",
      );
      expect(ssh?.args).toContain("StrictHostKeyChecking=yes");
    }),
  );

  const unconfirmed: ReadonlyArray<[string, () => Record<string, string>, string]> = [
    [
      "the latest backup does not include the bundle",
      () => ({ [LATEST]: latestReceipt([]) }),
      "does not include this published bundle",
    ],
    [
      "the backup recorded another manifest digest",
      () => ({
        [LATEST]: latestReceipt([
          { writerPath: bundle.writerPath, manifestSha256: "9".repeat(64) },
        ]),
      }),
      "does not confirm the current bundle manifest",
    ],
    [
      "the bundle's MANIFEST.sha256 no longer describes the receipt",
      () => ({
        [`${bundle.writerPath}/MANIFEST.sha256`]: `${"0".repeat(64)}  payload/other.txt\n`,
      }),
      "no longer matches the keep receipt",
    ],
    [
      "the bundle's MANIFEST.sha256 is unreadable",
      () => ({ [`${bundle.writerPath}/MANIFEST.sha256`]: undefined as unknown as string }),
      "Cannot read",
    ],
  ];
  it.effect.each(unconfirmed)("leaves a bundle unconfirmed when %s", ([_name, files, reason]) =>
    Effect.gen(function* () {
      const extra = files();
      const scripted = yield* library(extra);
      for (const [key, value] of Object.entries(extra))
        if (value === undefined) delete scripted.files[key];
      const result = yield* verify(scripted);
      const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
      expect(check?.proof).toBeNull();
      expect(check?.reason).toContain(reason);
    }),
  );

  it.effect(
    "leaves a bundle unconfirmed when the snapshot that verified its content has expired",
    () =>
      Effect.gen(function* () {
        const earlier = "c".repeat(64);
        const latest = fromJson(latestReceipt([bundle])) as {
          items: Array<Record<string, string>>;
        };
        latest.items[0]!.content_verified_snapshot = earlier;
        latest.items[0]!.method = `unchanged since ${earlier.slice(0, 8)} per restic diff`;
        // Only the newest snapshot is left in the repository: the one that verified the content is gone.
        const result = yield* verify(yield* library({ [LATEST]: toJson(latest) }));
        const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
        expect(check?.proof).toBeNull();
        expect(check?.reason).toContain("snapshot expired");
      }),
  );

  it.effect("refuses a backup receipt whose own snapshot no longer exists", () =>
    Effect.gen(function* () {
      const result = yield* verify(
        yield* library({}, () => output(toJson([{ id: "d".repeat(64) }]))),
      );
      expect(result._tag === "Success" && result.success.get("k".repeat(24))?.reason).toContain(
        "existing snapshot",
      );
    }),
  );

  describe("when the latest backup covered only some bundles", () => {
    const EARLIER = "b".repeat(64);
    const other = makeBundle({ id: "9".repeat(32), files: { "x.txt": "x" } });
    const folder = "/var/lib/workenv/backup/receipts";
    const listing = {
      [folder]: [{ Path: "bbbbbbbb.json", Size: 10, ModTime: "2026-10-21T03:58:05-04:00" }],
    };
    const earlier = (receipt: string) => ({ [`${folder}/bbbbbbbb.json`]: receipt });
    const snapshotsOf =
      (...ids: string[]) =>
      () =>
        output(toJson(ids.map((id) => ({ id }))));
    // The latest run backed up one other bundle; ours was covered by an earlier snapshot.
    const base = { [LATEST]: latestReceipt([other]) };

    it.effect("confirms a bundle by an earlier receipt whose snapshot still exists", () =>
      Effect.gen(function* () {
        const scripted = yield* library(
          { ...base, ...earlier(latestReceipt([bundle], EARLIER)) },
          snapshotsOf(SNAPSHOT, EARLIER),
          listing,
        );
        const result = yield* verify(scripted);
        const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
        expect(check?.reason).toBeNull();
        expect(check?.proof).toMatchObject({
          snapshot_id: EARLIER,
          content_verified_snapshot: EARLIER,
          manifest_sha256: bundle.manifestSha256,
        });
      }),
    );

    it.effect("starts no backup for a bundle an earlier receipt already covers", () =>
      Effect.gen(function* () {
        const scripted = yield* library(
          { ...base, ...earlier(latestReceipt([bundle], EARLIER)) },
          snapshotsOf(SNAPSHOT, EARLIER),
          listing,
        );
        const result = yield* retryBackups(workenvConfig(), [file()]).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, scripted.runner),
        );
        expect(result.confirmed.size).toBe(1);
        expect(result.started).toBe(false);
      }),
    );

    it.effect(
      "does not use an earlier receipt whose snapshot was forgotten, or one for another manifest",
      () =>
        Effect.gen(function* () {
          const forgotten = yield* verify(
            yield* library(
              { ...base, ...earlier(latestReceipt([bundle], EARLIER)) },
              snapshotsOf(SNAPSHOT),
              listing,
            ),
          );
          const changed = yield* verify(
            yield* library(
              {
                ...base,
                ...earlier(
                  latestReceipt(
                    [{ writerPath: bundle.writerPath, manifestSha256: "8".repeat(64) }],
                    EARLIER,
                  ),
                ),
              },
              snapshotsOf(SNAPSHOT, EARLIER),
              listing,
            ),
          );
          for (const result of [forgotten, changed]) {
            const check =
              result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
            expect(check?.proof).toBeNull();
            expect(check?.reason).toContain("does not include this published bundle");
          }
        }),
    );

    it.effect("still answers when an earlier receipt it was told about cannot be downloaded", () =>
      Effect.gen(function* () {
        // The folder lists a receipt that is not there to download: the bundle stays unconfirmed.
        const result = yield* verify(yield* library(base, snapshotsOf(SNAPSHOT, EARLIER), listing));
        expect(result._tag).toBe("Success");
        const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
        expect(check).toMatchObject({ proof: null });
        expect(check?.reason).toContain("does not include this published bundle");
      }),
    );
  });

  it.effect("refuses to trust a library whose identity or backup contract differs", () =>
    Effect.gen(function* () {
      const wrongLibrary = yield* verify(
        yield* library({ "/etc/library-interface.json": interfaceJson({ uuid: "other" }) }),
      );
      expect(wrongLibrary._tag === "Failure" && wrongLibrary.failure.message).toContain(
        "different library",
      );
      const contract = fromJson(interfaceJson()) as { backup: { repository: string } };
      contract.backup.repository = "/somewhere/else (restic)";
      const changed = yield* verify(
        yield* library({ "/etc/library-interface.json": toJson(contract) }),
      );
      expect(changed._tag === "Failure" && changed.failure.message).toContain("contract differs");
    }),
  );

  it.effect("does not confirm a bundle of another library", () =>
    Effect.gen(function* () {
      const result = yield* verify(yield* library(), {
        ...bundle.receipt,
        library_id: "someone-elses",
      });
      const check = result._tag === "Success" ? result.success.get("k".repeat(24)) : undefined;
      expect(check?.reason).toContain("published bundle of this library");
    }),
  );

  describe("retrying", () => {
    const retry = (scripted: ReturnType<typeof scriptedLibrary>, config = workenvConfig()) =>
      retryBackups(config, [file()]).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, scripted.runner),
        Effect.result,
      );
    const started = (calls: ReadonlyArray<{ args: ReadonlyArray<string> }>) =>
      calls.filter((call) => call.args.at(-1)?.includes("systemctl start workenv-backup.service"));

    it.effect("starts no backup when the latest one already covers the bundle", () =>
      Effect.gen(function* () {
        const scripted = yield* library();
        const result = yield* retry(scripted);
        expect(result._tag === "Success" && result.success.confirmed.size).toBe(1);
        expect(result._tag === "Success" && result.success.started).toBe(false);
        expect(started(scripted.calls)).toHaveLength(0);
      }),
    );

    it.effect(
      "starts the library backup for a missing bundle and confirms only what it then covers",
      () =>
        Effect.gen(function* () {
          const scripted = yield* library({ [LATEST]: latestReceipt([]) }, (command, files) => {
            if (command.includes("systemctl start")) {
              files[LATEST] = latestReceipt([bundle]);
              return output();
            }
            return output(toJson([{ id: SNAPSHOT }]));
          });
          const result = yield* retry(scripted);
          expect(result._tag === "Success" && result.success.started).toBe(true);
          expect(result._tag === "Success" && [...result.success.confirmed.keys()]).toEqual([
            "k".repeat(24),
          ]);
          expect(started(scripted.calls)).toHaveLength(1);
        }),
    );

    it.effect("reports a service that returned without covering the bundle as still pending", () =>
      Effect.gen(function* () {
        const scripted = yield* library({ [LATEST]: latestReceipt([]) }, (command) =>
          command.includes("systemctl start") ? output() : output(toJson([{ id: SNAPSHOT }])),
        );
        const result = yield* retry(scripted);
        expect(result._tag === "Success" && result.success.confirmed.size).toBe(0);
        expect(result._tag === "Success" && result.success.reasons.get("k".repeat(24))).toContain(
          "does not include",
        );
      }),
    );

    it.effect("checks again after a failed start, which may still have left a backup", () =>
      Effect.gen(function* () {
        const scripted = yield* library({ [LATEST]: latestReceipt([]) }, (command, files) => {
          if (command.includes("systemctl start")) {
            files[LATEST] = latestReceipt([bundle]);
            return output("", 1, "Job for workenv-backup.service failed");
          }
          return output(toJson([{ id: SNAPSHOT }]));
        });
        const result = yield* retry(scripted);
        expect(result._tag === "Success" && result.success.confirmed.size).toBe(1);
        expect(result._tag === "Success" && result.success.startFailure).toContain("failed");
      }),
    );

    it.effect.each(["missing", "malformed", "expired"] as const)(
      "recovers a %s latest receipt by starting and verifying the backup",
      (evidence) =>
        Effect.gen(function* () {
          const initial =
            evidence === "malformed" ? "{broken" : latestReceipt([bundle], "b".repeat(64));
          const scripted = yield* library({ [LATEST]: initial }, (command, files) => {
            if (command.includes("systemctl start")) files[LATEST] = latestReceipt([bundle]);
            return command.includes("snapshots") ? output(toJson([{ id: SNAPSHOT }])) : output();
          });
          if (evidence === "missing") delete scripted.files[LATEST];
          const result = yield* retry(scripted);
          expect(result._tag === "Success" && result.success.confirmed.size).toBe(1);
          expect(started(scripted.calls)).toHaveLength(1);
        }),
    );

    it.effect("uses older usable receipts even when the latest receipt is malformed", () =>
      Effect.gen(function* () {
        const folder = "/var/lib/workenv/backup/receipts";
        const scripted = yield* library(
          { [LATEST]: "{broken", [`${folder}/abcdef01.json`]: latestReceipt([bundle]) },
          undefined,
          {
            [folder]: [{ Path: "abcdef01.json", Size: 1, ModTime: "2026-10-22T10:00:00Z" }],
          },
        );
        const result = yield* retry(scripted);
        expect(result._tag === "Success" && result.success.confirmed.size).toBe(1);
        expect(started(scripted.calls)).toHaveLength(0);
      }),
    );

    it.effect("does nothing at all on a blocked route", () =>
      Effect.gen(function* () {
        const scripted = yield* library();
        const config = workenvConfig();
        const result = yield* retry(scripted, {
          ...config,
          keep: { ...config.keep, route_blocked: true },
        });
        expect(result._tag === "Failure" && result.failure.message).toContain("blocked");
        expect(scripted.calls).toHaveLength(0);
      }),
    );
  });
});
