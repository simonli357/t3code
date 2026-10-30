import { ServerSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const communicationWindowLabel = "Worker communication window (minutes)";
export const communicationWindowExplanation =
  "Only an explicit report that the entire assignment is done can reach the master during this window. Questions and blockers must wait. Each new assignment restarts the window; queued startup does not consume it. The worker's execution computer controls this setting. Changes apply immediately to running workers. Default: 15 minutes. Zero disables.";

const decodeMinutes = Schema.decodeUnknownOption(
  ServerSettings.fields.workerCommunicationWindowMinutes,
);

export function parseCommunicationWindowMinutes(text: string): number | undefined {
  if (!text.trim()) return undefined;
  return Option.getOrUndefined(decodeMinutes(Number(text)));
}
