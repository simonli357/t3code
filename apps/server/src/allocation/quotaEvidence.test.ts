import { expect, it } from "@effect/vitest";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";
import {
  readQuotaEvidenceRows,
  unresolvedQuotaRejections,
  type QuotaEvidence,
  type QuotaEvidenceRow,
} from "./quotaEvidence.ts";
import * as Schema from "effect/Schema";

const at = "2026-10-23T19:30:00.000Z";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("coalesces the last quota warning on the same turn/account across unrelated activity rowids", () => {
  const warning: QuotaEvidenceRow = {
    thread_id: "thread",
    turn_id: "turn",
    instanceId: "claude",
    kind: "runtime.warning",
    ordinal: 1,
    created_at: "2026-10-23T17:00:00.000Z",
    payload_json: encode({
      detail: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1792778400 },
    }),
  };
  const error: QuotaEvidenceRow = {
    ...warning,
    kind: "runtime.error",
    ordinal: 2,
    payload_json: encode({
      message: "Claude usage limit reached. Send the message again once the limit resets.",
    }),
  };
  expect(readQuotaEvidenceRows([error, warning]).every((e) => e.windowId === "five_hour")).toBe(
    true,
  );
  expect(
    readQuotaEvidenceRows([{ ...error, ordinal: 5 }, warning]).every(
      (e) => e.windowId === "five_hour",
    ),
  ).toBe(true);
  const allowed = {
    ...warning,
    ordinal: 3,
    kind: "account.quota-state",
    payload_json: encode({ quotaStates: [{ windowId: "five_hour", status: "allowed" }] }),
  };
  expect(
    readQuotaEvidenceRows([{ ...error, ordinal: 5 }, warning, allowed]).some(
      (e) => e.windowId === "unknown",
    ),
  ).toBe(true);
  for (const change of [
    { turn_id: null },
    { turn_id: "other" },
    { thread_id: "other" },
    { instanceId: "other" },
    { payload_json: encode({ message: "Codex usage limit reached." }) },
    { payload_json: encode({ quotaStates: [{ windowId: "unknown", status: "rejected" }] }) },
    {
      payload_json: encode({
        message: "Claude usage limit reached. Send the message again once the limit resets.",
        quotaStates: [{ windowId: "unknown", status: "rejected" }],
      }),
    },
  ]) {
    expect(
      readQuotaEvidenceRows([{ ...error, ...change }, warning]).some(
        (e) => e.windowId === "unknown",
      ),
    ).toBe(true);
  }
  // A separate unknown error is not erased by a later scoped allowed receipt.
  expect(
    unresolvedQuotaRejections(
      readQuotaEvidenceRows([
        { ...error, ordinal: 3, turn_id: "other-turn" },
        warning,
        {
          ...warning,
          kind: "account.quota-state",
          ordinal: 4,
          payload_json: encode({ quotaStates: [{ windowId: "five_hour", status: "allowed" }] }),
        },
      ]),
      undefined,
      at,
      15,
    ),
  ).toHaveLength(1);
});
const reset = "2026-10-23T18:00:00.000Z";
const nextReset = "2026-10-30T18:00:00.000Z";
const rejected: QuotaEvidence = {
  instanceId: "claude",
  windowId: "seven_day_overage_included",
  at: "2026-10-23T17:00:00.000Z",
  status: "rejected",
  resetsAt: reset,
  ordinal: 1,
};
const entry = (display_name: string) => ({ display_name, utilization: 0, resets_at: nextReset });
const probe = (entries: unknown[] = [entry("Fable")], checkedAt = at) =>
  claudeUsageResponseToLimits({
    checkedAt,
    response: {
      rate_limits_available: true,
      rate_limits: { ...({ model_scoped: entries } as object) },
    },
  });
const remaining = (limits = probe().limits, evidence = [rejected]) =>
  unresolvedQuotaRejections(evidence, limits, at, 15);

it("recovers a stopped scoped rejection from a proven late mapping and fresh reset, never elapsed time alone", () => {
  expect(remaining()).toEqual([]);
  const fresh = probe().limits;
  for (const patch of [
    { resetsAt: reset },
    { resetsAt: undefined },
    { checkedAt: "2026-10-23T18:00:00.000Z" },
    { usedPercent: 100 },
    { enforcement: undefined },
  ])
    expect(
      remaining({ ...fresh, windows: fresh.windows.map((w) => ({ ...w, ...patch })) }),
    ).toHaveLength(1);
  expect(remaining(probe([], at).limits)).toHaveLength(1);
  expect(remaining(probe([entry("Fable")], "2026-10-23T19:00:00.000Z").limits)).toHaveLength(1);
});

it("requires one proven association without guessing the first model or colliding numeric identities", () => {
  for (const entries of [
    [entry("Fable"), entry("Opus")],
    [entry("Fable"), { display_name: "Ghost", utilization: null }],
    [entry("Fable"), {}],
    [entry("A B"), entry("A-B")],
    [{ display_name: "Fable", utilization: Number.NaN }],
  ]) {
    for (const ordered of [entries, entries.toReversed()]) {
      const result = probe(ordered);
      expect(result.names.overageIncluded).toBeUndefined();
      expect(remaining(result.limits)).toHaveLength(1);
    }
  }
  const fresh = probe().limits;
  const numeric = fresh.windows[0]!;
  expect(
    remaining({ ...fresh, windows: [numeric, { ...numeric, id: "seven_day_other" }] }),
  ).toHaveLength(1);
});

it("preserves a rejection's known numeric scope and does not clear another rejected window", () => {
  const bound = { ...rejected, usageWindowId: "seven_day_fable" };
  expect(remaining(probe([entry("Other")]).limits, [bound])).toHaveLength(1);
  // A persisted association is enough to identify a subsequent fresh numeric reading.
  const fresh = probe().limits;
  expect(
    remaining({ ...fresh, windows: fresh.windows.map(({ enforcement: _mapping, ...w }) => w) }, [
      bound,
    ]),
  ).toEqual([]);
  const other: QuotaEvidence = {
    ...rejected,
    windowId: "seven_day",
    resetsAt: "2026-10-24T18:00:00.000Z",
  };
  expect(remaining(fresh, [rejected, other])).toEqual([other]);
  const allowed: QuotaEvidence = { ...rejected, status: "allowed", ordinal: 2 };
  const again = { ...rejected, ordinal: 3 };
  const noReset = { ...fresh, windows: fresh.windows.map((w) => ({ ...w, resetsAt: reset })) };
  expect(remaining(noReset, [rejected, allowed])).toEqual([]);
  expect(remaining(noReset, [allowed, again, rejected])).toEqual([again]);
  expect(remaining(noReset, [again, rejected, allowed])).toEqual([again]);
});

it("sparse numeric updates retain but cannot renew stale association evidence", () => {
  const old = probe([entry("Fable")], "2026-10-23T19:00:00.000Z").limits;
  const { enforcement: _mapping, ...numeric } = old.windows[0]!;
  const merged = applyUsageLimitsUpdate({
    previous: old,
    checkedAt: at,
    update: { windows: [{ ...numeric, usedPercent: 1 }] },
  })!;
  expect(merged.windows[0]?.enforcement?.checkedAt).toBe(old.checkedAt);
  expect(remaining(merged)).toHaveLength(1);
  expect(remaining(probe().limits)).toEqual([]);
});

it("recovers an exhausted account-wide allowance only with later provider acceptance and a fresh restored reading", () => {
  const row: QuotaEvidenceRow = {
    instanceId: "xl",
    thread_id: "old",
    turn_id: "turn",
    ordinal: 1,
    created_at: "2026-10-22T02:31:42.501Z",
    kind: "runtime.warning",
    payload_json: encode({
      detail: {
        status: "rejected",
        rateLimitType: "seven_day",
        resetsAt: 1792962000,
        isUsingOverage: false,
        unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1792962000 } },
      },
    }),
  };
  const checkedAt = "2026-10-24T09:50:46.769Z";
  const limits = claudeUsageResponseToLimits({
    checkedAt,
    response: {
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 60, resets_at: "2026-10-25T20:59:59.729Z" } },
    },
  }).limits;
  const errors = readQuotaEvidenceRows([row]);
  const accepted: QuotaEvidence = {
    instanceId: "xl",
    windowId: "five_hour",
    status: "allowed",
    at: "2026-10-24T05:02:56.822Z",
  };
  const unresolved = (es: QuotaEvidence[], ls = limits) =>
    unresolvedQuotaRejections(es, ls, checkedAt, 10);
  expect(unresolved([...errors, accepted])).toEqual([]);
  expect(unresolved([...errors, accepted].toReversed())).toEqual([]);
  for (const detail of [
    { isUsingOverage: true, utilization: 1 },
    { isUsingOverage: false, utilization: 0.6 },
    { isUsingOverage: false, utilization: "unknown" },
  ]) {
    const unproven = readQuotaEvidenceRows([
      {
        ...row,
        payload_json: encode({
          detail: {
            status: "rejected",
            rateLimitType: "seven_day",
            resetsAt: 1792962000,
            ...detail,
          },
        }),
      },
    ]);
    expect(unproven).toHaveLength(1);
    expect(unresolved([...unproven, accepted])).toHaveLength(1);
  }

  expect(unresolved(errors)).toHaveLength(1);
  expect(unresolved([...errors, { ...accepted, instanceId: "another-account" }])).toHaveLength(1);
  expect(unresolved([...errors, { ...accepted, at: row.created_at }])).toHaveLength(1);
  expect(unresolved([...errors, { ...accepted, at: "2026-10-25T00:00:00.000Z" }])).toHaveLength(1);
  for (const patch of [
    { checkedAt: row.created_at },
    { usedPercent: 100 },
    { resetsAt: "2026-10-25T20:55:00.000Z" },
  ])
    expect(
      unresolved([...errors, accepted], {
        ...limits,
        windows: limits.windows.map((w) => ({ ...w, ...patch })),
      }),
    ).toHaveLength(1);
  expect(
    unresolved([...errors.map((e) => ({ ...e, windowId: "unknown" })), accepted]),
  ).toHaveLength(1);
  expect(
    unresolved([...errors.map((e) => ({ ...e, windowId: "seven_day_sonnet" })), accepted]),
  ).toHaveLength(1);
  // A new rejection after the acceptance is authoritative even if a reading is lower.
  expect(
    unresolved([...errors, accepted, { ...errors[0]!, at: "2026-10-24T09:49:00.000Z" }]),
  ).toHaveLength(1);
});

it("requires an explicit inactive complete Claude probe after the short reset, never a sparse omission", () => {
  const checkedAt = "2026-10-24T09:50:46.769Z";
  const evidence: QuotaEvidence[] = [
    {
      instanceId: "xl",
      windowId: "five_hour",
      status: "rejected",
      at: "2026-10-24T05:02:57.987Z",
      resetsAt: "2026-10-24T09:20:00.000Z",
    },
  ];
  const read = (value: object) =>
    claudeUsageResponseToLimits({
      checkedAt,
      response: {
        rate_limits_available: true,
        rate_limits: { ...({ five_hour: value } as object) },
      },
    }).limits;
  const inactive = read({ utilization: 0, resets_at: null });
  expect(unresolvedQuotaRejections(evidence, inactive, checkedAt, 10)).toEqual([]);
  for (const limits of [
    read({ utilization: 0 }),
    read({ utilization: 1, resets_at: null }),
    read({ utilization: null, resets_at: null }),
    { ...inactive, checkedAt: "2026-10-24T09:19:00.000Z" },
  ])
    expect(unresolvedQuotaRejections(evidence, limits, checkedAt, 10)).toHaveLength(1);
  expect(
    unresolvedQuotaRejections(
      [{ ...evidence[0]!, resetsAt: "2026-10-24T11:00:00.000Z" }],
      inactive,
      checkedAt,
      10,
    ),
  ).toHaveLength(1);
  const sparse = applyUsageLimitsUpdate({
    previous: inactive,
    checkedAt,
    update: { windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 0 }] },
  })!;
  expect(unresolvedQuotaRejections(evidence, sparse, checkedAt, 10)).toHaveLength(1);
});

it("recovers only the session scope stated by the native message on the exact failed Claude retry", () => {
  const row: QuotaEvidenceRow = {
    instanceId: "xl",
    thread_id: "thread",
    turn_id: "retry",
    ordinal: 1,
    created_at: "2026-10-22T03:01:44.152Z",
    kind: "runtime.error",
    payload_json: encode({
      message: "Claude usage limit reached. Send the message again once the limit resets.",
    }),
    native_error_text: "You've hit your session limit \u00b7 resets 3:30am (America/Toronto)",
  };
  expect(readQuotaEvidenceRows([row])[0]?.windowId).toBe("five_hour");
  expect(
    readQuotaEvidenceRows([
      {
        ...row,
        native_error_text: row.native_error_text!.replace("session limit", "weekly limit"),
      },
    ])[0]?.windowId,
  ).toBe("seven_day");
  expect(
    readQuotaEvidenceRows([
      {
        ...row,
        native_error_text: row.native_error_text!.replace("session limit", "weekly Opus limit"),
      },
    ])[0]?.windowId,
  ).toBe("unknown");
  for (const patch of [
    { native_error_text: "You've hit your limit \u00b7 resets 3:30am (America/Toronto)" },
    { native_error_text: null },
    { turn_id: null },
    { payload_json: encode({ message: "Other quota error" }) },
    {
      payload_json: encode({
        message: "Claude usage limit reached. Send the message again once the limit resets.",
        quotaStates: [{ windowId: "unknown", status: "rejected" }],
      }),
    },
  ])
    expect(readQuotaEvidenceRows([{ ...row, ...patch }])[0]?.windowId).toBe("unknown");
});
