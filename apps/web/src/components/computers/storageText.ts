/**
 * The sentences of a group header: how many entries, how many bytes, and what the number does not
 * cover. Pure, so the rule "unknown is never zero, and a total says what is missing from it" is
 * tested rather than inspected.
 */
import { formatBytes } from "./computersFormat";
import type { GroupCoverage, HoldingGroupModel } from "./storageViewModel";

const NOUN = {
  workspaces: ["workspace", "workspaces"],
  archives: ["archive", "archives"],
  backups: ["repository", "repositories"],
  other: ["item", "items"],
} as const;

export function describeGroupUsage(group: HoldingGroupModel): {
  readonly count: string;
  readonly bytes: string;
  readonly caveats: readonly string[];
} {
  const [one, many] = NOUN[group.id];
  const count =
    group.count === null
      ? "Loading"
      : `${group.count}${group.countIsLowerBound ? "+" : ""} ${group.count === 1 ? one : many}`;
  const partial = group.unmeasured > 0;
  const bytes =
    group.bytes === null
      ? group.measuring
        ? "Measuring…"
        : "Size not measured"
      : `${partial ? "≥ " : ""}${formatBytes(group.bytes)} on disk`;
  const caveats: string[] = [];
  if (group.count !== null && group.count > 0 && partial)
    caveats.push(
      `${group.unmeasured} of ${group.count} not fully measured${group.measuring ? ", measuring" : ""}`,
    );
  else if (group.measuring) caveats.push("Measuring in the background");
  if (group.sharedBytes !== null && group.sharedBytes > 0)
    caveats.push(
      `up to ${formatBytes(group.sharedBytes)} is hard-linked and may also be counted by another entry`,
    );
  if (group.ramBytes !== null && group.ramBytes > 0)
    caveats.push(`${formatBytes(group.ramBytes)} in RAM, not counted as disk`);
  if (group.storedElsewhere > 0)
    caveats.push(`${group.storedElsewhere} stored on other computers, not counted here`);
  if (group.count === 0) caveats.push("Nothing found");
  return { count, bytes, caveats };
}

const STATE_WORD: Record<GroupCoverage["state"], string> = {
  complete: "complete",
  partial: "partly reported",
  unsupported: "not supported",
  unavailable: "unavailable",
  offline: "offline",
  loading: "loading",
  error: "could not be read",
};

/** Whether every computer answered for this group, and one sentence for each that did not. */
export function describeCoverage(coverage: ReadonlyArray<GroupCoverage>): {
  readonly overall: "complete" | "partial" | "unsupported" | "unavailable";
  readonly notes: readonly string[];
} {
  const settled = coverage.filter((entry) => entry.state !== "loading");
  const overall = settled.every((entry) => entry.state === "complete")
    ? "complete"
    : settled.every((entry) => entry.state === "unsupported")
      ? "unsupported"
      : settled.every((entry) =>
            ["unsupported", "unavailable", "error", "offline"].includes(entry.state),
          ) && settled.every((entry) => entry.lastKnownAt === null)
        ? "unavailable"
        : "partial";
  const notes = settled
    .filter((entry) => entry.state !== "complete")
    .map(
      (entry) =>
        `${entry.name}: ${STATE_WORD[entry.state]}${entry.reason ? `. ${entry.reason}` : ""}${
          entry.lastKnownAt ? " Showing what was last known." : ""
        }`,
    );
  return { overall, notes };
}
