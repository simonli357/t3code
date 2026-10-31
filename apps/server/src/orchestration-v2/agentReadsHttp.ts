import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as UsageMeasurements from "../usage/UsageMeasurements.ts";
import * as SessionMessages from "./SessionMessages.ts";

/** The two reads agents make over HTTP: another session's recent messages, and retained usage. */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "agentReads",
  Effect.fnUntraced(function* (handlers) {
    const sessionMessages = yield* SessionMessages.SessionMessages;
    const usageMeasurements = yield* UsageMeasurements.UsageMeasurements;
    return handlers
      .handle(
        "sessionHistory",
        Effect.fn("environment.agentReads.sessionHistory")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* sessionMessages.readRecent(args.params.threadId, args.query);
        }),
      )
      .handle(
        "usageMeasurements",
        Effect.fn("environment.agentReads.usageMeasurements")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* usageMeasurements.read(args.query);
        }),
      );
  }),
);
