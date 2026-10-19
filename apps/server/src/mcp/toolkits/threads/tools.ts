import {
  SettledThreadPurgeError,
  SettledThreadPurgeInput,
  SettledThreadPurgeReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as Purge from "../../../orchestration/SettledThreadPurge.ts";

const purgeSettled = Tool.make("t3_purge_settled_threads", {
  description:
    "Permanently purge T3 threads settled for more than settledForDays days: their database rows (except one thread.deleted tombstone event each), native Claude/Codex transcript files, and checkpoint refs. dryRun defaults to true and only reports what would be removed; pass dryRun=false only when the user explicitly asked to purge. Threads that are pinned, live, part of an active worker job, or linked to a kept thread (worker owner, orchestrator handoff, proposed plan, shared provider session) are skipped with a reason. Worktrees stay on disk. Irreversible.",
  parameters: SettledThreadPurgeInput,
  success: SettledThreadPurgeReport,
  failure: SettledThreadPurgeError,
  dependencies: [Purge.SettledThreadPurge],
});
export const ThreadsToolkit = Toolkit.make(purgeSettled);
export const handlers = ThreadsToolkit.toLayer(
  Effect.gen(function* () {
    const service = yield* Purge.SettledThreadPurge;
    return { t3_purge_settled_threads: (input) => service.purge(input) };
  }),
);
