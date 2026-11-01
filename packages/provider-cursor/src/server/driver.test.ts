// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as HttpClient from "effect/http/HttpClient";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { CursorDriver } from "./driver.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { Cursor } from "./sdk.ts";

const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("No host keychain access"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No provider network calls")),
    ),
  ),
);

it.layer(layer)("Cursor CLI driver", (it) => {
  it.effect(
    "retains browser credentials, uses the CLI account catalog, budgets context, and closes access on logout",
    () =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-driver-" });
        const fixture = NodeURL.fileURLToPath(
          new URL("./fixtures/acp-process.cjs", import.meta.url),
        );
        const binary = NodePath.join(cwd, platform === "win32" ? "cursor-test.cmd" : "cursor-test");
        yield* fs.writeFileString(
          binary,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
            : `#!/bin/sh\nexec '${process.execPath}' '${fixture}'\n`,
        );
        if (platform !== "win32") yield* fs.chmod(binary, 0o700);
        const catalog = NodePath.join(cwd, "catalog.json");
        const writeCatalog = (window: string) =>
          fs.writeFileString(
            catalog,
            JSON.stringify({
              models: [
                {
                  value: "test-model",
                  name: "Test",
                  configOptions: [
                    {
                      id: "context",
                      category: "model_config",
                      type: "select",
                      name: "Context",
                      currentValue: window,
                      options: [
                        { value: "300k", name: "300k" },
                        { value: "1m", name: "1m" },
                      ],
                    },
                  ],
                },
              ],
            }),
          );
        yield* writeCatalog("1m");
        const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
          options?.onLoginUrl?.("https://cursor.com/test-only");
          await options?.store?.save({
            version: 1,
            backendUrl: "https://api2.cursor.sh",
            apiKey: "synthetic-browser-key",
            createdAtMs: 0,
            apiKeyExpiresAtMs: 4_000_000_000_000,
          });
          return { apiKey: "synthetic-browser-key", apiKeyExpiresAtMs: 4_000_000_000_000 };
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => login.mockRestore()));
        const instanceId = ProviderInstanceId.make("cursor-browser-test");
        const input = {
          instanceId,
          displayName: "Cursor",
          enabled: true,
          config: { ...CursorDriver.defaultConfig(), binaryPath: binary },
          environment: [
            { name: "CURSOR_API_KEY", value: "", sensitive: true },
            { name: "TEST_CATALOG_FILE", value: catalog, sensitive: false },
          ],
        };
        const instance = yield* CursorDriver.create(input);
        expect((yield* instance.snapshot.refresh).status).toBe("error");
        yield* instance.auth!.start("client");
        yield* instance.auth!.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("authenticated");
        const threadId = ThreadId.make("cursor-driver-thread");
        const modelSelection = { instanceId, model: "test-model" };
        const runtimePolicy = {
          cwd,
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
          workspaceEnvironment: { HOME: cwd, USERPROFILE: cwd, TMP: cwd, TEMP: cwd },
        };
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-driver-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(runtime.getModelContextWindow?.(modelSelection)).toBe(1_000_000);
        yield* writeCatalog("300k");
        yield* instance.snapshot.refresh;
        expect(runtime.getModelContextWindow?.(modelSelection)).toBe(300_000);
        expect(
          runtime.getModelContextWindow?.({
            ...modelSelection,
            options: [{ id: "contextWindow", value: "1m" }],
          }),
        ).toBe(1_000_000);
        const recreated = yield* CursorDriver.create(input);
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("authenticated");
        yield* instance.auth!.logout(Effect.void);
        expect((yield* recreated.snapshot.refresh).status).toBe("error");
        expect(
          (yield* instance.orchestrationAdapter
            .openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("after-logout"),
              modelSelection,
              runtimePolicy,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped),
  );
});
