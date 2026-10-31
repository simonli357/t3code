import { UsageMeasurementsInput, UsageMeasurementsReport } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Measurements from "../../../usage/UsageMeasurements.ts";

const read = Tool.make("t3_usage_measurements", {
  description:
    "Read retained account quota consumption rates and per-turn context size, tokens/cache, session age, elapsed/tool timing, and model/effort/context-band token-rate baselines. Filter by instanceId/threadId, lookbackHours (1–336), turnLimit (1–100). Read-only: does not select accounts, refresh logins, redeem resets or send prompts. Quota rates include all account traffic; token baselines are not quota percentages. Inspect sample age, count, scope and limitations before predicting capacity. Unknown measurements are null, not zero. Use current provider capacity and worker load alongside this evidence.",
  parameters: UsageMeasurementsInput,
  success: UsageMeasurementsReport,
  dependencies: [Measurements.UsageMeasurements],
})
  .annotate(Tool.Title, "Read usage measurements")
  .annotate(Tool.Readonly, true);

export const UsageToolkit = Toolkit.make(read);
