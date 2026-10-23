import { ProviderQuotaState, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type QuotaEvidence = typeof ProviderQuotaState.Type & {
  instanceId: string;
  at: string;
  ordinal?: number;
  threadId?: string;
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
});
const decodeLegacyWarning = Schema.decodeUnknownSync(LegacyWarning);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));

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
        : (limits?.windows ?? []).filter((w) => w.id === e.windowId);
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
          w.usedPercent >= 100 ||
          !w.resetsAt
        )
          return false;
        if (e.resetsAt) return checked > Date.parse(e.resetsAt) && w.resetsAt > e.resetsAt;
        return (
          w.windowDurationMins !== undefined &&
          Date.parse(w.resetsAt) - w.windowDurationMins * 60_000 > Date.parse(e.at)
        );
      })
    );
  });
}
