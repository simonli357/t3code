import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { buildDeepseekHarnessModels } from "./status.ts";

const FLASH = '["deepseek-official","deepseek-flash"]';
const LEGACY_FLASH = '["deepseek-official","deepseek-v4-flash"]';
const PRO = '["deepseek-official","deepseek-v4-pro"]';

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: LEGACY_FLASH,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: LEGACY_FLASH, name: "deepseek-v4-flash" },
          { value: FLASH, name: "DeepSeek-V4.1-Flash" },
          { value: PRO, name: "DeepSeek-V4-Pro" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
] as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("DeepSeek Harness models", () => {
  it("lists the live catalog and makes V4.1 Flash the default", () => {
    const models = buildDeepseekHarnessModels({ configOptions });
    assert.deepEqual(
      models.map((model) => [model.slug, model.isDefault === true]),
      [
        ["deepseek-official/deepseek-v4-flash", false],
        ["deepseek-official/deepseek-flash", true],
        ["deepseek-official/deepseek-v4-pro", false],
      ],
    );
    const flash = models[1];
    assert.deepEqual(flash?.aliases, [
      "deepseek-harness-default",
      "deepseek-v4-flash",
      "deepseek-flash",
    ]);
    const reasoning = flash?.capabilities?.optionDescriptors?.[0];
    assert.equal(reasoning?.id, "reasoning_effort");
    assert.deepEqual(
      reasoning?.type === "select" ? reasoning.options.map((option) => option.id) : [],
      ["off", "low", "high", "max"],
    );
    assert.equal(
      reasoning?.type === "select"
        ? reasoning.options.find((option) => option.isDefault)?.id
        : null,
      "high",
    );
  });

  it("falls back to Flash and Pro while the catalog probe has not completed", () => {
    const models = buildDeepseekHarnessModels({});
    assert.deepEqual(
      models.map((model) => model.slug),
      ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"],
    );
    assert.equal(models[0]?.isDefault, true);
  });
});
