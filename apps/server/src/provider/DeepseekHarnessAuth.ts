import {
  ProviderSetupError,
  type ProviderAuthInteraction,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

const METHOD_ID = "deepseek-api-key";
const CREDENTIAL_VERSION = 1;

type Credentials = {
  readonly version: typeof CREDENTIAL_VERSION;
  readonly apiKey: string;
};

export const methods: ReadonlyArray<ProviderAuthMethod> = [
  {
    id: METHOD_ID,
    name: "DeepSeek API key",
    description: "Billed to the DeepSeek API account. Subscription windows are not available.",
    type: "credentials",
  },
];

export function decodeApiKey(value: Uint8Array | undefined): string | undefined {
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

export const makeDeepseekHarnessAuth = Effect.fn("makeDeepseekHarnessAuth")(function* (input: {
  readonly instanceId: ProviderInstanceId;
}) {
  const credentialStore = yield* ProviderCredentialStore.make(
    "deepseekHarness",
    input.instanceId,
  );
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: input.instanceId, operation, detail });
  const read = credentialStore.get.pipe(
    Effect.map((value) => decodeApiKey(Option.getOrUndefined(value))),
    Effect.mapError(() => setupError("read", "Could not read the saved DeepSeek API key.")),
  );
  const controller = yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    credentialBinding: credentialStore.binding,
    methods: Effect.succeed(methods),
    defaultMethodId: METHOD_ID,
    authenticate: (_methodId, context) =>
      Effect.gen(function* () {
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
        yield* credentialStore.set(encodeApiKey(apiKey)).pipe(
          Effect.mapError(() =>
            setupError("start", "Could not save the DeepSeek API key securely."),
          ),
        );
      }).pipe(Effect.scoped),
    logout: credentialStore.remove.pipe(
      Effect.mapError(() =>
        setupError("logout", "Could not remove the saved DeepSeek API key."),
      ),
      Effect.as("DeepSeek API key removed."),
    ),
  });
  return {
    controller,
    read,
    withAccess: controller.withAccess!,
  };
});
