import * as NodeCrypto from "node:crypto";
import {
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type UsageMeasurementsInput,
  type UsageMeasurementsReport,
  UsageTurnMeasurement,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

const HOUR = 3_600_000;
const RETENTION = 14 * 24 * HOUR;
const MAX_TURNS = 5_000;
const MAX_SAMPLES = 30_000;
const QuotaSample = Schema.Struct({
  accountKey: Schema.String,
  instanceId: Schema.String,
  identityKnown: Schema.Boolean,
  checkedAt: Schema.String,
  window: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
    label: Schema.String,
    usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    resetsAt: Schema.optional(Schema.String),
    windowDurationMins: Schema.optional(Schema.Number),
  }),
});
const StoredMeasurements = Schema.Struct({
  version: Schema.Literal(1),
  turns: Schema.Array(UsageTurnMeasurement),
  quotas: Schema.Array(QuotaSample),
});
const decodeStoredMeasurements = Schema.decodeUnknownSync(StoredMeasurements);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Turn = Mutable<UsageTurnMeasurement>;
type Sample = typeof QuotaSample.Type;
type Selection = { model: string; effort?: string | undefined; createdAt: string };
const key = (instanceId: string, threadId: string, turnId: string) =>
  JSON.stringify([instanceId, threadId, turnId]);
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
const contextBand = (tokens: number | null) =>
  tokens === null
    ? "unknown"
    : tokens < 32_000
      ? "under32k"
      : tokens < 128_000
        ? "32k-128k"
        : tokens < 256_000
          ? "128k-256k"
          : "256k+";

/** No text, tool arguments, credentials or transcript bodies are retained. */
export class MeasurementHistory {
  private allowed = new Set<string>();
  private scopeApplied = false;
  private readonly turns = new Map<string, Turn>();
  private quotas: Sample[] = [];
  private readonly identities = new Map<string, { accountKey: string; identityKnown: boolean }>();
  private readonly tools = new Map<string, { open: Set<string>; since: number | null }>();
  private readonly contexts = new Map<string, number>();

  setAllowed(instanceIds: readonly string[]) {
    if (
      this.scopeApplied &&
      this.allowed.size === instanceIds.length &&
      instanceIds.every((id) => this.allowed.has(id))
    )
      return;
    this.scopeApplied = true;
    this.allowed = new Set(instanceIds);
    for (const [id, turn] of this.turns) {
      if (!this.allowed.has(turn.instanceId)) {
        this.turns.delete(id);
        this.tools.delete(id);
      }
    }
    this.quotas = this.quotas.filter((s) => this.allowed.has(s.instanceId));
    for (const id of this.identities.keys()) if (!this.allowed.has(id)) this.identities.delete(id);
    for (const id of this.contexts.keys())
      if (!this.allowed.has(JSON.parse(id)[0])) this.contexts.delete(id);
  }

  restore(raw: unknown) {
    this.scopeApplied = false;
    const stored = decodeStoredMeasurements(raw);
    this.quotas = [...stored.quotas].slice(-MAX_SAMPLES);
    for (const item of stored.turns.slice(-MAX_TURNS)) {
      const turn = { ...item };
      // Downtime is not measured execution. A later event may create a new,
      // incomplete observation, but must never extend this turn through downtime.
      if (turn.state === "running") {
        turn.state = "interrupted";
        turn.endedAt = turn.lastObservedAt;
        turn.toolTimingComplete = false;
      }
      this.turns.set(key(turn.instanceId, turn.threadId, turn.turnId), turn);
    }
  }

  snapshot(now: number) {
    this.prune(now);
    return { version: 1, turns: [...this.turns.values()], quotas: this.quotas };
  }

  recordProviders(providers: readonly ServerProvider[]) {
    for (const provider of providers) {
      if (!this.allowed.has(provider.instanceId)) continue;
      const identity =
        provider.auth.email?.toLowerCase() ?? provider.usageLimits?.credentialFingerprint;
      const accountKey = identity
        ? NodeCrypto.createHash("sha256")
            .update(`${provider.driver}:${identity}:${provider.auth.label ?? ""}`)
            .digest("hex")
            .slice(0, 24)
        : `unknown:${provider.instanceId}`;
      this.identities.set(provider.instanceId, { accountKey, identityKnown: Boolean(identity) });
      const limits = provider.usageLimits;
      if (!limits || limits.unavailable) continue;
      for (const window of limits.windows) {
        this.recordQuota({
          accountKey,
          identityKnown: Boolean(identity),
          instanceId: provider.instanceId,
          checkedAt: window.checkedAt ?? limits.checkedAt,
          window,
        });
      }
    }
  }

  private recordQuota(sample: Sample) {
    const timestamp = Date.parse(sample.checkedAt);
    if (!Number.isFinite(timestamp)) return;
    const previous = this.quotas.findLast(
      (s) => s.accountKey === sample.accountKey && s.window.id === sample.window.id,
    );
    if (previous) {
      if (timestamp <= Date.parse(previous.checkedAt)) return;
      // Registry snapshots merge sparse native windows. An unchanged window's
      // new snapshot timestamp is NOT proof it was remeasured. Keep its age.
      if (
        previous.window.usedPercent === sample.window.usedPercent &&
        previous.window.resetsAt === sample.window.resetsAt
      )
        return;
    }
    this.quotas.push(sample);
    if (this.quotas.length > MAX_SAMPLES) this.quotas.splice(0, this.quotas.length - MAX_SAMPLES);
  }

  observe(event: ProviderRuntimeEvent, selection?: Selection) {
    const instanceId = event.providerInstanceId;
    if (!instanceId || !this.allowed.has(instanceId) || !event.turnId) return;
    const measuredTypes = [
      "turn.started",
      "turn.completed",
      "turn.aborted",
      "thread.token-usage.updated",
      "item.started",
      "item.completed",
      "model.rerouted",
    ];
    if (!measuredTypes.includes(event.type)) return;
    const now = Date.parse(event.createdAt);
    if (!Number.isFinite(now)) return;
    const id = key(instanceId, event.threadId, event.turnId);
    let turn = this.turns.get(id);
    if (turn && turn.state !== "running") return;
    const contextKey = JSON.stringify([instanceId, event.threadId]);
    if (!turn) {
      const initial = this.contexts.get(contextKey) ?? null;
      turn = {
        instanceId,
        accountKey: this.identities.get(instanceId)?.accountKey ?? `unknown:${instanceId}`,
        threadId: event.threadId,
        turnId: event.turnId,
        model: selection?.model ?? null,
        effort: selection?.effort ?? null,
        selectionSource: selection ? "thread" : "unknown",
        sessionCreatedAt: selection?.createdAt ?? null,
        observedAt: event.createdAt,
        startedAt: null,
        endedAt: null,
        state: "running",
        lastObservedAt: event.createdAt,
        initialContextTokens: initial,
        latestContextTokens: initial,
        peakContextTokens: initial,
        contextCapacityTokens: null,
        compactions: 0,
        mixedModels: false,
        toolWallMs: 0,
        toolTimingComplete: event.type === "turn.started",
        apiDurationMs: null,
        tokens: null,
      };
      this.turns.set(id, turn);
      this.prune(now);
    }
    if (now < Date.parse(turn.lastObservedAt)) return;
    turn.lastObservedAt = event.createdAt;
    if (event.type === "turn.started") {
      turn.startedAt ??= event.createdAt;
      if (selection) {
        turn.model = selection.model;
        turn.effort = selection.effort ?? null;
        turn.sessionCreatedAt = selection.createdAt;
        turn.selectionSource = "thread";
      }
      if (event.payload.model) {
        turn.model = event.payload.model;
        turn.selectionSource = "provider";
      }
      if (event.payload.effort) turn.effort = event.payload.effort;
    } else if (event.type === "thread.token-usage.updated") {
      const usage = event.payload.usage;
      turn.latestContextTokens = usage.usedTokens;
      turn.peakContextTokens = Math.max(turn.peakContextTokens ?? 0, usage.usedTokens);
      turn.contextCapacityTokens = usage.maxTokens ?? turn.contextCapacityTokens;
      this.contexts.set(contextKey, usage.usedTokens);
    } else if (event.type === "model.rerouted") {
      turn.mixedModels = true;
    } else if (event.type === "item.started" || event.type === "item.completed") {
      if (event.payload.itemType === "context_compaction" && event.type === "item.completed")
        turn.compactions++;
      if (
        !event.itemId ||
        !isToolLifecycleItemType(event.payload.itemType) ||
        event.payload.agentId ||
        event.payload.parentToolUseId
      )
        return;
      const timing = this.tools.get(id) ?? { open: new Set<string>(), since: null };
      if (event.type === "item.started") {
        if (timing.open.size === 0) timing.since = now;
        timing.open.add(event.itemId);
      } else if (!timing.open.delete(event.itemId)) {
        turn.toolTimingComplete = false;
      } else if (timing.open.size === 0 && timing.since !== null) {
        turn.toolWallMs += Math.max(0, now - timing.since);
        timing.since = null;
      }
      this.tools.set(id, timing);
    } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const timing = this.tools.get(id);
      if (timing?.since !== null && timing?.since !== undefined) {
        turn.toolWallMs += Math.max(0, now - timing.since);
        turn.toolTimingComplete = false;
      }
      this.tools.delete(id);
      turn.endedAt = event.createdAt;
      turn.state =
        event.type === "turn.aborted"
          ? "aborted"
          : event.payload.state === "completed"
            ? "completed"
            : "failed";
      turn.tokens = event.payload.tokenUsage ?? null;
      if (event.type === "turn.completed") turn.apiDurationMs = event.payload.apiDurationMs ?? null;
    }
  }

  private prune(now: number) {
    for (const [id, turn] of this.turns) {
      if (Date.parse(turn.lastObservedAt) < now - RETENTION || this.turns.size > MAX_TURNS) {
        this.turns.delete(id);
        this.tools.delete(id);
      }
    }
    this.quotas = this.quotas
      .filter((s) => Date.parse(s.checkedAt) >= now - RETENTION)
      .slice(-MAX_SAMPLES);
    if (this.contexts.size > MAX_TURNS) this.contexts.clear();
  }

  report(input: UsageMeasurementsInput, now: number): UsageMeasurementsReport {
    this.prune(now);
    const since = now - (input.lookbackHours ?? 168) * HOUR;
    const matching = [...this.turns.values()].filter(
      (t) =>
        Date.parse(t.lastObservedAt) >= since &&
        (!input.instanceId || t.instanceId === input.instanceId) &&
        (!input.threadId || t.threadId === input.threadId),
    );
    const turns = matching
      .toSorted(
        (a, b) =>
          Number(b.state === "running") - Number(a.state === "running") ||
          Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt),
      )
      .slice(0, input.turnLimit ?? 30)
      .map((t) => {
        const end = t.endedAt ? Date.parse(t.endedAt) : now;
        const elapsedMs = Math.max(0, end - Date.parse(t.startedAt ?? t.observedAt));
        const openSince = this.tools.get(key(t.instanceId, t.threadId, t.turnId))?.since;
        const toolWallMs = t.toolWallMs + (openSince != null ? Math.max(0, end - openSince) : 0);
        return {
          ...t,
          toolWallMs,
          elapsedMs,
          sessionAgeMs: t.sessionCreatedAt
            ? Math.max(0, end - Date.parse(t.sessionCreatedAt))
            : null,
          nonToolWallMs: t.toolTimingComplete ? Math.max(0, elapsedMs - toolWallMs) : null,
        };
      });
    const groups = new Map<
      string,
      { turn: Turn; inputs: number[]; outputs: number[]; duration: number }
    >();
    for (const t of matching) {
      if (
        t.state !== "completed" ||
        !t.startedAt ||
        !t.endedAt ||
        !t.model ||
        t.mixedModels ||
        t.tokens?.usageStatus !== "complete" ||
        t.tokens.hasSubagents
      )
        continue;
      const duration = Date.parse(t.endedAt) - Date.parse(t.startedAt);
      if (duration < 60_000) continue;
      const id = JSON.stringify([
        t.accountKey,
        t.instanceId,
        t.model,
        t.effort,
        contextBand(t.peakContextTokens),
      ]);
      const group = groups.get(id) ?? { turn: t, inputs: [], outputs: [], duration: 0 };
      group.inputs.push((t.tokens.inputTokens * HOUR) / duration);
      group.outputs.push((t.tokens.outputTokens * HOUR) / duration);
      group.duration += duration;
      groups.set(id, group);
    }
    const accountGroups = new Map<string, Sample[]>();
    for (const s of this.quotas) {
      if (Date.parse(s.checkedAt) < since) continue;
      const items = accountGroups.get(s.accountKey) ?? [];
      items.push(s);
      accountGroups.set(s.accountKey, items);
    }
    const accounts: UsageMeasurementsReport["accounts"][number][] = [];
    for (const [accountKey, samples] of accountGroups) {
      const instanceIds = [...this.identities]
        .filter(([, value]) => value.accountKey === accountKey)
        .map(([id]) => id);
      if (input.instanceId && !instanceIds.includes(input.instanceId)) continue;
      const latest = new Map<string, Sample>();
      for (const s of samples) latest.set(s.window.id, s);
      accounts.push({
        accountKey,
        instanceIds,
        identityKnown: samples.at(-1)!.identityKnown,
        windows: [...latest.values()].map((s) => ({
          window: s.window,
          checkedAt: s.checkedAt,
          ageSeconds: Math.max(0, (now - Date.parse(s.checkedAt)) / 1000),
          rate: quotaRate(
            samples.filter((p) => p.window.id === s.window.id),
            now,
          ),
        })),
      });
    }
    return {
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      monitoredInstanceIds: [...this.allowed],
      retentionDays: 14,
      persistenceError: null,
      accounts,
      turns,
      totalMatchingTurns: matching.length,
      profiles: [...groups.values()].map(({ turn: t, inputs, outputs, duration }) => ({
        instanceId: t.instanceId,
        accountKey: t.accountKey,
        model: t.model!,
        effort: t.effort,
        contextBand: contextBand(t.peakContextTokens),
        turns: inputs.length,
        totalTurnWallMs: duration,
        medianInputTokensPerTurnHour: percentile(inputs, 0.5),
        p90InputTokensPerTurnHour: percentile(inputs, 0.9),
        medianOutputTokensPerTurnHour: percentile(outputs, 0.5),
        p90OutputTokensPerTurnHour: percentile(outputs, 0.9),
      })),
      limitations: [
        "Measurements start when collection is installed; retained history is capped at 14 days, 5000 turns and 30000 quota changes. No historical transcripts are backfilled.",
        "Quota rates are account-wide, including unobserved terminal/remote usage. Never attribute an account delta to one worker or add duplicate account windows across hosts.",
        "Percentages are percentage points of each window's allowance, not comparable token budgets across plans. Unknown login identity prevents reliable alias grouping.",
        "Non-tool wall time includes network, user waits and orchestration; it is not measured model compute. Provider API duration is separate and optional.",
        "Token profile rates use completed, >=1 minute, single-model main-agent turns without subagents. Input includes cache reads/writes; reasoning is already included in output. Rates are not quota percentages.",
        "Context tokens measure current model context, not total transcript size. Session age includes idle time. Thread-selected model/effort are fallback metadata, not proof of actual provider billing.",
        "Unchanged merged quota windows retain their earlier timestamps. Sparse, stale, saturated or reset-spanning samples produce no forecast; forecasts assume unchanged load and do not predict a new worker's cost.",
      ],
    };
  }
}

function quotaRate(
  samples: Sample[],
  now: number,
): UsageMeasurementsReport["accounts"][number]["windows"][number]["rate"] {
  const latest = samples.at(-1)!;
  const reset = Date.parse(latest.window.resetsAt ?? "");
  const hoursUntilReset = Number.isFinite(reset) ? Math.max(0, (reset - now) / HOUR) : null;
  const eligible: Sample[] = [];
  // Stop at decreases, identity/window reset boundaries and large gaps.
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    const next = samples[i + 1];
    if (
      s.window.resetsAt !== latest.window.resetsAt ||
      Date.parse(s.checkedAt) < now - HOUR ||
      (next &&
        (s.window.usedPercent > next.window.usedPercent ||
          Date.parse(next.checkedAt) - Date.parse(s.checkedAt) > 30 * 60_000))
    )
      break;
    eligible.unshift(s);
  }
  const first = eligible[0];
  const intervalMinutes = first
    ? (Date.parse(latest.checkedAt) - Date.parse(first.checkedAt)) / 60_000
    : 0;
  const reason =
    now - Date.parse(latest.checkedAt) > 15 * 60_000
      ? "stale"
      : hoursUntilReset === 0
        ? "resetNeedsFreshReading"
        : latest.window.usedPercent >= 100
          ? "saturated"
          : eligible.length < 2 || intervalMinutes < 5
            ? "insufficientSamples"
            : !Number.isFinite(reset)
              ? "resetUnknown"
              : null;
  const rate =
    reason === null && first
      ? ((latest.window.usedPercent - first.window.usedPercent) * 60) / intervalMinutes
      : null;
  const consumedSinceReading =
    rate === null ? 0 : (rate * Math.max(0, now - Date.parse(latest.checkedAt))) / HOUR;
  // One-step error within this same observed reset cycle. Account-level only:
  // external traffic and quantized readings are deliberately included.
  const errors: number[] = [];
  if (reason === null && eligible.length >= 5) {
    for (let i = 2; i < eligible.length; i++) {
      const a = eligible[i - 2]!;
      const b = eligible[i - 1]!;
      const c = eligible[i]!;
      const previousHours = (Date.parse(b.checkedAt) - Date.parse(a.checkedAt)) / HOUR;
      const nextHours = (Date.parse(c.checkedAt) - Date.parse(b.checkedAt)) / HOUR;
      if (previousHours > 0 && nextHours > 0)
        errors.push(
          Math.abs(
            (c.window.usedPercent - b.window.usedPercent) / nextHours -
              (b.window.usedPercent - a.window.usedPercent) / previousHours,
          ),
        );
    }
  }
  return {
    predictionErrorPointsPerHour: errors.length ? percentile(errors, 0.9) : null,
    sampleCount: eligible.length,
    intervalMinutes,
    percentagePointsPerHour: rate,
    hoursUntilExhaustion:
      rate !== null && rate > 0
        ? Math.max(0, 100 - latest.window.usedPercent - consumedSinceReading) / rate
        : null,
    hoursUntilReset,
    projectedUsedPercentAtReset:
      rate !== null && hoursUntilReset !== null
        ? latest.window.usedPercent + consumedSinceReading + rate * hoursUntilReset
        : null,
    reason,
  };
}
