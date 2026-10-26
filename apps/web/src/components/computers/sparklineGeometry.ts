/**
 * Geometry for a sparkline, kept apart from the SVG so the honest parts are testable: a sample
 * with no value and a stretch with no samples are both drawn as gaps, never as 0.
 */
import { clampPercent, formatPercent, formatWindow } from "./computersFormat";
import type { MetricSample } from "./computersViewModel";

/**
 * The drawing space is 100 x 100 with y growing downward. 0% and 100% sit 2 units inside the
 * edges so a stroke on either line is not clipped.
 */
const X_MAX = 100;
const Y_AT_ZERO = 98;
const Y_AT_FULL = 2;

/** Enough detail for a strip a few hundred pixels wide; longer histories are averaged down. */
const DEFAULT_MAX_POINTS = 90;

/** A hole wider than this many typical sample intervals breaks the line. */
const GAP_IN_INTERVALS = 3;

export interface SparklineStats {
  /** Time covered by the samples, first to last. */
  readonly spanMs: number;
  readonly min: number;
  readonly max: number;
  readonly average: number;
}

export interface Sparkline {
  /** One path for every run of samples; a lone sample is a zero-length stroke, drawn as a dot. */
  readonly linePath: string;
  /** The fill under each run of two or more samples; empty when there is none. */
  readonly areaPath: string;
  readonly stats: SparklineStats;
}

interface Point {
  readonly x: number;
  readonly value: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const yOf = (value: number) => round2(Y_AT_ZERO - (value / 100) * (Y_AT_ZERO - Y_AT_FULL));

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Averages runs of neighbours so a long run fits `maxPoints`, keeping both ends where they were. */
function decimate(run: ReadonlyArray<Point>, maxPoints: number): ReadonlyArray<Point> {
  if (run.length <= maxPoints) return run;
  const groupSize = Math.ceil(run.length / maxPoints);
  const out: Point[] = [];
  for (let start = 0; start < run.length; start += groupSize) {
    const group = run.slice(start, start + groupSize);
    out.push({
      x: group.reduce((sum, point) => sum + point.x, 0) / group.length,
      value: group.reduce((sum, point) => sum + point.value, 0) / group.length,
    });
  }
  out[0] = { x: run[0]!.x, value: out[0]!.value };
  out[out.length - 1] = { x: run.at(-1)!.x, value: out.at(-1)!.value };
  return out;
}

/**
 * Builds the paths for a series of percent samples, oldest first. Returns null when no sample has a
 * value, so the caller shows an empty state instead of a line at 0.
 */
export function buildSparkline(
  samples: ReadonlyArray<MetricSample>,
  maxPoints: number = DEFAULT_MAX_POINTS,
): Sparkline | null {
  const parsed: Array<{ readonly at: number; readonly value: number | null }> = [];
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    if (!Number.isFinite(at)) continue;
    parsed.push({
      at,
      value:
        sample.percent !== null && Number.isFinite(sample.percent)
          ? clampPercent(sample.percent)
          : null,
    });
  }
  parsed.sort((a, b) => a.at - b.at);

  const known = parsed.flatMap((sample) => (sample.value === null ? [] : [sample.value]));
  if (known.length === 0) return null;

  const first = parsed[0]!.at;
  const last = parsed.at(-1)!.at;
  const spanMs = last - first;
  const xOf = (at: number) => (spanMs === 0 ? X_MAX : ((at - first) / spanMs) * X_MAX);

  const intervals: number[] = [];
  for (let i = 1; i < parsed.length; i += 1) {
    const interval = parsed[i]!.at - parsed[i - 1]!.at;
    if (interval > 0) intervals.push(interval);
  }
  const typicalInterval = median(intervals);
  const maxGapMs = typicalInterval === null ? Infinity : typicalInterval * GAP_IN_INTERVALS;

  const runs: Point[][] = [];
  let run: Point[] = [];
  const endRun = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  parsed.forEach((sample, index) => {
    if (sample.value === null) {
      endRun();
      return;
    }
    if (index > 0 && sample.at - parsed[index - 1]!.at > maxGapMs) endRun();
    run.push({ x: xOf(sample.at), value: sample.value });
  });
  endRun();

  const lineParts: string[] = [];
  const areaParts: string[] = [];
  for (const points of runs.map((fullRun) => decimate(fullRun, maxPoints))) {
    const coordinates = points.map((point) => `${round2(point.x)} ${yOf(point.value)}`);
    lineParts.push(
      points.length === 1 ? `M${coordinates[0]} L${coordinates[0]}` : `M${coordinates.join(" L")}`,
    );
    if (points.length >= 2) {
      const left = round2(points[0]!.x);
      const right = round2(points.at(-1)!.x);
      areaParts.push(`M${left} ${Y_AT_ZERO} L${coordinates.join(" L")} L${right} ${Y_AT_ZERO} Z`);
    }
  }

  return {
    linePath: lineParts.join(" "),
    areaPath: areaParts.join(" "),
    stats: {
      spanMs,
      min: Math.min(...known),
      max: Math.max(...known),
      average: known.reduce((sum, value) => sum + value, 0) / known.length,
    },
  };
}

/** "CPU over the last 58m 0s: 4% to 71%, average 23%", for a screen reader and the hover. */
export function describeSparkline(label: string, stats: SparklineStats): string {
  const span = formatWindow(stats.spanMs);
  const range = `${formatPercent(stats.min)} to ${formatPercent(stats.max)}`;
  const window = stats.spanMs > 0 ? ` over the last ${span}` : "";
  return `${label}${window}: ${range}, average ${formatPercent(stats.average)}`;
}
