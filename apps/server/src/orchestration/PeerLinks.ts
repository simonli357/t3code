import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

/** Another T3 environment this server may exchange worker traffic with. */
export const PeerEnvironment = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** Base URL of the peer's server, for example its Tailscale Serve origin. */
  url: TrimmedNonEmptyString,
  /** Bearer token issued by the peer (`t3 auth session issue`). */
  token: TrimmedNonEmptyString,
});
export type PeerEnvironment = typeof PeerEnvironment.Type;
const decodePeers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ peers: Schema.Array(PeerEnvironment) })),
);
const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
/** Secret holding `{ "peers": PeerEnvironment[] }`, written by `t3w peer link`. */
export const PEER_SECRET = "peer-environments";
export const PEER_ROUTE = "/api/peer/v1";
/** How long one call to a linked computer may take unless its caller allows more. */
export const PEER_CALL_TIMEOUT_MS = 15_000;

/** The peer could not be reached or did not answer; queued work is retried. */
export class PeerUnavailable extends Schema.TaggedError<PeerUnavailable>()("PeerUnavailable", {
  environmentId: Schema.String,
  message: Schema.String,
}) {}
/** The peer answered and refused the request; retrying the same request will not help. */
export class PeerRejected extends Schema.TaggedError<PeerRejected>()("PeerRejected", {
  message: Schema.String,
}) {}

export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    readonly list: Effect.Effect<ReadonlyArray<Pick<PeerEnvironment, "environmentId" | "label">>>;
    readonly localEnvironment: Effect.Effect<{
      readonly environmentId: string;
      readonly label: string;
    }>;
    /** Finds a configured peer by label (case-insensitive) or environment ID. */
    readonly resolve: (nameOrId: string) => Effect.Effect<Option.Option<PeerEnvironment>>;
    readonly call: (
      environmentId: string,
      request: unknown,
      timeoutMs?: number,
    ) => Effect.Effect<unknown, PeerUnavailable | PeerRejected>;
  }
>()("t3/orchestration/PeerLinks") {}

export const findPeer = (peers: ReadonlyArray<PeerEnvironment>, nameOrId: string) =>
  Option.fromNullishOr(
    peers.find(
      (peer) =>
        peer.environmentId === nameOrId || peer.label.toLowerCase() === nameOrId.toLowerCase(),
    ),
  );

export const layer = Layer.effect(
  PeerLinks,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const client = yield* HttpClient.HttpClient;
    const environment = yield* ServerEnvironment;
    // Read on every use so `t3w peer link` takes effect without a restart.
    const peers = secrets.get(PEER_SECRET).pipe(
      Effect.map((bytes) =>
        Option.isSome(bytes)
          ? Option.match(decodePeers(new TextDecoder().decode(bytes.value)), {
              onNone: () => [],
              onSome: (file) => file.peers,
            })
          : [],
      ),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<PeerEnvironment>)),
    );
    const localEnvironment = environment.getDescriptor.pipe(
      Effect.map((descriptor) => ({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
      })),
    );
    return PeerLinks.of({
      list: peers.pipe(
        Effect.map((entries) =>
          entries.map(({ environmentId, label }) => ({ environmentId, label })),
        ),
      ),
      localEnvironment,
      resolve: (nameOrId) => peers.pipe(Effect.map((list) => findPeer(list, nameOrId))),
      call: Effect.fn("PeerLinks.call")(function* (
        environmentId,
        request,
        timeoutMs = PEER_CALL_TIMEOUT_MS,
      ) {
        const peer = findPeer(yield* peers, environmentId);
        if (Option.isNone(peer))
          return yield* new PeerRejected({
            message: `Environment ${environmentId} is not a configured peer.`,
          });
        const { label, url, token } = peer.value;
        const from = (yield* localEnvironment).environmentId;
        const unavailable = (detail: string) =>
          new PeerUnavailable({ environmentId, message: `${label}: ${detail}` });
        const response = yield* client
          .execute(
            HttpClientRequest.post(new URL(PEER_ROUTE, url).toString()).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
              HttpClientRequest.bodyJsonUnsafe({ from, request }),
            ),
          )
          .pipe(
            Effect.flatMap((res) =>
              res.json.pipe(Effect.map((body) => ({ status: res.status, body }))),
            ),
            Effect.timeout(timeoutMs),
            Effect.mapError((cause) =>
              unavailable(
                `unreachable (${cause instanceof Error ? cause.message : String(cause)})`,
              ),
            ),
          );
        if (response.status === 200) return response.body;
        const detail = decodeMessage(response.body).pipe(
          Option.map((body) => body.message),
          Option.getOrElse(() => `HTTP ${response.status}`),
        );
        // 409 is a deliberate refusal; anything else (auth, 5xx) may recover later.
        return yield* response.status === 409
          ? new PeerRejected({ message: `${label}: ${detail}` })
          : unavailable(detail);
      }),
    });
  }),
);
