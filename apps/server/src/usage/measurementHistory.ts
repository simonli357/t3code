// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  isToolLifecycleItemType,
  type ServerProvider,
  type TurnTokenUsage,
  type UsageMeasurementsInput,
  type UsageMeasurementsReport,
  UsageTurnMeasurement,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

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

/**
 * The V2 event pipeline has typed domain events rather than V1's provider runtime events. This is
 * the small event vocabulary the retained-measurement model needs, after V2 normalization.
 */
export interface MeasurementEvent {
  readonly type:
    | "turn.started"
    | "turn.completed"
    | "turn.aborted"
    | "context.updated"
    | "turn.tokens"
    | "item.started"
    | "item.completed"
    | "model.rerouted";
  readonly providerInstanceId?: string | undefined;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly itemId?: string | undefined;
  readonly payload: {
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly usage?: { readonly usedTokens: number; readonly maxTokens?: number | undefined };
    readonly itemType?: string | undefined;
    readonly agentId?: string | undefined;
    readonly parentToolUseId?: string | undefined;
    readonly state?: "completed" | "failed" | "interrupted" | "cancelled" | undefined;
    readonly tokenUsage?: TurnTokenUsage | null | undefined;
    readonly apiDurationMs?: number | null | undefined;
  };
}

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
    this.quotas = this.quotas.filter((sample) => this.allowed.has(sample.instanceId));
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
      (entry) => entry.accountKey === sample.accountKey && entry.window.id === sample.window.id,
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

  observe(event: MeasurementEvent, selection?: Selection) {
    const instanceId = event.providerInstanceId;
    if (!instanceId || !this.allowed.has(instanceId) || !event.turnId) return;
    const now = Date.parse(event.createdAt);
    if (!Number.isFinite(now)) return;
    const id = key(instanceId, event.threadId, event.turnId);
    let turn = this.turns.get(id);
    // A late token update belongs to the turn whose terminal event already landed.
    if (turn && turn.state !== "running" && event.type !== "turn.tokens") return;
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
    } else if (event.type === "context.updated") {
      const usage = event.payload.usage;
      if (!usage) return;
      turn.latestContextTokens = usage.usedTokens;
      turn.peakContextTokens = Math.max(turn.peakContextTokens ?? 0, usage.usedTokens);
      turn.contextCapacityTokens = usage.maxTokens ?? turn.contextCapacityTokens;
      this.contexts.set(contextKey, usage.usedTokens);
    } else if (event.type === "turn.tokens") {
      turn.tokens = event.payload.tokenUsage ?? null;
    } else if (event.type === "model.rerouted") {
      turn.mixedModels = true;
    } else if (event.type === "item.started" || event.type === "item.completed") {
      if (event.payload.itemType === "context_compaction" && event.type === "item.completed")
        turn.compactions++;
      if (
        !event.itemId ||
        !event.payload.itemType ||
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
      turn.tokens = event.payload.tokenUsage ?? turn.tokens;
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
      .filter((sample) => Date.parse(sample.checkedAt) >= now - RETENTION)
      .slice(-MAX_SAMPLES);
    if (this.contexts.size > MAX_TURNS) this.contexts.clear();
  }

  report(input: UsageMeasurementsInput, now: number): UsageMeasurementsReport {
    this.prune(now);
    const since = now - (input.lookbackHours ?? 168) * HOUR;
    const matching = [...this.turns.values()].filter(
      (turn) =>
        Date.parse(turn.lastObservedAt) >= since &&
        (!input.instanceId || turn.instanceId === input.instanceId) &&
        (!input.threadId || turn.threadId === input.threadId),
    );
    const turns = matching
      .toSorted(
        (a, b) =>
          Number(b.state === "running") - Number(a.state === "running") ||
          Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt),
      )
      .slice(0, input.turnLimit ?? 30)
      .map((turn) => {
        const end = turn.endedAt ? Date.parse(turn.endedAt) : now;
        const elapsedMs = Math.max(0, end - Date.parse(turn.startedAt ?? turn.observedAt));
        const openSince = this.tools.get(key(turn.instanceId, turn.threadId, turn.turnId))?.since;
        const toolWallMs = turn.toolWallMs + (openSince != null ? Math.max(0, end - openSince) : 0);
        return {
          ...turn,
          toolWallMs,
          elapsedMs,
          sessionAgeMs: turn.sessionCreatedAt
            ? Math.max(0, end - Date.parse(turn.sessionCreatedAt))
            : null,
          nonToolWallMs: turn.toolTimingComplete ? Math.max(0, elapsedMs - toolWallMs) : null,
        };
      });
    const groups = new Map<
      string,
      { turn: Turn; inputs: number[]; outputs: number[]; duration: number }
    >();
    for (const turn of matching) {
      if (
        turn.state !== "completed" ||
        !turn.startedAt ||
        !turn.endedAt ||
        !turn.model ||
        turn.mixedModels ||
        turn.tokens?.usageStatus !== "complete" ||
        turn.tokens.hasSubagents
      )
        continue;
      const duration = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
      if (duration < 60_000) continue;
      const id = JSON.stringify([
        turn.accountKey,
        turn.instanceId,
        turn.model,
        turn.effort,
        contextBand(turn.peakContextTokens),
      ]);
      const group = groups.get(id) ?? { turn, inputs: [], outputs: [], duration: 0 };
      group.inputs.push((turn.tokens.inputTokens * HOUR) / duration);
      group.outputs.push((turn.tokens.outputTokens * HOUR) / duration);
      group.duration += duration;
      groups.set(id, group);
    }
    const accountGroups = new Map<string, Sample[]>();
    for (const sample of this.quotas) {
      if (Date.parse(sample.checkedAt) < since) continue;
      const items = accountGroups.get(sample.accountKey) ?? [];
      items.push(sample);
      accountGroups.set(sample.accountKey, items);
    }
    const accounts: UsageMeasurementsReport["accounts"][number][] = [];
    for (const [accountKey, samples] of accountGroups) {
      const instanceIds = [...this.identities]
        .filter(([, value]) => value.accountKey === accountKey)
        .map(([id]) => id);
      if (input.instanceId && !instanceIds.includes(input.instanceId)) continue;
      const latest = new Map<string, Sample>();
      for (const sample of samples) latest.set(sample.window.id, sample);
      accounts.push({
        accountKey,
        instanceIds,
        identityKnown: samples.at(-1)!.identityKnown,
        windows: [...latest.values()].map((sample) => ({
          window: sample.window,
          checkedAt: sample.checkedAt,
          ageSeconds: Math.max(0, (now - Date.parse(sample.checkedAt)) / 1000),
          rate: quotaRate(
            samples.filter((entry) => entry.window.id === sample.window.id),
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
      profiles: [...groups.values()].map(({ turn, inputs, outputs, duration }) => ({
        instanceId: turn.instanceId,
        accountKey: turn.accountKey,
        model: turn.model!,
        effort: turn.effort,
        contextBand: contextBand(turn.peakContextTokens),
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
    const sample = samples[i]!;
    const next = samples[i + 1];
    if (
      sample.window.resetsAt !== latest.window.resetsAt ||
      Date.parse(sample.checkedAt) < now - HOUR ||
      (next &&
        (sample.window.usedPercent > next.window.usedPercent ||
          Date.parse(next.checkedAt) - Date.parse(sample.checkedAt) > 30 * 60_000))
    )
      break;
    eligible.unshift(sample);
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
