import { assert, it } from "@effect/vitest";

import {
  applyPreferredCodexDefaultModel,
  mapCodexModelCapabilities,
  resolveCodexUsageSource,
} from "./CodexProvider.ts";

it("keeps custom Codex model providers outside the OpenAI subscription allowance", () => {
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: {
        type: "chatgpt",
        email: "shared@example.com",
        planType: "pro",
      },
      config: {
        kind: "available",
        config: {
          model_provider: "deepseek",
          model_providers: {
            deepseek: { name: "DeepSeek" },
          },
        },
      },
    }),
    { kind: "apiKey", label: "DeepSeek API key" },
  );
});

it("recognizes native ChatGPT, API-key, and Bedrock Codex auth sources", () => {
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
      config: { kind: "available", config: { model_provider: "openai" } },
    }),
    { kind: "subscription" },
  );
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "apiKey" },
      config: { kind: "available", config: { model_provider: "openai" } },
    }),
    { kind: "apiKey", label: "OpenAI API Key" },
  );
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "amazonBedrock" },
      config: { kind: "available", config: { model_provider: "openai" } },
    }),
    { kind: "apiKey", label: "Amazon Bedrock" },
  );
});

it("does not infer subscription quota when the effective config cannot be read", () => {
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "chatgpt", email: "unrelated@example.com", planType: "pro" },
      config: { kind: "unavailable" },
    }),
    {
      kind: "unverified",
      message: "Could not verify which model provider Codex is using.",
    },
  );
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "apiKey" },
      config: { kind: "unavailable" },
    }),
    { kind: "apiKey", label: "OpenAI API Key" },
  );
});

it("accepts the default OpenAI model provider as a subscription source", () => {
  assert.deepStrictEqual(
    resolveCodexUsageSource({
      account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
      config: { kind: "available", config: {} },
    }),
    { kind: "subscription" },
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
