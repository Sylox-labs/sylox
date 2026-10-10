// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WalletPickerModal, type WalletOption } from "./WalletPickerModal";

const freighter: WalletOption = {
  id: "freighter",
  name: "Freighter",
  icon: "https://example.com/freighter.png",
  installed: true,
};

const notInstalled: WalletOption = {
  id: "xbull",
  name: "xBull",
  icon: "https://example.com/xbull.png",
  installed: false,
  installUrl: "https://xbull.app/install",
};

describe("WalletPickerModal", () => {
  it("renders nothing when closed", () => {
    render(
      <WalletPickerModal isOpen={false} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus into the dialog on open - to the first focusable element (the Close button)", () => {
    render(
      <WalletPickerModal isOpen={true} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
  });

  it("restores focus to the element that was focused before opening, on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { rerender } = render(
      <WalletPickerModal isOpen={true} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={vi.fn()} />,
    );
    expect(trigger).not.toHaveFocus();

    rerender(
      <WalletPickerModal isOpen={false} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={vi.fn()} />,
    );
    expect(trigger).toHaveFocus();

    document.body.removeChild(trigger);
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<WalletPickerModal isOpen={true} onClose={onClose} wallets={[freighter]} onSelectWallet={vi.fn()} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog - wraps from the last focusable row back to the first", async () => {
    const user = userEvent.setup();
    render(
      <WalletPickerModal
        isOpen={true}
        onClose={vi.fn()}
        wallets={[freighter, notInstalled]}
        onSelectWallet={vi.fn()}
      />,
    );

    // Close button, then the two wallet rows (button, then install link) are the focusable set.
    const closeButton = screen.getByRole("button", { name: /close/i });
    const installLink = screen.getByRole("link", { name: /xbull/i });

    installLink.focus();
    expect(installLink).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus(); // Wrapped past the last row back to the first focusable element.
  });

  it("traps Shift+Tab focus inside the dialog - wraps from the first focusable element back to the last", async () => {
    const user = userEvent.setup();
    render(
      <WalletPickerModal
        isOpen={true}
        onClose={vi.fn()}
        wallets={[freighter, notInstalled]}
        onSelectWallet={vi.fn()}
      />,
    );

    const closeButton = screen.getByRole("button", { name: /close/i });
    const installLink = screen.getByRole("link", { name: /xbull/i });

    closeButton.focus();
    await user.tab({ shift: true });
    expect(installLink).toHaveFocus();
  });

  it("calls onSelectWallet when an installed wallet is clicked", async () => {
    const user = userEvent.setup();
    const onSelectWallet = vi.fn();
    render(
      <WalletPickerModal isOpen={true} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={onSelectWallet} />,
    );

    await user.click(screen.getByRole("button", { name: /freighter/i }));
    expect(onSelectWallet).toHaveBeenCalledWith("freighter");
  });

  it("shows an install link instead of a clickable row for a wallet that isn't installed", () => {
    const onSelectWallet = vi.fn();
    render(
      <WalletPickerModal isOpen={true} onClose={vi.fn()} wallets={[notInstalled]} onSelectWallet={onSelectWallet} />,
    );

    const link = screen.getByRole("link", { name: /xbull/i });
    expect(link).toHaveAttribute("href", "https://xbull.app/install");
    expect(link).toHaveAttribute("target", "_blank");
    // Never rendered as a clickable connect row - there's nothing to connect to yet.
    expect(screen.queryByRole("button", { name: /xbull/i })).not.toBeInTheDocument();
  });

  it("announces a plain-language error to screen readers", () => {
    render(
      <WalletPickerModal
        isOpen={true}
        onClose={vi.fn()}
        wallets={[freighter]}
        onSelectWallet={vi.fn()}
        error="Freighter isn't installed. Install it, then try again."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Freighter isn't installed. Install it, then try again.",
    );
  });

  it("shows no alert when there is no error", () => {
    render(
      <WalletPickerModal isOpen={true} onClose={vi.fn()} wallets={[freighter]} onSelectWallet={vi.fn()} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables every wallet row while a connection is in flight", () => {
    render(
      <WalletPickerModal
        isOpen={true}
        onClose={vi.fn()}
        wallets={[freighter]}
        onSelectWallet={vi.fn()}
        isConnecting={true}
      />,
    );
    expect(screen.getByRole("button", { name: /freighter/i })).toBeDisabled();
  });
});
