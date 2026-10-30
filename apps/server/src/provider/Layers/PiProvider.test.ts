// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  buildInitialPiProviderSnapshot,
  buildPiModels,
  checkPiProviderStatus,
} from "./PiProvider.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const deepSeekModels = [
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    provider: "deepseek",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
  },
] as const;

const piCliSource = `
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("0.81.0\\n");
} else {
  const models = ${JSON.stringify(deepSeekModels)};
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const request = JSON.parse(line);
    const data = request.type === "get_state"
      ? {
          model: { provider: "deepseek", id: "deepseek-v4-pro" },
          sessionFile: null,
        }
      : request.type === "get_available_models"
        ? { models }
        : undefined;
    process.stdout.write(JSON.stringify({
      type: "response",
      id: request.id,
      success: data !== undefined,
      ...(data === undefined ? { error: "unsupported request" } : { data }),
    }) + "\\n");
  });
}
`;

it.effect("starts disabled with Pi's default model and compact command", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialPiProviderSnapshot(decodeSettings({ enabled: false }));

    expect(snapshot.displayName).toBe("Pi");
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.models.map((model) => model.slug)).toEqual(["pi-default"]);
    expect(snapshot.slashCommands?.map((command) => command.name)).toEqual(["compact"]);
  }),
);

it("uses Pi's readable model names and configured default", () => {
  const models = buildPiModels({
    rpcModels: deepSeekModels,
    currentModel: "deepseek/deepseek-v4-pro",
    customModels: [],
  });

  expect(models).toEqual([
    expect.objectContaining({
      slug: "deepseek/deepseek-flash",
      name: "DeepSeek V4.1 Flash",
    }),
    expect.objectContaining({
      slug: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      isDefault: true,
      aliases: ["pi-default"],
    }),
  ]);
  expect(models[0]?.isDefault).toBeUndefined();
});

it.effect("reports ready when Pi and its ACP bridge both respond", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-provider-test-")),
    );
    const piVersionPath = writeFakeCli({
      directory,
      name: "fake-pi",
      source: piCliSource,
    });
    const bridgePath = writeFakeCli({
      directory,
      name: "fake-pi-acp",
      source: execScriptSource({ scriptPath: mockAgentPath }),
    });

    const snapshot = yield* checkPiProviderStatus({
      settings: decodeSettings({ binaryPath: bridgePath, enabled: true }),
      environment: { ...process.env, PI_ACP_PI_COMMAND: piVersionPath },
    });

    expect(snapshot.installed).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.version).toBe("0.81.0");
    expect(snapshot.models.map((model) => [model.slug, model.name, model.isDefault])).toEqual([
      ["deepseek/deepseek-flash", "DeepSeek V4.1 Flash", undefined],
      ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", true],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
