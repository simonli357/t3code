import {
  ProviderQuotaState,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type QuotaEvidence = typeof ProviderQuotaState.Type & {
  instanceId: string;
  at: string;
  ordinal?: number;
  threadId?: string;
  /** Native Claude rejection identifies exhaustion of this account-wide bucket. */
  exhausted?: boolean;
};
export type QuotaEvidenceRow = {
  payload_json: string;
  created_at: string;
  kind: string;
  ordinal: number;
  thread_id: string;
  turn_id: string | null;
  instanceId: string;
  native_error_text?: string | null;
};
const Payload = Schema.Struct({
  providerInstanceId: Schema.optional(Schema.String),
  quotaStates: Schema.optional(Schema.Array(ProviderQuotaState)),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.Unknown),
});
const LegacyWarning = Schema.Struct({
  status: Schema.Literal("rejected"),
  rateLimitType: Schema.optional(Schema.String),
  resetsAt: Schema.optional(Schema.Number),
  utilization: Schema.optional(Schema.Unknown),
  isUsingOverage: Schema.optional(Schema.Unknown),
  unifiedWindows: Schema.optional(Schema.Unknown),
});
const decodeNativeWindows = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Struct({ utilization: Schema.optional(Schema.Number) })),
);
const decodeLegacyWarning = Schema.decodeUnknownSync(LegacyWarning);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));
const decodeOptional = Schema.decodeUnknownOption(Schema.fromJsonString(Payload));
const decodeSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      providerInstanceId: Schema.optional(Schema.String),
      providerName: Schema.optional(Schema.String),
    }),
  ),
);

export function quotaEvidenceInstances(
  historicalSession: string | null,
  fallback: string,
  providers: readonly ServerProvider[],
  payloadJson: string,
): string[] {
  const explicit = Option.getOrUndefined(decodeOptional(payloadJson))?.providerInstanceId;
  if (explicit !== undefined) return [explicit];
  const session =
    historicalSession === null
      ? undefined
      : Option.getOrUndefined(decodeSession(historicalSession));
  const instanceId = session?.providerInstanceId ?? fallback;
  const provider = providers.find((p) => p.instanceId === instanceId);
  // Some imported histories relabelled the instance while retaining the original
  // driver. Never charge Claude evidence to Codex; retain conservative protection
  // on every possible account of the recorded driver when its identity was lost.
  if (session?.providerName && provider && provider.driver !== session.providerName)
    return providers.filter((p) => p.driver === session.providerName).map((p) => p.instanceId);
  return [instanceId];
}

/** Read the populated projection shapes, including pre-receipt histories. */
export function readQuotaEvidence(
  row: { payload_json: string; created_at: string; kind: string; ordinal?: number },
  instanceId: string,
): QuotaEvidence[] {
  try {
    const payload = decode(row.payload_json);
    const base = {
      instanceId: payload.providerInstanceId ?? instanceId,
      at: row.created_at,
      ...(row.ordinal !== undefined ? { ordinal: row.ordinal } : {}),
    };
    if (payload.quotaStates) return payload.quotaStates.map((state) => ({ ...base, ...state }));
    if (
      row.kind === "runtime.error" &&
      /usage.?limit|rate.?limit|quota/i.test(payload.message ?? "")
    )
      return [{ ...base, windowId: "unknown", status: "rejected" }];
    if (row.kind === "runtime.warning") {
      const detail = decodeLegacyWarning(payload.detail);
      const utilization =
        detail.utilization ??
        Option.getOrUndefined(decodeNativeWindows(detail.unifiedWindows))?.[
          detail.rateLimitType ?? ""
        ]?.utilization;
      const resetsAt =
        detail.resetsAt === undefined
          ? undefined
          : Option.getOrUndefined(
              Option.map(DateTime.make(detail.resetsAt * 1000), DateTime.formatIso),
            );
      return [
        {
          ...base,
          windowId: detail.rateLimitType ?? "unknown",
          ...(detail.isUsingOverage === false &&
          (detail.rateLimitType === "five_hour" || detail.rateLimitType === "seven_day") &&
          typeof utilization === "number" &&
          Number.isFinite(utilization) &&
          utilization >= 1
            ? { exhausted: true }
            : {}),
          status: "rejected",
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
    }
  } catch {
    /* An ordinary warning or malformed historical payload is not a quota receipt. */
  }
  return [];
}

/** Keep the last quota warning on the same turn/account. Unrelated tool rows
 * may intervene; another quota receipt breaks the pair. */
export function readQuotaEvidenceRows(rows: readonly QuotaEvidenceRow[]): QuotaEvidence[] {
  const decoded = rows.map((row) => ({ row, evidence: readQuotaEvidence(row, row.instanceId) }));
  const ordered = [...decoded].sort((a, b) => a.row.ordinal - b.row.ordinal);
  const lastByTurn = new Map<string, (typeof decoded)[number]>();
  const previousByEntry = new Map<(typeof decoded)[number], (typeof decoded)[number]>();
  for (const entry of ordered) {
    const key = `${entry.row.instanceId}:${entry.row.thread_id}:${entry.row.turn_id}`;
    const previous = lastByTurn.get(key);
    if (previous) previousByEntry.set(entry, previous);
    if (entry.evidence.length) lastByTurn.set(key, entry);
  }
  return decoded.flatMap((entry) => {
    const { row } = entry;
    let { evidence } = entry;
    const previous = previousByEntry.get(entry);
    if (
      row.kind === "runtime.error" &&
      row.turn_id !== null &&
      evidence.length === 1 &&
      evidence[0]!.windowId === "unknown" &&
      previous?.row.kind === "runtime.warning" &&
      previous.row.thread_id === row.thread_id &&
      previous.row.turn_id === row.turn_id &&
      previous.row.created_at <= row.created_at &&
      previous.evidence.length > 0 &&
      previous.evidence.every(
        (e) =>
          e.instanceId === evidence[0]!.instanceId &&
          e.status === "rejected" &&
          e.windowId !== "unknown",
      ) &&
      decode(row.payload_json).quotaStates === undefined &&
      decode(row.payload_json).message ===
        "Claude usage limit reached. Send the message again once the limit resets."
    ) {
      evidence = previous.evidence.map((e) => ({ ...e, at: row.created_at, ordinal: row.ordinal }));
    }
    // Older Claude retries emit no new quota event, but retain the native error
    // message on this exact failed turn. Do not infer scope from neighboring turns.
    const nativeWindow =
      /^You've hit your (session|weekly) limit [\u00b7\uFFFD] resets [^\r\n]+$/.exec(
        row.native_error_text ?? "",
      )?.[1];
    if (
      row.kind === "runtime.error" &&
      row.turn_id !== null &&
      evidence.length === 1 &&
      evidence[0]!.windowId === "unknown" &&
      decode(row.payload_json).quotaStates === undefined &&
      decode(row.payload_json).message ===
        "Claude usage limit reached. Send the message again once the limit resets." &&
      nativeWindow
    ) {
      evidence = evidence.map((e) => ({
        ...e,
        windowId: nativeWindow === "session" ? "five_hour" : "seven_day",
      }));
    }
    return evidence.map((e) => ({ ...e, threadId: row.thread_id }));
  });
}

export function unresolvedQuotaRejections(
  evidence: readonly QuotaEvidence[],
  limits: ServerProviderUsageLimits | undefined,
  at: string,
  maxAgeMinutes: number,
): QuotaEvidence[] {
  const latest = new Map<string, QuotaEvidence>();
  // The projection supplies newest insertion first for same-clock events.
  for (const e of evidence) {
    const old = latest.get(e.windowId);
    if (!old || e.at > old.at || (e.at === old.at && (e.ordinal ?? 0) > (old.ordinal ?? 0)))
      latest.set(e.windowId, e);
  }
  return [...latest.values()].filter((e) => {
    if (e.status === "allowed") return false;
    const windows =
      e.windowId === "unknown"
        ? (limits?.windows ?? [])
        : (limits?.windows ?? []).filter((w) =>
            e.usageWindowId
              ? w.id === e.usageWindowId
              : w.id === e.windowId || w.enforcement?.windowId === e.windowId,
          );
    // A known event binding cannot migrate to another model. Otherwise a later
    // complete probe can establish it, but multiple possible buckets stay unknown.
    if (e.windowId !== "unknown" && windows.length !== 1) return true;
    if (!e.usageWindowId && windows[0]?.id !== e.windowId && e.windowId !== "unknown") {
      const mappedAt = Date.parse(windows[0]?.enforcement?.checkedAt ?? "");
      if (
        !Number.isFinite(mappedAt) ||
        mappedAt > Date.parse(at) ||
        Date.parse(at) - mappedAt > maxAgeMinutes * 60_000
      )
        return true;
    }
    // A passed timestamp is not replenishment. For legacy errors without a reset,
    // every reported window must prove a cycle beginning after the rejection.
    return (
      !windows.length ||
      !windows.every((w) => {
        const checked = Date.parse(w.checkedAt ?? limits!.checkedAt);
        if (
          checked > Date.parse(at) ||
          Date.parse(at) - checked > maxAgeMinutes * 60_000 ||
          checked <= Date.parse(e.at) ||
          w.usedPercent >= 100
        )
          return false;
        // An explicit empty/inactive five-hour probe confirms that the old rolling
        // window ended. Missing resets on sparse updates provide no such evidence.
        if (
          e.windowId === "five_hour" &&
          w.id === "five_hour" &&
          w.inactive &&
          w.usedPercent === 0 &&
          !w.resetsAt &&
          (e.resetsAt
            ? checked > Date.parse(e.resetsAt)
            : w.windowDurationMins === 300 && checked > Date.parse(e.at) + 300 * 60_000)
        )
          return true;
        if (!w.resetsAt) return false;
        // A restored account-wide allowance can retain its scheduled weekly reset.
        // Require recorded exhaustion AND later provider acceptance, not merely a
        // low reading. Scoped/unknown limits never borrow another bucket's recovery.
        if (
          e.exhausted &&
          (e.windowId === "five_hour" || e.windowId === "seven_day") &&
          w.id === e.windowId &&
          e.resetsAt &&
          Math.abs(Date.parse(w.resetsAt) - Date.parse(e.resetsAt)) <= 1000 &&
          evidence.some(
            (a) =>
              a.instanceId === e.instanceId &&
              a.status === "allowed" &&
              (a.windowId === "five_hour" || a.windowId === "seven_day") &&
              a.at > e.at &&
              Date.parse(a.at) <= checked,
          )
        )
          return true;
        if (e.resetsAt) return checked > Date.parse(e.resetsAt) && w.resetsAt > e.resetsAt;
        return (
          w.windowDurationMins !== undefined &&
          Date.parse(w.resetsAt) - w.windowDurationMins * 60_000 > Date.parse(e.at)
        );
      })
    );
  });
}
