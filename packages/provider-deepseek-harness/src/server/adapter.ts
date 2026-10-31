import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  applyDeepseekHarnessEffort,
  applyDeepseekHarnessModelSelection,
  DEEPSEEK_HARNESS_DRIVER_KIND,
  makeDeepseekHarnessAcpRuntime,
} from "./acpSupport.ts";
import {
  mergeProviderInstanceEnvironment,
  mergeWorkspaceEnvironment,
} from "@t3tools/provider-core/server/instanceEnvironment";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { DeepseekHarnessSettings } from "../settings.ts";

export { DEEPSEEK_HARNESS_DRIVER_KIND } from "./acpSupport.ts";

const DEFAULT_DEEPSEEK_HARNESS_SETTINGS = Schema.decodeSync(DeepseekHarnessSettings)({});

/**
 * The harness reads and writes files in its own session, streams reasoning and
 * tool updates over ACP, and negotiates native load/fork/resume.
 */
const DeepseekHarnessProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: true,
    canForkFromTurn: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DeepseekHarnessAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DeepseekHarnessSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly dshHome: string;
  readonly apiKey: Effect.Effect<string | undefined>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  /** Replaces the `dsh --profile acp` launch in replay tests. */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

function makeDeepseekHarnessAcpAdapterFlavor(
  options: DeepseekHarnessAdapterV2Options,
): AcpAdapterV2Flavor {
  return {
    driver: DEEPSEEK_HARNESS_DRIVER_KIND,
    runtimeHarness: "deepseek-harness",
    capabilities: DeepseekHarnessProviderCapabilitiesV2,
    // DSH keys a session's directory by the cwd in its header; relocation lets a moved or forked
    // session open under the workspace of the computer it now runs on.
    activationMeta: { load: { dshRelocate: true }, fork: { dshRelocate: true, dshAncestry: [] } },
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }: AcpAdapterV2RuntimeInput) =>
        Effect.gen(function* () {
          const apiKey = yield* options.apiKey;
          return yield* makeDeepseekHarnessAcpRuntime({
            ...input,
            settings: options.settings,
            dshHome: options.dshHome,
            apiKey,
            environment: mergeWorkspaceEnvironment(
              { ...options.environment, ...processEnvironment },
              runtimePolicy,
            ),
          });
        })),
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyDeepseekHarnessModelSelection(runtime, modelSelection).pipe(
        Effect.tap(() => applyDeepseekHarnessEffort(runtime, modelSelection)),
      ),
  };
}

const makeDeepseekHarnessAdapterV2 = Effect.fn("makeDeepseekHarnessAdapterV2")(function* (
  options: DeepseekHarnessAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeDeepseekHarnessAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type DeepseekHarnessAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeDeepseekHarnessAdapterV2Driver = (input: {
  readonly dshHome: string;
  readonly apiKey: Effect.Effect<string | undefined>;
}): ProviderAdapterDriver<DeepseekHarnessSettings, DeepseekHarnessAdapterV2DriverEnv> => ({
  driverKind: DEEPSEEK_HARNESS_DRIVER_KIND,
  configSchema: DeepseekHarnessSettings,
  defaultConfig: (): DeepseekHarnessSettings => DEFAULT_DEEPSEEK_HARNESS_SETTINGS,
  create: Effect.fn("DeepseekHarnessAdapterV2Driver.create")(
    function* (createInput: ProviderAdapterDriverCreateInput<DeepseekHarnessSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDeepseekHarnessAdapterV2({
        instanceId: createInput.instanceId,
        settings: { ...createInput.config, enabled: createInput.enabled },
        environment: yield* mergeProviderInstanceEnvironment(
          createInput.environment,
          hostEnvironment,
        ),
        selfInvocation,
        dshHome: input.dshHome,
        apiKey: input.apiKey,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DEEPSEEK_HARNESS_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, createInput) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DEEPSEEK_HARNESS_DRIVER_KIND,
              instanceId: createInput.instanceId,
              detail: "Failed to create the DeepSeek Harness ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
