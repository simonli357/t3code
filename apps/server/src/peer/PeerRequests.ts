import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** How long one request to a linked environment may take unless its caller allows more. */
const PEER_REQUEST_TIMEOUT = Duration.seconds(30);

/** The peer could not be reached or did not answer; queued work is retried. */
export class PeerUnavailable extends Schema.TaggedError<PeerUnavailable>()("PeerUnavailable", {
  environmentId: Schema.String,
  message: Schema.String,
}) {}

/** The peer answered and refused; sending the same request again will not help. */
export class PeerRejected extends Schema.TaggedError<PeerRejected>()("PeerRejected", {
  message: Schema.String,
}) {}

/** A handler refuses with this, so the sender sees a final answer instead of a retryable outage. */
const peerRefusal = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export type PeerRequestHandler = (
  from: EnvironmentId,
  body: unknown,
) => Effect.Effect<unknown, OrchestratorMcpFailure>;

const FULL_LIMITS = {
  runtimeMode: "full-access" satisfies RuntimeMode,
  interactionMode: "default" satisfies ProviderInteractionMode,
} as const;

const Answer = Schema.Struct({ result: Schema.Unknown });

/**
 * Server-to-server requests over the native peer link. The receiving side's
 * `t3_peer_request` tool hands each request to the handler registered for its
 * topic; services register theirs when they start, so no service depends on
 * the tool and the tool on no service.
 */
export class PeerRequests extends Context.Service<
  PeerRequests,
  {
    readonly register: (topic: string, handler: PeerRequestHandler) => Effect.Effect<void>;
    /** The linked caller's request, run by its topic's handler. */
    readonly handle: (
      from: EnvironmentId,
      topic: string,
      body: unknown,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
    /** Sends a request to a linked environment and returns its answer. */
    readonly call: (
      environmentId: EnvironmentId,
      topic: string,
      body: unknown,
      timeout?: Duration.Duration,
    ) => Effect.Effect<unknown, PeerUnavailable | PeerRejected>;
  }
>()("t3/peer/PeerRequests") {}

const make = Effect.gen(function* () {
  const client = yield* PeerMcpClient.PeerMcpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const handlers = yield* Ref.make<ReadonlyMap<string, PeerRequestHandler>>(new Map());

  return PeerRequests.of({
    register: Effect.fn("PeerRequests.register")(function* (topic, handler) {
      yield* Ref.update(handlers, (current) => new Map(current).set(topic, handler));
    }),
    handle: Effect.fn("PeerRequests.handle")(function* (from, topic, body) {
      const handler = (yield* Ref.get(handlers)).get(topic);
      if (handler === undefined)
        return yield* peerRefusal(`This environment does not handle ${topic} requests.`);
      return yield* handler(from, body);
    }),
    call: Effect.fn("PeerRequests.call")(function* (
      environmentId,
      topic,
      body,
      timeout = PEER_REQUEST_TIMEOUT,
    ) {
      const from = yield* environment.getEnvironmentId;
      const answer = yield* client
        .call({
          environmentId,
          tool: "t3_peer_request",
          arguments: { from, topic, body },
          limits: FULL_LIMITS,
          success: Answer,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "The linked environment did not answer in time.",
                }),
              ),
          }),
          // Only a failure to get an answer is retryable; the peer's own refusals are final.
          Effect.mapError((failure) =>
            failure.code === "orchestration_error"
              ? new PeerUnavailable({ environmentId, message: failure.message })
              : new PeerRejected({ message: failure.message }),
          ),
        );
      return answer.result;
    }),
  });
});

export const layer = Layer.effect(PeerRequests, make);
