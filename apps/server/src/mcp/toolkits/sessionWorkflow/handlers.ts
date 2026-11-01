import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SessionWorkflow from "../../SessionWorkflowService.ts";
import { SessionWorkflowToolkit } from "./tools.ts";
import { readCaller } from "../../threadAccess.ts";

export const layer = McpToolAccess.toLayer(SessionWorkflowToolkit, {
  t3_session_list: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(SessionWorkflow.SessionWorkflowService),
      Effect.flatMap((service) => service.list(input)),
    ),
  ),
  t3_session_history: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(SessionWorkflow.SessionWorkflowService),
      Effect.flatMap((service) => service.history(input)),
    ),
  ),
  t3_provider_catalog: McpToolAccess.reads(() =>
    readCaller().pipe(
      Effect.andThen(SessionWorkflow.SessionWorkflowService),
      Effect.flatMap((service) => service.catalog),
    ),
  ),
});
