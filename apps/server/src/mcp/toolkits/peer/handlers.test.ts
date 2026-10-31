import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as PeerRequests from "../../../peer/PeerRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PeerHandlers from "./handlers.ts";
import { PeerToolkit } from "./tools.ts";

const here = EnvironmentId.make("environment:here");
const there = EnvironmentId.make("environment:there");
const stranger = EnvironmentId.make("environment:stranger");

const world = (client: McpInvocationContext.McpClientCaller | undefined) =>
  McpToolAccess.HandlersLayer.layer(PeerHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: here,
          requestNamespace: "client:test",
          thread: undefined,
          client,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        PeerRequests.layer.pipe(
          Layer.provide(Layer.mock(PeerMcpClient.PeerMcpClient)({})),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(here),
            }),
          ),
        ),
        Layer.mock(PeerLinks.PeerLinks)({
          get: (id) =>
            Effect.succeed(
              id === there ? Option.some({} as PeerLinks.ResolvedPeerLink["link"]) : Option.none(),
            ),
        }),
      ),
    ),
  );

const send = (client: McpInvocationContext.McpClientCaller | undefined, from: EnvironmentId) =>
  Effect.gen(function* () {
    const requests = yield* PeerRequests.PeerRequests;
    yield* requests.register("echo", (sender, body) => Effect.succeed({ sender, body }));
    const toolkit = yield* PeerToolkit;
    const results = yield* toolkit
      .handle("t3_peer_request", { from, topic: "echo", body: { n: 1 } })
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  }).pipe(Effect.provide(world(client)));

const link = (access: McpInvocationContext.McpClientCaller["access"], linked = true) => ({
  sessionId: "link",
  label: "T3 Code · There",
  access,
  linked,
});

it.effect("runs a request from a full-access link to an environment that is linked back", () =>
  Effect.gen(function* () {
    expect(yield* send(link("full-access"), there)).toEqual({
      result: { sender: there, body: { n: 1 } },
    });
  }),
);

it.effect("refuses anything but a full-access link to a linked environment", () =>
  Effect.gen(function* () {
    for (const [client, from] of [
      [link("auto"), there],
      [link("full-access", false), there],
      [undefined, there],
      [link("full-access"), stranger],
    ] as const) {
      expect(yield* send(client, from)).toMatchObject({ code: "capability_denied" });
    }
  }),
);
