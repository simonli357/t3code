import { unresolvedQuotaRejections, type QuotaEvidence } from "./quotaEvidence.ts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import type {
  AllocationAccount,
  AllocationInventory,
  AllocationRequest,
  OrchestrationThreadShell,
  ServerProvider,
  UsageMeasurementsReport,
} from "@t3tools/contracts";

/** Login identity is shared across aliases and computers; credential bytes never leave the registry. */
export function allocationIdentity(provider: ServerProvider): string | null {
  const identity = provider.auth.email?.trim().toLowerCase();
  return identity
    ? NodeCrypto.createHash("sha256")
        .update(JSON.stringify([provider.driver, identity]))
        .digest("hex")
    : null;
}
const contextBand = (tokens: number | undefined) =>
  tokens === undefined
    ? "unknown"
    : tokens < 32_000
      ? "under32k"
      : tokens < 128_000
        ? "32k-128k"
        : tokens < 256_000
          ? "128k-256k"
          : "256k+";

export function allocationInventory(input: {
  environmentId: string;
  at: string;
  providers: readonly ServerProvider[];
  threads: readonly OrchestrationThreadShell[];
  measurements: UsageMeasurementsReport;
  quotaEvidence?: readonly QuotaEvidence[];
  maxReadingAgeMinutes?: number;
  request?: AllocationRequest;
}): AllocationInventory {
  const { environmentId, at, providers, threads, measurements, request } = input;
  const accounts: AllocationAccount[] = providers.map((p) => {
    const measured = measurements.accounts.find((a) => a.instanceIds.includes(p.instanceId));
    const effort =
      request?.options.find((o) => o.id === "reasoningEffort" || o.id === "effort")?.value ?? null;
    const profile = request
      ? measurements.profiles.find(
          (v) =>
            v.instanceId === p.instanceId &&
            v.model === request.model &&
            v.effort === effort &&
            v.contextBand === contextBand(request.contextTokens),
        )
      : undefined;
    const limits = p.usageLimits;
    const evidence = (input.quotaEvidence ?? []).filter((e) => e.instanceId === p.instanceId);
    // Legacy shells without projected receipts still need conservative protection.
    for (const t of threads) {
      if (
        (t.session?.providerInstanceId ?? t.modelSelection.instanceId) === p.instanceId &&
        t.session?.status === "error" &&
        /usage.?limit|rate.?limit|quota/i.test(t.session.lastError ?? "") &&
        !evidence.some((e) => e.threadId === t.id && e.at >= t.session!.updatedAt)
      )
        evidence.push({
          instanceId: p.instanceId,
          windowId: "unknown",
          status: "rejected",
          at: t.session.updatedAt,
        });
    }
    const rejected = unresolvedQuotaRejections(
      evidence,
      limits,
      at,
      input.maxReadingAgeMinutes ?? 15,
    );
    const limitedUntil =
      rejected
        .map((e) => e.resetsAt)
        .filter((v): v is string => !!v)
        .sort()
        .at(-1) ?? null;
    const failed =
      rejected.length > 0 ||
      threads.some(
        (t) =>
          (t.session?.providerInstanceId ?? t.modelSelection.instanceId) === p.instanceId &&
          t.session?.status === "error" &&
          /unauthori[sz]ed|authentication/i.test(t.session.lastError ?? ""),
      );
    const available =
      p.enabled &&
      p.installed &&
      p.availability !== "unavailable" &&
      p.status !== "error" &&
      p.status !== "disabled" &&
      p.auth.status === "authenticated" &&
      !failed &&
      !limits?.unavailable;
    return {
      retainHistory: measurements.monitoredInstanceIds.includes(p.instanceId),
      environmentId,
      instanceId: p.instanceId,
      driver: p.driver,
      accountKey: allocationIdentity(p),
      label: p.displayName ?? p.instanceId,
      available,
      unavailableReason: available
        ? null
        : failed
          ? "Provider rejected an ongoing session for quota/auth; resolve the rejection before new admission."
          : "Provider is not authenticated, healthy, or reporting quota.",
      limitedUntil,
      models: p.models.map(({ slug, capabilities }) => ({ slug, capabilities })),
      shortWindow: limits?.windows.some(
        (w) =>
          w.kind === "session" ||
          (w.windowDurationMins !== undefined && w.windowDurationMins <= 1440),
      )
        ? "reported"
        : limits?.shortWindowAbsent === true && limits.shortWindowAbsentCheckedAt !== undefined
          ? "known-absent"
          : "unknown",
      ...(limits?.shortWindowAbsentCheckedAt
        ? { shortWindowAbsentCheckedAt: limits.shortWindowAbsentCheckedAt }
        : {}),
      windows: (limits?.windows ?? []).map((w) => {
        const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const scope = w.modelScope ? normalize(w.modelScope) : null;
        const scopedModels = scope
          ? p.models
              .filter((m) => `-${normalize(m.slug)}-`.includes(`-${scope}-`))
              .map((m) => m.slug)
          : [];
        const rate = measured?.windows.find(
          (v) =>
            v.window.id === w.id &&
            w.resetsAt !== undefined &&
            v.window.resetsAt === w.resetsAt &&
            v.window.windowDurationMins === w.windowDurationMins,
        );
        const duration =
          w.windowDurationMins !== undefined && w.windowDurationMins > 0
            ? w.windowDurationMins / 60
            : null;
        return {
          id: w.id,
          label: w.label,
          kind: w.kind,
          usedPoints: w.usedPercent,
          checkedAt: w.checkedAt ?? limits!.checkedAt,
          resetsAt: w.resetsAt ?? null,
          cycleStartedAt:
            w.resetsAt && duration
              ? DateTime.formatIso(
                  DateTime.makeUnsafe(Date.parse(w.resetsAt) - duration * 3_600_000),
                )
              : null,
          durationHours: duration,
          ...(w.applicableModels
            ? { models: w.applicableModels }
            : scopedModels.length
              ? { models: scopedModels }
              : {}),
          ratePointsPerHour: rate?.rate.percentagePointsPerHour ?? null,
          samples: rate?.rate.sampleCount ?? 0,
          predictionErrorPointsPerHour: rate?.rate.predictionErrorPointsPerHour ?? null,
          rateAgeMinutes: rate ? rate.ageSeconds / 60 : null,
        };
      }),
      resetCredits: limits?.resetCredits
        ? {
            count: limits.resetCredits.availableCount,
            expiresAt: limits.resetCredits.nextExpiresAt ?? null,
            scope: "Provider-reported credit; scope not reported. No automatic redemption.",
          }
        : null,
      profileSamples: profile?.turns ?? 0,
      // Token rates never become quota. Comparable variability can only increase
      // the cold-start margin, bounded to 2x; absent context remains unknown.
      profileUncertainty:
        profile && profile.turns >= 5 && profile.medianOutputTokensPerTurnHour > 0
          ? Math.max(
              1,
              Math.min(
                2,
                profile.p90OutputTokensPerTurnHour / profile.medianOutputTokensPerTurnHour,
              ),
            )
          : 1,
    };
  });
  return {
    environmentId,
    observedAt: at,
    complete: true,
    accounts,
    demand: threads
      .filter(
        (t) =>
          t.session?.status === "running" ||
          t.session?.status === "starting" ||
          t.backgroundLiveness === "working" ||
          t.latestTurn?.state === "running",
      )
      .map((t) => {
        const instanceId = t.session?.providerInstanceId ?? t.modelSelection.instanceId;
        return {
          environmentId,
          threadId: t.id,
          instanceId,
          accountKey: accounts.find((a) => a.instanceId === instanceId)?.accountKey ?? null,
          model: t.modelSelection.model,
          options: t.modelSelection.options ?? [],
          state: t.session?.status === "starting" ? "pending" : "running",
        };
      }),
    notices: [
      "Quota deltas include external and shared use. Token variability only increases uncertainty; it is not converted to subscription percentages.",
      "Normal cycle starts use the provider-reported duration and reset schedule; manual reset plans do not advance that schedule.",
    ],
  };
}
