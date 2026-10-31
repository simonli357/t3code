import { PI_DEFAULT_MODEL, ProviderDriverKind, type PiSettings } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

/**
 * `pi-acp` authenticates by launching Pi in a terminal. T3 never triggers it:
 * Pi is configured separately, and the bridge treats `authenticate` as a
 * no-op, so the id only satisfies the ACP handshake.
 */
export const PI_ACP_AUTH_METHOD_ID = "pi_terminal_login";
export const PI_ACP_DEFAULT_COMMAND = "pi-acp";
export const PI_DEFAULT_MODEL_SLUG = PI_DEFAULT_MODEL;
export const PI_MODEL_CONFIG_ID = "model";
export const PI_THOUGHT_LEVEL_CONFIG_ID = "thought_level";

export interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly settings: PiSettings;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly workspaceEnvironment?: Readonly<Record<string, string>>;
  readonly mcpEnvironment?: Readonly<Record<string, string>>;
}

export function piBridgeCommand(settings: PiSettings): string {
  return settings.binaryPath.trim() || PI_ACP_DEFAULT_COMMAND;
}

export function piBridgeArgs(settings: PiSettings): ReadonlyArray<string> {
  return tokenizeCliArgs(settings.launchArgs);
}

export const makePiAcpRuntime = Effect.fn("makePiAcpRuntime")(function* (input: PiAcpRuntimeInput) {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: PI_ACP_AUTH_METHOD_ID,
      resumeMethod: "load",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      spawn: {
        command: piBridgeCommand(input.settings),
        args: piBridgeArgs(input.settings),
        cwd: input.cwd,
        env: {
          ...(input.baseEnvironment ?? process.env),
          ...input.agentDeviceEnvironment,
          ...input.workspaceEnvironment,
          ...input.mcpEnvironment,
        },
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

/**
 * pi-acp ignores ACP `mcpServers`, so T3's tools reach Pi through this extension.
 * It registers the session's T3 MCP endpoint, passed in the environment.
 */
export const PI_T3_EXTENSION = `// Written by T3 Code: gives Pi sessions started by T3 the T3 tools.
export default function (pi) {
  const url = process.env.T3CODE_MCP_URL;
  const authorization = process.env.T3CODE_MCP_AUTHORIZATION;
  if (!url || !authorization) return;
  pi.registerMcpServer("t3-code", {
    url,
    headers: { Authorization: authorization },
    exposure: "direct",
  });
}
`;

/** pi-acp starts `PI_ACP_PI_COMMAND` with fixed arguments, so this launcher adds the extension. */
export function piLauncher(platform: NodeJS.Platform, piCommand: string, extensionPath: string) {
  if (platform === "win32")
    return {
      name: "pi-t3.cmd",
      content: `@echo off\r\n"${piCommand}" -e "${extensionPath}" %*\r\n`,
    };
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return {
    name: "pi-t3",
    content: `#!/bin/sh\nexec ${quote(piCommand)} -e ${quote(extensionPath)} "$@"\n`,
  };
}

/** Pi advertises fully-qualified `provider/model-id` values. */
export function piModelSlug(optionValue: string): string {
  return optionValue.trim();
}

export function piModelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  slug: string | null | undefined,
): string | undefined {
  const model = configOptions.find(
    (option) => option.id === PI_MODEL_CONFIG_ID || option.category === "model",
  );
  if (model?.type !== "select") return undefined;
  if (!slug || slug === PI_DEFAULT_MODEL_SLUG) return model.currentValue;
  const values = model.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
  return values.find((value) => value === slug || value.endsWith(`/${slug}`));
}

export const applyPiModelSelection = Effect.fn("applyPiModelSelection")(function* <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setModel" | "setConfigOption"
  >;
  readonly model: string | null | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | undefined, E> {
  const options = yield* input.runtime.getConfigOptions;
  const option = piModelOption(options, input.model);
  if (option !== undefined) {
    yield* input.runtime.setModel(option).pipe(Effect.mapError(input.mapError));
  }
  if (input.reasoningEffort !== undefined) {
    const thoughtLevel = options.find(
      (candidate) =>
        candidate.id === PI_THOUGHT_LEVEL_CONFIG_ID ||
        candidate.id === "reasoning_effort" ||
        candidate.id === "reasoningEffort",
    );
    if (thoughtLevel?.type === "select") {
      yield* input.runtime
        .setConfigOption(thoughtLevel.id, input.reasoningEffort)
        .pipe(Effect.mapError(input.mapError));
    }
  }
  return option === undefined ? undefined : piModelSlug(option);
});
