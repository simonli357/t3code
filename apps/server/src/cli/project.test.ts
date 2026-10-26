import { assert, it } from "@effect/vitest";

import { AuthSessionId, EnvironmentInternalError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientError } from "effect/unstable/http";

import {
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerRequestError,
  ProjectLiveServerBusyError,
  projectCommandErrorFromLiveServerRequest,
  tryResolveLiveProjectExecutionMode,
} from "./project.ts";

it("maps declared server failures into structural project command errors", () => {
  const cause = new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_snapshot_failed",
    traceId: "trace-123",
  });

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerDeclaredResponseError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.code, "internal_error");
  assert.strictEqual(error.traceId, "trace-123");
  assert.strictEqual(error.message, "Server request failed (internal_error, trace trace-123).");
  assert.strictEqual(error.cause, cause);
});

it.effect(
  "a failed snapshot probe preserves the live server state and refuses offline mode",
  () => {
    let removed = false;
    let revoked = false;
    const state = JSON.stringify({
      version: 1,
      pid: process.pid,
      port: 3773,
      origin: "http://localhost:3773",
      startedAt: "2026-10-26T00:00:00Z",
    });
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const result = yield* Effect.result(
        tryResolveLiveProjectExecutionMode(
          {
            issueSession: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test-session"),
                token: "test-token",
                method: "bearer-access-token",
                scopes: [],
                subject: "test",
                client: { deviceType: "bot" },
                expiresAt: now,
              }),
            revokeSession: () =>
              Effect.sync(() => {
                revoked = true;
                return true;
              }),
          },
          { serverRuntimeStatePath: "/test/server-runtime.json" },
        ),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProjectLiveServerBusyError);
        assert.include(result.failure.message, "Retry");
      }
      assert.isFalse(removed);
      assert.isTrue(revoked);
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed(state),
          remove: () =>
            Effect.sync(() => {
              removed = true;
            }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: "server stalled" }),
            }),
          ),
        ),
      ),
    );
  },
);

it("preserves unexpected server failures without deriving the message from them", () => {
  const cause = new Error("credential abc123 was rejected");

  const error = projectCommandErrorFromLiveServerRequest(cause);

  assert.instanceOf(error, ProjectLiveServerRequestError);
  assert.strictEqual(error.operation, "callLiveServer");
  assert.strictEqual(error.message, "Failed to call the running server.");
  assert.strictEqual(error.cause, cause);
});
