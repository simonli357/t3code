import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const SettledThreadPurgeInput = Schema.Struct({
  settledForDays: NonNegativeInt,
  /** Defaults to true: report what would be purged without changing anything. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type SettledThreadPurgeInput = typeof SettledThreadPurgeInput.Type;

export const SettledThreadPurgeThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  providerInstanceId: Schema.NullOr(Schema.String),
  settledAt: IsoDateTime,
  transcriptPaths: Schema.Array(Schema.String),
  transcriptBytes: NonNegativeInt,
  /** Why transcripts were not (fully) removed, e.g. an unsupported provider. */
  transcriptNote: Schema.NullOr(Schema.String),
  checkpointRefs: NonNegativeInt,
  /** The thread's worktree, which the purge leaves on disk. */
  worktreePath: Schema.NullOr(Schema.String),
});
export type SettledThreadPurgeThread = typeof SettledThreadPurgeThread.Type;

export const SettledThreadPurgeReport = Schema.Struct({
  dryRun: Schema.Boolean,
  settledForDays: NonNegativeInt,
  settledBefore: IsoDateTime,
  /** Threads purged, or that would be purged in a dry run. */
  purged: Schema.Array(SettledThreadPurgeThread),
  skipped: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, reason: Schema.String }),
  ),
  failed: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, error: Schema.String }),
  ),
  transcriptPathsRemoved: Schema.Array(Schema.String),
  bytesRemoved: NonNegativeInt,
  rowCounts: Schema.Record(Schema.String, NonNegativeInt),
  /** Free pages SQLite reuses for new rows; the file itself does not shrink. */
  databaseReusableBytes: NonNegativeInt,
  notes: Schema.Array(Schema.String),
});
export type SettledThreadPurgeReport = typeof SettledThreadPurgeReport.Type;

export class SettledThreadPurgeError extends Schema.TaggedError<SettledThreadPurgeError>()(
  "SettledThreadPurgeError",
  { message: Schema.String },
) {}
