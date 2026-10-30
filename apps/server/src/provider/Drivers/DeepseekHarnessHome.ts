import type { DeepseekHarnessSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveDeepseekHarnessHome = Effect.fn("resolveDeepseekHarnessHome")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly stateDir: string;
    readonly settings: Pick<DeepseekHarnessSettings, "homePath">;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<string, never, Crypto.Crypto | Path.Path> {
    const path = yield* Path.Path;
    const configured =
      input.settings.homePath.trim() || input.environment.DSH_HOME?.trim() || "";
    if (configured) return path.resolve(expandHomePath(configured));
    const crypto = yield* Crypto.Crypto;
    const key = Encoding.encodeHex(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.instanceId))
        .pipe(Effect.orDie),
    );
    return path.join(input.stateDir, "providers", "deepseek-harness", key);
  },
);
