import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The caller can durably record ambiguity immediately before a native clone.
 * Validation and process startup failures before this boundary remain retryable. */
export const BeforeNativeFork = Context.Reference<Effect.Effect<void, string>>(
  "t3/provider/BeforeNativeFork",
  { defaultValue: () => Effect.void },
);
