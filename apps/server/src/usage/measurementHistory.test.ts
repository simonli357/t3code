import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { MeasurementHistory, type MeasurementEvent } from "./measurementHistory.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const base = Date.parse("2026-10-18T12:00:00Z");
const iso = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(base + minutes * 60_000));
const tokens = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 12_000,
  outputTokens: 2_000,
  cachedInputTokens: 10_000,
  reasoningTokens: 1_000,
} as const;

function event(
  type: MeasurementEvent["type"],
  minutes: number,
  payload: MeasurementEvent["payload"] = {},
  extras: Partial<MeasurementEvent> = {},
): MeasurementEvent {
  return {
    type,
    providerInstanceId: "codex",
    threadId: "thread",
    turnId: "turn",
    createdAt: iso(minutes),
    payload,
    ...extras,
  };
}

function provider(minutes: number, used: number) {
  return decodeProvider({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated", email: "owner@example.test" },
    checkedAt: iso(minutes),
    models: [],
    usageLimits: {
      checkedAt: iso(minutes),
      windows: [{ id: "five_hour", kind: "session", label: "5h", usedPercent: used }],
    },
  });
}

it("collects nothing without an explicit account allowlist", () => {
  const history = new MeasurementHistory();
  history.recordProviders([provider(0, 10)]);
  history.observe(event("turn.started", 0));

  const report = history.report({}, base);
  expect(report.turns).toEqual([]);
  expect(report.accounts).toEqual([]);
});

it("measures context and the union of overlapping V2 tool time", () => {
  const history = new MeasurementHistory();
  history.setAllowed(["codex"]);
  history.recordProviders([provider(0, 10)]);
  history.observe(event("turn.started", 0), {
    model: "deepseek-official/deepseek-flash",
    effort: "max",
    createdAt: iso(-1440),
  });
  history.observe(event("context.updated", 1, { usage: { usedTokens: 100_000 } }));
  history.observe(
    event("item.started", 2, { itemType: "command_execution" }, { itemId: "command" }),
  );
  history.observe(event("item.started", 3, { itemType: "dynamic_tool_call" }, { itemId: "tool" }));
  history.observe(
    event("item.completed", 4, { itemType: "command_execution" }, { itemId: "command" }),
  );
  history.observe(
    event("item.completed", 5, { itemType: "dynamic_tool_call" }, { itemId: "tool" }),
  );
  history.observe(event("turn.tokens", 9, { tokenUsage: tokens }));
  history.observe(event("turn.completed", 10, { state: "completed" }));
  history.observe(event("turn.completed", 11, { state: "completed" }));

  const report = history.report({}, base + 10 * 60_000);
  expect(report.turns).toHaveLength(1);
  expect(report.turns[0]).toMatchObject({
    elapsedMs: 600_000,
    toolWallMs: 180_000,
    nonToolWallMs: 420_000,
    peakContextTokens: 100_000,
    sessionAgeMs: 1450 * 60_000,
    state: "completed",
    effort: "max",
  });
  expect(report.profiles[0]).toMatchObject({
    contextBand: "32k-128k",
    turns: 1,
    medianInputTokensPerTurnHour: 72_000,
    medianOutputTokensPerTurnHour: 12_000,
  });
  expect(report.accounts[0]?.instanceIds).toEqual(["codex"]);
});

it("drops measurements when the account is removed from the opt-in list", () => {
  const history = new MeasurementHistory();
  history.setAllowed([ProviderInstanceId.make("codex")]);
  history.recordProviders([provider(0, 10)]);
  history.observe(event("turn.started", 0));

  history.setAllowed([]);

  expect(history.report({}, base).turns).toEqual([]);
  expect(history.snapshot(base).quotas).toEqual([]);
});
