import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as LinkedSessions from "../peer/LinkedSessions.ts";
import * as SessionMoves from "../moves/SessionMoves.ts";
import * as UsageMeasurements from "../usage/UsageMeasurements.ts";
import * as SessionMessages from "./SessionMessages.ts";
import * as AgentReads from "./agentReadsHttp.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.agentReads) {}

it.effect(
  "native workflow routes require read/operate scopes and decode only the fixed operations",
  () =>
    Effect.gen(function* () {
      let scopes: ReadonlySet<AuthEnvironmentScope> = new Set();
      const calls: string[] = [];
      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(AgentReads.layer),
        Layer.provide(Layer.mock(SessionMoves.SessionMoves)({})),
        Layer.provide(Layer.mock(SessionMessages.SessionMessages)({})),
        Layer.provide(Layer.mock(UsageMeasurements.UsageMeasurements)({})),
        Layer.provide(
          Layer.succeed(LinkedSessions.LinkedSessions, {
            query: (input) =>
              Effect.sync(() => {
                calls.push(`read:${input.environmentId}`);
                return { environmentId: input.environmentId, threads: [], nextCursor: null };
              }),
            command: (input) =>
              Effect.sync(() => {
                calls.push(`write:${input.environmentId}`);
                return { sequence: 1 };
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
            Effect.suspend(() =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                }),
              ),
            ),
          ),
        ),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const request = (route: "query" | "command", body: object) =>
        Effect.promise(() =>
          handler(
            new Request(`http://test/api/orchestration/linked-sessions/${route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        );
      const read = { environmentId: EnvironmentId.make("remote"), operation: "list", limit: 1 };
      const write = {
        environmentId: "remote",
        operation: "organize",
        threadId: "t",
        action: "settle",
      };
      expect((yield* request("query", read)).status).toBe(403);
      scopes = new Set(["orchestration:read"]);
      expect((yield* request("query", read)).status).toBe(200);
      expect((yield* request("command", write)).status).toBe(403);
      scopes = new Set(["orchestration:read", "orchestration:operate"]);
      expect((yield* request("command", write)).status).toBe(200);
      for (const body of [
        { ...read, operation: "proxy", tool: "anything", url: "http://elsewhere" },
        { ...read, limit: 101 },
        { ...read, limit: -1 },
      ])
        expect((yield* request("query", body)).status).toBe(400);
      expect((yield* request("command", { ...write, action: "delete" })).status).toBe(400);
      expect(calls).toEqual(["read:remote", "write:remote"]);
    }),
);
