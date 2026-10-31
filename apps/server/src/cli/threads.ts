import { NonNegativeInt, SettledThreadPurgeReport } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { reportThreadErrors, withThreadTools } from "./thread.ts";

const formatBytes = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/** Plain lines, no tables, so the report wraps cleanly in narrow terminals. */
function formatSettledThreadPurgeReport(report: typeof SettledThreadPurgeReport.Type): string {
  const lines: Array<string> = [];
  const count = report.purged.length;
  lines.push(
    report.dryRun
      ? `Dry run: ${count} thread${count === 1 ? "" : "s"} settled before ${report.settledBefore} would be purged.`
      : `Purged ${count} thread${count === 1 ? "" : "s"} settled before ${report.settledBefore}.`,
  );
  for (const thread of report.purged) {
    lines.push("", `  ${thread.threadId}  ${thread.title}`);
    lines.push(`    ${thread.providerInstanceId ?? "no provider"}, settled ${thread.settledAt}`);
    lines.push(
      `    ${thread.transcriptPaths.length} transcript path(s), ${formatBytes(thread.transcriptBytes)}; ${thread.checkpointRefs} checkpoint ref(s)`,
    );
    for (const transcript of thread.transcriptPaths) lines.push(`      ${transcript}`);
    if (thread.transcriptNote !== null) lines.push(`    note: ${thread.transcriptNote}`);
    if (thread.worktreePath !== null) lines.push(`    worktree kept: ${thread.worktreePath}`);
  }
  if (report.skipped.length > 0) {
    lines.push("", `Skipped ${report.skipped.length}:`);
    for (const thread of report.skipped) {
      lines.push(`  ${thread.threadId}  ${thread.title}`, `    ${thread.reason}`);
    }
  }
  if (report.failed.length > 0) {
    lines.push("", `Failed ${report.failed.length}:`);
    for (const thread of report.failed) {
      lines.push(`  ${thread.threadId}  ${thread.title}`, `    ${thread.error}`);
    }
  }
  const rows = Object.entries(report.rowCounts).filter(([, rowCount]) => rowCount > 0);
  lines.push(
    "",
    `Rows: ${rows.reduce((total, [, rowCount]) => total + rowCount, 0)}`,
    ...rows.map(([table, rowCount]) => `  ${table} ${rowCount}`),
    `Transcripts: ${report.transcriptPathsRemoved.length} path(s), ${formatBytes(report.bytesRemoved)}`,
    `Database free pages: ${formatBytes(report.databaseReusableBytes)}`,
    "",
    ...report.notes,
  );
  if (report.dryRun && count > 0) lines.push("", "Run again with --yes to purge.");
  return lines.join("\n");
}

const purgeSettledCommand = Command.make("purge-settled", {
  ...projectLocationFlags,
  days: Flag.Int("days").pipe(
    Flag.withSchema(NonNegativeInt),
    Flag.withDescription("Purge threads settled for more than this many days."),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Purge for real. Without it, only print what would be purged."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Permanently remove settled threads, their provider transcripts and checkpoint refs from a running server. Prints what would go and what stays; --yes purges.",
  ),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.threads.purgeSettled")(function* (tools) {
        const report = yield* tools.call(
          "t3_purge_settled_threads",
          { settledForDays: flags.days, dryRun: !flags.yes },
          SettledThreadPurgeReport,
        );
        yield* Console.log(formatSettledThreadPurgeReport(report));
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const threadsCommand = Command.make("threads").pipe(
  Command.withDescription("Manage threads on the running server."),
  Command.withSubcommands([purgeSettledCommand]),
);
