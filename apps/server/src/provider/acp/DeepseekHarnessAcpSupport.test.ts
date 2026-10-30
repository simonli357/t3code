import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as EffectAcpSchema from "effect-acp/schema";

import { applyDeepseekHarnessModelSelection } from "./DeepseekHarnessAcpSupport.ts";

const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          {
            value: '["deepseek-official","deepseek-v4-flash"]',
            name: "deepseek-v4-flash",
          },
          {
            value: '["deepseek-official","deepseek-flash"]',
            name: "DeepSeek-V4.1-Flash",
          },
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
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

it.effect("maps the T3 model and Max reasoning selection into DSH config", () =>
  Effect.gen(function* () {
    const selectedModels: string[] = [];
    const selectedOptions: Array<readonly [string, string | boolean]> = [];
    const model = yield* applyDeepseekHarnessModelSelection({
      runtime: {
        getConfigOptions: Effect.succeed(configOptions),
        setModel: (value) =>
          Effect.sync(() => {
            selectedModels.push(value);
          }),
        setConfigOption: (id, value) =>
          Effect.sync(() => {
            selectedOptions.push([id, value]);
            return { configOptions };
          }),
      },
      model: "deepseek-flash",
      reasoningEffort: "max",
      mapError: (cause) => cause,
    });

    expect(model).toBe("deepseek-official/deepseek-flash");
    expect(selectedModels).toEqual(['["deepseek-official","deepseek-flash"]']);
    expect(selectedOptions).toEqual([["reasoning_effort", "max"]]);
  }),
);
