import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PegHistoryChart } from "./PegHistoryChart";
import type { PegHistoryPoint } from "@/lib/asset-data";

const HOUR = 3600;

function point(overrides: Partial<PegHistoryPoint> & { epoch: bigint }): PegHistoryPoint {
  return {
    timestamp: Number(overrides.epoch) * HOUR,
    state: "Final",
    pegRatio: 1.0,
    tracked: true,
    ...overrides,
  };
}

function buildPoints(totalHours: number, untrackedHours: number): PegHistoryPoint[] {
  return Array.from({ length: totalHours }, (_, i) =>
    point({
      epoch: BigInt(i),
      tracked: i >= untrackedHours,
      state: i >= untrackedHours ? "Final" : "Empty",
      pegRatio: i >= untrackedHours ? 1.0 : null,
    }),
  );
}

describe("PegHistoryChart", () => {
  it("shows the dashed boundary and the in-region label when the untracked region is wide (>=15%)", () => {
    // 240 hours, 216 untracked (90% of the width) - well over the 15% floor.
    const points = buildPoints(240, 216);
    render(<PegHistoryChart points={points} depegThreshold={null} />);

    expect(screen.getByText("Not tracked yet")).toBeInTheDocument();
  });

  it("hides the in-region label when the untracked region is narrow (<15%), keeping only the line", () => {
    // 240 hours, 20 untracked (~8% of the width) - under the 15% floor.
    const points = buildPoints(240, 20);
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    expect(screen.queryByText("Not tracked yet")).not.toBeInTheDocument();
    // The dashed boundary line is still drawn even when the label is hidden.
    const dashedLines = container.querySelectorAll('line[stroke-dasharray="3 3"]');
    expect(dashedLines.length).toBeGreaterThan(0);
  });

  it("draws no untracked band or label at all when every hour is tracked", () => {
    const points = buildPoints(240, 0);
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    expect(screen.queryByText("Not tracked yet")).not.toBeInTheDocument();
    expect(container.querySelectorAll('line[stroke-dasharray="3 3"]')).toHaveLength(0);
  });

  it("uses a subtle fill opacity for the untracked band (0.12-0.15, not something stronger)", () => {
    const points = buildPoints(240, 216);
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    const rect = container.querySelector("rect");
    expect(rect).not.toBeNull();
    const opacity = Number(rect!.getAttribute("fill-opacity"));
    expect(opacity).toBeGreaterThanOrEqual(0.12);
    expect(opacity).toBeLessThanOrEqual(0.15);
  });
});
