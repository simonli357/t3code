import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import * as Measurements from "../../../usage/UsageMeasurements.ts";
import { UsageToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_measurements: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const service = yield* Measurements.UsageMeasurements;
      return yield* service.read(input);
    }),
  ),
});
