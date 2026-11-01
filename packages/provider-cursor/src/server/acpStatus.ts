import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  buildServerProvider,
  providerModelsFromSettings,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import type { CursorSettings } from "../settings.ts";
import { buildCursorDiscoveredModelsFromAvailableModelsResponse } from "./acpModel.ts";

const Choice = Schema.Struct({ value: Schema.String, name: Schema.String });
const ConfigBase = {
  id: Schema.optionalKey(Schema.String),
  configId: Schema.optionalKey(Schema.String),
  name: Schema.String,
  category: Schema.optionalKey(Schema.NullOr(Schema.String)),
};
const Config = Schema.Union([
  Schema.Struct({
    ...ConfigBase,
    type: Schema.Literal("select"),
    currentValue: Schema.String,
    options: Schema.Array(
      Schema.Union([
        Choice,
        Schema.Struct({ group: Schema.String, options: Schema.Array(Choice) }),
      ]),
    ),
  }),
  Schema.Struct({ ...ConfigBase, type: Schema.Literal("boolean"), currentValue: Schema.Boolean }),
]);
const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      name: Schema.String,
      configOptions: Schema.optionalKey(Schema.Array(Config)),
    }),
  ),
});

const decodeCatalog = Schema.decodeUnknownEffect(Catalog);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

/** Uses the same account, endpoint and CLI as turns, without creating a native session. */
export const checkCursorAcpStatus = Effect.fn("checkCursorAcpStatus")(function* (
  settings: CursorSettings,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = providerModelsFromSettings(
    [],
    settings.customModels,
    createModelCapabilities({ optionDescriptors: [] }),
  );
  const base = {
    checkedAt,
    enabled: settings.enabled,
    models,
    presentation: {
      displayName: "Cursor",
      supportsConversationRollback: false,
      showInteractionModeToggle: true,
    },
  };
  if (!settings.enabled)
    return buildServerProvider({
      ...base,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in T3 Code settings.",
      },
    });
  const cwd = environment.USERPROFILE || environment.HOME || (yield* HostProcess.HomeDirectory);
  let initialized = false;
  const probe = Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        cwd,
        spawn: {
          command: settings.binaryPath || "cursor-agent",
          args: [...(settings.apiEndpoint ? ["-e", settings.apiEndpoint] : []), "acp"],
          cwd,
          env: environment,
          extendEnv: false,
        },
        clientInfo: { name: "t3-code", version: "0.0.0" },
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
        authenticateOnAuthRequired: false,
      }),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    yield* runtime.initialize();
    initialized = true;
    yield* runtime.authenticate!("cursor_login");
    const raw = yield* runtime.request("cursor/list_available_models", {});
    const catalog = yield* decodeCatalog(raw);
    return yield* Effect.try(() =>
      buildCursorDiscoveredModelsFromAvailableModelsResponse({
        models: catalog.models.map((model) => ({
          ...model,
          configOptions:
            model.configOptions?.map((option): AcpSchema.SessionConfigOption => {
              const id = option.id ?? option.configId;
              if (!id) throw new Error("Cursor catalog option has no ID.");
              return option.type === "select"
                ? {
                    ...option,
                    id,
                    options: option.options.flatMap((entry) =>
                      "value" in entry ? [entry] : entry.options,
                    ),
                  }
                : { ...option, id };
            }) ?? [],
        })),
      }),
    );
  }).pipe(Effect.scoped, Effect.timeout("15 seconds"));
  return yield* probe.pipe(
    Effect.map((discovered) =>
      buildServerProvider({
        ...base,
        models: [...discovered, ...models],
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
        },
      }),
    ),
    Effect.orElseSucceed((cause) =>
      buildServerProvider({
        ...base,
        probe: {
          installed: initialized,
          version: null,
          status: "error",
          auth: {
            status:
              isAcpRequestError(cause) && cause.code === -32000 ? "unauthenticated" : "unknown",
          },
          message:
            "Cursor CLI initialization or authentication failed. Check this provider's binary path and environment; sign in with that CLI account, then refresh.",
        },
      }),
    ),
  );
});
