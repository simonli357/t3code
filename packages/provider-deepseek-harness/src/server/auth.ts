import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";

const METHOD_ID = "deepseek-api-key";
const CREDENTIAL_VERSION = 1;
const CREDENTIAL_NAMESPACE = "deepseekHarness";

export const deepseekHarnessAuthMethods: ReadonlyArray<ProviderAuthMethod> = [
  {
    id: METHOD_ID,
    name: "DeepSeek API key",
    description: "Billed to the DeepSeek API account. Subscription windows are not available.",
    type: "credentials",
  },
];

export function decodeDeepseekHarnessApiKey(value: Uint8Array | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      parsed.version === CREDENTIAL_VERSION &&
      "apiKey" in parsed &&
      typeof parsed.apiKey === "string"
    ) {
      const apiKey = parsed.apiKey.trim();
      return apiKey.length > 0 ? apiKey : undefined;
    }
  } catch {}
  return undefined;
}

const encodeApiKey = (apiKey: string) =>
  new TextEncoder().encode(JSON.stringify({ version: CREDENTIAL_VERSION, apiKey }));

export interface DeepseekHarnessAuth {
  readonly controller: ProviderAuthController;
  readonly readApiKey: Effect.Effect<string | undefined, ProviderSetupError>;
}

export const makeDeepseekHarnessAuth = Effect.fn("makeDeepseekHarnessAuth")(function* (input: {
  readonly instanceId: ProviderInstanceId;
}) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
    CREDENTIAL_NAMESPACE,
    input.instanceId,
  );
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation, detail });
  const readApiKey = credentials.get.pipe(
    Effect.map((value) => decodeDeepseekHarnessApiKey(Option.getOrUndefined(value))),
    Effect.mapError(() => setupError("read", "Could not read the saved DeepSeek API key.")),
  );
  const controller = yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    credentialBinding: credentials.binding,
    methods: Effect.succeed(deepseekHarnessAuthMethods),
    defaultMethodId: METHOD_ID,
    authenticate: Effect.fn("DeepseekHarnessAuth.authenticate")(function* (
      _methodId: string,
      context: ProviderAuthFlow.ProviderAuthFlowContext,
    ) {
      const submitted = yield* Deferred.make<string>();
      const interaction: ProviderAuthInteraction = {
        type: "credentials",
        id: METHOD_ID,
        fields: [{ name: "apiKey", label: "DeepSeek API key", secret: true }],
      };
      yield* context.setInteraction(interaction, (response) =>
        Effect.gen(function* () {
          if (response.type !== "credentials") {
            return yield* setupError("start", "Enter a DeepSeek API key.");
          }
          const apiKey = response.values.apiKey?.trim();
          if (!apiKey) {
            return yield* setupError("start", "Enter a DeepSeek API key.");
          }
          yield* Deferred.succeed(submitted, apiKey);
        }),
      );
      const apiKey = yield* Deferred.await(submitted);
      yield* context.verifying;
      yield* credentials
        .set(encodeApiKey(apiKey))
        .pipe(
          Effect.mapError(() =>
            setupError("start", "Could not save the DeepSeek API key securely."),
          ),
        );
    }, Effect.scoped),
    logout: credentials.remove.pipe(
      Effect.mapError(() => setupError("logout", "Could not remove the saved DeepSeek API key.")),
      Effect.as("DeepSeek API key removed."),
    ),
  });
  return { controller, readApiKey } satisfies DeepseekHarnessAuth;
});
