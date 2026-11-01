import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  SessionWorkflowListInput as ListInput,
  SessionWorkflowListResult as ListResult,
  SessionWorkflowHistoryInput as HistoryInput,
  SessionWorkflowHistoryResult as HistoryResult,
  SessionWorkflowCatalogResult as CatalogResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SessionMessages from "../orchestration-v2/SessionMessages.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/** Exact session metadata and bounded history for workflow clients, using the V2 read services. */
export class SessionWorkflowService extends Context.Service<
  SessionWorkflowService,
  {
    readonly list: (
      input: typeof ListInput.Type,
    ) => Effect.Effect<typeof ListResult.Type, OrchestratorMcpFailure>;
    readonly history: (
      input: typeof HistoryInput.Type,
    ) => Effect.Effect<typeof HistoryResult.Type, OrchestratorMcpFailure>;
    readonly catalog: Effect.Effect<typeof CatalogResult.Type>;
  }
>()("t3/mcp/SessionWorkflowService") {}

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
export const layer = Layer.effect(
  SessionWorkflowService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const messages = yield* SessionMessages.SessionMessages;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    return SessionWorkflowService.of({
      list: Effect.fn("SessionWorkflowService.list")(function* (input) {
        // Exact ids include archives and older settled work. Never guess a prefix or another environment.
        const entries =
          input.threadId === undefined
            ? yield* threads.getShellSnapshot({ location: input.location ?? "active" }).pipe(
                Effect.mapError(failure),
                Effect.map((snapshot) =>
                  input.location === "archive" ? snapshot.archivedThreads : snapshot.threads,
                ),
              )
            : [yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(failure))];
        const visible = entries
          .filter(
            (entry): entry is OrchestrationV2ThreadShell =>
              entry !== null && entry.deletedAt === null,
          )
          .filter((entry) => input.projectId === undefined || entry.projectId === input.projectId)
          .filter(
            (entry) =>
              input.titleContains === undefined ||
              entry.title.toLowerCase().includes(input.titleContains.toLowerCase()),
          )
          .toSorted((a, b) => a.id.localeCompare(b.id));
        const cursor = input.cursor ?? 0;
        const end = cursor + (input.limit ?? 100);
        return {
          environmentId: yield* environment.getEnvironmentId,
          threads: visible.slice(cursor, end),
          nextCursor: end < visible.length ? end : null,
        };
      }),
      history: Effect.fn("SessionWorkflowService.history")(function* ({ threadId, ...input }) {
        return {
          environmentId: yield* environment.getEnvironmentId,
          history: yield* messages.readRecent(threadId, input).pipe(Effect.mapError(failure)),
        };
      }),
      catalog: Effect.all({
        environment: environment.getDescriptor,
        providers: providers.getProviders,
      }),
    });
  }),
);
