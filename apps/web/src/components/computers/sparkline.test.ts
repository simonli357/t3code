import { describe, expect, it } from "vite-plus/test";

import type { MetricSample } from "./computersViewModel";
import { buildSparkline, describeSparkline } from "./sparkline";

const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const sample = (secondsIn: number, percent: number | null): MetricSample => ({
  at: new Date(T0 + secondsIn * 1_000).toISOString(),
  percent,
});

/** Every "x y" pair of a path, in order. */
const coordinates = (path: string): Array<[number, number]> =>
  [...path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);

const subpaths = (path: string) => path.split("M").filter(Boolean);

describe("buildSparkline", () => {
  it("has nothing to draw when no sample has a value, rather than a line at zero", () => {
    expect(buildSparkline([])).toBeNull();
    expect(buildSparkline([sample(0, null), sample(5, null)])).toBeNull();
    expect(buildSparkline([{ at: "garbage", percent: 50 }])).toBeNull();
  });

  it("maps 0% and 100% inside the edges, spanning the first to the last sample", () => {
    const line = buildSparkline([sample(0, 0), sample(10, 100)])!;
    expect(coordinates(line.linePath)).toEqual([
      [0, 98],
      [100, 2],
    ]);
    expect(line.areaPath).toContain("Z");
  });

  it("draws a lone sample as a dot at the right edge and no area", () => {
    const line = buildSparkline([sample(0, 50)])!;
    expect(subpaths(line.linePath)).toHaveLength(1);
    expect(coordinates(line.linePath)).toEqual([
      [100, 50],
      [100, 50],
    ]);
    expect(line.areaPath).toBe("");
  });

  it("breaks the line at a sample with no value instead of dropping it to zero", () => {
    const line = buildSparkline([
      sample(0, 20),
      sample(5, 30),
      sample(10, null),
      sample(15, 40),
      sample(20, 50),
    ])!;
    expect(subpaths(line.linePath)).toHaveLength(2);
    expect(coordinates(line.linePath).every(([, y]) => y < 98)).toBe(true);
  });

  it("breaks the line across a stretch with no samples at all", () => {
    const line = buildSparkline([
      sample(0, 10),
      sample(5, 10),
      sample(10, 10),
      sample(15, 10),
      sample(3_600, 10),
      sample(3_605, 10),
    ])!;
    expect(subpaths(line.linePath)).toHaveLength(2);
  });

  it("clamps a reading outside 0-100 for drawing and keeps ends in place when it thins a long run", () => {
    const many = Array.from({ length: 1_000 }, (_, index) => sample(index, (index % 100) + 50));
    const line = buildSparkline(many, 60)!;
    const points = coordinates(line.linePath);
    expect(points.length).toBeLessThanOrEqual(60);
    expect(points[0]?.[0]).toBe(0);
    expect(points.at(-1)?.[0]).toBe(100);
    expect(points.every(([, y]) => y >= 2 && y <= 98)).toBe(true);
    expect(line.stats.max).toBe(100);
  });

  it("reports min, max, and average over the known samples only", () => {
    const line = buildSparkline([sample(0, 10), sample(5, null), sample(10, 30)])!;
    expect(line.stats).toEqual({ spanMs: 10_000, min: 10, max: 30, average: 20 });
  });

  it("orders samples by time whatever order they arrive in", () => {
    const line = buildSparkline([sample(10, 100), sample(0, 0)])!;
    expect(coordinates(line.linePath)).toEqual([
      [0, 98],
      [100, 2],
    ]);
  });
});

describe("describeSparkline", () => {
  it("states the window and the range for a screen reader", () => {
    expect(describeSparkline("CPU", { spanMs: 3_480_000, min: 4, max: 71, average: 23.4 })).toBe(
      "CPU over the last 58m: 4% to 71%, average 23%",
    );
  });

  it("omits the window for a single instant", () => {
    expect(describeSparkline("Memory", { spanMs: 0, min: 33, max: 33, average: 33 })).toBe(
      "Memory: 33% to 33%, average 33%",
    );
  });
});
