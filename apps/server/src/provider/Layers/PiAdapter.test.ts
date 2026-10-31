// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PiSettings,
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
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("drives Pi through its ACP bridge and resumes by native session id", () => {
  const threadId = ThreadId.make("pi-adapter-test");
  const instanceId = ProviderInstanceId.make("pi");
  const provider = ProviderDriverKind.make("pi");

  return Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-test-")),
    );
    const requestLogPath = NodePath.join(directory, "requests.ndjson");
    const wrapperPath = writeFakeCli({
      directory,
      name: "fake-pi-acp",
      env: {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      },
      source: execScriptSource({ scriptPath: mockAgentPath }),
    });

    const adapter = yield* makePiAdapter(
      decodeSettings({ binaryPath: wrapperPath, enabled: true }),
      {
        environment: process.env,
        instanceId,
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
      modelSelection: { instanceId, model: "composer-2" },
    });
    const turn = yield* adapter.sendTurn({
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

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: { instanceId, model: "composer-2" },
      resumeCursor: created.resumeCursor,
    });
    yield* adapter.stopSession(threadId);
    yield* Fiber.interrupt(eventFiber);

    const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });

    expect(requests.find((request) => request.method === "authenticate")?.params?.methodId).toBe(
      "pi_terminal_login",
    );
    expect(requests.find((request) => request.method === "session/new")?.params?.cwd).toBe(
      directory,
    );
    expect(
      requests.find((request) => request.method === "session/set_config_option")?.params,
    ).toMatchObject({ configId: "model", value: "composer-2" });
    const prompt = requests.find((request) => request.method === "session/prompt");
    expect(JSON.stringify(prompt?.params)).toContain("hello");
    expect(requests.some((request) => request.method === "session/load")).toBe(true);

    expect(
      events.some(
        (event) => event.type === "content.delta" && event.payload.delta === "hello from mock",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "turn.completed" &&
          event.turnId === turn.turnId &&
          event.payload.state === "completed",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(testLayer));
});
