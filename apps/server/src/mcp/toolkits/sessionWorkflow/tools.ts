import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SessionWorkflowListInput,
  SessionWorkflowListResult,
  SessionWorkflowHistoryInput,
  SessionWorkflowHistoryResult,
  SessionWorkflowCatalogResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionWorkflow from "../../SessionWorkflowService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    SessionWorkflow.SessionWorkflowService,
    ThreadManagement.ThreadManagementService,
  ],
};
export const SessionWorkflowToolkit = Toolkit.make(
  Tool.make("t3_session_list", {
    ...shared,
    description:
      "Page exact session shell metadata for workflow clients. Includes settled sessions; location selects active or archive. threadId reads one exact session across both. Pages can shift.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      ...SessionWorkflowListInput.fields,
    }),
    success: SessionWorkflowListResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_session_history", {
    ...shared,
    description:
      "Bounded recent prompts and final replies. beforeMessageId pages older messages; messageId and Unicode offset continue one message. view all includes intermediate replies. maxChars bounds the history JSON.",
    parameters: Schema.Struct({
      environmentId: OrchestratorMcpEnvironmentTarget,
      ...SessionWorkflowHistoryInput.fields,
    }),
    success: SessionWorkflowHistoryResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_provider_catalog", {
    ...shared,
    description:
      "Read this environment's complete published provider catalog and identity for exact workflow validation. Does not refresh providers or change configuration.",
    parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
    success: SessionWorkflowCatalogResult,
  }).annotate(Tool.Readonly, true),
);
