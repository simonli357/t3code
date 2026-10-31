import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { DeepseekHarnessSettings } from "../settings.ts";

export const DEEPSEEK_HARNESS_DRIVER_KIND = ProviderDriverKind.make("deepseekHarness");
/** T3's slug for the harness's current model, whatever the catalog names it. */
export const DEEPSEEK_HARNESS_DEFAULT_MODEL_SLUG = "deepseek-harness-default";
/** Threads saved while the API exposed `deepseek-v4-flash` still carry that slug. */
export const DEEPSEEK_HARNESS_RETIRED_FLASH_ALIAS = "deepseek-v4-flash";
export const DEEPSEEK_HARNESS_FLASH_BASENAME = "deepseek-flash";
const MODEL_CONFIG_ID = "model";
/** T3 stores effort under the harness's own config id, so no translation can drift. */
export const DEEPSEEK_HARNESS_EFFORT_OPTION_ID = "reasoning_effort";
const EFFORT_CONFIG_ID = DEEPSEEK_HARNESS_EFFORT_OPTION_ID;

export const DEEPSEEK_HARNESS_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  low: "Low",
  high: "High",
  max: "Max",
};

/** Fallback effort choices for a catalog probe that has not completed yet. */
export const DEEPSEEK_HARNESS_EFFORT_OPTION_DESCRIPTOR: ProviderOptionDescriptor = {
  id: DEEPSEEK_HARNESS_EFFORT_OPTION_ID,
  label: "Reasoning",
  type: "select",
  options: Object.entries(EFFORT_LABELS).map(([id, label]) => ({
    id,
    label,
    ...(id === "high" ? { isDefault: true } : {}),
  })),
};

/** The harness selects models as `["provider","model"]`; T3 shows `provider/model`. */
export function deepseekHarnessModelSlug(optionValue: string): string {
  try {
    const parsed: unknown = JSON.parse(optionValue);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch {}
  return optionValue;
}

function modelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find(
    (option) => option.id === MODEL_CONFIG_ID || option.category === "model",
  );
}

/**
 * Maps a T3 slug onto the harness's option value. A saved
 * `deepseek-v4-flash` slug drives the live `deepseek-flash` model, because the
 * API renamed it and old threads must keep running.
 */
export function deepseekHarnessModelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  slug: string | null | undefined,
): string | undefined {
  const model = modelConfigOption(configOptions);
  if (model?.type !== "select") return undefined;
  if (!slug) return model.currentValue;
  const wanted =
    slug === DEEPSEEK_HARNESS_RETIRED_FLASH_ALIAS ? DEEPSEEK_HARNESS_FLASH_BASENAME : slug;
  return collectSessionConfigOptionValues(model).find((value) => {
    const qualified = deepseekHarnessModelSlug(value);
    return (
      value === wanted ||
      qualified === wanted ||
      qualified.slice(qualified.lastIndexOf("/") + 1) === wanted
    );
  });
}

export const applyDeepseekHarnessModelSelection = Effect.fn("applyDeepseekHarnessModelSelection")(
  function* (
    runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "getConfigOptions" | "setModel">,
    modelSelection: ModelSelection,
  ): Effect.fn.Return<string | undefined, EffectAcpErrors.AcpError> {
    const options = yield* runtime.getConfigOptions;
    const option = deepseekHarnessModelOption(options, modelSelection.model);
    if (option !== undefined) {
      yield* runtime.setModel(option);
    }
    return option === undefined ? undefined : deepseekHarnessModelSlug(option);
  },
);

/** The shared option loop writes a stored effort; a thread without one keeps the harness default. */
export const applyDeepseekHarnessEffort = Effect.fn("applyDeepseekHarnessEffort")(function* (
  runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >,
  modelSelection: ModelSelection,
): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
  const effort = getModelSelectionStringOptionValue(modelSelection, EFFORT_CONFIG_ID);
  if (effort === undefined) return;
  const option = (yield* runtime.getConfigOptions).find(
    (entry) => entry.id === EFFORT_CONFIG_ID && entry.type === "select",
  );
  if (option === undefined) return;
  if (!collectSessionConfigOptionValues(option).includes(effort)) return;
  yield* runtime.setConfigOption(EFFORT_CONFIG_ID, effort);
});

/** Compaction is a harness request rather than a model-visible `/compact` prompt. */
export const requestDeepseekHarnessCompaction = Effect.fn("requestDeepseekHarnessCompaction")(
  function* (
    runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
    sessionId: string,
  ): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
    yield* runtime.request("deepseek-harness/compact", { sessionId });
  },
);

export interface DeepseekHarnessAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "cancelBehavior" | "clientCapabilities"
> {
  readonly settings: DeepseekHarnessSettings;
  readonly dshHome: string;
  readonly apiKey: string | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeDeepseekHarnessAcpRuntime = Effect.fn("makeDeepseekHarnessAcpRuntime")(function* (
  input: DeepseekHarnessAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const { settings, dshHome, apiKey, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: settings.binaryPath.trim() || "dsh",
        args: ["--profile", settings.profile.trim() || "acp"],
        cwd: input.cwd,
        env: {
          ...environment,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
        },
      },
      // The harness answers a cancelled prompt with its own stop reason.
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

/** The harness reports its ACP fork/load lifecycle; a build without it cannot resume or fork. */
export function deepseekHarnessSupportsNativeLifecycle(
  initializeResult: EffectAcpSchema.InitializeResponse | undefined,
): boolean {
  return (
    initializeResult?.agentCapabilities?.loadSession === true &&
    initializeResult.agentCapabilities.sessionCapabilities?.fork !== undefined
  );
}

export type DeepseekHarnessRuntimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy;
