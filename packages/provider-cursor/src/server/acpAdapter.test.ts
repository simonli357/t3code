// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  RunAttemptId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CursorSettings } from "../settings.ts";
import {
  cursorAcpSpawn,
  cursorLaunchMode,
  cursorNativeForkRuntime,
  makeCursorAcpAdapter,
} from "./acpAdapter.ts";

const fixture = NodeURL.fileURLToPath(new URL("./fixtures/acp-process.cjs", import.meta.url));
const settings = Schema.decodeSync(CursorSettings)({ enabled: true });
const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);

it.layer(layer)("Cursor ACP isolation", (it) => {
  it.effect("loads complete history concurrently without sharing environment, account or cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-acp-" });
      const ambient = {
        HOME: process.env.HOME,
        TMP: process.env.TMP,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      };
      const sessions = yield* Effect.forEach(
        ["one", "two"],
        (account) =>
          Effect.gen(function* () {
            const cwd = NodePath.join(root, account);
            yield* fs.makeDirectory(cwd);
            const instanceId = ProviderInstanceId.make(`cursor-${account}`);
            const threadId = ThreadId.make(account);
            const modelSelection = { instanceId, model: "test-model" };
            const runtimePolicy = {
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              cwd,
              workspaceEnvironment: {
                HOME: cwd,
                TMP: cwd,
                XDG_CACHE_HOME: cwd,
                WORKENV_JOB_ID: account,
                TOOL_PATH: cwd,
              },
            };
            const options = {
              instanceId,
              settings,
              selfInvocation: { command: process.execPath, entrypoint: undefined },
              environment: {
                SystemRoot: process.env.SystemRoot,
                PATH: process.env.PATH,
                TEST_ACCOUNT: account,
                CURSOR_API_KEY: `synthetic-${account}`,
                HOME: "ambient-home",
                TMP: "ambient-temp",
              },
            };
            let spawnInput: ReturnType<typeof cursorAcpSpawn> | undefined;
            const adapter = yield* makeCursorAcpAdapter({
              ...options,
              makeRuntime: (input) => {
                spawnInput = cursorAcpSpawn(options, input);
                return AcpSessionRuntime.make({
                  ...input,
                  spawn: { ...spawnInput, command: process.execPath, args: [fixture] },
                  sessionLoadReplayIdleGap: 0,
                });
              },
            });
            const runtime = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(account),
              modelSelection,
              runtimePolicy,
              initialNativeThreadId: `native-${account}`,
            });
            const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
            const snapshot = yield* runtime.readThreadSnapshot({ providerThread: thread });
            expect(snapshot.messages.map((message) => message.text)).toEqual([
              "Complete original user history",
              "Complete original assistant history",
            ]);
            const now = yield* DateTime.now;
            for (const ordinal of [1, 2]) {
              yield* runtime.startTurn(
                makeTurnInput({
                  threadId,
                  providerThread: thread,
                  instanceId,
                  runtimePolicy,
                  now,
                  ordinal,
                  modelSelection,
                }),
              );
              const events = yield* runtime.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              );
              const assistant = events
                .filter(
                  (event) => event.type === "message.updated" && event.message.role === "assistant",
                )
                .at(-1);
              expect(assistant?.type).toBe("message.updated");
              if (assistant?.type === "message.updated")
                expect(JSON.parse(assistant.message.text)).toMatchObject({
                  account,
                  home: cwd,
                  temp: cwd,
                  cache: cwd,
                  key: `synthetic-${account}`,
                  tool: cwd,
                });
              expect(
                events.some(
                  (event) => event.type === "plan.updated" && event.plan.kind === "todo_list",
                ),
              ).toBe(true);
              expect(
                events.some(
                  (event) => event.type === "plan.updated" && event.plan.kind === "proposed_plan",
                ),
              ).toBe(true);
            }
            const fork = yield* runtime.forkThread({
              sourceProviderThread: thread,
              targetThreadId: ThreadId.make(`${account}-fork`),
            });
            expect(fork.nativeThreadRef?.nativeId).toBe(`native-${account}-fork`);
            expect(spawnInput?.env).toMatchObject({
              HOME: cwd,
              TMP: cwd,
              XDG_CACHE_HOME: cwd,
              WORKENV_JOB_ID: account,
              CURSOR_API_KEY: `synthetic-${account}`,
            });
            // Observe the child process environment directly through the same protocol runtime.
            const protocol = yield* AcpSessionRuntime.make({
              cwd,
              clientInfo: { name: "test", version: "1" },
              spawn: { ...spawnInput!, command: process.execPath, args: [fixture] },
            });
            yield* protocol.start();
            const response = yield* protocol.request("session/prompt", {
              sessionId: "check",
              prompt: [],
            });
            expect(response).toEqual({ stopReason: "end_turn" });
            const childEnv = yield* protocol.request("fixture/environment", {});
            expect(childEnv).toEqual({
              home: cwd,
              temp: cwd,
              cache: cwd,
              tool: cwd,
              account,
              key: `synthetic-${account}`,
              cwd,
            });
            return { runtime, thread, modelSelection, runtimePolicy };
          }),
        { concurrency: "unbounded" },
      );
      const first = sessions[0]!;
      const bad = {
        ...first.thread,
        nativeThreadRef: { ...first.thread.nativeThreadRef!, nativeId: "missing" },
      };
      expect(
        (yield* first.runtime.readThreadSnapshot({ providerThread: bad }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const recovered = yield* first.runtime.readThreadSnapshot({ providerThread: first.thread });
      expect(recovered.messages).toHaveLength(2);
      expect({
        HOME: process.env.HOME,
        TMP: process.env.TMP,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      }).toEqual(ambient);
    }).pipe(Effect.scoped),
  );
});

it("does not let --force or Auto bypass explicit sandbox and approval policy", () => {
  const base = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: "/workspace",
  };
  expect(cursorLaunchMode({ ...base, sandboxPolicy: { type: "readOnly" } })).toBe(
    "approval-required",
  );
  expect(cursorLaunchMode({ ...base, approvalPolicy: "on-request" })).toBe("approval-required");
  expect(
    cursorAcpSpawn({ settings, environment: {} }, { cwd: "/workspace", runtimePolicy: base }).args,
  ).toContain("--force");
});

it.effect(
  "refuses native fork/load during an active turn and releases the guard after cancellation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const mock = Layer.mock(AcpSessionRuntime.AcpSessionRuntime)({
        prompt: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(done)),
            Effect.as({ stopReason: "cancelled" as const }),
          ),
        cancel: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const runtime = cursorNativeForkRuntime(
          yield* AcpSessionRuntime.AcpSessionRuntime,
          {},
          "/unused",
          "approval-required",
          "win32",
        );
        const prompt = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "wait" }] })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const forked = yield* runtime
          .forkSession("11111111-1111-4111-8111-111111111111")
          .pipe(Effect.result);
        expect(forked._tag).toBe("Failure");
        if (forked._tag === "Failure") expect(String(forked.failure.cause)).toContain("active");
        expect(
          (yield* runtime.loadSession("11111111-1111-4111-8111-111111111111").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        yield* runtime.cancel;
        yield* Fiber.join(prompt);
        const retried = yield* runtime
          .forkSession("11111111-1111-4111-8111-111111111111")
          .pipe(Effect.result);
        expect(retried._tag).toBe("Failure");
        if (retried._tag === "Failure")
          expect(String(retried.failure.cause)).toContain("home directory");
      }).pipe(Effect.provide(mock));
    }).pipe(Effect.scoped),
);

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
  readonly ordinal?: number;
  readonly modelSelection?: ModelSelection;
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
  readonly messageText?: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  const ordinal = input.ordinal ?? 1;
  const suffix = `${input.threadId}:${ordinal}`;
  const modelSelection =
    input.modelSelection ?? ({ instanceId: input.instanceId, model: "default" } as const);
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "ACP adapter test",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: input.messageText ?? "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}
