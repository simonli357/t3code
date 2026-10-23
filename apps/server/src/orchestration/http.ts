import * as ProviderAllocation from "../allocation/ProviderAllocation.ts";
import * as AllocationAssignments from "../allocation/AllocationAssignments.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  PeerRequestError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadHistory from "./ContextHandoff.ts";
import * as UsageMeasurements from "../usage/UsageMeasurements.ts";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { WorkerControls } from "./WorkerControls.ts";
import { SessionMoves } from "./SessionMoves.ts";
import { SettledThreadPurge } from "./SettledThreadPurge.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const measurements = yield* UsageMeasurements.UsageMeasurements;
    const workers = yield* WorkerControls;
    const allocation = yield* ProviderAllocation.ProviderAllocation;
    const allocationAssignments = yield* AllocationAssignments.AllocationAssignments;
    const moves = yield* SessionMoves;
    const settledThreadPurge = yield* SettledThreadPurge;
    const history = yield* ThreadHistory.ThreadHistory;

    return handlers
      .handle(
        "providerAllocationStart",
        Effect.fn("environment.providerAllocationStart")(function* (args) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* allocationAssignments.start(args.payload);
        }),
      )
      .handle(
        "providerAllocation",
        Effect.fn("environment.providerAllocation")(function* (args) {
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* allocation.execute(args.payload);
        }),
      )
      .handle(
        "moveSession",
        Effect.fn("environment.sessionMove")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* moves.request(args.payload);
        }),
      )
      .handle(
        "sessionMoveStatus",
        Effect.fn("environment.sessionMoveStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* moves.status(args.payload);
        }),
      )
      .handle(
        "sessionHistory",
        Effect.fn("environment.orchestration.sessionHistory")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* history.readRecent(args.params.threadId, args.payload);
        }),
      )
      .handle(
        "peer",
        Effect.fn("environment.peer")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const request = args.payload.request;
          if (
            request &&
            typeof request === "object" &&
            "_tag" in request &&
            typeof request._tag === "string" &&
            request._tag.startsWith("allocation")
          )
            return yield* allocation
              .receive(args.payload.from, request)
              .pipe(Effect.mapError((e) => new PeerRequestError({ message: e.message })));
          if (
            request &&
            typeof request === "object" &&
            "_tag" in request &&
            request._tag === "sessionMove"
          )
            return yield* moves
              .receive(args.payload.from, request)
              .pipe(Effect.mapError((error) => new PeerRequestError({ message: error.message })));
          return yield* workers
            .receive(args.payload.from, request)
            .pipe(Effect.mapError((error) => new PeerRequestError({ message: error.message })));
        }),
      )
      .handle(
        "purgeSettledThreads",
        Effect.fn("environment.orchestration.purgeSettledThreads")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* settledThreadPurge.purge(args.payload);
        }),
      )
      .handle(
        "usageMeasurements",
        Effect.fn("environment.usage.measurements")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* measurements.read(args.payload);
        }),
      )
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
).pipe(Layer.provide(ThreadHistory.layer));
