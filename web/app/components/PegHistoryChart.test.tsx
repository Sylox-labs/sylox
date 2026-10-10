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
    provisionalSubCoverage: null,
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

  it("marks a Pending hour still waiting on its sub-epochs with a 'Provisional' tooltip, leaving Final hours unmarked", () => {
    const points = [
      point({ epoch: BigInt(0), state: "Final", pegRatio: 1.0, provisionalSubCoverage: null }),
      point({
        epoch: BigInt(1),
        state: "Pending",
        pegRatio: null,
        provisionalSubCoverage: 5,
      }),
      point({ epoch: BigInt(2), state: "Final", pegRatio: 0.999, provisionalSubCoverage: null }),
    ];
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    const markers = container.querySelectorAll("circle");
    expect(markers).toHaveLength(1);
    expect(markers[0].querySelector("title")?.textContent).toMatch(
      /^provisional\. based on 5 of 12 sub-epochs so far\.$/i,
    );
  });

  it("marks a Disputed hour with undisputed sub-epochs left as 'Under dispute. Based on N of 12 undisputed sub-epochs.'", () => {
    const points = [
      point({ epoch: BigInt(0), state: "Final", pegRatio: 1.0, provisionalSubCoverage: null }),
      point({
        epoch: BigInt(1),
        state: "Disputed",
        pegRatio: null,
        provisionalSubCoverage: 3,
      }),
    ];
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    const markers = container.querySelectorAll("circle");
    expect(markers).toHaveLength(1);
    expect(markers[0].querySelector("title")?.textContent).toMatch(
      /^under dispute\. based on 3 of 12 undisputed sub-epochs\.$/i,
    );
  });

  it("marks a Disputed hour with zero undisputed sub-epochs as 'Under dispute. No undisputed sub-epochs yet.'", () => {
    const points = [
      point({ epoch: BigInt(0), state: "Final", pegRatio: 1.0, provisionalSubCoverage: null }),
      point({
        epoch: BigInt(1),
        state: "Disputed",
        pegRatio: null,
        provisionalSubCoverage: 0,
      }),
    ];
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    const markers = container.querySelectorAll("circle");
    expect(markers).toHaveLength(1);
    expect(markers[0].querySelector("title")?.textContent).toMatch(
      /^under dispute\. no undisputed sub-epochs yet\.$/i,
    );
  });

  it("marks no provisional hours when none have a provisionalSubCoverage set", () => {
    const points = buildPoints(10, 0);
    const { container } = render(<PegHistoryChart points={points} depegThreshold={null} />);

    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });
});
