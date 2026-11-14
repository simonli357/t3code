import { HostProcessHostname } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "./config.ts";

/**
 * A database records the installation that last ran it: the machine's host
 * name and the database file's real path. Running and queued work in the
 * database belongs to that installation. A server that finds another
 * installation recorded is running a copy, for example one made for testing
 * or moved to another path or computer. Resuming the copy's work would run it
 * a second time next to the original: the same provider sessions, prompts,
 * reports and peer calls.
 *
 * `claimInstallation` runs before any reactor starts. On a copy it settles the
 * copied work in the same transaction that records this installation, so a
 * crash in between repeats the settling instead of resuming.
 */
export interface InstallationClaim {
  /** The database was another installation's; its running and queued work was settled. */
  readonly copied: boolean;
}

/** This server's claim, for startup steps that present copied work differently. */
export const CurrentInstallationClaim = Context.Reference<InstallationClaim>(
  "t3/installationOwner/CurrentInstallationClaim",
  { defaultValue: () => ({ copied: false }) },
);

const COPIED_WORK_ERROR = "Copied from another installation; not resumed here.";

export const claimInstallation = Effect.fn("claimInstallation")(function* (options: {
  /**
   * Databases from builds before this record carry none. Only the installed
   * service or the packaged desktop app adopts such a database as its own;
   * anything else, such as a dev server, treats it as a copy.
   */
  readonly adoptUnrecorded: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const { dbPath } = yield* ServerConfig.ServerConfig;
  const host = yield* HostProcessHostname;
  const databasePath = yield* fileSystem.realPath(dbPath).pipe(Effect.orElseSucceed(() => dbPath));
  const claimedAt = DateTime.formatIso(yield* DateTime.now);

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [owner] = yield* sql<{ readonly host: string; readonly databasePath: string }>`
        SELECT host, database_path AS "databasePath" FROM custom_installation_owner WHERE id = 1`;
      const copied =
        owner === undefined
          ? !options.adoptUnrecorded
          : owner.host !== host || owner.databasePath !== databasePath;
      const settled = copied ? yield* settleCopiedWork : 0;
      yield* sql`INSERT INTO custom_installation_owner (id, host, database_path, claimed_at)
        VALUES (1, ${host}, ${databasePath}, ${claimedAt})
        ON CONFLICT(id) DO UPDATE SET host = excluded.host,
          database_path = excluded.database_path, claimed_at = excluded.claimed_at`;
      if (settled > 0) {
        yield* Effect.logWarning(
          "Settled running and queued work copied from another installation",
          {
            settledRows: settled,
            recordedHost: owner?.host ?? "unrecorded (older build)",
            recordedDatabasePath: owner?.databasePath ?? "unrecorded (older build)",
          },
        );
      }
      return { copied } satisfies InstallationClaim;
    }),
  );
});

/**
 * Settles everything that would act on its own once the server starts and
 * returns how many rows changed. Rows stay for history; only their pending
 * state ends. Startup reconciliation then shows the copied running threads as
 * stopped.
 */
const settleCopiedWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = sql<{ readonly count: number }>`SELECT total_changes() AS count`.pipe(
    Effect.map(([row]) => row?.count ?? 0),
  );
  const before = yield* changes;
  const payload = sql.literal(
    "CASE WHEN json_valid(runtime_payload_json) THEN runtime_payload_json ELSE '{}' END",
  );
  // Provider sessions: without a running binding or a continuation marker,
  // startup reconciliation has nothing to resume.
  yield* sql`UPDATE provider_session_runtime
    SET status = 'stopped',
      runtime_payload_json = json_set(
        CASE WHEN json_type(${payload}) = 'object' THEN ${payload} ELSE '{}' END,
        '$.activeTurnId', NULL,
        '$.continueAfterServerUpdate', NULL,
        '$.continueAfterServerUpdatePrepared', NULL)
    WHERE status != 'stopped'
      OR json_extract(${payload}, '$.activeTurnId') IS NOT NULL
      OR json_extract(${payload}, '$.continueAfterServerUpdate') IS NOT NULL`;
  // Worker jobs: queued prompts, assignments, wake-ups (resume_at), retries,
  // peer deliveries and reports, plus outcomes not yet reported to a master.
  yield* sql`UPDATE custom_worker_jobs SET state = 'cancelled', error = ${COPIED_WORK_ERROR}
    WHERE state NOT IN ('completed', 'error', 'interrupted', 'cancelled')`;
  yield* sql`UPDATE custom_worker_jobs SET reported = 1 WHERE reported = 0`;
  // A copied worker's later turns would report to its master; the master's session is the original's.
  yield* sql`UPDATE custom_workers SET notify = 0 WHERE notify != 0`;
  // Orchestrator handoffs and automatic renewals would create successors and send them prompts.
  yield* sql`UPDATE custom_orchestrator_handoffs SET state = 'cancelled', error = ${COPIED_WORK_ERROR}
    WHERE state = 'queued'`;
  yield* sql`INSERT INTO custom_session_renewals (thread_id, state, error)
    SELECT thread_id, 'error', ${COPIED_WORK_ERROR} FROM custom_workers
    UNION SELECT owner_id, 'error', ${COPIED_WORK_ERROR} FROM custom_workers WHERE owner_id IS NOT NULL
    ON CONFLICT(thread_id) DO UPDATE SET state = 'error', error = excluded.error
      WHERE custom_session_renewals.state NOT IN ('completed', 'error')`;
  // Session moves and ownership changes call linked computers.
  yield* sql`UPDATE custom_session_moves SET state = 'cancelled', locked = 0,
      error = ${COPIED_WORK_ERROR}, updated_at = ${DateTime.formatIso(yield* DateTime.now)}
    WHERE state NOT IN ('complete', 'cancelled')`;
  yield* sql`UPDATE custom_ownership_transactions SET state = 'aborted', participants_json = '[]',
      error = COALESCE(error, ${COPIED_WORK_ERROR})
    WHERE state IN ('preparing', 'committed') OR (state = 'aborted' AND participants_json != '[]')`;
  yield* sql`DELETE FROM custom_ownership_reservation`;
  yield* sql`UPDATE custom_session_ownership_changes SET announced = 1 WHERE announced = 0`;
  return (yield* changes) - before;
});
