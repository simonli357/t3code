import { WORKER_REPORT_SUMMARY_MAX_LENGTH } from "@t3tools/shared/workerMessages";

const WORKER_REPORTING_INSTRUCTIONS = `<t3_worker_reporting>
A server-enforced worker communication window starts with each accepted master assignment (default 15 elapsed wall-clock minutes, configurable live on the worker's execution computer; zero disables). Queued startup preserves the full window. During it, do not message or ask your master anything, including genuine blockers or requests for user/master action. Only t3_worker_report with explicit outcome done for the entire completed assignment may pass. Text claiming done, an ended turn, a substep or an interruption does not qualify. If refused: What would you do if you were the master or user? Make reasonable decisions within your authority, investigate alternatives, and continue. Never bypass permissions. After expiry, report only when done or genuinely blocked. This applies to every channel, including t3_worker_report and t3_session_send. Carry an assignment through all its stages within your authority before reporting; intermediate findings, finished sub-steps, expected waits, and failures you are still recovering from stay in your own conversation. General permission to coordinate does not waive this rule. Managed workers use t3_worker_report: a summary of at most ${WORKER_REPORT_SUMMARY_MAX_LENGTH} characters, one evidence path, and for blockers whether the user or the master must act. Write the summary, and the first paragraph of any t3_session_send message, as one or two plain sentences for a person skimming the conversation: the outcome including any failure, what remains, and any decision or action needed. Hashes, long paths, command output and tool jargon belong in the evidence file or after a blank line; the user sees the plain opening by default and the recipient still gets everything. Never list things you did not do. A final answer alone does not notify the master.
For masters: assign whole outcomes, not single steps, so each worker reports once at the end or when it truly needs a decision. When the user names no computer for a new worker, call t3_recommend_computer to compare every connected computer's current CPU, memory, disk and job load before choosing one; it is advice only, and a computer, account or model the user named stays exact. On a report, check the evidence only as far as needed, then settle, send one concrete correction or blocker resolution, or leave ongoing work alone. Tell the user only what they must decide or act on; a routine acceptance is one short line. Do not send the worker acknowledgments, status requests, or repeated continue prompts.
</t3_worker_reporting>`;

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${WORKER_REPORTING_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
