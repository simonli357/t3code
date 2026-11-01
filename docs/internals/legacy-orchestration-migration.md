# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source and provide a read-only recovery source if an import
needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, prepared-base designation, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields and a missing prepared-base designation for threads imported before those fields were covered.
Project base prompts remain in the shared project projection and are read by the V2 project store.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

Activities retain their original payload in historical tool items. Proposed plans and checkpoint
references/file summaries become V2 artifacts under a completed historical node. No old actions,
approvals, runs, schedules, or worker jobs are replayed by the importer. The original projection
and checkpoint-blob tables remain available. Copied queued/submitted worker jobs keep their ids,
prompts, ownership, and old turn references but become explicitly interrupted: V1 native turn ids
cannot settle V2 run receipts. Historical notices are not redelivered; a new assignment resumes the
worker through the normal service. Trial tooling must separately disable schedules and other
background execution before booting a copied home. Migration 63 keeps its ledger name but no
longer drops the legacy tables. A database already processed by an older destructive V2 preview must be recovered from the
original V1 database rather than assumed complete.

## First continuation

When the V1 runtime has a compatible native identity, the shell binds it as an unloaded provider
thread. Codex, Claude, Pi, DeepSeek Harness, OpenCode, and Grok can resume through their existing
adapters. Native files and the same provider profile must still be available. Pi's V1 UUID is
resolved to exactly one matching session-file header; missing or ambiguous matches fail instead
of starting an empty conversation. Cursor CLI and Antigravity identities are retained in the source
but are not claimed compatible with their V2 adapters.

Native continuation does not inject a duplicate transcript handoff. Otherwise the first continuation
uses the portable handoff budget and retrieval instructions for omitted history. The full transcript
remains imported regardless of what fits in the provider's context window.

## Client and server cutover

Clients and servers must agree on `ORCHESTRATION_PROTOCOL_VERSION` (currently 2). The client
runtime appends `orchestrationProtocol=2` to the socket URL, and the `/ws` route rejects a missing
or mismatched version with HTTP 426 (`orchestration_protocol_incompatible`) before any RPC or auth
work runs. The client checks the environment descriptor the same way: a missing version means the
host predates protocol 2, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

Saved client sessions require the same environment identity, signing secret, and copied auth rows.
Protocol rejection is separate from authentication: changing the trial identity intentionally breaks
cookie identity and is not a fidelity test of production migration.

V1 peer links use a different route and unfenced credentials. Startup preserves their identities,
labels, URLs, and original secret, exposes them as inactive transition records, and never guesses
that an old token works on the V2 route. Upgrade the counterpart, obtain a new fenced pairing
credential there, and call the normal link operation with `expectedEnvironmentId`. That operation
validates the descriptor, protocol, capabilities, and exact identity before replacing the record.
Verify an authenticated peer operation before treating the transition as complete; repeat for the
reverse direction. The original V1 secret stays available for rollback.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. After repairing supported V2 preview ledgers,
[`runMigrations`](../../apps/server/src/persistence/Migrations.ts) rejects history that would skip a
requested migration at id 55 or later without its expected name. Earlier name clashes remain
warnings for compatibility with site-local migrations. There is no safe id range for a fork inside
this ledger: any id at or below a future upstream id masks it forever, so fork schema changes belong
in a separate migration table or outside the migrator entirely.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.
