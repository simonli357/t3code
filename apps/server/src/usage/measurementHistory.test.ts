import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  ProviderRuntimeEvent,
  ServerProvider,
  UsageMeasurementsReport,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { MeasurementHistory } from "./measurementHistory.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeReport = Schema.decodeUnknownSync(UsageMeasurementsReport);
const base = Date.parse("2026-10-18T12:00:00Z");
const iso = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(base + minutes * 60_000));
function provider(
  instanceId: string,
  minutes: number,
  used: number,
  reset = iso(300),
  email = "owner@example.test",
) {
  return decodeProvider({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: iso(minutes),
    models: [],
    usageLimits: {
      checkedAt: iso(minutes),
      windows: [
        { id: "five_hour", kind: "session", label: "5h", usedPercent: used, resetsAt: reset },
      ],
    },
  });
}
function event(type: string, minutes: number, payload: object = {}, extras: object = {}) {
  return decodeEvent({
    type,
    eventId: `${type}-${minutes}`,
    provider: "codex",
    providerInstanceId: "codex",
    threadId: "thread",
    turnId: "turn",
    createdAt: iso(minutes),
    payload,
    ...extras,
  });
}
const tokens = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 12000,
  outputTokens: 2000,
  cachedInputTokens: 10000,
  reasoningTokens: 1000,
};
it("reports prediction error only after comparable quota intervals, including external burn changes", () => {
  const h = new MeasurementHistory();
  h.setAllowed(["codex"]);
  for (const [minutes, used] of [
    [0, 10],
    [5, 11],
    [10, 12],
    [15, 20],
    [20, 30],
  ])
    h.recordProviders([provider("codex", minutes!, used!)]);
  const rate = h.report({}, base + 20 * 60_000).accounts[0]!.windows[0]!.rate;
  expect(rate.predictionErrorPointsPerHour).toBeGreaterThan(0);
  h.recordProviders([provider("codex", 25, 0, iso(400))]);
  expect(
    h.report({}, base + 25 * 60_000).accounts[0]!.windows[0]!.rate.predictionErrorPointsPerHour,
  ).toBeNull();
});
function history() {
  const h = new MeasurementHistory();
  h.setAllowed(["codex", "claudeAgent"]);
  h.recordProviders([provider("codex", 0, 10)]);
  return h;
}

describe("usage measurements", () => {
  it("uses a window's actual timestamp rather than a newer sparse snapshot time", () => {
    const h = history();
    const next = provider("codex", 20, 25);
    h.recordProviders([
      {
        ...next,
        usageLimits: {
          ...next.usageLimits!,
          windows: next.usageLimits!.windows.map((w) => ({ ...w, checkedAt: iso(5) })),
        },
      },
    ]);
    expect(h.report({}, base + 20 * 60_000).accounts[0]?.windows[0]?.checkedAt).toBe(iso(5));
  });
  it("collects nothing without an explicit account allowlist", () => {
    const h = new MeasurementHistory();
    h.recordProviders([provider("codex", 0, 10)]);
    h.observe(event("turn.started", 0));
    expect(h.report({}, base).turns).toEqual([]);
    expect(h.report({}, base).accounts).toEqual([]);
  });
  it("never records shared accounts, even when they share a known login", () => {
    const h = history();
    h.recordProviders([provider("codex_antoine", 10, 20)]);
    h.observe(event("turn.started", 0, {}, { providerInstanceId: "codex_antoine" }));
    expect(h.report({}, base + 10 * 60_000).turns).toEqual([]);
    expect(h.snapshot(base).quotas.map((s) => s.instanceId)).toEqual(["codex"]);
  });
  it("measures context and union of overlapping tool time without inventing compute time", () => {
    const h = history();
    h.observe(event("turn.started", 0, { model: "astra", effort: "high" }), {
      model: "astra",
      effort: "high",
      createdAt: iso(-1440),
    });
    h.observe(
      event("thread.token-usage.updated", 1, { usage: { usedTokens: 100000, maxTokens: 1000000 } }),
    );
    h.observe(event("item.started", 2, { itemType: "command_execution" }, { itemId: "a" }));
    h.observe(event("item.started", 3, { itemType: "mcp_tool_call" }, { itemId: "b" }));
    h.observe(event("item.completed", 4, { itemType: "command_execution" }, { itemId: "a" }));
    h.observe(event("item.completed", 5, { itemType: "mcp_tool_call" }, { itemId: "b" }));
    h.observe(
      event("turn.completed", 10, { state: "completed", tokenUsage: tokens, apiDurationMs: 45000 }),
    );
    const report = h.report({}, base + 10 * 60_000);
    decodeReport(report);
    expect(report.turns[0]).toMatchObject({
      elapsedMs: 600000,
      toolWallMs: 180000,
      nonToolWallMs: 420000,
      peakContextTokens: 100000,
      apiDurationMs: 45000,
      sessionAgeMs: 1450 * 60000,
    });
    expect(report.profiles[0]).toMatchObject({
      contextBand: "32k-128k",
      medianInputTokensPerTurnHour: 72000,
      medianOutputTokensPerTurnHour: 12000,
    });
  });
  it("does not count duplicate completion or add reasoning/cache to total tokens", () => {
    const h = history();
    h.observe(event("turn.started", 0, { model: "astra" }));
    const finish = event("turn.completed", 10, { state: "completed", tokenUsage: tokens });
    h.observe(finish);
    h.observe(finish);
    const report = h.report({}, base + 10 * 60000);
    expect(report.profiles[0]?.turns).toBe(1);
    expect(report.profiles[0]?.medianOutputTokensPerTurnHour).toBe(12000);
    expect(report.profiles[0]?.medianInputTokensPerTurnHour).toBe(72000);
  });
  it("keeps short, partial, subagent and mixed-model turns out of baselines", () => {
    const h = history();
    for (const [i, usage] of [
      tokens,
      { ...tokens, usageStatus: "partial" },
      { ...tokens, hasSubagents: true },
      tokens,
    ].entries()) {
      const extra = { turnId: `turn${i}` };
      h.observe(event("turn.started", 0, { model: "astra" }, extra));
      if (i === 3)
        h.observe(
          event(
            "model.rerouted",
            1,
            { fromModel: "astra", toModel: "sol", reason: "fallback" },
            extra,
          ),
        );
      h.observe(
        event(
          "turn.completed",
          i === 0 ? 0.5 : 10,
          { state: "completed", tokenUsage: usage },
          extra,
        ),
      );
    }
    expect(h.report({}, base + 10 * 60000).profiles).toEqual([]);
  });
  it("marks missing starts and unmatched tool completions as incomplete", () => {
    const h = history();
    h.observe(event("item.completed", 3, { itemType: "command_execution" }, { itemId: "missing" }));
    h.observe(event("turn.completed", 10, { state: "completed", tokenUsage: tokens }));
    const report = h.report({}, base + 10 * 60000);
    expect(report.turns[0]?.startedAt).toBeNull();
    expect(report.turns[0]?.nonToolWallMs).toBeNull();
    expect(report.profiles).toEqual([]);
  });
  it("calculates account pace and reset projection without allocating it to workers", () => {
    const h = history();
    h.recordProviders([provider("codex", 30, 20)]);
    const rate = h.report({}, base + 30 * 60000).accounts[0]?.windows[0]?.rate;
    expect(rate).toMatchObject({
      percentagePointsPerHour: 20,
      hoursUntilExhaustion: 4,
      hoursUntilReset: 4.5,
      projectedUsedPercentAtReset: 110,
      sampleCount: 2,
    });
  });
  it("does not bridge quota resets, decreases, stale readings or saturation", () => {
    for (const [used, reset, now, reason] of [
      [5, iso(330), 30, "insufficientSamples"],
      [5, iso(300), 30, "insufficientSamples"],
      [20, iso(300), 50, "stale"],
      [100, iso(300), 30, "saturated"],
    ] as const) {
      const h = history();
      h.recordProviders([provider("codex", 30, used, reset)]);
      expect(h.report({}, base + now * 60000).accounts[0]?.windows[0]?.rate).toMatchObject({
        percentagePointsPerHour: null,
        reason,
      });
    }
  });
  it("does not freshen unchanged merged windows or accept out-of-order samples", () => {
    const h = history();
    h.recordProviders([provider("codex", 30, 10), provider("codex", -1, 5)]);
    const report = h.report({}, base + 30 * 60000);
    expect(report.accounts[0]?.windows[0]).toMatchObject({
      checkedAt: iso(0),
      ageSeconds: 1800,
      rate: { reason: "stale" },
    });
  });
  it("separates account changes on one instance and filters queries", () => {
    const h = history();
    h.recordProviders([provider("codex", 30, 20, iso(300), "other@example.test")]);
    const report = h.report({ instanceId: ProviderInstanceId.make("codex") }, base + 30 * 60000);
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]?.windows[0]?.rate.percentagePointsPerHour).toBeNull();
  });
  it("retains completed measurements across restart without counting downtime", () => {
    const h = history();
    h.observe(event("turn.started", 0, { model: "astra" }));
    h.observe(event("thread.token-usage.updated", 5, { usage: { usedTokens: 40000 } }));
    const restored = new MeasurementHistory();
    restored.restore(h.snapshot(base + 5 * 60000));
    restored.setAllowed(["codex"]);
    const report = restored.report({}, base + 60 * 60000);
    expect(report.turns[0]).toMatchObject({
      state: "interrupted",
      elapsedMs: 300000,
      endedAt: iso(5),
      nonToolWallMs: null,
    });
    expect(report.profiles).toEqual([]);
    restored.setAllowed([]);
    expect(restored.snapshot(base + 60 * 60000)).toMatchObject({ turns: [], quotas: [] });
  });
  it("drops history outside retention", () => {
    const h = history();
    h.observe(event("turn.started", 0));
    expect(h.report({}, base + 15 * 24 * 3600000)).toMatchObject({ turns: [], accounts: [] });
  });
});
