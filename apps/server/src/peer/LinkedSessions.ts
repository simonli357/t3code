import {
  LinkedSessionQuery,
  LinkedSessionQueryResult,
  LinkedSessionCommand,
  LinkedSessionCommandResult,
  LinkedSessionError,
  SessionWorkflowListResult,
  SessionWorkflowHistoryResult,
  SessionWorkflowCatalogResult,
  SessionWorkflowProjectsResult,
  SessionMoveResult,
  OrchestrationV2DispatchCommandResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** Native authenticated clients reach only these typed operations; the peer still checks its MCP link's scopes and fence. */
export class LinkedSessions extends Context.Service<
  LinkedSessions,
  {
    readonly query: (
      input: LinkedSessionQuery,
    ) => Effect.Effect<typeof LinkedSessionQueryResult.Type, LinkedSessionError>;
    readonly command: (
      input: LinkedSessionCommand,
    ) => Effect.Effect<typeof LinkedSessionCommandResult.Type, LinkedSessionError>;
  }
>()("t3/peer/LinkedSessions") {}

export const layer = Layer.effect(
  LinkedSessions,
  Effect.gen(function* () {
    const peers = yield* PeerMcpClient.PeerMcpClient;
    const links = yield* PeerLinks.PeerLinks;
    const enabled = links.enabled.pipe(
      Effect.flatMap((value) =>
        value
          ? Effect.void
          : Effect.fail(
              new LinkedSessionError({ message: "Linked environments is off on this machine." }),
            ),
      ),
    );
    const failure = (error: { message: string }) =>
      new LinkedSessionError({ message: error.message });
    // Native UI/CLI scope checks are at the transport. These limits cannot widen the destination link's access.
    const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;
    return LinkedSessions.of({
      query: Effect.fn("LinkedSessions.query")(function* ({ environmentId, operation, ...args }) {
        yield* enabled;
        const common = { environmentId, arguments: args, limits };
        switch (operation) {
          case "list":
            return yield* peers
              .call({ ...common, tool: "t3_session_list", success: SessionWorkflowListResult })
              .pipe(Effect.mapError(failure));
          case "history":
            return yield* peers
              .call({
                ...common,
                tool: "t3_session_history",
                success: SessionWorkflowHistoryResult,
              })
              .pipe(Effect.mapError(failure));
          case "catalog":
            return yield* peers
              .call({
                ...common,
                tool: "t3_provider_catalog",
                success: SessionWorkflowCatalogResult,
              })
              .pipe(Effect.mapError(failure));
          case "projects":
            return yield* peers
              .call({ ...common, tool: "t3_project_list", success: SessionWorkflowProjectsResult })
              .pipe(Effect.mapError(failure));
        }
      }),
      command: Effect.fn("LinkedSessions.command")(function* ({
        environmentId,
        operation,
        ...args
      }) {
        yield* enabled;
        const common = { environmentId, arguments: args, limits };
        switch (operation) {
          case "organize":
            return yield* peers
              .call({
                ...common,
                tool: "t3_thread_organize",
                success: OrchestrationV2DispatchCommandResult,
              })
              .pipe(Effect.mapError(failure));
          case "move":
            return yield* peers
              .call({ ...common, tool: "t3_session_move", success: SessionMoveResult })
              .pipe(Effect.mapError(failure));
          case "moveStatus":
            return yield* peers
              .call({ ...common, tool: "t3_session_move_status", success: SessionMoveResult })
              .pipe(Effect.mapError(failure));
        }
      }),
    });
  }),
);
