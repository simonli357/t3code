import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { enforceDeepseekModelSelection, restrictDeepseekProvider } from "./deepseekPolicy.ts";
import { hydrateCachedProvider } from "./providerStatusCache.ts";

describe("DeepSeek model policy", () => {
  for (const [driver, id, flash] of [
    ["codex", "deepseek_codex", "deepseek-flash"],
    ["deepseekHarness", "deepseekHarness", "deepseek-official/deepseek-flash"],
    ["pi", "pi", "deepseek/deepseek-flash"],
    ["opencode", "opencode", "deepseek/deepseek-flash"],
  ] as const) {
    it(`${driver} removes Pro after cache hydration and exposes only max`, () => {
      const provider: ServerProvider = {
        instanceId: ProviderInstanceId.make(id),
        driver: ProviderDriverKind.make(driver),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-01T00:00:00.000Z",
        slashCommands: [],
        skills: [],
        models: [flash, "deepseek/deepseek-v4-pro", "deepseek-official/deepseek-v4-flash"].map(
          (slug) => ({
            slug,
            name: slug,
            isCustom: false,
            isDefault: slug !== flash,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "low",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "max", label: "Max" },
                  ],
                },
              ],
            },
          }),
        ),
      };
      const result = restrictDeepseekProvider(
        hydrateCachedProvider({
          cachedProvider: provider,
          fallbackProvider: { ...provider, models: [] },
        }),
      );
      expect(result.models.map((model) => model.slug)).toEqual([flash]);
      expect(result.models[0]?.isDefault).toBe(true);
      expect(result.models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id:
            driver === "deepseekHarness"
              ? "reasoning_effort"
              : driver === "opencode"
                ? "variant"
                : "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "max",
          options: [{ id: "max", label: "Max", isDefault: true }],
        },
      ]);
    });
    it.effect(`${driver} refuses Pro and pins old Flash options to max`, () =>
      Effect.gen(function* () {
        const instance = ProviderInstanceId.make(id);
        const rejected = yield* Effect.flip(
          enforceDeepseekModelSelection(
            driver,
            instance,
            createModelSelection(instance, "deepseek-v4-pro"),
            "test",
          ),
        );
        expect(rejected.issue).toContain("restricted");
        const pinned = yield* enforceDeepseekModelSelection(
          driver,
          instance,
          {
            instanceId: instance,
            model: flash,
            options: [{ id: "reasoningEffort", value: "low" }],
          },
          "test",
        );
        expect(pinned?.options).toEqual([
          {
            id:
              driver === "deepseekHarness"
                ? "reasoning_effort"
                : driver === "opencode"
                  ? "variant"
                  : "reasoningEffort",
            value: "max",
          },
        ]);
      }),
    );
  }
  it.effect("leaves other providers and their reasoning choices alone", () =>
    Effect.gen(function* () {
      const selection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6-astra",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      expect(
        yield* enforceDeepseekModelSelection("codex", selection.instanceId, selection, "test"),
      ).toBe(selection);
    }),
  );
});
