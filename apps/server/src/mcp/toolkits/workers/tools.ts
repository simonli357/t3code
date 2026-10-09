import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Workers from "../../../orchestration/WorkerControls.ts";
import * as Invocation from "../../McpInvocationContext.ts";

const dependencies = [Workers.WorkerControls, Invocation.McpInvocationContext];
const failure = Schema.Union([Workers.WorkerError]);
const spawn = Tool.make("t3_worker_spawn", {
  description:
    "Fork a prepared base into a persistent worker owned by THIS master. Use the project's worker skill to resolve the base, title, explicit provider/model, and fixed reasoning options first. Pass a stable destination UUID across retries. The base keeps its native history unchanged. The worker keeps its selected account/model/options on follow-ups. Acceptance means queued, not task completed. Each finished assignment automatically reports to this master when idle; do other work or end your turn instead of polling.",
  parameters: Workers.SpawnInput,
  success: Workers.WorkerResult,
  failure,
  dependencies,
});
const list = Tool.make("t3_worker_list", {
  description:
    "List workers owned by this master, including their base, fixed selection, notification setting, and latest assignment. Ownership survives restarts and context compaction.",
  success: Schema.Array(Workers.WorkerResult),
  failure,
  dependencies,
});
const read = Tool.make("t3_worker_read", {
  description:
    "Read new worker replies after inherited base history. The saved cursor survives master compaction and server restarts. Set includeProgress=true for streaming and tool activity. Continue with nextSequence as afterSequence and nextTextOffset as textOffset until hasMore=false. Omit the cursor to continue from the last read, or provide an explicit cursor to reread. Reading does not accept the task or stop completion notifications.",
  parameters: Workers.ReadInput,
  success: Workers.ReadResult,
  failure,
  dependencies,
});
const send = Tool.make("t3_worker_send", {
  description:
    "Send an assignment or correction to the SAME worker conversation, retaining its provider/model/options. Rejects changed settings immediately; queues durably if busy and settings still match. Use a new clientRequestId per assignment, stable across retries with identical prompt. Each assignment gets its own completion notification. Does not interrupt or steer active work.",
  parameters: Workers.SendInput,
  success: Workers.JobResult,
  failure,
  dependencies,
});
const wait = Tool.make("t3_worker_wait", {
  description:
    "Wait for a specific worker assignment (requestId from spawn/latestRequest or send) to finish, fail, or be cancelled. Bounded to 55 seconds; timeout does not stop the worker. Prefer automatic reports for long work. Inspect error/state and read the output before judging acceptance.",
  parameters: Workers.WaitInput,
  success: Workers.WaitResult,
  failure,
  dependencies,
});
const control = Tool.make("t3_worker_control", {
  description:
    "Control an owned worker: set modelSelection {instanceId, model, options} to explicitly change its account/provider/model and saved profile, or use adoptCurrentSettings=true to accept an intentional UI change (not both). Validate the choice against available profiles and the user's constraints. Switching preserves the T3 thread and permission modes; a running turn continues, and queued/future assignments use the new selection. Cross-provider switches use T3's conversation handoff. Ownership, profile validity, and permission checks still apply. Failed work is never retried automatically. Also supports notifications and cancelRequestId; stop running work with T3's stop control.",
  parameters: Workers.ControlInput,
  success: Workers.WorkerResult,
  failure,
  dependencies,
});
export const WorkersToolkit = Toolkit.make(spawn, list, read, send, wait, control);
export const handlers = WorkersToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* Workers.WorkerControls;
    const owner = Effect.map(Invocation.McpInvocationContext, (scope) => scope.threadId);
    return {
      t3_worker_spawn: (input) => owner.pipe(Effect.flatMap((id) => service.spawn(id, input))),
      t3_worker_list: () => owner.pipe(Effect.flatMap((id) => service.list(id))),
      t3_worker_read: (input) => owner.pipe(Effect.flatMap((id) => service.read(id, input))),
      t3_worker_send: (input) => owner.pipe(Effect.flatMap((id) => service.send(id, input))),
      t3_worker_wait: (input) => owner.pipe(Effect.flatMap((id) => service.wait(id, input))),
      t3_worker_control: (input) => owner.pipe(Effect.flatMap((id) => service.control(id, input))),
    };
  }),
);
