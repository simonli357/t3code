import { expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  ServerProvider,
  ThreadId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import { applyUsageLimitsUpdate } from "../provider/providerUsageLimits.ts";
import { decideAllocation } from "./decision.ts";
import { allocationInventory } from "./inventory.ts";
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
  unresolvedQuotaRejections(evidence, limits, at);

it("recovers a stopped scoped rejection from a mapping and reset proven after it, never elapsed time alone", () => {
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
  // A probe taken after the rejection still proves it over half an hour later.
  expect(remaining(probe([entry("Fable")], "2026-10-23T19:00:00.000Z").limits)).toEqual([]);
  expect(remaining(probe([entry("Fable")], "2026-10-23T16:30:00.000Z").limits)).toHaveLength(1);
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

it("sparse numeric updates retain but cannot renew an association from before the rejection", () => {
  const old = probe([entry("Fable")], "2026-10-23T16:30:00.000Z").limits;
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

it("recovers an account-wide rejection on a later accepted turn, or once its used-up limit reads room again", () => {
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
  const unresolved = (es: QuotaEvidence[], ls: ServerProviderUsageLimits | undefined = limits) =>
    unresolvedQuotaRejections(es, ls, checkedAt);
  const patched = (patch: object) => ({
    ...limits,
    windows: limits.windows.map((w) => ({ ...w, ...patch })),
  });
  // The rejection recorded the weekly limit used up; a later reading of it shows room in the
  // same cycle, so the provider restored it.
  expect(unresolved(errors)).toEqual([]);
  // A reading from before the rejection, a full one, or one of a cycle that has not begun since.
  for (const patch of [
    { checkedAt: row.created_at },
    { usedPercent: 100 },
    { resetsAt: "2026-10-25T20:55:00.000Z" },
  ])
    expect(unresolved(errors, patched(patch))).toHaveLength(1);
  // A later accepted turn proves it over whatever the meter says, and without a reading.
  for (const reading of [patched({ usedPercent: 100 }), undefined]) {
    expect(unresolved([...errors, accepted], reading)).toEqual([]);
    expect(unresolved([...errors, accepted].toReversed(), reading)).toEqual([]);
  }
  // Not this account, not after the rejection, or not yet.
  for (const other of [
    { ...accepted, instanceId: "another-account" },
    { ...accepted, at: row.created_at },
    { ...accepted, at: "2026-10-25T00:00:00.000Z" },
  ])
    expect(unresolved([...errors, other], patched({ usedPercent: 100 }))).toHaveLength(1);
  // A rejection that did not record the limit used up is not explained by a low reading; only an
  // accepted turn ends it.
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
    expect(unresolved(unproven)).toHaveLength(1);
    expect(unresolved([...unproven, accepted])).toEqual([]);
  }
  // A rejection that names no window, or another model's window, borrows no recovery.
  expect(
    unresolved([...errors.map((e) => ({ ...e, windowId: "unknown" })), accepted]),
  ).toHaveLength(1);
  expect(
    unresolved([...errors.map((e) => ({ ...e, windowId: "seven_day_sonnet" })), accepted]),
  ).toHaveLength(1);
  // A newer rejection outweighs every proof taken before it.
  expect(
    unresolved(
      [...errors, accepted, { ...errors[0]!, at: "2026-10-24T09:49:00.000Z" }],
      patched({ checkedAt: "2026-10-24T09:45:00.000Z" }),
    ),
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
  expect(unresolvedQuotaRejections(evidence, inactive, checkedAt)).toEqual([]);
  for (const limits of [
    read({ utilization: 0 }),
    read({ utilization: 1, resets_at: null }),
    read({ utilization: null, resets_at: null }),
    { ...inactive, checkedAt: "2026-10-24T09:19:00.000Z" },
  ])
    expect(unresolvedQuotaRejections(evidence, limits, checkedAt)).toHaveLength(1);
  expect(
    unresolvedQuotaRejections(
      [{ ...evidence[0]!, resetsAt: "2026-10-24T11:00:00.000Z" }],
      inactive,
      checkedAt,
    ),
  ).toHaveLength(1);
  const sparse = applyUsageLimitsUpdate({
    previous: inactive,
    checkedAt,
    update: { windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 0 }] },
  })!;
  expect(unresolvedQuotaRejections(evidence, sparse, checkedAt)).toHaveLength(1);
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

// Account XY on 2026-11-13/14, copied from its projection rows and usage reading: Claude
// rejected the Fable bucket at 100%, restored it while keeping the weekly reset, and accepted
// Fable turns again.
const xyThread = "6c8de02d-495c-4023-b91c-926989ecc0e8";
const xyTurn = "e3d43fee-fd82-4b2e-86d6-45787240c0a9";
const xyRejection: QuotaEvidenceRow[] = [
  {
    instanceId: "claude_xiyang",
    thread_id: xyThread,
    turn_id: xyTurn,
    ordinal: 1618746,
    created_at: "2026-11-13T22:04:58.883Z",
    kind: "account.quota-state",
    payload_json: encode({
      quotaStates: [
        {
          windowId: "seven_day_overage_included",
          usageWindowId: "seven_day_fable",
          status: "rejected",
          resetsAt: "2026-11-15T23:00:00.000Z",
        },
      ],
      providerInstanceId: "claude_xiyang",
    }),
  },
  {
    instanceId: "claude_xiyang",
    thread_id: xyThread,
    turn_id: xyTurn,
    ordinal: 1618747,
    created_at: "2026-11-13T22:04:58.890Z",
    kind: "runtime.warning",
    payload_json: encode({
      message:
        "Claude usage limit reached. This turn is paused until the 7-day Fable limit resets in 48h 56m.",
      detail: {
        status: "rejected",
        resetsAt: 1794783600,
        rateLimitType: "seven_day_overage_included",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.56, resetsAt: 1794615000, status: "allowed" },
          seven_day: { utilization: 0.59, resetsAt: 1794783600, status: "allowed" },
          seven_day_overage_included: {
            utilization: 1,
            resetsAt: 1794783600,
            status: "rejected",
            surpassedThreshold: 1,
          },
        },
      },
    }),
  },
  {
    instanceId: "claude_xiyang",
    thread_id: xyThread,
    turn_id: xyTurn,
    ordinal: 1618748,
    created_at: "2026-11-13T22:04:59.511Z",
    kind: "runtime.error",
    payload_json: encode({
      message: "Claude usage limit reached. Send the message again once the limit resets.",
    }),
  },
];
/** A later receipt the provider accepted, on a turn measured to run `model`. */
const xyAccepted = (
  created_at: string,
  model: string | undefined,
  patch: Partial<QuotaEvidenceRow> = {},
): QuotaEvidenceRow => ({
  instanceId: "claude_xiyang",
  thread_id: xyThread,
  turn_id: "2ba47af2-fbcf-4112-b260-0a2c7ac84cd3",
  ordinal: 1627868,
  created_at,
  kind: "account.quota-state",
  payload_json: encode({
    quotaStates: [
      { windowId: "seven_day", status: "allowed", resetsAt: "2026-11-15T23:00:00.000Z" },
    ],
    providerInstanceId: "claude_xiyang",
  }),
  model,
  ...patch,
});
const FABLE = "claude-fable-5-2";
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const fableAccepted = xyAccepted("2026-11-14T15:43:48.066Z", FABLE);
const opusAccepted = xyAccepted("2026-11-14T15:46:33.907Z", "claude-opus-5-5", {
  thread_id: "f24a522c-f59f-46ea-b92c-4fac440e25bc",
  turn_id: "01a56c80-6f2a-478a-b61b-7f76008cce42",
  ordinal: 1627942,
});
const xyChecked = "2026-11-14T15:48:09.811Z";
const xyAt = "2026-11-14T15:51:42.373Z";
const xyReading: ServerProviderUsageLimits = {
  checkedAt: xyChecked,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 5,
      checkedAt: "2026-11-14T05:04:26.226Z",
      resetsAt: "2026-11-14T08:50:00.624Z",
      windowDurationMins: 300,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 44,
      checkedAt: xyChecked,
      resetsAt: "2026-11-15T23:00:01.142Z",
      windowDurationMins: 10080,
    },
    {
      enforcement: { windowId: "seven_day_overage_included", checkedAt: xyChecked },
      modelScope: "Fable",
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 49,
      checkedAt: xyChecked,
      resetsAt: "2026-11-15T23:00:00.142Z",
      windowDurationMins: 10080,
    },
  ],
};
const fableWindow = (patch: object, reading = xyReading): ServerProviderUsageLimits => ({
  ...reading,
  windows: reading.windows.map((w) => (w.id === "seven_day_fable" ? { ...w, ...patch } : w)),
});
const xyUnresolved = (
  rows: QuotaEvidenceRow[],
  reading: ServerProviderUsageLimits | undefined = xyReading,
  now = xyAt,
) => unresolvedQuotaRejections(readQuotaEvidenceRows(rows), reading, now);

it("clears a restored model-scoped rejection once its own bucket reads room again, however old that reading", () => {
  // No turn has run on Fable since; the bucket read 49% after the rejection, in the same cycle.
  expect(xyUnresolved(xyRejection)).toEqual([]);
  expect(xyUnresolved([...xyRejection, opusAccepted])).toEqual([]);
  // The same reading twenty minutes later (XY on 2026-11-17, drained again once its reading aged).
  expect(xyUnresolved(xyRejection, xyReading, "2026-11-14T16:08:10.000Z")).toEqual([]);
  // A bound receipt names its bucket directly; its reading needs no separate mapping.
  expect(
    unresolvedQuotaRejections(
      [readQuotaEvidenceRows(xyRejection).at(-1)!].map((e) => ({
        ...e,
        usageWindowId: "seven_day_fable",
      })),
      fableWindow({ enforcement: undefined }),
      xyAt,
    ),
  ).toEqual([]);
});

it("clears a model-scoped rejection once the provider accepts a later turn on a model it covers", () => {
  // The bucket's only reading is from before the rejection, so it proves nothing on its own.
  const before = "2026-11-13T22:00:00.000Z";
  const old = fableWindow({
    checkedAt: before,
    enforcement: { windowId: "seven_day_overage_included", checkedAt: before },
  });
  expect(xyUnresolved(xyRejection, old)).toHaveLength(1);
  expect(xyUnresolved([...xyRejection, fableAccepted], old)).toEqual([]);
  expect(xyUnresolved([fableAccepted, ...xyRejection].toReversed(), old)).toEqual([]);
  // Without any reading of the bucket, the same model as the rejected turn accepted again.
  const unread = (rows: QuotaEvidenceRow[]) =>
    unresolvedQuotaRejections(readQuotaEvidenceRows(rows), undefined, xyAt);
  const onFable = xyRejection.map((row) => ({ ...row, model: FABLE }));
  expect(unread([...onFable, fableAccepted])).toEqual([]);
  expect(unread([...onFable, opusAccepted])).toHaveLength(1);
  expect(unread([...xyRejection, fableAccepted])).toHaveLength(1);
});

it("keeps a model-scoped rejection that nothing after it shows over", () => {
  const held = (rows: QuotaEvidenceRow[], reading?: ServerProviderUsageLimits, now?: string) =>
    expect(xyUnresolved(rows, reading, now)).toHaveLength(1);
  const before = "2026-11-13T22:00:00.000Z";
  const old = fableWindow({
    checkedAt: before,
    enforcement: { windowId: "seven_day_overage_included", checkedAt: before },
  });
  // The scoped window still reads full, or was read before the rejection.
  held(xyRejection, fableWindow({ usedPercent: 100 }));
  held(xyRejection, old);
  // Only the account-wide windows were read; the scoped bucket has no reading at all.
  held(xyRejection, {
    ...xyReading,
    windows: xyReading.windows.filter((w) => w.id !== "seven_day_fable"),
  });
  // An association from before the rejection cannot identify the later numeric reading.
  held(
    xyRejection,
    fableWindow({ enforcement: { windowId: "seven_day_overage_included", checkedAt: before } }),
  );
  // The reading belongs to another cycle than the one the rejection named.
  held(xyRejection, fableWindow({ resetsAt: "2026-11-15T21:00:00.000Z" }));
  // An acceptance before the rejection, after now, on another model or on another account.
  held([...xyRejection, xyAccepted("2026-11-13T21:58:26.846Z", FABLE)], old);
  held([...xyRejection, fableAccepted], old, "2026-11-14T15:40:00.000Z");
  held([...xyRejection, opusAccepted], old);
  held(
    [
      ...xyRejection,
      {
        ...fableAccepted,
        instanceId: "claude_xinya",
        payload_json: fableAccepted.payload_json.replace("claude_xiyang", "claude_xinya"),
      },
    ],
    old,
  );
  // A rejection that did not record the bucket used up is not explained by a low reading.
  const notExhausted = xyRejection.map((row) =>
    row.kind === "runtime.warning"
      ? {
          ...row,
          payload_json: row.payload_json.replace('"utilization":1,', '"utilization":0.99,'),
        }
      : row,
  );
  expect(notExhausted[1]!.payload_json).toContain('"utilization":0.99,');
  held(notExhausted);
  // A new rejection after the acceptance and the reading is authoritative.
  held([
    ...xyRejection,
    fableAccepted,
    ...xyRejection.map((row) => ({
      ...row,
      created_at: row.created_at.replace("2026-11-13T22:04", "2026-11-14T15:49"),
      ordinal: row.ordinal + 20_000,
    })),
  ]);
});

it("offers XY for a Fable high worker once its restored Fable bucket clears the rejection, and as that reading ages", () => {
  const claudeProvider = (instanceId: string, label: string, limits: ServerProviderUsageLimits) =>
    decodeProvider({
      instanceId,
      displayName: label,
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", email: `${instanceId}@example.test` },
      checkedAt: xyAt,
      models: ["claude-opus-5-5", FABLE].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: ["high", "xhigh"].map((id) => ({ id, label: id })),
            },
          ],
        },
      })),
      usageLimits: limits,
    });
  // ARA is 94% into its week, as when XY was passed over.
  const ara = claudeProvider("claude_ara", "ARA", {
    checkedAt: xyChecked,
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 94,
        checkedAt: xyChecked,
        resetsAt: "2026-11-16T02:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
  });
  const decide = (reading: ServerProviderUsageLimits, now = xyAt) => {
    const inventory = allocationInventory({
      environmentId: "sliara",
      at: now,
      providers: [claudeProvider("claude_xiyang", "XY", reading), ara],
      threads: [],
      measurements: {
        observedAt: xyAt,
        monitoredInstanceIds: [],
        retentionDays: 14,
        persistenceError: null,
        accounts: [],
        turns: [],
        totalMatchingTurns: 0,
        profiles: [],
        limitations: [],
      },
      quotaEvidence: readQuotaEvidenceRows(xyRejection),
    });
    return decideAllocation({
      at: now,
      policy: defaultAllocationPolicy,
      request: {
        kind: "worker",
        assignmentId: "fable-high",
        environmentId: "sliara",
        threadId: ThreadId.make("fable-high"),
        driver: inventory.accounts[0]!.driver,
        model: FABLE,
        options: [{ id: "effort", value: "high" }],
        expectedHours: 2,
      },
      inventories: [inventory],
      reservations: [],
      authorityAvailable: true,
    });
  };
  // Before the provider restored it, the bucket's last reading predates the rejection.
  const old = "2026-11-13T22:00:00.000Z";
  const before = decide(
    fableWindow({
      checkedAt: old,
      enforcement: { windowId: "seven_day_overage_included", checkedAt: old },
    }),
  );
  expect(before.selectedInstanceId).toBe("claude_ara");
  expect(before.candidates.find((c) => c.instanceId === "claude_xiyang")).toMatchObject({
    drainedUntil: "2026-11-15T23:00:00.000Z",
    line: expect.stringContaining(
      "drained until 2026-11-15T23:00:00.000Z (provider limit rejection on Weekly · Fable)",
    ),
  });
  // Once it reads room, and still when that reading is twenty minutes old.
  for (const now of [xyAt, "2026-11-14T16:08:10.000Z"]) {
    const after = decide(xyReading, now);
    expect(after.selectedInstanceId).toBe("claude_xiyang");
    expect(after.candidates.find((c) => c.instanceId === "claude_xiyang")).toMatchObject({
      eligible: true,
      roomPoints: 51,
    });
  }
});
