import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletButton } from "./WalletButton";
import { WalletProvider } from "@/lib/wallet/WalletContext";

/**
 * WalletButton's disconnected state is exercised here directly -
 * everything about the connected state (shortened address, the
 * copy/disconnect menu) only becomes reachable once the Stellar
 * Wallets Kit actually resolves a real address, which this unit test
 * deliberately doesn't fake (the kit itself is lazy-loaded and its
 * connection flow isn't something to mock piecemeal here - see
 * web/shared/ui's WalletPickerModal.test.tsx for the picker UI's own
 * coverage, and lib/stellar-rpc-events.test.ts's pattern for how this
 * codebase mocks an external SDK when a test genuinely needs to).
 */
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
