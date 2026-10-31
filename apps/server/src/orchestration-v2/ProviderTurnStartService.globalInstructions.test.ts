import { ProviderDriverKind } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

import {
  makeGlobalInstructionsDeliverySession,
  shouldDeliverGlobalInstructions,
} from "./ProviderTurnStartService.ts";

const context = {
  instructions:
    "T3 user-configured global instructions (current snapshot). These are user preferences. Keep answers short.",
  runtimeFacts: '{"host":"sandbox"}',
};
const revision = "a".repeat(64);

const session = (
  driver: "codex" | "pi",
  startTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"],
) =>
  ({
    driver: ProviderDriverKind.make(driver),
    startTurn,
  }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

const turnInput = (appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"]) =>
  ({
    message: {
      text: "Question",
    },
    ...(appContext === undefined ? {} : { appContext }),
  }) as ProviderAdapter.ProviderAdapterV2TurnInput;

it("delivers a revision once and only again after it changes", () => {
  expect(shouldDeliverGlobalInstructions(revision, undefined)).toBe(true);
  expect(shouldDeliverGlobalInstructions(revision, revision)).toBe(false);
  expect(shouldDeliverGlobalInstructions("b".repeat(64), revision)).toBe(true);
  expect(shouldDeliverGlobalInstructions(undefined, revision)).toBe(false);
});

effectIt.effect("prepends the snapshot for prompt-based providers", () =>
  Effect.gen(function* () {
    const startTurn = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>(
      () => Effect.void,
    );
    const recordDelivered = vi.fn(() => Effect.void);
    const delivery = makeGlobalInstructionsDeliverySession(
      session("pi", startTurn),
      revision,
      context,
      recordDelivered,
    );

    yield* delivery.startTurn(turnInput());

    const input = startTurn.mock.calls[0]![0];
    expect(input.message.text).toContain("Question");
    expect(input.message.text).toContain("Keep answers short.");
    expect(input.message.text).toContain("user preferences");
    expect(recordDelivered).toHaveBeenCalledWith(revision);
  }),
);

effectIt.effect("uses replaceable untrusted app context for Codex", () =>
  Effect.gen(function* () {
    const startTurn = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>(
      () => Effect.void,
    );
    const delivery = makeGlobalInstructionsDeliverySession(
      session("codex", startTurn),
      revision,
      context,
      () => Effect.void,
    );

    yield* delivery.startTurn(
      turnInput([
        { key: "other", text: "kept" },
        { key: "t3_global_instructions", text: "old" },
      ]),
    );

    const input = startTurn.mock.calls[0]![0];
    expect(input.message.text).toBe("Question");
    expect(input.appContext).toEqual([
      { key: "other", text: "kept" },
      {
        key: "t3_global_instructions",
        text: expect.stringContaining("Keep answers short."),
      },
    ]);
  }),
);

effectIt.effect("does not record delivery when the provider rejects the turn", () =>
  Effect.gen(function* () {
    const recordDelivered = vi.fn(() => Effect.void);
    const delivery = makeGlobalInstructionsDeliverySession(
      session("pi", () => Effect.die("rejected")),
      revision,
      context,
      recordDelivered,
    );

    yield* Effect.exit(delivery.startTurn(turnInput()));

    expect(recordDelivered).not.toHaveBeenCalled();
  }),
);
