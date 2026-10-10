import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventPageClient, loadData } from "./EventPageClient";
import { WalletProvider } from "@/lib/wallet/WalletContext";
import type { EventPageData } from "@/lib/event-data";

function renderEventPage(eventId: string) {
  return render(
    <WalletProvider>
      <EventPageClient eventId={eventId} />
    </WalletProvider>,
  );
}

const { fetchEventPageData } = vi.hoisted(() => ({
  fetchEventPageData: vi.fn(),
}));

vi.mock("@/lib/event-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/event-data")>("@/lib/event-data");
  return { ...actual, fetchEventPageData };
});

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.stubEnv("NODE_ENV", originalNodeEnv ?? "test");
  fetchEventPageData.mockReset();
});

describe("loadData - fixture routing", () => {
  it("resolves a fixture id from the fixture module outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const data = await loadData("fixture-proposed");
    expect(data.proposal.status).toBe("ok");
    if (data.proposal.status === "ok") {
      expect(data.proposal.value.assetCode).toBe("DEMOUSD");
    }
    // Never touches the live contract fetch for a fixture id.
    expect(fetchEventPageData).not.toHaveBeenCalled();
  });

  it("never resolves a fixture id from the fixture module in production - falls through to the live fetch path, which rejects it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchEventPageData.mockRejectedValue(new Error("should not be called with a non-numeric id"));

    await expect(loadData("fixture-proposed")).rejects.toThrow(/isn't a valid event id/i);
    // Confirms the fixture branch was skipped entirely in production -
    // "fixture-proposed" fails BigInt() parsing before ever reaching
    // fetchEventPageData, the same as any other malformed id would.
    expect(fetchEventPageData).not.toHaveBeenCalled();
  });

  it("all four fixture routes behave the same way in production - rejected as an invalid id, never fixture data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const id of ["fixture-proposed", "fixture-challenged", "fixture-cured", "fixture-declared"]) {
      await expect(loadData(id)).rejects.toThrow(/isn't a valid event id/i);
    }
  });

  it("passes a real numeric id straight to the live contract fetch, in every environment", async () => {
    const fakeData = { proposal: { status: "error", message: "n/a" } } as unknown as EventPageData;
    fetchEventPageData.mockResolvedValue(fakeData);

    for (const env of ["development", "production", "test"]) {
      fetchEventPageData.mockClear();
      vi.stubEnv("NODE_ENV", env);
      await loadData("42");
      expect(fetchEventPageData).toHaveBeenCalledWith(BigInt(42));
    }
  });
});

describe("EventPageClient", () => {
  it("shows a loading state before data arrives", () => {
    fetchEventPageData.mockReturnValue(new Promise(() => {}));
    renderEventPage("42");
    expect(screen.getByText(/loading event from the registry/i)).toBeInTheDocument();
  });

  it("shows a page-wide error when the fetch rejects", async () => {
    fetchEventPageData.mockRejectedValue(new Error("RPC unreachable"));
    renderEventPage("42");
    expect(await screen.findByRole("alert")).toHaveTextContent("RPC unreachable");
  });

  it("always shows the testnet banner", () => {
    fetchEventPageData.mockReturnValue(new Promise(() => {}));
    renderEventPage("42");
    expect(screen.getByText(/testnet\. prices are sample data/i)).toBeInTheDocument();
  });
});
