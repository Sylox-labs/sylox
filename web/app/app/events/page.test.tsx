import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import EventsPage from "./page";
import { WalletProvider } from "@/lib/wallet/WalletContext";
import type { EventListRow } from "@/lib/events-list-data";

const { listRegistryEvents } = vi.hoisted(() => ({
  listRegistryEvents: vi.fn(),
}));

vi.mock("@/lib/events-list-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/events-list-data")>("@/lib/events-list-data");
  return { ...actual, listRegistryEvents };
});

function renderEventsPage() {
  return render(
    <WalletProvider>
      <EventsPage />
    </WalletProvider>,
  );
}

const baseRow: EventListRow = {
  id: BigInt(1),
  assetCode: "USDC",
  kind: "Depeg",
  state: "Proposed",
  proposedAt: BigInt(1_790_000_000),
  windowClosesAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

describe("EventsPage", () => {
  it("always shows the testnet banner", () => {
    listRegistryEvents.mockReturnValue(new Promise(() => {}));
    renderEventsPage();
    expect(screen.getByText(/testnet\. prices are sample data/i)).toBeInTheDocument();
  });

  it("shows a loading state before data arrives", () => {
    listRegistryEvents.mockReturnValue(new Promise(() => {}));
    renderEventsPage();
    expect(screen.getByText(/loading events from the registry/i)).toBeInTheDocument();
  });

  it("shows a page-wide error when the scan rejects", async () => {
    listRegistryEvents.mockRejectedValue(new Error("RPC unreachable"));
    renderEventsPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("RPC unreachable");
  });

  it("shows an honest empty state when nothing was found within the scanned window", async () => {
    listRegistryEvents.mockResolvedValue({
      rows: [],
      oldestLedgerScanned: 100_000,
      latestLedger: 100_000 + Math.round((2 * 86400) / 5),
      stoppedAtRequestCap: false,
    });
    renderEventsPage();
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument();
    expect(screen.getByText(/events in the last 2 days/i)).toBeInTheDocument();
  });

  it("labels the window as only-partially-scanned when the request cap was hit", async () => {
    listRegistryEvents.mockResolvedValue({
      rows: [],
      oldestLedgerScanned: 100_000,
      latestLedger: 100_000 + Math.round((1.5 * 86400) / 5),
      stoppedAtRequestCap: true,
    });
    renderEventsPage();
    expect(await screen.findByText(/no events found in the last 1.5 days scanned/i)).toBeInTheDocument();
    // Never reads as if the whole claimed window was checked when it wasn't.
    expect(screen.queryByText(/^no events yet\.?$/i)).not.toBeInTheDocument();
  });

  it("renders a row with asset code, kind, state, and a countdown, linking to its Event screen", async () => {
    listRegistryEvents.mockResolvedValue({
      rows: [baseRow],
      oldestLedgerScanned: 100_000,
      latestLedger: 200_000,
      stoppedAtRequestCap: false,
    });
    renderEventsPage();

    expect(await screen.findByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("Depeg")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText(/h left|m left/)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /USDC/ });
    expect(link).toHaveAttribute("href", "/event/1");
  });

  it("shows 'Challenged' for the contract's Escalated state, matching the plain-language action", async () => {
    listRegistryEvents.mockResolvedValue({
      rows: [{ ...baseRow, state: "Escalated" }],
      oldestLedgerScanned: 100_000,
      latestLedger: 200_000,
      stoppedAtRequestCap: false,
    });
    renderEventsPage();

    expect(await screen.findByText("Challenged")).toBeInTheDocument();
  });

  it("shows no countdown for a row with no open window (Cured/Declared/Rejected)", async () => {
    listRegistryEvents.mockResolvedValue({
      rows: [{ ...baseRow, state: "Cured", windowClosesAt: null }],
      oldestLedgerScanned: 100_000,
      latestLedger: 200_000,
      stoppedAtRequestCap: false,
    });
    renderEventsPage();

    await screen.findByText("USDC");
    expect(screen.queryByText(/h left|m left|d left/)).not.toBeInTheDocument();
  });
});
