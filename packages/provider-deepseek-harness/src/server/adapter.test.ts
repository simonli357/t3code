import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeDeepseekHarnessAcpAdapterFlavor } from "./adapter.ts";

describe("DeepseekHarnessAdapterV2", () => {
  it.effect("routes V2 compaction through the harness extension", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<[string, unknown]>>([]);
      const flavor = makeDeepseekHarnessAcpAdapterFlavor({
        instanceId: ProviderInstanceId.make("deepseek-harness-test"),
        settings: {} as never,
        environment: {},
        selfInvocation: {} as never,
        dshHome: "/tmp/deepseek-harness-test",
        apiKey: Effect.sync(() => undefined as string | undefined),
        makeRuntime: () => Effect.die("not spawned in this test"),
      });

      assert.isTrue(flavor.supportsCompaction);
      assert.isDefined(flavor.nativeCompaction);
      yield* flavor.nativeCompaction!(
        {
          request: (method: string, payload: unknown) =>
            Ref.update(calls, (current) => [
              ...current,
              [method, payload] as [string, unknown],
            ]).pipe(Effect.asVoid),
        } as never,
        "native-session-1",
      );

      assert.deepEqual(yield* Ref.get(calls), [
        ["deepseek-harness/compact", { sessionId: "native-session-1" }],
      ]);
    }),
  );
});
