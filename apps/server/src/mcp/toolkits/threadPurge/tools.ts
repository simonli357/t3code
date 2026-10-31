import {
  OrchestratorMcpFailure,
  SettledThreadPurgeError,
  SettledThreadPurgeInput,
  SettledThreadPurgeReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Purge from "../../../orchestration-v2/SettledThreadPurge.ts";

const purgeSettled = Tool.make("t3_purge_settled_threads", {
  description:
    "Permanently purge T3 threads settled for more than settledForDays days: their rows (except one thread.deleted tombstone each), native Claude/Codex/DeepSeek Harness/Pi transcript files and checkpoint refs. dryRun defaults to true and lists what would go and what stays, with a reason for each thread kept; pass dryRun=false only when the user explicitly asked to purge. Worktrees stay on disk. Irreversible.",
  parameters: SettledThreadPurgeInput,
  success: SettledThreadPurgeReport,
  failure: Schema.Union([SettledThreadPurgeError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Purge.SettledThreadPurge,
  ],
}).annotate(Tool.Destructive, true);

export const ThreadPurgeToolkit = Toolkit.make(purgeSettled);
