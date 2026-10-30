// @effect-diagnostics preferSchemaOverJson:off - Pi's RPC mode uses raw NDJSON messages.
import {
  type CustomModelSetting,
  type ModelCapabilities,
  PI_DEFAULT_MODEL,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  COMPACT_SLASH_COMMAND,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makePiAcpRuntime, piModelSlug } from "../acp/PiAcpSupport.ts";
import { sessionConfigOptionsFromInitialize } from "../acp/AcpRuntimeModel.ts";

const PRESENTATION = {
  displayName: "Pi",
  supportsConversationRollback: false,
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  // Pi's bridge runs tools using Pi's own approval configuration.
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_TIMEOUT = "8 seconds";
const MODEL_LIST_TIMEOUT = "12 seconds";
const INITIALIZE_TIMEOUT = "12 seconds";
const AUTH = {
  status: "unknown",
  type: "terminal",
  label: "Pi account",
} as const;
const MODEL_PLACEHOLDER: ServerProviderModel = {
  slug: PI_DEFAULT_MODEL,
  name: "Pi default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

interface PiRpcModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

interface PiRpcModelCatalog {
  readonly currentModel: string | undefined;
  readonly models: ReadonlyArray<PiRpcModel>;
}

interface PiRpcResponse {
  readonly id: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePiRpcResponse(line: string): Option.Option<PiRpcResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return Option.none();
  }
  if (!isRecord(parsed) || parsed.type !== "response") return Option.none();
  const id = nonEmptyString(parsed.id);
  if (!id || typeof parsed.success !== "boolean") return Option.none();
  return Option.some({
    id,
    success: parsed.success,
    ...(parsed.data !== undefined ? { data: parsed.data } : {}),
    ...(parsed.error !== undefined ? { error: parsed.error } : {}),
  });
}

function parsePiRpcModelCatalog(responses: ReadonlyArray<PiRpcResponse>): PiRpcModelCatalog {
  const stateResponse = responses.find((response) => response.id === "state");
  const modelsResponse = responses.find((response) => response.id === "models");
  if (!stateResponse?.success || !modelsResponse?.success) {
    throw new Error(
      `Pi did not return its model catalog (responses: ${responses
        .map((response) => `${response.id}:${response.success}`)
        .join(", ")}).`,
    );
  }

  const state = isRecord(stateResponse.data) ? stateResponse.data : undefined;
  const selectedModel = state && isRecord(state.model) ? state.model : undefined;
  const provider = nonEmptyString(selectedModel?.provider);
  const id = nonEmptyString(selectedModel?.id);
  const modelRows = isRecord(modelsResponse.data) ? modelsResponse.data.models : undefined;
  const models = Array.isArray(modelRows)
    ? modelRows.flatMap((row) => {
        if (!isRecord(row)) return [];
        const modelId = nonEmptyString(row.id);
        const modelProvider = nonEmptyString(row.provider);
        if (!modelId || !modelProvider) return [];
        return [
          {
            id: modelId,
            name: nonEmptyString(row.name) ?? modelId,
            provider: modelProvider,
          },
        ];
      })
    : [];

  return {
    currentModel: provider && id ? `${provider}/${id}` : undefined,
    models,
  };
}

function modelEntries(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name }]
      : entry.options.map((nested) => ({ value: nested.value, name: nested.name })),
  );
}

function piDisplayName(value: string, name: string): string {
  const provider = value.includes("/") ? value.slice(0, value.indexOf("/")) : undefined;
  const prefix = provider ? `${provider}/` : undefined;
  const trimmed = name.trim();
  return (prefix && trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed) || value;
}

function reasoningCapabilities(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ModelCapabilities {
  const reasoning = options?.find(
    (option) =>
      option.id === "thought_level" ||
      option.id === "reasoning_effort" ||
      option.id === "reasoningEffort",
  );
  if (reasoning?.type !== "select") return EMPTY_CAPABILITIES;
  const values = reasoning.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Thinking",
        type: "select",
        options: values.map((entry) => ({
          id: entry.value,
          label: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.value === reasoning.currentValue ? { isDefault: true } : {}),
        })),
        ...(typeof reasoning.currentValue === "string"
          ? { currentValue: reasoning.currentValue }
          : {}),
      },
    ],
  });
}

export function buildPiModels(input: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly rpcModels?: ReadonlyArray<PiRpcModel>;
  readonly currentModel?: string;
  readonly customModels?: ReadonlyArray<CustomModelSetting>;
}): ReadonlyArray<ServerProviderModel> {
  const model = input.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const acpModels = modelEntries(model);
  const discoveredEntries =
    acpModels.length > 0
      ? acpModels
      : (input.rpcModels ?? []).map((entry) => ({
          value: `${entry.provider}/${entry.id}`,
          name: entry.name,
        }));
  const current = (model?.type === "select" ? model.currentValue : undefined) ?? input.currentModel;
  const capabilities = reasoningCapabilities(input.configOptions);
  const discovered: ServerProviderModel[] = discoveredEntries.map((entry) => ({
    slug: piModelSlug(entry.value),
    name: piDisplayName(entry.value, entry.name),
    isCustom: false,
    ...(entry.value === current
      ? {
          isDefault: true,
          aliases: [PI_DEFAULT_MODEL],
        }
      : {}),
    capabilities,
  }));
  return providerModelsFromSettings(
    discovered.length > 0 ? discovered : [MODEL_PLACEHOLDER],
    input.customModels ?? [],
    capabilities,
  );
}

export function buildInitialPiProviderSnapshot(
  settings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = buildPiModels({
      customModels: settings.customModels,
    });
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: AUTH,
            message: "Checking Pi availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: AUTH,
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });
}

function piVersionCommand(environment: NodeJS.ProcessEnv): string {
  return environment.PI_ACP_PI_COMMAND?.trim() || "pi";
}

function runVersionProbe(environment: NodeJS.ProcessEnv) {
  return Effect.gen(function* () {
    const command = piVersionCommand(environment);
    const args = ["--version"];
    const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        cwd: process.cwd(),
        env: environment,
        extendEnv: false,
        shell: spawn.shell,
      }),
    ).pipe(Effect.timeoutOption(VERSION_TIMEOUT));
  });
}

function runModelListProbe(environment: NodeJS.ProcessEnv) {
  return Effect.gen(function* () {
    const command = piVersionCommand(environment);
    const args = ["--mode", "rpc", "--no-themes", "--no-session"];
    const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const input = [
      JSON.stringify({ id: "state", type: "get_state" }),
      JSON.stringify({ id: "models", type: "get_available_models" }),
      "",
    ].join("\n");
    const responses = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* childProcessSpawner.spawn(
          ChildProcess.make(spawn.command, spawn.args, {
            cwd: process.cwd(),
            env: environment,
            extendEnv: false,
            shell: spawn.shell,
            stdin: Stream.encodeText(Stream.make(input)),
          }),
        );
        const [responseChunk] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.map(parsePiRpcResponse),
              Stream.filter(Option.isSome),
              Stream.map(Option.getOrThrow),
              Stream.take(2),
              Stream.runCollect,
            ),
            Stream.runDrain(child.stderr),
          ],
          { concurrency: "unbounded" },
        );
        return responseChunk;
      }),
    );
    return parsePiRpcModelCatalog(responses);
  }).pipe(Effect.timeoutOption(MODEL_LIST_TIMEOUT));
}

function initializeProbe(input: {
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makePiAcpRuntime({
        settings: input.settings,
        baseEnvironment: input.environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      return yield* runtime.initialize();
    }),
  ).pipe(Effect.timeoutOption(INITIALIZE_TIMEOUT));
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (input: {
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = buildPiModels({
    customModels: input.settings.customModels,
  });

  if (!input.settings.enabled) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: AUTH,
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runVersionProbe(input.environment).pipe(
    Effect.catch((cause) =>
      isCommandMissingCause(cause)
        ? Effect.succeed(Option.none())
        : Effect.logWarning("Pi version probe failed.").pipe(Effect.as(Option.none())),
    ),
  );
  const versionOutput = Option.flatMap(versionResult, (result) =>
    result.code === 0 ? Option.some(result.stdout) : Option.none(),
  );
  if (Option.isNone(versionOutput)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: AUTH,
        message:
          "Pi was not found on PATH. Install @earendil-works/pi-coding-agent and sign in before using it.",
      },
    });
  }

  const initializeAttempt = yield* initializeProbe({
    settings: input.settings,
    environment: input.environment,
  }).pipe(
    Effect.map((result) => ({ ok: true as const, result })),
    Effect.catch((cause) =>
      Effect.logWarning("Pi ACP initialize probe failed.", { cause }).pipe(
        Effect.as({ ok: false as const, missingBridge: isCommandMissingCause(cause) }),
      ),
    ),
  );
  if (initializeAttempt.ok && Option.isNone(initializeAttempt.result)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version: parseGenericCliVersion(Option.getOrElse(versionOutput, () => "")),
        status: "warning",
        auth: AUTH,
        message: "Pi is installed, but the pi-acp bridge did not respond in time.",
      },
    });
  }
  if (!initializeAttempt.ok && initializeAttempt.missingBridge) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version: parseGenericCliVersion(Option.getOrElse(versionOutput, () => "")),
        status: "error",
        auth: AUTH,
        message:
          "The pi-acp bridge was not found. Install pi-acp or set the ACP bridge executable.",
      },
    });
  }
  const initializeResult = initializeAttempt.ok
    ? Option.getOrUndefined(initializeAttempt.result)
    : undefined;
  const configOptions = initializeResult
    ? sessionConfigOptionsFromInitialize(initializeResult)
    : undefined;
  const hasAcpModels =
    modelEntries(
      configOptions?.find((option) => option.id === "model" || option.category === "model"),
    ).length > 0;
  const modelCatalog = hasAcpModels
    ? Option.none<PiRpcModelCatalog>()
    : yield* runModelListProbe(input.environment).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Pi model list probe failed.", { cause }).pipe(
            Effect.as(Option.none<PiRpcModelCatalog>()),
          ),
        ),
      );
  const models = buildPiModels({
    customModels: input.settings.customModels,
    ...(configOptions ? { configOptions } : {}),
    ...Option.match(modelCatalog, {
      onNone: () => ({}),
      onSome: (catalog) => ({
        rpcModels: catalog.models,
        ...(catalog.currentModel ? { currentModel: catalog.currentModel } : {}),
      }),
    }),
  });
  const version = parseGenericCliVersion(Option.getOrElse(versionOutput, () => ""));
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: initializeResult ? "ready" : "warning",
      auth: AUTH,
      message: initializeResult
        ? "Pi is ready. Models, tools, and authentication come from Pi's own configuration."
        : "Pi is installed, but the pi-acp bridge did not complete its ACP handshake. Check the bridge executable and arguments.",
    },
  });
});

export const piProviderChanges = (settings: PiSettings, previous: PiSettings) =>
  settings.binaryPath !== previous.binaryPath ||
  settings.launchArgs !== previous.launchArgs ||
  JSON.stringify(settings.customModels) !== JSON.stringify(previous.customModels);
