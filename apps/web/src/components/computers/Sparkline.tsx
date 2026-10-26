import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { formatWindow } from "./computersFormat";
import type { MetricSample } from "./computersViewModel";
import { buildSparkline, describeSparkline } from "./sparklineGeometry";

/**
 * A percent history as a line on a fixed 0-100% scale, so a quiet computer looks quiet. Runs of
 * samples are drawn separately: a sample with no value, or a stretch with no samples, is a gap in the
 * line, never a drop to zero. Static SVG; nothing animates.
 */
export function Sparkline({
  samples,
  label,
  muted,
}: {
  readonly samples: ReadonlyArray<MetricSample>;
  /** What the series is, for the accessible name ("CPU"). */
  readonly label: string;
  /** Last known data rather than live: drawn in the quiet colour. */
  readonly muted: boolean;
}) {
  const sparkline = useMemo(() => buildSparkline(samples), [samples]);

  if (sparkline === null) {
    return (
      <div className="flex flex-col gap-0.5">
        <div
          role="img"
          aria-label={`${label}: no history yet`}
          className="h-8 w-full border-b border-dashed border-border"
        />
        <span className="text-3xs text-muted-foreground">No history yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <svg
        role="img"
        aria-label={describeSparkline(label, sparkline.stats)}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className={cn("h-8 w-full overflow-visible", muted ? "text-muted-foreground" : "text-info")}
      >
        {sparkline.areaPath ? (
          <path d={sparkline.areaPath} fill="currentColor" fillOpacity={0.14} stroke="none" />
        ) : null}
        <path
          d={sparkline.linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="text-3xs text-muted-foreground">
        {sparkline.stats.spanMs > 0
          ? `Last ${formatWindow(sparkline.stats.spanMs)}`
          : "One measurement"}
      </span>
    </div>
  );
}
