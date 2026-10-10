import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ExplorerPage from "./page";
import { RISK_BANDS } from "@sylox/ui/risk-bands";
import type { ExplorerAssetRow } from "@/lib/explorer-data";

const { fetchExplorerRows } = vi.hoisted(() => ({
  fetchExplorerRows: vi.fn(),
}));

vi.mock("@/lib/explorer-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/explorer-data")>(
    "@/lib/explorer-data",
  );
  return { ...actual, fetchExplorerRows };
});

const normalBand = RISK_BANDS.find((b) => b.name === "normal")!;

describe("ExplorerPage", () => {
  it("always shows the testnet banner", async () => {
    fetchExplorerRows.mockResolvedValue([]);
    render(<ExplorerPage />);
    expect(screen.getByText(/testnet\. sample and live testnet data/i)).toBeInTheDocument();
  });

  it("shows a loading state before data arrives", () => {
    fetchExplorerRows.mockReturnValue(new Promise(() => {}));
    render(<ExplorerPage />);
    expect(screen.getByText(/loading assets from the oracle/i)).toBeInTheDocument();
  });

  it("renders an asset card for each row, with score and stale badge", async () => {
    const rows: ExplorerAssetRow[] = [
      {
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        band: normalBand,
        score: 12,
        stale: true,
        eventInProgress: false,
        eventDeclared: false,
      },
    ];
    fetchExplorerRows.mockResolvedValue(rows);
    render(<ExplorerPage />);

    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.queryByText("Event in progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Event declared")).not.toBeInTheDocument();
  });

  it("shows an em dash for a score-less (brand-new) asset instead of 0", async () => {
    const rows: ExplorerAssetRow[] = [
      {
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        band: normalBand,
        score: null,
        stale: true,
        eventInProgress: false,
        eventDeclared: false,
      },
    ];
    fetchExplorerRows.mockResolvedValue(rows);
    render(<ExplorerPage />);

    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    fetchExplorerRows.mockRejectedValue(new Error("RPC unreachable"));
    render(<ExplorerPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("RPC unreachable");
  });

  it("shows empty state when there are no tracked assets", async () => {
    fetchExplorerRows.mockResolvedValue([]);
    render(<ExplorerPage />);

    expect(await screen.findByText(/no assets are tracked yet/i)).toBeInTheDocument();
  });
});
