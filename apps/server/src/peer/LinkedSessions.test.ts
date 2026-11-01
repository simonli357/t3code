import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  ProjectId,
  type SessionMoveResult,
  type SessionMoveInput,
  type SessionMoveStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SessionMoves from "../moves/SessionMoves.ts";
import { SessionMovesToolkit } from "../mcp/toolkits/sessionMoves/tools.ts";
import * as SessionMoveHandlers from "../mcp/toolkits/sessionMoves/handlers.ts";
import { layerWorld, seed, master, setLatestRun } from "../workers/integration.testkit.ts";
import * as LinkedSessions from "./LinkedSessions.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";

const here = descriptorOf("workflow-here", "Here");
const there = descriptorOf("workflow-there", "There");

// Real SQLite projections, decider, typed MCP handlers, OAuth pairing and HTTP sockets.
// Provider turns are simulated by the existing event-sink fixture, never executed.
it.effect(
  "reads paired V2 sessions with paging, checks link scopes, and settles through the decider",
  () =>
    Effect.gen(function* () {
      const world = yield* Layer.build(layerWorld());
      const moveCalls: Array<SessionMoveInput | SessionMoveStatusInput> = [];
      const moveResult: SessionMoveResult = {
        requestId: CommandId.make("move-workflow"),
        threadId: master,
        targetThreadId: master,
        sourceEnvironmentId: there.environmentId,
        targetEnvironmentId: here.environmentId,
        projectId: ProjectId.make("destination"),
        state: "queued",
        error: null,
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      // The move service alone is a stand-in; native out/back/cancel/recovery has its own integration suite.
      const moveService = Layer.mock(SessionMoves.SessionMoves)({
        request: (input) =>
          Effect.sync(() => {
            moveCalls.push(input);
            return { ...moveResult, requestId: input.requestId };
          }),
        status: (input) =>
          Effect.sync(() => {
            moveCalls.push(input);
            return { ...moveResult, state: input.cancel ? "cancelled" : "queued" };
          }),
      });
      const expiredSession = yield* Ref.make(false);
      const expirations = yield* Ref.make(0);
      const expireOnce = HttpRouter.middleware(
        (effect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (
              request.url === "/mcp" &&
              request.headers["mcp-session-id"] !== undefined &&
              (yield* Ref.get(expiredSession))
            ) {
              yield* Ref.set(expiredSession, false);
              yield* Ref.update(expirations, (n) => n + 1);
              return HttpServerResponse.empty({ status: 404 });
            }
            return yield* effect;
          }),
        { global: true },
      );
      yield* seed().pipe(Effect.provideContext(world));
      for (let i = 0; i < 102; i++)
        yield* seed(ThreadId.make(`thread:paged-${String(i).padStart(3, "0")}`)).pipe(
          Effect.provideContext(world),
        );
      const tools = Layer.mergeAll(
        McpHttpServer.layerSessionWorkflowToolkit,
        McpHttpServer.layerThreadToolkit,
        McpHttpServer.toolkitRegistration(SessionMovesToolkit, SessionMoveHandlers.layer),
        expireOnce,
      ).pipe(
        Layer.provide(moveService),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(there.environmentId),
            getDescriptor: Effect.succeed(there),
          }),
        ),
        Layer.provide(Layer.succeedContext(world)),
      );
      const peer = yield* servePeer(there, tools);
      const local = yield* Layer.build(
        LinkedSessions.layer.pipe(Layer.provideMerge(layerLinkingEnvironment(here))),
      );
      const client = Context.get(local, LinkedSessions.LinkedSessions);
      const links = Context.get(local, PeerLinks.PeerLinks);
      const read = (operation: "list" | "catalog") =>
        client.query({ environmentId: there.environmentId, operation });
      const organize = (action: "settle" | "unsettle" | "archive" | "unarchive") =>
        client.command({
          environmentId: there.environmentId,
          operation: "organize",
          threadId: master,
          action,
        });
      yield* linkTo(links, peer, "read-only");
      const first = yield* read("list");
      expect(first).toMatchObject({ environmentId: there.environmentId, nextCursor: 100 });
      if (!("threads" in first)) return yield* Effect.die("expected threads");
      expect(first.threads).toHaveLength(100);
      yield* Ref.set(expiredSession, true);
      const second = yield* client.query({
        environmentId: there.environmentId,
        operation: "list",
        cursor: 100,
      });
      expect(second).toMatchObject({ nextCursor: null });
      expect(yield* Ref.get(expirations)).toBe(1);
      if (!("threads" in second)) return yield* Effect.die("expected threads");
      expect(new Set([...first.threads, ...second.threads].map((t) => t.id)).size).toBe(103);
      expect(
        yield* client.query({
          environmentId: there.environmentId,
          operation: "list",
          threadId: ThreadId.make("missing"),
        }),
      ).toMatchObject({ threads: [] });
      expect(
        yield* client.query({
          environmentId: there.environmentId,
          operation: "list",
          titleContains: "paged-100",
        }),
      ).toMatchObject({ threads: [{ id: "thread:paged-100" }] });
      const catalog = yield* read("catalog");
      expect(catalog).toMatchObject({
        environment: { environmentId: there.environmentId },
        providers: [{ instanceId: "codex" }, { instanceId: "claude" }],
      });
      expect((yield* organize("settle").pipe(Effect.flip)).message).toMatch(
        /read.only|cannot|denied/i,
      );

      const sql = Context.get(world, SqlClient.SqlClient);
      expect(
        (yield* client
          .command({
            environmentId: there.environmentId,
            operation: "moveStatus",
            requestId: moveResult.requestId,
          })
          .pipe(Effect.flip)).message,
      ).toMatch(/read.only/i);
      for (let i = 0; i < 18; i++) {
        const at = `2026-10-01T00:00:${String(i).padStart(2, "0")}.000Z`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${`m-${i}`}, ${master}, NULL, 'user', 0, ${at}, ${at}, ${JSON.stringify({ id: `m-${i}`, threadId: master, runId: null, nodeId: null, role: "user", text: i === 17 ? "🦉".repeat(2000) : `prompt ${i}`, attachments: [], streaming: false, createdAt: at, updatedAt: at, createdBy: "user", creationSource: "web" })})`;
      }
      const history = yield* client.query({
        environmentId: there.environmentId,
        operation: "history",
        threadId: master,
        messageLimit: 3,
        maxChars: 1024,
      });
      if (!("history" in history)) return yield* Effect.die("expected history");
      expect(JSON.stringify(history.history).length).toBeLessThanOrEqual(1024);
      expect(history.history.page.hasMore).toBe(true);
      const last = history.history.messages.at(-1)!;
      expect(last.nextOffset).not.toBeNull();
      const continued = yield* client.query({
        environmentId: there.environmentId,
        operation: "history",
        threadId: master,
        messageId: last.messageId,
        offset: last.nextOffset!,
        maxChars: 64000,
      });
      if (!("history" in continued)) return yield* Effect.die("expected history");
      expect(last.text + continued.history.messages[0]!.text).toBe("🦉".repeat(2000));
      const older = yield* client.query({
        environmentId: there.environmentId,
        operation: "history",
        threadId: master,
        beforeMessageId: history.history.page.beforeMessageId!,
        messageLimit: 15,
      });
      if (!("history" in older)) return yield* Effect.die("expected history");
      expect(older.history.messages.every((m) => m.messageId !== last.messageId)).toBe(true);
      expect(
        (yield* client
          .query({
            environmentId: there.environmentId,
            operation: "history",
            threadId: master,
            messageId: MessageId.make("missing"),
          })
          .pipe(Effect.flip)).message,
      ).toContain("Message not found");

      // Operate permission alone still cannot cross a lower-access link's thread-origin fence.
      yield* linkTo(links, peer, "auto");
      expect((yield* organize("settle").pipe(Effect.flip)).message).toMatch(/link|mode|access/i);
      yield* linkTo(links, peer, "full-access");
      const move = {
        environmentId: there.environmentId,
        operation: "move" as const,
        requestId: moveResult.requestId,
        threadId: master,
        environment: here.environmentId,
        projectId: moveResult.projectId,
      };
      yield* client.command(move);
      yield* client.command(move);
      const expectedMove = {
        requestId: move.requestId,
        threadId: master,
        environment: here.environmentId,
        projectId: move.projectId,
      };
      expect(moveCalls).toEqual([expectedMove, expectedMove]);
      expect(
        yield* client.command({
          environmentId: there.environmentId,
          operation: "moveStatus",
          requestId: move.requestId,
          cancel: true,
        }),
      ).toMatchObject({
        sourceEnvironmentId: there.environmentId,
        targetEnvironmentId: here.environmentId,
        state: "cancelled",
      });
      yield* organize("settle");
      yield* organize("settle"); // lost-response retry is harmless
      const exact = () =>
        client.query({ environmentId: there.environmentId, operation: "list", threadId: master });
      const settled = yield* exact();
      if (!("threads" in settled)) return yield* Effect.die("expected threads");
      expect(settled.threads[0]!.settledAt).not.toBeNull();
      yield* organize("unsettle");
      expect(yield* exact()).toMatchObject({ threads: [{ settledAt: null }] });
      yield* organize("archive");
      expect(yield* exact()).toMatchObject({ threads: [{ id: master }] });
      expect(
        yield* client.query({
          environmentId: there.environmentId,
          operation: "list",
          location: "archive",
        }),
      ).toMatchObject({ threads: [{ id: master }] });
      yield* organize("unarchive");

      const orchestrator = Context.get(world, Orchestrator.OrchestratorV2);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-active"),
        threadId: master,
        messageId: MessageId.make("active-prompt"),
        text: "fixture",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* setLatestRun(master, "running").pipe(Effect.provideContext(world));
      expect((yield* organize("settle").pipe(Effect.flip)).message).toMatch(/active|running|turn/i);
      yield* setLatestRun(master, "completed").pipe(Effect.provideContext(world));
      yield* organize("settle");
      expect(
        (yield* client
          .query({ environmentId: EnvironmentId.make("unknown"), operation: "list" })
          .pipe(Effect.flip)).message,
      ).toMatch(/link|found/i);
      yield* Ref.set(peer.descriptor, descriptorOf("replacement", "Other"));
      expect((yield* read("list").pipe(Effect.flip)).message).toMatch(/answer|reach|identity/i);
      yield* Ref.set(peer.descriptor, there);
      expect(yield* exact()).toMatchObject({ threads: [{ id: master }] });
      yield* links.unlink(there.environmentId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
