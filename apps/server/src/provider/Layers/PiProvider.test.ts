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
  checkPiProviderStatus,
} from "./PiProvider.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

it.effect("starts disabled with Pi's default model and compact command", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialPiProviderSnapshot(
      decodeSettings({ enabled: false }),
    );

    expect(snapshot.displayName).toBe("Pi");
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.models.map((model) => model.slug)).toEqual(["pi-default"]);
    expect(snapshot.slashCommands?.map((command) => command.name)).toEqual(["compact"]);
  }),
);

it.effect("reports ready when Pi and its ACP bridge both respond", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-provider-test-")),
    );
    const piVersionPath = writeFakeCli({
      directory,
      name: "fake-pi",
      source: 'process.stdout.write("0.81.0\\n");',
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
  }).pipe(Effect.provide(NodeServices.layer)),
);
