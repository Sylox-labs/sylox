"use client";

import type { PegHistoryPoint } from "@/lib/asset-data";

export interface PegHistoryChartProps {
  points: PegHistoryPoint[];
  /** Plain decimal, e.g. 0.95 - drawn as a reference line. Null when no Depeg definition exists for this asset. */
  depegThreshold: number | null;
}

const WIDTH = 960;
const HEIGHT = 220;
const PAD_X = 8;
const PAD_Y = 16;

/**
 * Hand-rolled SVG line chart: no charting library. Nothing else in this
 * app or web/landing already depends on one (confirmed before adding
 * this), and the one thing this chart actually needs - breaking the
 * line at a gap instead of drawing a false dip to 0 - is the one thing
 * most line-chart libraries make hardest to get right by default (many
 * null-handling options default to "interpolate through" or "treat as
 * zero"). A plain <path> built from explicit M/L segments gives exact
 * control over that, in about 100 lines, for a single 240-point line
 * with one reference line. Revisit with a library if the Markets/Event
 * screens need genuinely complex charts (zoom, multiple series,
 * tooltips) that this hand-rolled approach can't reasonably grow into.
 *
 * Every point whose pegRatio is null (effectively Empty/Pending/Disputed
 * - see lib/asset-data.ts's fetchEffectiveRing/fetchPegHistory, which
 * promote a Pending slot to Final once its own pending_until has
 * passed, via RiskOracle.effective_window) is a real gap: the line
 * breaks there, nothing is drawn, and it is never treated as a 0
 * value. A missing or still-contested hour must never render as a
 * fake depeg dip (this is the single thing to check first in review).
 */
export function PegHistoryChart({ points, depegThreshold }: PegHistoryChartProps) {
  const known = points.filter(
    (p): p is PegHistoryPoint & { pegRatio: number } => p.pegRatio !== null,
  );
  // state is already the EFFECTIVE state (see fetchEffectiveRing in
  // lib/asset-data.ts) - a Pending hour past its own pending_until
  // counts as confirmed here too, matching known/pegRatio above.
  const confirmedCount = known.length;
  const pendingCount = points.filter((p) => p.state === "Pending" || p.state === "Disputed").length;
  const missingCount = points.filter((p) => p.state === "Empty").length;

  if (known.length === 0) {
    return (
      <p className="font-mono text-sm text-cyber-tin">
        No confirmed hourly history yet.
      </p>
    );
  }

  const minTimestamp = points[0].timestamp;
  const maxTimestamp = points[points.length - 1].timestamp;
  const timeSpan = maxTimestamp - minTimestamp || 1;

  const values = known.map((p) => p.pegRatio);
  const minValue = Math.min(...values, depegThreshold ?? Infinity);
  const maxValue = Math.max(...values, depegThreshold ?? -Infinity);
  const valueSpan = maxValue - minValue || 1;
  // A little headroom so the line and the threshold label never sit
  // flush against the chart edge.
  const valuePad = valueSpan * 0.1;

  function x(timestamp: number): number {
    return PAD_X + ((timestamp - minTimestamp) / timeSpan) * (WIDTH - PAD_X * 2);
  }

  function y(value: number): number {
    const t = (value - (minValue - valuePad)) / (valueSpan + valuePad * 2);
    return HEIGHT - PAD_Y - t * (HEIGHT - PAD_Y * 2);
  }

  // Build one <path> per contiguous run of known points. A run breaks
  // (M instead of L) whenever the next point is a gap - this is what
  // keeps a missing/pending/disputed hour from being interpolated
  // across or rendered as a dip.
  const segments: string[] = [];
  let current: string | null = null;
  for (const point of points) {
    if (point.pegRatio === null) {
      current = null;
      continue;
    }
    const command: string = current === null ? "M" : "L";
    const segment: string = `${command}${x(point.timestamp).toFixed(2)},${y(point.pegRatio).toFixed(2)}`;
    if (current === null) {
      segments.push(segment);
    } else {
      segments[segments.length - 1] += ` ${segment}`;
    }
    current = segment;
  }

  const thresholdY = depegThreshold !== null ? y(depegThreshold) : null;

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Peg value over the stored history, ${confirmedCount} confirmed, ${pendingCount} pending, ${missingCount} missing of ${points.length} hours`}
      >
        {thresholdY !== null && (
          <line
            x1={PAD_X}
            x2={WIDTH - PAD_X}
            y1={thresholdY}
            y2={thresholdY}
            stroke="var(--color-risk-crimson)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}
        {segments.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="var(--color-silo-oatmeal)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-wide text-cyber-tin">
        <span>
          {confirmedCount} confirmed · {pendingCount} pending · {missingCount} missing
        </span>
        {depegThreshold !== null && (
          <span className="flex items-center gap-1.5 text-risk-crimson-tint">
            <span className="inline-block h-px w-3 border-t border-dashed border-risk-crimson" />
            depeg threshold ({depegThreshold.toFixed(2)})
          </span>
        )}
      </div>
    </div>
  );
}
