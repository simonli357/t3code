import { WorkerRenewalSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type RenewalField = keyof WorkerRenewalSettings;
export const renewalFields = [
  { key: "masterHours", label: "Master warning (hours)" },
  { key: "masterHardHours", label: "Master automatic renewal (hours)" },
  { key: "workerHours", label: "Worker warning (hours)" },
  { key: "workerHardHours", label: "Worker automatic renewal (hours)" },
  { key: "codexScale", label: "Codex time multiplier" },
  { key: "toolWaitSeconds", label: "Exclude tool waits longer than (seconds)" },
] as const;

/** Empty hard limits disable automation; blanks in other fields are not zero. */
export function renewalFieldPatch(key: RenewalField, text: string) {
  const hard = key === "masterHardHours" || key === "workerHardHours";
  const value = hard && text.trim() === "" ? null : Number(text);
  if ((!hard && text.trim() === "") || (value !== null && !Number.isFinite(value))) return null;
  const patch = { [key]: value };
  return Schema.is(WorkerRenewalSettings.fields[key])(value) ? patch : null;
}
