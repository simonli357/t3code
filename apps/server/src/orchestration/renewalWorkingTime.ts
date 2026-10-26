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
export function renewalWorkingHours(
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
