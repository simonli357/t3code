import { describe, expect, it } from "@effect/vitest";

import { buildDeepseekHarnessModels } from "./DeepseekHarnessProvider.ts";

describe("buildDeepseekHarnessModels", () => {
  it("advertises the official models and move-compatible reasoning options before a session starts", () => {
    const models = buildDeepseekHarnessModels({});

    expect(models.map((model) => model.slug)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);

    for (const model of models) {
      const reasoning = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "reasoning_effort",
      );
      expect(reasoning).toMatchObject({
        type: "select",
        options: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
      });
    }
  });
});
