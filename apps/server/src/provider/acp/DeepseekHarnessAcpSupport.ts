import { type DeepseekHarnessSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildAcpPrompt } from "./AcpPrompt.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** DSH fork commit containing the T3 ACP lifecycle used by this adapter. */
export const DEEPSEEK_HARNESS_T3_COMMIT = "8e02db92bd0cb21e0792338dbfdc24b5e013fb9c";
export const DEEPSEEK_HARNESS_T3_SOURCE = `https://github.com/simonli357/deepseek-harness/tree/${DEEPSEEK_HARNESS_T3_COMMIT}`;

export interface DeepseekHarnessAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "cancelBehavior" | "clientCapabilities" | "resumeMethod" | "spawn"
> {
  readonly settings: DeepseekHarnessSettings;
  readonly dshHome: string;
  readonly apiKey: string | undefined;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  readonly workspaceEnvironment?: Readonly<Record<string, string>>;
}

export const makeDeepseekHarnessAcpRuntime = Effect.fn("makeDeepseekHarnessAcpRuntime")(function* (
  input: DeepseekHarnessAcpRuntimeInput,
) {
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: "deepseek-api-key",
      resumeMethod: "load",
      cancelBehavior: "wait-for-prompt",
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      spawn: {
        command: input.settings.binaryPath.trim() || "dsh",
        args: ["--profile", input.settings.profile.trim() || "acp"],
        cwd: input.cwd,
        env: {
          ...(input.baseEnvironment ?? process.env),
          ...input.agentDeviceEnvironment,
          ...input.workspaceEnvironment,
          DSH_HOME: input.dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          ...(input.apiKey ? { DEEPSEEK_API_KEY: input.apiKey } : {}),
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

export const DEEPSEEK_HARNESS_CANCEL_TIMEOUT = "20 seconds";

export function deepseekHarnessPermissionMode(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? "danger-full-access" : "workspace-write";
}

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

export function deepseekHarnessModelOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  slug: string | null | undefined,
): string | undefined {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return undefined;
  if (!slug) return model.currentValue;
  // Threads saved before the API exposed `deepseek-flash` still select the
  // retired slug; drive the live session with the model the catalog offers.
  const wanted = slug === "deepseek-v4-flash" ? "deepseek-flash" : slug;
  const values = model.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
  return values.find((value) => {
    const qualified = deepseekHarnessModelSlug(value);
    return (
      value === wanted ||
      qualified === wanted ||
      qualified.slice(qualified.lastIndexOf("/") + 1) === wanted
    );
  });
}

export const applyDeepseekHarnessModelSelection = Effect.fn("applyDeepseekHarnessModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setConfigOption"
    >;
    readonly model: string | null | undefined;
    readonly reasoningEffort?: string | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const options = yield* input.runtime.getConfigOptions;
    const option = deepseekHarnessModelOption(options, input.model);
    if (option !== undefined) {
      yield* input.runtime.setModel(option).pipe(Effect.mapError(input.mapError));
    }
    if (input.reasoningEffort !== undefined) {
      yield* input.runtime
        .setConfigOption("reasoning_effort", input.reasoningEffort)
        .pipe(Effect.mapError(input.mapError));
    }
    return option === undefined ? undefined : deepseekHarnessModelSlug(option);
  },
);

export const buildDeepseekHarnessPrompt = buildAcpPrompt;
