import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  DEEPSEEK_HARNESS_DEFAULT_MODEL_SLUG,
  DEEPSEEK_HARNESS_DRIVER_KIND,
  DEEPSEEK_HARNESS_EFFORT_OPTION_DESCRIPTOR,
  DEEPSEEK_HARNESS_EFFORT_OPTION_ID,
  DEEPSEEK_HARNESS_FLASH_BASENAME,
  DEEPSEEK_HARNESS_RETIRED_FLASH_ALIAS,
  DEEPSEEK_HARNESS_SUPPORTED_RUNTIME_MODES,
  deepseekHarnessModelSlug,
  deepseekHarnessSupportsNativeLifecycle,
  makeDeepseekHarnessAcpRuntime,
} from "./acpSupport.ts";
import type { DeepseekHarnessSettings } from "../settings.ts";

const PRESENTATION = {
  displayName: "DeepSeek Harness",
  showInteractionModeToggle: true,
  supportedRuntimeModes: DEEPSEEK_HARNESS_SUPPORTED_RUNTIME_MODES,
} as const;
const VERSION_TIMEOUT = "8 seconds";
const INITIALIZE_TIMEOUT = "15 seconds";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: `deepseek-official/${DEEPSEEK_HARNESS_FLASH_BASENAME}`,
    name: "DeepSeek V4.1 Flash",
    isCustom: false,
    isDefault: true,
    aliases: [
      DEEPSEEK_HARNESS_DEFAULT_MODEL_SLUG,
      DEEPSEEK_HARNESS_RETIRED_FLASH_ALIAS,
      DEEPSEEK_HARNESS_FLASH_BASENAME,
    ],
    capabilities: createModelCapabilities({
      optionDescriptors: [DEEPSEEK_HARNESS_EFFORT_OPTION_DESCRIPTOR],
    }),
  },
  {
    slug: "deepseek-official/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    isCustom: false,
    aliases: ["deepseek-v4-pro"],
    capabilities: createModelCapabilities({
      optionDescriptors: [DEEPSEEK_HARNESS_EFFORT_OPTION_DESCRIPTOR],
    }),
  },
];

type SelectEntry = {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null | undefined;
};

/** The harness groups its catalog by provider; flatten the groups T3 renders flat. */
function selectEntries(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<SelectEntry> {
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name, description: entry.description }]
      : entry.options.map((nested) => ({
          value: nested.value,
          name: nested.name,
          description: nested.description,
        })),
  );
}

function reasoningCapabilities(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ModelCapabilities {
  const reasoning = options?.find(
    (option) => option.id === "reasoning_effort" || option.id === DEEPSEEK_HARNESS_EFFORT_OPTION_ID,
  );
  if (reasoning?.type !== "select") return EMPTY_CAPABILITIES;
  const current = typeof reasoning.currentValue === "string" ? reasoning.currentValue : undefined;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: DEEPSEEK_HARNESS_EFFORT_OPTION_ID,
        label: "Reasoning",
        type: "select",
        options: selectEntries(reasoning).map((entry) => ({
          id: entry.value,
          label: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.value === current ? { isDefault: true } : {}),
        })),
        ...(current === undefined ? {} : { currentValue: current }),
      },
    ],
  });
}

/**
 * V4.1 Flash is the default even on a machine whose saved harness selection is
 * an older model; the harness's own current model only wins when the catalog
 * does not list Flash at all.
 */
export function buildDeepseekHarnessModels(input: {
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly customModels?: ReadonlyArray<CustomModelSetting>;
}): ReadonlyArray<ServerProviderModel> {
  const model = input.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const current = model?.type === "select" ? model.currentValue : undefined;
  const capabilities = reasoningCapabilities(input.configOptions);
  const entries = selectEntries(model);
  const flash = entries.find(
    (entry) =>
      deepseekHarnessModelSlug(entry.value).split("/").at(-1) === DEEPSEEK_HARNESS_FLASH_BASENAME,
  );
  const defaultEntry = flash ?? entries.find((entry) => entry.value === current);
  const discovered: ServerProviderModel[] = entries.map((entry) => {
    const slug = deepseekHarnessModelSlug(entry.value);
    const basename = slug.slice(slug.lastIndexOf("/") + 1);
    const isDefault = defaultEntry !== undefined && entry.value === defaultEntry.value;
    const aliases = [
      ...(isDefault ? [DEEPSEEK_HARNESS_DEFAULT_MODEL_SLUG] : []),
      // Threads saved before the API exposed `deepseek-flash` still carry the
      // retired slug; destination catalogs must resolve it for native moves.
      ...(basename === DEEPSEEK_HARNESS_FLASH_BASENAME
        ? [DEEPSEEK_HARNESS_RETIRED_FLASH_ALIAS, DEEPSEEK_HARNESS_FLASH_BASENAME]
        : // Live catalog slugs are qualified; keep the bare basename resolvable too.
          [basename]),
    ];
    return {
      slug,
      name: entry.name.trim() || slug,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      ...(aliases.length > 0 ? { aliases: [...new Set(aliases)] } : {}),
      capabilities,
    };
  });
  return providerModelsFromSettings(
    discovered.length > 0 ? discovered : FALLBACK_MODELS,
    input.customModels ?? [],
    capabilities,
  );
}

export const buildInitialDeepseekHarnessProviderSnapshot = (
  settings: DeepseekHarnessSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      driver: DEEPSEEK_HARNESS_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: buildDeepseekHarnessModels({ customModels: settings.customModels }),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown", type: "api-key", label: "DeepSeek API key" },
        message: settings.enabled
          ? "Checking DeepSeek Harness availability..."
          : "DeepSeek Harness is disabled in T3 Code settings.",
      },
    }),
  );

const runVersionProbe = Effect.fn("runVersionProbe")(function* (
  settings: DeepseekHarnessSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath.trim() || "dsh";
  const args = ["--profile", settings.profile.trim() || "acp", "--version"];
  const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawn.command, spawn.args, {
      env: environment,
      extendEnv: false,
      shell: spawn.shell,
    }),
  ).pipe(Effect.timeoutOption(VERSION_TIMEOUT));
});

export interface DeepseekHarnessCatalog {
  readonly initialize: EffectAcpSchema.InitializeResponse | undefined;
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined;
}

/** Opens one throwaway session, because this build only publishes its catalog per session. */
const probeDeepseekHarnessCatalog = Effect.fn("probeDeepseekHarnessCatalog")(function* (input: {
  readonly settings: DeepseekHarnessSettings;
  readonly dshHome: string;
  readonly apiKey: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): Effect.fn.Return<
  Option.Option<DeepseekHarnessCatalog>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const probed = yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeDeepseekHarnessAcpRuntime({
        settings: input.settings,
        dshHome: input.dshHome,
        apiKey: input.apiKey,
        environment: input.environment,
        cwd: input.cwd,
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      const initialize = yield* runtime.initialize();
      yield* runtime.start();
      const configOptions = yield* runtime.getConfigOptions;
      yield* runtime.closeSession().pipe(Effect.catch(() => Effect.void));
      return { initialize, configOptions } satisfies DeepseekHarnessCatalog;
    }),
  ).pipe(
    Effect.timeoutOption(INITIALIZE_TIMEOUT),
    Effect.catch((cause) =>
      Effect.logWarning("DeepSeek Harness ACP catalog probe failed.", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  return probed;
});

export const checkDeepseekHarnessProviderStatus = Effect.fn("checkDeepseekHarnessProviderStatus")(
  function* (input: {
    readonly settings: DeepseekHarnessSettings;
    readonly dshHome: string;
    readonly apiKey: string | undefined;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
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
    const auth = (
      status: "authenticated" | "unauthenticated" | "unknown",
    ): ProviderProbeResult["auth"] =>
      ({ status, type: "api-key", label: "DeepSeek API key" }) as const;

    if (!input.settings.enabled) {
      return buildServerProvider({
        driver: DEEPSEEK_HARNESS_DRIVER_KIND,
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: auth("unknown"),
          message: "DeepSeek Harness is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runVersionProbe(input.settings, environment).pipe(
      Effect.catch((cause) =>
        isCommandMissingCause(cause)
          ? Effect.succeedNone
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
        driver: DEEPSEEK_HARNESS_DRIVER_KIND,
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: auth(input.apiKey === undefined ? "unauthenticated" : "authenticated"),
          message:
            "DeepSeek Harness executable was not found. Set the launcher in provider settings.",
        },
      });
    }

    const catalog = yield* probeDeepseekHarnessCatalog({
      settings: input.settings,
      dshHome: input.dshHome,
      apiKey: input.apiKey,
      environment,
      cwd: input.cwd,
    });
    const probed = Option.getOrUndefined(catalog);
    const authenticated = input.apiKey !== undefined;
    const supportsNativeLifecycle = deepseekHarnessSupportsNativeLifecycle(probed?.initialize);
    const models = buildDeepseekHarnessModels({
      customModels: input.settings.customModels,
      ...(probed?.configOptions === undefined ? {} : { configOptions: probed.configOptions }),
    });
    return buildServerProvider({
      driver: DEEPSEEK_HARNESS_DRIVER_KIND,
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parseGenericCliVersion(Option.getOrElse(versionOutput, () => "")),
        status: authenticated && supportsNativeLifecycle ? "ready" : "warning",
        auth: auth(authenticated ? "authenticated" : "unauthenticated"),
        ...(authenticated
          ? supportsNativeLifecycle
            ? probed === undefined
              ? { message: "Harness is installed, but its ACP catalog probe did not complete." }
              : {}
            : { message: "This Harness build lacks native load/fork. Install a T3-enabled build." }
          : { message: "Add a DeepSeek API key to start a session." }),
      },
    });
  },
);
