import { IdleCompactionSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const idleCompactionTitle = "Idle compaction";
export const idleCompactionEnabledLabel = "Compact idle Claude threads before the cache expires";
export const idleCompactionExplanation =
  "Compacts an idle Claude thread with a large context shortly before its prompt cache expires, so coming back re-reads a summary instead of the whole thread. The thread keeps less detail and shows a line when it happens. Busy, waiting, settled, snoozed or moving threads, workers that reported done, and drained accounts are skipped. Changes apply immediately.";
export const idleCompactionContextLabel = "Compact from this many context tokens";
export const idleCompactionLeadLabel = "Minutes before the cache expires";

const decodeContextTokens = Schema.decodeUnknownOption(IdleCompactionSettings.fields.contextTokens);
const decodeLeadMinutes = Schema.decodeUnknownOption(IdleCompactionSettings.fields.leadMinutes);

export function parseIdleCompactionContextTokens(text: string): number | undefined {
  if (!text.trim()) return undefined;
  return Option.getOrUndefined(decodeContextTokens(Number(text)));
}

export function parseIdleCompactionLeadMinutes(text: string): number | undefined {
  if (!text.trim()) return undefined;
  return Option.getOrUndefined(decodeLeadMinutes(Number(text)));
}
