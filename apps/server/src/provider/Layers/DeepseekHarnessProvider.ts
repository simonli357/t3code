import {
  type CustomModelSetting,
  DEEPSEEK_HARNESS_DEFAULT_MODEL,
  type DeepseekHarnessSettings,
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import {
  DEEPSEEK_HARNESS_T3_COMMIT,
  deepseekHarnessModelSlug,
  makeDeepseekHarnessAcpRuntime,
} from "../acp/DeepseekHarnessAcpSupport.ts";
import { sessionConfigOptionsFromInitialize } from "../acp/AcpRuntimeModel.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const PRESENTATION = {
  displayName: "DeepSeek Harness",
  supportsConversationRollback: false,
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_TIMEOUT = "8 seconds";
const INITIALIZE_TIMEOUT = "12 seconds";
// ACP only exposes its session config after starting a session, but session
// moves validate saved options against the destination catalog first.
const FALLBACK_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoning_effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
    },
  ],
});
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    isCustom: false,
    isDefault: true,
    aliases: [DEEPSEEK_HARNESS_DEFAULT_MODEL],
    capabilities: FALLBACK_CAPABILITIES,
  },
  {
    slug: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    capabilities: FALLBACK_CAPABILITIES,
  },
];

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

function reasoningCapabilities(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ModelCapabilities {
  const reasoning = options?.find(
    (option) => option.id === "reasoning_effort" || option.id === "reasoningEffort",
  );
  if (reasoning?.type !== "select") return EMPTY_CAPABILITIES;
  const values = reasoning.options.flatMap((entry) =>
    "value" in entry ? [entry] : entry.options,
  );
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
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

export function buildDeepseekHarnessModels(input: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly customModels?: ReadonlyArray<CustomModelSetting>;
}): ReadonlyArray<ServerProviderModel> {
  const model = input.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const current = model?.type === "select" ? model.currentValue : undefined;
  const capabilities = reasoningCapabilities(input.configOptions);
  const discovered: ServerProviderModel[] = modelEntries(model).map((entry) => ({
    slug: deepseekHarnessModelSlug(entry.value),
    name: entry.name.trim() || deepseekHarnessModelSlug(entry.value),
    isCustom: false,
    ...(entry.value === current
      ? {
          isDefault: true,
          aliases: [DEEPSEEK_HARNESS_DEFAULT_MODEL],
        }
      : {}),
    capabilities,
  }));
  return providerModelsFromSettings(
    discovered.length > 0 ? discovered : FALLBACK_MODELS,
    input.customModels ?? [],
    capabilities,
  );
}

function slashCommands(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  const hasReasoning = options?.some(
    (option) => option.id === "reasoning_effort" || option.id === "reasoningEffort",
  );
  return hasReasoning ? [COMPACT_SLASH_COMMAND] : [COMPACT_SLASH_COMMAND];
}

export function buildInitialDeepseekHarnessProviderSnapshot(
  settings: DeepseekHarnessSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = buildDeepseekHarnessModels({
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
            auth: { status: "unknown", type: "api-key", label: "DeepSeek API key" },
            message: "Checking DeepSeek Harness availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown", type: "api-key", label: "DeepSeek API key" },
            message: "DeepSeek Harness is disabled in T3 Code settings.",
          },
    });
  });
}

function runVersionProbe(
  settings: DeepseekHarnessSettings,
  environment: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const command = settings.binaryPath.trim() || "dsh";
    const args = ["--profile", settings.profile.trim() || "acp", "--version"];
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

function initializeProbe(input: {
  readonly settings: DeepseekHarnessSettings;
  readonly dshHome: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly apiKey: string | undefined;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeDeepseekHarnessAcpRuntime({
        settings: input.settings,
        dshHome: input.dshHome,
        apiKey: input.apiKey,
        baseEnvironment: input.environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        mcpServers: [],
      });
      return yield* runtime.initialize();
    }),
  ).pipe(Effect.timeoutOption(INITIALIZE_TIMEOUT));
}

export const checkDeepseekHarnessProviderStatus = Effect.fn(
  "checkDeepseekHarnessProviderStatus",
)(function* (input: {
  readonly settings: DeepseekHarnessSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly dshHome: string;
  readonly apiKey: string | undefined;
}): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const environment = {
    ...input.environment,
    DSH_HOME: input.dshHome,
    DSH_TELEMETRY_DISABLED: "1",
  };
  const fallbackModels = buildDeepseekHarnessModels({
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
        auth: { status: "unknown", type: "api-key", label: "DeepSeek API key" },
        message: "DeepSeek Harness is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runVersionProbe(input.settings, environment).pipe(
    Effect.catch((cause) =>
      isCommandMissingCause(cause)
        ? Effect.succeed(Option.none())
        : Effect.logWarning("DeepSeek Harness version probe failed.").pipe(
            Effect.as(Option.none()),
          ),
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
        auth: { status: "unknown", type: "api-key", label: "DeepSeek API key" },
        message:
          "DeepSeek Harness executable was not found. Set the pinned launcher in provider settings.",
      },
    });
  }

  const initialized = yield* initializeProbe({
    settings: input.settings,
    dshHome: input.dshHome,
    environment,
    apiKey: input.apiKey,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("DeepSeek Harness ACP initialize probe failed.", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  const initializeResult = Option.getOrUndefined(initialized);
  const supportsNativeT3Lifecycle =
    initializeResult?.agentCapabilities?.loadSession === true &&
    initializeResult.agentCapabilities.sessionCapabilities?.fork !== undefined;
  const options = initializeResult
    ? sessionConfigOptionsFromInitialize(initializeResult)
    : undefined;
  const models = buildDeepseekHarnessModels({
    customModels: input.settings.customModels,
    ...(options ? { configOptions: options } : {}),
  });
  const authenticated = input.apiKey !== undefined;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: slashCommands(options),
    probe: {
      installed: true,
      version: parseGenericCliVersion(Option.getOrElse(versionOutput, () => "")),
      status: authenticated && supportsNativeT3Lifecycle ? "ready" : "warning",
      auth: authenticated
        ? { status: "authenticated", type: "api-key", label: "DeepSeek API key" }
        : { status: "unauthenticated", type: "api-key", label: "DeepSeek API key" },
      ...(authenticated
        ? !supportsNativeT3Lifecycle
          ? {
              message:
                `This Harness build lacks native load/fork. Install T3 build ${DEEPSEEK_HARNESS_T3_COMMIT.slice(0, 8)}.`,
            }
          : options
            ? {}
            : { message: "Harness is installed, but its ACP catalog probe did not complete." }
        : { message: "Add a DeepSeek API key to start a session." }),
    },
  });
});

export const deepseekHarnessProviderChanges = (
  settings: DeepseekHarnessSettings,
  previous: DeepseekHarnessSettings,
) =>
  settings.binaryPath !== previous.binaryPath ||
  settings.profile !== previous.profile ||
  settings.homePath !== previous.homePath ||
  JSON.stringify(settings.customModels) !== JSON.stringify(previous.customModels);
