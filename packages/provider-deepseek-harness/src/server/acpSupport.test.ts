import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  applyDeepseekHarnessEffort,
  applyDeepseekHarnessModelSelection,
  deepseekHarnessModelOption,
  deepseekHarnessModelSlug,
  requestDeepseekHarnessCompaction,
} from "./acpSupport.ts";

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

describe("DeepSeek Harness model options", () => {
  it("qualifies the harness's provider/model tuples", () => {
    assert.equal(deepseekHarnessModelSlug(FLASH), "deepseek-official/deepseek-flash");
    assert.equal(deepseekHarnessModelSlug("custom-model"), "custom-model");
    assert.equal(deepseekHarnessModelSlug('["only-one"]'), '["only-one"]');
  });

  it("matches by slug, by basename and through the retired flash alias", () => {
    assert.equal(
      deepseekHarnessModelOption(configOptions, "deepseek-official/deepseek-flash"),
      FLASH,
    );
    assert.equal(deepseekHarnessModelOption(configOptions, "deepseek-v4-pro"), PRO);
    // Threads saved before the rename select `deepseek-v4-flash`; they keep running Flash.
    assert.equal(deepseekHarnessModelOption(configOptions, "deepseek-v4-flash"), FLASH);
    assert.equal(deepseekHarnessModelOption(configOptions, "missing-model"), undefined);
  });
});

describe("DeepSeek Harness selection", () => {
  it.effect("writes the model and the reasoning effort the thread stored", () =>
    Effect.gen(function* () {
      const writes = yield* Ref.make<Array<[string, string]>>([]);
      const runtime = {
        getConfigOptions: Effect.succeed(configOptions),
        setModel: (model: string) =>
          Ref.update(writes, (current) => [...current, ["model", model] as [string, string]]),
        setConfigOption: (id: string, value: string | boolean) =>
          Ref.update(writes, (current) => [
            ...current,
            [id, String(value)] as [string, string],
          ]).pipe(Effect.as({} as never)),
      };
      const selection: ModelSelection = {
        instanceId: ProviderInstanceId.make("deepseekHarness"),
        model: "deepseek-official/deepseek-flash",
        options: [{ id: "reasoning_effort", value: "max" }],
      };

      const applied = yield* applyDeepseekHarnessModelSelection(runtime as never, selection);
      yield* applyDeepseekHarnessEffort(runtime as never, selection);

      assert.equal(applied, "deepseek-official/deepseek-flash");
      assert.deepEqual(yield* Ref.get(writes), [
        ["model", FLASH],
        ["reasoning_effort", "max"],
      ]);
    }),
  );

  // The harness compacts through its own request; a `/compact` prompt would reach the model instead.
  it.effect("asks the harness ACP extension to compact the session", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<[string, unknown]>>([]);
      const runtime = {
        request: (method: string, payload: unknown) =>
          Ref.update(calls, (current) => [...current, [method, payload] as [string, unknown]]).pipe(
            Effect.as(undefined),
          ),
      };

      yield* requestDeepseekHarnessCompaction(runtime as never, "session-1");

      assert.deepEqual(yield* Ref.get(calls), [
        ["deepseek-harness/compact", { sessionId: "session-1" }],
      ]);
    }),
  );
});
