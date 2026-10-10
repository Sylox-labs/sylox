import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletButton } from "./WalletButton";
import { WalletProvider } from "@/lib/wallet/WalletContext";

const ADDRESS = "GCWWB2WYVRE4SSMASR6EMFQ7D3K6BEOLN5UQAXGS5YWPX2ZJ44JYKER5";

/**
 * WalletButton's disconnected state is exercised here directly. The
 * connected state (shortened address, the copy/disconnect menu) needs
 * a real address, which these two tests get through the SAME path a
 * real connection uses (openPicker -> pick a wallet in the modal ->
 * handleSelectWallet) by mocking the kit at the @/lib/wallet/kit
 * boundary - the same pattern WriteActionButton.test.tsx's "connected
 * flow" describe block uses, not a shortcut that bypasses
 * WalletContext's own logic.
 */
function makeFakeKit() {
  return {
    refreshSupportedWallets: vi.fn(async () => [
      { id: "freighter", name: "Freighter", icon: "", isAvailable: true, url: "" },
    ]),
    setWallet: vi.fn(),
    fetchAddress: vi.fn(async () => ({ address: ADDRESS })),
    disconnect: vi.fn(async () => {}),
    signTransaction: vi.fn(async () => ({ signedTxXdr: "fake-xdr" })),
  };
}

describe("WalletButton", () => {
  it("shows 'Connect wallet' when no wallet is connected", () => {
    render(
      <WalletProvider>
        <WalletButton />
      </WalletProvider>,
    );
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });

  it("opens the wallet picker modal on click", async () => {
    const user = userEvent.setup();
    render(
      <WalletProvider>
        <WalletButton />
      </WalletProvider>,
    );

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(await screen.findByRole("dialog", { name: /connect a wallet/i })).toBeInTheDocument();
  });
});

describe("WalletButton - connected", () => {
  it("shows the shortened address as a button with a visible dropdown affordance, and opens a menu with Copy address and Disconnect on click", async () => {
    vi.resetModules();
    vi.doMock("@/lib/wallet/kit", () => ({ getKit: async () => makeFakeKit() }));
    const { WalletProvider: FreshProvider } = await import("@/lib/wallet/WalletContext");
    const { WalletButton: FreshWalletButton } = await import("./WalletButton");

    const user = userEvent.setup();
    render(
      <FreshProvider>
        <FreshWalletButton />
      </FreshProvider>,
    );

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(await screen.findByRole("button", { name: /freighter/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const addressButton = screen.getByRole("button", { name: /GCWW…KER5.*wallet options/i });
    expect(addressButton).toBeInTheDocument();
    // The chevron SVG is the only visible signal this button opens a
    // menu - without it the address reads as a static label, not
    // something to click (the bug this test guards against).
    expect(addressButton.querySelector("svg")).not.toBeNull();
    expect(addressButton).toHaveAttribute("aria-haspopup", "menu");
    expect(addressButton).toHaveAttribute("aria-expanded", "false");

    await user.click(addressButton);
    expect(addressButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: /copy address/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /disconnect/i })).toBeInTheDocument();

    vi.doUnmock("@/lib/wallet/kit");
  });

  it("disconnects the wallet and returns to the 'Connect wallet' state when Disconnect is clicked", async () => {
    vi.resetModules();
    vi.doMock("@/lib/wallet/kit", () => ({ getKit: async () => makeFakeKit() }));
    const { WalletProvider: FreshProvider } = await import("@/lib/wallet/WalletContext");
    const { WalletButton: FreshWalletButton } = await import("./WalletButton");

    const user = userEvent.setup();
    render(
      <FreshProvider>
        <FreshWalletButton />
      </FreshProvider>,
    );

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(await screen.findByRole("button", { name: /freighter/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /GCWW…KER5.*wallet options/i }));
    await user.click(screen.getByRole("menuitem", { name: /disconnect/i }));

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByText(/GCWW…KER5/i)).not.toBeInTheDocument();

    vi.doUnmock("@/lib/wallet/kit");
  });
});
