import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  deepseekReasoningOptionId,
  isAllowedDeepseekModel,
  isDeepseekModel,
  pinDeepseekModelSelection,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { ProviderValidationError } from "./Errors.ts";

export const enforceDeepseekModelSelection = (
  driver: string,
  instanceId: ProviderInstanceId,
  selection: ModelSelection | undefined,
  operation: string,
): Effect.Effect<ModelSelection | undefined, ProviderValidationError> =>
  isAllowedDeepseekModel(driver, instanceId, selection?.model)
    ? Effect.succeed(pinDeepseekModelSelection(driver, instanceId, selection))
    : Effect.fail(
        new ProviderValidationError({
          operation,
          issue:
            "DeepSeek is restricted to V4.1 Flash with max reasoning. Select DeepSeek V4.1 Flash.",
        }),
      );

/** Apply after cache merging so old catalogs cannot restore disabled models or efforts. */
export function restrictDeepseekProvider(provider: ServerProvider): ServerProvider {
  if (
    !provider.models.some((model) =>
      isDeepseekModel(provider.driver, provider.instanceId, model.slug),
    )
  ) {
    return provider;
  }
  const models = provider.models
    .filter(
      (model) =>
        isAllowedDeepseekModel(provider.driver, provider.instanceId, model.slug) &&
        !model.slug.endsWith("deepseek-v4-flash"),
    )
    .map((model) =>
      !isDeepseekModel(provider.driver, provider.instanceId, model.slug)
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              optionDescriptors: [
                ...(model.capabilities?.optionDescriptors ?? []).filter(
                  (option) =>
                    ![
                      "reasoningEffort",
                      "reasoning_effort",
                      "thought_level",
                      "effort",
                      "variant",
                    ].includes(option.id),
                ),
                {
                  id: deepseekReasoningOptionId(provider.driver),
                  label: "Reasoning",
                  type: "select" as const,
                  currentValue: "max",
                  options: [{ id: "max", label: "Max", isDefault: true }],
                },
              ],
            },
          },
    );
  return {
    ...provider,
    models: models.some((model) => model.isDefault)
      ? models
      : models.map((model, index) => (index === 0 ? { ...model, isDefault: true } : model)),
  };
}
