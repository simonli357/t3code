import * as Effect from "effect/Effect";

import * as WorkerService from "../../../workers/WorkerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkersToolkit } from "./tools.ts";

/** The thread making the call: a master for most tools, the worker itself for `t3_worker_report`. */
const caller = (tool: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, tool)),
    Effect.map((scope) => scope.thread.threadId),
  );

export const layer = McpToolAccess.toLayer(WorkersToolkit, {
  t3_worker_spawn: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.spawn(yield* caller("t3_worker_spawn"), input);
    }),
  ),
  t3_worker_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.list(yield* caller("t3_worker_list"));
    }),
  ),
  t3_worker_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.read(yield* caller("t3_worker_read"), input);
    }),
  ),
  t3_worker_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.send(yield* caller("t3_worker_send"), input);
    }),
  ),
  t3_worker_wait: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.wait(yield* caller("t3_worker_wait"), input);
    }),
  ),
  t3_worker_control: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.control(yield* caller("t3_worker_control"), input);
    }),
  ),
  t3_worker_report: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.report(yield* caller("t3_worker_report"), input);
    }),
  ),
  t3_session_ownership_read: McpToolAccess.reads(({ threadId }) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.readOwnership(threadId);
    }),
  ),
  t3_session_ownership: McpToolAccess.actsAsCaller(({ userRequest, ...input }) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      const threadId = yield* caller("t3_session_ownership");
      return yield* workers.changeOwnership(input, { threadId, userRequest });
    }),
  ),
  t3_orchestrator_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.handoff(yield* caller("t3_orchestrator_handoff"), input);
    }),
  ),
  t3_orchestrator_handoff_status: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.handoffStatus(yield* caller("t3_orchestrator_handoff_status"), input);
    }),
  ),
  t3_worker_reclaim: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workers = yield* WorkerService.WorkerService;
      return yield* workers.reclaim(yield* caller("t3_worker_reclaim"), input);
    }),
  ),
});
