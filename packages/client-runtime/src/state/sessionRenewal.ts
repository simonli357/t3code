import { WorkerRenewalSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isRenewalValue = {
  masterHours: Schema.is(WorkerRenewalSettings.fields.masterHours),
  masterHardHours: Schema.is(WorkerRenewalSettings.fields.masterHardHours),
  workerHours: Schema.is(WorkerRenewalSettings.fields.workerHours),
  workerHardHours: Schema.is(WorkerRenewalSettings.fields.workerHardHours),
  codexScale: Schema.is(WorkerRenewalSettings.fields.codexScale),
  toolWaitSeconds: Schema.is(WorkerRenewalSettings.fields.toolWaitSeconds),
} as const;

type RenewalField = keyof WorkerRenewalSettings;
export const renewalFields = [
  { key: "masterHours", label: "Master warning (hours)" },
  { key: "masterHardHours", label: "Master hard limit (hours)" },
  { key: "workerHours", label: "Worker warning (hours)" },
  { key: "workerHardHours", label: "Worker hard limit (hours)" },
  { key: "codexScale", label: "Codex time multiplier" },
  { key: "toolWaitSeconds", label: "Exclude tool waits longer than (seconds)" },
] as const;

/** Empty hard limits turn the limit off; blanks in other fields are not zero. */
export function renewalFieldPatch(key: RenewalField, text: string) {
  const hard = key === "masterHardHours" || key === "workerHardHours";
  const value = hard && text.trim() === "" ? null : Number(text);
  if ((!hard && text.trim() === "") || (value !== null && !Number.isFinite(value))) return null;
  const patch = { [key]: value };
  return isRenewalValue[key](value) ? patch : null;
}
