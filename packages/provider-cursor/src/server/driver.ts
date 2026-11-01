import {
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { checkCursorAcpStatus } from "./acpStatus.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import { type CursorAdapterV2DriverEnv } from "./adapter.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeCursorAcpAdapter } from "./acpAdapter.ts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot } from "./status.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "./skills.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";

import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type CursorDriverEnv =
  | Exclude<CursorAdapterV2DriverEnv, import("./CursorAgentSdk.ts").CursorAgentSdkRunner>
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderEventLoggers.ProviderEventLoggers
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | CursorSdk.CursorSdk
  | ProviderHost.ProviderHost
  | CursorKeychain.CursorKeychain;

export const CursorDriver: ProviderDriver<
  CursorSettings,
  CursorDriverEnv,
  CursorUsageAccounts.CursorUsageAccounts
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  usage: {
    kind: "scan",
    provider: "cursor",
    scan: ({ settings, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            keychainUsageEnabled: settings.cursorKeychainUsageEnabled,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  create: Effect.fn("CursorDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const keychain = yield* CursorKeychain.CursorKeychain;
    const selfInvocation = yield* resolveSelfInvocation();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: displayName ?? "Cursor",
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
    const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
      instanceId,
      path.join(
        host.paths.stateDir,
        "provider-auth",
        encodeURIComponent(instanceId),
        "cursor.json",
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Could not open the Cursor credential store.",
            cause,
          }),
      ),
    );
    const auth = yield* makeCursorAuth({
      instanceId,
      displayName: displayName ?? "Cursor",
      enabled,
      ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
      store: credentials.store,
      credentialBinding: credentials.binding,
      onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
        snapshot.refresh.pipe(
          Effect.flatMap((provider) =>
            !signedIn || provider.auth.status === "authenticated"
              ? Effect.void
              : Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                  }),
                ),
          ),
        ),
    });
    const stampSnapshot: typeof stampIdentity = (draft) =>
      stampIdentity({
        ...draft,
        setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
        auth: {
          ...draft.auth,
          canLogout: !auth.usesApiKey,
        },
      });

    let catalogModels: ReadonlyArray<ServerProviderModel> = [];
    const acpAdapter = yield* makeCursorAcpAdapter({
      instanceId,
      settings: effectiveConfig,
      environment: processEnv,
      readEnvironment: auth.readApiKey.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map((apiKey) => (apiKey ? { ...processEnv, CURSOR_API_KEY: apiKey } : processEnv)),
      ),
      selfInvocation,
      getModels: () => catalogModels,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: eventLoggers.native,
          provider: DRIVER_KIND,
          threadId,
        }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor orchestration adapter.",
            cause,
          }),
      ),
    );
    const orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      ...acpAdapter,
      openSession: (input) =>
        acpAdapter.openSession(input).pipe(
          auth.withAccess,
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: DRIVER_KIND,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    };
    const textGeneration = yield* makeCursorTextGeneration(
      effectiveConfig,
      processEnv,
      auth.requireApiKey,
      auth.withAccess,
    );

    const checkProvider = auth.readApiKey.pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.flatMap((apiKey) =>
        checkCursorAcpStatus(effectiveConfig, {
          ...processEnv,
          CURSOR_API_KEY: apiKey,
        }).pipe(
          Effect.filterOrElse(
            (snapshot) =>
              !(
                effectiveConfig.enabled &&
                snapshot.installed &&
                snapshot.auth.status === "authenticated"
              ),
            (snapshot) =>
              host.settings.get.pipe(
                Effect.flatMap((settings) =>
                  readCursorUsageLimits(
                    effectiveConfig,
                    { ...processEnv, CURSOR_API_KEY: apiKey },
                    settings.cursorKeychainUsageEnabled,
                  ),
                ),
                Effect.map((usageLimits) => ({ ...snapshot, usageLimits })),
              ),
          ),
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(CursorKeychain.CursorKeychain, keychain),
      Effect.map(stampSnapshot),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.tap((provider) =>
        Effect.sync(() => {
          // A failed check lists only custom models, so keep the last loaded catalog.
          if (provider.models.some((model) => !model.isCustom)) {
            catalogModels = provider.models;
          }
        }),
      ),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
      checkProvider,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Cursor snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probeCursorSkills(cwd, processEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
