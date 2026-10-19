import { UsageMeasurementsInput, UsageMeasurementsReport } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Measurements from "../../../usage/UsageMeasurements.ts";

const read = Tool.make("t3_usage_measurements", {
  description:
    "Read retained account quota consumption rates and per-turn context size, tokens/cache, session age, elapsed/tool/API timing, and model/effort/context-band token-rate baselines. Filter by instanceId/threadId, lookbackHours (1–336), turnLimit (1–100). Read-only: does not select accounts, refresh logins, redeem resets or send prompts. Quota rates include all account traffic; token baselines are not quota percentages. Inspect sample age, count, scope and limitations before predicting capacity. Unknown measurements are null, not zero. Use current provider capacity and worker load alongside this evidence.",
  parameters: UsageMeasurementsInput,
  success: UsageMeasurementsReport,
  dependencies: [Measurements.UsageMeasurements],
});
export const UsageToolkit = Toolkit.make(read);
export const handlers = UsageToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* Measurements.UsageMeasurements;
    return { t3_usage_measurements: (input) => service.read(input) };
  }),
);
