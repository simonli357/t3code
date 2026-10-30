import type * as EffectAcpSchema from "effect-acp/schema";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  PI_DEFAULT_MODEL_SLUG,
  applyPiModelSelection,
  piBridgeArgs,
  piModelOption,
} from "./PiAcpSupport.ts";

const modelOption: EffectAcpSchema.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "anthropic/claude-sonnet-4-5",
  options: [
    { value: "anthropic/claude-sonnet-4-5", name: "anthropic/Claude Sonnet 4.5" },
    { value: "openai/gpt-6-astra", name: "openai/GPT-6 Astra" },
  ],
};

const thoughtLevel: EffectAcpSchema.SessionConfigOption = {
  id: "thought_level",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};

describe("piBridgeArgs", () => {
  it("tokenizes quoted bridge arguments", () => {
    expect(
      piBridgeArgs({
        enabled: true,
        binaryPath: "npx",
        launchArgs: '-y "pi-acp" --quiet',
        customModels: [],
      }),
    ).toEqual(["-y", "pi-acp", "--quiet"]);
  });
});

describe("piModelOption", () => {
  it("uses the live default for the product default model", () => {
    expect(piModelOption([modelOption], PI_DEFAULT_MODEL_SLUG)).toBe("anthropic/claude-sonnet-4-5");
    expect(piModelOption([modelOption], undefined)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("matches fully qualified ids and bare model slugs", () => {
    expect(piModelOption([modelOption], "openai/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(piModelOption([modelOption], "gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(piModelOption([modelOption], "missing-model")).toBeUndefined();
  });
});

describe("applyPiModelSelection", () => {
  it.effect("selects the model and thinking level through ACP config options", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string]> = [];
      const runtime = {
        getConfigOptions: Effect.succeed([modelOption, thoughtLevel]),
        setModel: (model: string) =>
          Effect.sync(() => {
            calls.push(["model", model]);
          }),
        setConfigOption: (configId: string, value: string | boolean) =>
          Effect.sync(() => {
            calls.push([configId, String(value)]);
            return { configOptions: [modelOption, thoughtLevel] };
          }),
      };

      const resolved = yield* applyPiModelSelection({
        runtime,
        model: "gpt-6-astra",
        reasoningEffort: "high",
        mapError: (cause) => cause,
      });

      expect(resolved).toBe("openai/gpt-6-astra");
      expect(calls).toEqual([
        ["model", "openai/gpt-6-astra"],
        ["thought_level", "high"],
      ]);
    }),
  );
});
