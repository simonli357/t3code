import { TextGenerationError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";

import { DeepseekHarnessSettings } from "../settings.ts";
import {
  DEEPSEEK_HARNESS_DRIVER_KIND,
  type DeepseekHarnessAdapterV2DriverEnv,
  makeDeepseekHarnessAdapterV2Driver,
} from "./adapter.ts";
import { makeDeepseekHarnessAuth } from "./auth.ts";
import {
  buildInitialDeepseekHarnessProviderSnapshot,
  checkDeepseekHarnessProviderStatus,
} from "./status.ts";

const decodeSettings = Schema.decodeSync(DeepseekHarnessSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DEEPSEEK_HARNESS_DRIVER_KIND,
  packageName: null,
});

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "DeepSeek Harness does not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export type DeepseekHarnessDriverEnv =
  | DeepseekHarnessAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

/**
 * A configured `$DSH_HOME` wins, then the environment's, then a per-instance
 * directory so two instances never share saved sessions or profiles.
 */
export const resolveDeepseekHarnessHome = Effect.fn("resolveDeepseekHarnessHome")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly stateDir: string;
    readonly settings: Pick<DeepseekHarnessSettings, "homePath">;
    readonly environment: NodeJS.ProcessEnv;
    readonly home: string;
  }): Effect.fn.Return<string, never, Crypto.Crypto | Path.Path> {
    const path = yield* Path.Path;
    const configured = input.settings.homePath.trim() || input.environment.DSH_HOME?.trim() || "";
    if (configured) return path.resolve(expandHomePath(configured, input.home));
    const crypto = yield* Crypto.Crypto;
    const key = Hex.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.instanceId))
        .pipe(Effect.orDie),
    );
    return path.join(input.stateDir, "providers", "deepseek-harness", key);
  },
);

export const DeepseekHarnessDriver: ProviderDriver<
  DeepseekHarnessSettings,
  DeepseekHarnessDriverEnv
> = {
  driverKind: DEEPSEEK_HARNESS_DRIVER_KIND,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true },
  configSchema: DeepseekHarnessSettings,
  defaultConfig: (): DeepseekHarnessSettings => decodeSettings({}),
  create: Effect.fn("DeepseekHarnessDriver.create")(function* (input) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const hostEnvironment = yield* HostProcess.Environment;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      input.environment,
      hostEnvironment,
    );
    const effectiveConfig = {
      ...input.config,
      enabled: input.enabled,
    } satisfies DeepseekHarnessSettings;
    const dshHome = yield* resolveDeepseekHarnessHome({
      instanceId: input.instanceId,
      stateDir: host.paths.stateDir,
      settings: effectiveConfig,
      environment: processEnvironment,
      home: hostEnvironment.HOME ?? hostEnvironment.USERPROFILE ?? host.paths.baseDir,
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(Path.Path, path));
    const auth = yield* makeDeepseekHarnessAuth({ instanceId: input.instanceId });
    const readApiKey = auth.readApiKey.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the DeepSeek Harness API key.", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DEEPSEEK_HARNESS_DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId: input.instanceId,
      driverKind: DEEPSEEK_HARNESS_DRIVER_KIND,
      displayName: input.displayName,
      accentColor: input.accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<DeepseekHarnessSettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialDeepseekHarnessProviderSnapshot(settings.provider).pipe(
          Effect.map(stampIdentity),
        ),
      checkProvider: Effect.gen(function* () {
        const apiKey = yield* readApiKey;
        return yield* checkDeepseekHarnessProviderStatus({
          settings: effectiveConfig,
          dshHome,
          apiKey,
          environment: processEnvironment,
          cwd: host.paths.cwd,
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.map(stampIdentity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DEEPSEEK_HARNESS_DRIVER_KIND,
            instanceId: input.instanceId,
            detail: "Failed to build the DeepSeek Harness provider snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeDeepseekHarnessAdapterV2Driver({
      dshHome,
      apiKey: readApiKey,
    })
      .create({
        instanceId: input.instanceId,
        displayName: input.displayName,
        accentColor: input.accentColor,
        environment: input.environment,
        enabled: input.enabled,
        config: effectiveConfig,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DEEPSEEK_HARNESS_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to build the DeepSeek Harness orchestration adapter.",
              cause,
            }),
        ),
      );

    return {
      instanceId: input.instanceId,
      driverKind: DEEPSEEK_HARNESS_DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: unsupportedTextGeneration,
      auth: auth.controller,
    } satisfies ProviderInstance;
  }),
};
