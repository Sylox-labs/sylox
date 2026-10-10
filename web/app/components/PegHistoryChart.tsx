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

function formatAxisDate(timestampSecs: number): string {
  const date = new Date(timestampSecs * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

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
 *
 * An untracked point (before the asset's own first_epoch - see
 * PegHistoryPoint.tracked) is a different thing from a gap: the ring
 * always spans the full 240-hour window regardless of how long the
 * asset has actually existed, so an hour before the asset was added is
 * not something a keeper failed to post, and must not count toward
 * "missing" or be drawn the same way as a real gap.
 */
export function PegHistoryChart({ points, depegThreshold }: PegHistoryChartProps) {
  const trackedPoints = points.filter((p) => p.tracked);

  const known = trackedPoints.filter(
    (p): p is PegHistoryPoint & { pegRatio: number } => p.pegRatio !== null,
  );
  // state is already the EFFECTIVE state (see fetchEffectiveRing in
  // lib/asset-data.ts) - a Pending hour past its own pending_until
  // counts as confirmed here too, matching known/pegRatio above.
  const confirmedCount = known.length;
  const pendingCount = trackedPoints.filter(
    (p) => p.state === "Pending" || p.state === "Disputed",
  ).length;
  const missingCount = trackedPoints.filter((p) => p.state === "Empty").length;

  const historyStartsLate = trackedPoints.length < points.length;

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

  // Build one <path> per contiguous run of known, TRACKED points. A run
  // breaks (M instead of L) whenever the next point is a gap or
  // untracked - this is what keeps a missing/pending/disputed hour from
  // being interpolated across or rendered as a dip, and keeps the line
  // from starting before the asset actually existed.
  const segments: string[] = [];
  let current: string | null = null;
  for (const point of points) {
    if (point.pegRatio === null || !point.tracked) {
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

  // The unshaded "not tracked yet" region, drawn as a single rect behind
  // everything else - a visually distinct "this is before the asset
  // existed" band, never a line (there is nothing to draw a line through).
  let untrackedBand: { xStart: number; xEnd: number } | null = null;
  if (historyStartsLate) {
    const lastUntrackedIndex = points.findIndex((p) => p.tracked) - 1;
    if (lastUntrackedIndex >= 0) {
      untrackedBand = {
        xStart: x(points[0].timestamp),
        xEnd: x(points[lastUntrackedIndex].timestamp),
      };
    }
  }

  const thresholdY = depegThreshold !== null ? y(depegThreshold) : null;

  return (
    <div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Peg value over the stored history, ${confirmedCount} confirmed, ${pendingCount} pending, ${missingCount} missing of ${trackedPoints.length} tracked hours`}
      >
        {untrackedBand !== null && (
          <rect
            x={untrackedBand.xStart}
            y={0}
            width={Math.max(0, untrackedBand.xEnd - untrackedBand.xStart)}
            height={HEIGHT}
            fill="var(--color-cement-grey)"
            fillOpacity={0.08}
          />
        )}
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

      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-cyber-tin/70">
        <span>{formatAxisDate(points[0].timestamp)}</span>
        <span>{formatAxisDate(points[points.length - 1].timestamp)}</span>
      </div>

      {historyStartsLate && (
        <p className="mt-2 font-mono text-[10px] text-cyber-tin">
          History starts when the asset was added.
        </p>
      )}

      <div className="mt-2 flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-cyber-tin">
        <span className="whitespace-nowrap">
          {confirmedCount} confirmed · {pendingCount} pending · {missingCount} missing
        </span>
        {depegThreshold !== null && (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-risk-crimson-tint">
            <span className="inline-block h-px w-3 shrink-0 border-t border-dashed border-risk-crimson" />
            depeg threshold ({depegThreshold.toFixed(2)})
          </span>
        )}
      </div>
    </div>
  );
}
