import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ExplorerPage from "./page";
import { RISK_BANDS } from "@sylox/ui/risk-bands";
import type { ExplorerAssetRow, ExplorerAssetError } from "@/lib/explorer-data";

const { fetchExplorerData } = vi.hoisted(() => ({
  fetchExplorerData: vi.fn(),
}));

vi.mock("@/lib/explorer-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/explorer-data")>(
    "@/lib/explorer-data",
  );
  return { ...actual, fetchExplorerData };
});

const normalBand = RISK_BANDS.find((b) => b.name === "normal")!;

const baseRow: ExplorerAssetRow = {
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  code: "USDC",
  homeDomain: "centre.io",
  band: normalBand,
  score: 12,
  pegRatio: 0.9998,
  stale: true,
  eventInProgress: false,
  eventDeclared: false,
};

describe("ExplorerPage", () => {
  it("always shows the testnet banner", async () => {
    fetchExplorerData.mockResolvedValue({ rows: [], errors: [] });
    render(<ExplorerPage />);
    expect(screen.getByText(/testnet\. live testnet data/i)).toBeInTheDocument();
  });

  it("shows a loading state before data arrives", () => {
    fetchExplorerData.mockReturnValue(new Promise(() => {}));
    render(<ExplorerPage />);
    expect(screen.getByText(/loading assets from the oracle/i)).toBeInTheDocument();
  });

  it("renders an asset card with code, home domain, score, peg value and stale badge", async () => {
    fetchExplorerData.mockResolvedValue({ rows: [baseRow], errors: [] });
    render(<ExplorerPage />);

    expect(await screen.findByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("centre.io")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("0.9998")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(screen.getByText("Stale")).toBeInTheDocument();
    expect(screen.queryByText("Event in progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Event declared")).not.toBeInTheDocument();
  });

  it("shows an em dash for a score-less (brand-new) asset instead of 0", async () => {
    const rows: ExplorerAssetRow[] = [{ ...baseRow, score: null, pegRatio: null }];
    fetchExplorerData.mockResolvedValue({ rows, errors: [] });
    render(<ExplorerPage />);

    expect(await screen.findAllByText("—")).toHaveLength(2); // score and peg both unset
  });

  it("shows a page-wide error when the asset list itself fails to load", async () => {
    fetchExplorerData.mockRejectedValue(new Error("RPC unreachable"));
    render(<ExplorerPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("RPC unreachable");
  });

  it("shows empty state when there are no tracked assets", async () => {
    fetchExplorerData.mockResolvedValue({ rows: [], errors: [] });
    render(<ExplorerPage />);

    expect(await screen.findByText(/no assets are tracked yet/i)).toBeInTheDocument();
  });

  it("renders a per-asset error card without losing the other rows", async () => {
    const errors: ExplorerAssetError[] = [
      { asset: "CAFRI2UDYGXUU25B5ITFNZDUMJXZYD7S4ATYBSYCANETT5UN6JRPUP2H", message: "boom" },
    ];
    fetchExplorerData.mockResolvedValue({ rows: [baseRow], errors });
    render(<ExplorerPage />);

    // The good row still renders.
    expect(await screen.findByText("0.9998")).toBeInTheDocument();
    // The failed asset gets its own card, not a page-wide failure.
    expect(screen.getByText(/couldn't read this asset/i)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
