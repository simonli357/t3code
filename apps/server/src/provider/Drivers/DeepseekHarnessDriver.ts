import {
  DeepseekHarnessSettings,
  ProviderDriverKind,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDeepseekHarnessAuth } from "../DeepseekHarnessAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepseekHarnessAdapter } from "../Layers/DeepseekHarnessAdapter.ts";
import {
  buildInitialDeepseekHarnessProviderSnapshot,
  checkDeepseekHarnessProviderStatus,
  deepseekHarnessProviderChanges,
} from "../Layers/DeepseekHarnessProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { resolveDeepseekHarnessHome } from "./DeepseekHarnessHome.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("deepseekHarness");
const decodeSettings = Schema.decodeSync(DeepseekHarnessSettings);

export type DeepseekHarnessDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerSecretStore.ServerSecretStore
  | ServerConfig
  | ServerSettingsService;

export const DeepseekHarnessDriver: ProviderDriver<
  DeepseekHarnessSettings,
  DeepseekHarnessDriverEnv
> = {
  driverKind: DRIVER,
  metadata: { displayName: "DeepSeek Harness", supportsMultipleInstances: true },
  configSchema: DeepseekHarnessSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies DeepseekHarnessSettings;
      const dshHome = yield* resolveDeepseekHarnessHome({
        instanceId,
        stateDir: serverConfig.stateDir,
        settings: effectiveConfig,
        environment: processEnvironment,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Path.Path, path),
      );
      const auth = yield* makeDeepseekHarnessAuth({ instanceId });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: null,
          }),
        ),
      );
      const readApiKey = auth.read.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the DeepSeek Harness API key.", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(
        effectiveConfig,
        serverSettings,
      );
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DeepseekHarnessSettings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        checkProviderOnSettingsChange: (previous, next) =>
          previous.enableProviderUpdateChecks === next.enableProviderUpdateChecks &&
          !deepseekHarnessProviderChanges(next.provider, previous.provider),
        initialSnapshot: (settings) =>
          buildInitialDeepseekHarnessProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider: Effect.gen(function* () {
          const settings = yield* snapshotSettings.getSettings;
          const apiKey = yield* readApiKey;
          return yield* checkDeepseekHarnessProviderStatus({
            settings: settings.provider,
            environment: processEnvironment,
            dshHome,
            apiKey,
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
              driver: DRIVER,
              instanceId,
              detail: `Failed to build DeepSeek Harness status: ${cause.message}`,
              cause,
            }),
        ),
      );

      const unsupportedTextGeneration = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation: operation as TextGenerationError["operation"],
            detail:
              "DeepSeek Harness text generation is not available. Choose another provider for generated text.",
          }),
        );
      const textGeneration = {
        generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
        generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
        generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
        generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
      } satisfies ProviderInstance["textGeneration"];
      const adapter = yield* makeDeepseekHarnessAdapter(effectiveConfig, {
        environment: processEnvironment,
        instanceId,
        dshHome,
        readApiKey,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        auth: auth.controller,
      } satisfies ProviderInstance;
    }),
};
