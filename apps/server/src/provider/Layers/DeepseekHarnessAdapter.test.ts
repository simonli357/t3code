// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DeepseekHarnessSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDeepseekHarnessAdapter } from "./DeepseekHarnessAdapter.ts";

const decodeSettings = Schema.decodeSync(DeepseekHarnessSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-dsh-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("forwards T3 MCP and filters DeepSeek Harness load replay", () => {
  const threadId = ThreadId.make("dsh-adapter-test");
  const instanceId = ProviderInstanceId.make("deepseekHarness");
  const provider = ProviderDriverKind.make("deepseekHarness");

  return Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-adapter-test-")),
    );
    const requestLogPath = NodePath.join(directory, "requests.ndjson");
    const wrapperPath = writeFakeCli({
      directory,
      name: "fake-dsh",
      env: {
        T3_ACP_EMIT_LOAD_REPLAY: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      },
      source: execScriptSource({ scriptPath: mockAgentPath }),
    });
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("test-environment"),
      threadId,
      providerSessionId: "mock-session-1",
      providerInstanceId: instanceId,
      endpoint: "http://127.0.0.1:9999/mcp",
      authorizationHeader: "Bearer test-only",
      capabilities: new Set(["preview"]),
    });

    const adapter = yield* makeDeepseekHarnessAdapter(
      decodeSettings({ binaryPath: wrapperPath, enabled: true }),
      {
        environment: process.env,
        instanceId,
        dshHome: directory,
        readApiKey: Effect.succeed("test-only"),
      },
    );
    const events: ProviderRuntimeEvent[] = [];
    const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkChild);

    const created = yield* adapter.startSession({
      threadId,
      provider,
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: { instanceId, model: "deepseek-flash" },
    });
    yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
    });
    // A settled turn must not block switching accounts or providers.
    expect(
      (yield* adapter.listSessions()).find((session) => session.threadId === threadId)
        ?.activeTurnId,
    ).toBeUndefined();
    yield* adapter.stopSession(threadId);

    const replayStart = events.length;
    yield* adapter.startSession({
      threadId,
      provider,
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: { instanceId, model: "deepseek-flash" },
      resumeCursor: created.resumeCursor,
    });

    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);

    const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const create = requests.find((request) => request.method === "session/new");
    expect(create?.params?.mcpServers).toEqual([
      expect.objectContaining({
        name: "t3-code",
        url: "http://127.0.0.1:9999/mcp",
      }),
    ]);
    expect(
      events
        .slice(replayStart)
        .filter(
          (event) =>
            event.type === "content.delta" &&
            (event.payload.delta === "replayed assistant text" || event.payload.delta === "replay"),
        ),
    ).toEqual([]);
  }).pipe(
    Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    Effect.provide(testLayer),
  );
});
