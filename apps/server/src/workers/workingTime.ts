import { type WorkerRenewalSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type Interval = { start: string | null; end: string | null };
type Range = readonly [number, number];

function merge(ranges: Range[]): Range[] {
  const result: [number, number][] = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** Overlapping tool calls exclude a minute once, including an unfinished long wait. */
export function workingHours(
  turns: readonly Interval[],
  waits: readonly Interval[],
  now: number,
  waitSeconds: number,
) {
  const ranges = (values: readonly Interval[]) =>
    values.flatMap(({ start, end }): Range[] => {
      const from = Date.parse(start ?? "");
      const to = end === null ? now : Date.parse(end);
      return Number.isFinite(from) && Number.isFinite(to) && to > from ? [[from, to]] : [];
    });
  const work = merge(ranges(turns));
  const excluded = merge(ranges(waits).filter(([start, end]) => end - start > waitSeconds * 1000));
  let milliseconds = 0;
  for (const [start, end] of work) {
    milliseconds += end - start;
    for (const [waitStart, waitEnd] of excluded) {
      if (waitStart >= end) break;
      milliseconds -= Math.max(0, Math.min(end, waitEnd) - Math.max(start, waitStart));
    }
  }
  return Math.max(0, milliseconds) / 3_600_000;
}

export type WorkTime = { hours: number; turns: number; compactions: number; scale: number };

/**
 * Working time of one thread from its stored runs: run time that started work, minus tool calls
 * longer than `toolWaitSeconds`. Codex threads are scaled because their sessions run longer.
 */
export const measureWorkingTime = Effect.fn("measureWorkingTime")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  limits: WorkerRenewalSettings,
) {
  const runs = yield* sql<{
    start: string;
    end: string | null;
    provider: string;
  }>`SELECT COALESCE(json_extract(payload_json, '$.workStartedAt'), json_extract(payload_json, '$.startedAt')) AS start,
      completed_at AS end, provider
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId} AND COALESCE(json_extract(payload_json, '$.workStartedAt'), json_extract(payload_json, '$.startedAt')) IS NOT NULL
    ORDER BY ordinal`;
  if (runs.length === 0) return undefined;
  const waits = yield* sql<{
    start: string | null;
    end: string | null;
  }>`SELECT json_extract(payload_json, '$.startedAt') AS start, json_extract(payload_json, '$.completedAt') AS end
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND type IN ('command_execution', 'dynamic_tool')`;
  const compactions = (yield* sql<{
    total: number;
  }>`SELECT COUNT(*) AS total FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND type = 'compaction'`)[0]!.total;
  const hours = workingHours(
    runs,
    waits,
    DateTime.toEpochMillis(yield* DateTime.now),
    limits.toolWaitSeconds,
  );
  const scale = runs.at(-1)!.provider === "codex" ? limits.codexScale : 1;
  return { hours, turns: runs.length, compactions, scale } satisfies WorkTime;
});

/** One report line; `advice` follows once the thread reaches its soft threshold. */
export const workLine = (who: string, work: WorkTime, threshold: number, advice: string) =>
  `${who}: ${work.hours.toFixed(1)} h over ${work.turns} turn${work.turns === 1 ? "" : "s"}, ${work.compactions} compaction${work.compactions === 1 ? "" : "s"}.` +
  (threshold > 0 && work.hours >= threshold * work.scale
    ? ` Over the ${threshold * work.scale} h renewal threshold: ${advice}`
    : "");
