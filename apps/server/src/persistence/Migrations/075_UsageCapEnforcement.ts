import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE provider_usage_cap_latches (
    account_key TEXT NOT NULL,
    driver TEXT NOT NULL,
    window_id TEXT NOT NULL,
    cycle_key TEXT NOT NULL,
    used_percent REAL NOT NULL,
    threshold_percent REAL NOT NULL,
    checked_at TEXT NOT NULL,
    resets_at TEXT,
    enforced_at TEXT NOT NULL,
    stop_workers INTEGER NOT NULL,
    stop_masters INTEGER NOT NULL,
    PRIMARY KEY (account_key, window_id)
  )`;
});
