import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Header } from "./Header";

describe("Header", () => {
  it("renders the primary nav links and the GitHub link", () => {
    render(<Header />);
    // The off-canvas mobile menu duplicates every nav link (it's always
    // mounted, just aria-hidden until opened — see Header.tsx's own
    // comment on why it isn't conditionally rendered), so every label
    // appears twice in the DOM at once. Scope to the visible desktop
    // <nav> to assert against a single, unambiguous copy of each link.
    const desktopNav = within(screen.getByRole("navigation", { name: /primary/i }));
    expect(desktopNav.getByText("How it works")).toBeInTheDocument();
    expect(desktopNav.getByText("Who it's for")).toBeInTheDocument();
    expect(desktopNav.getByText("Status")).toBeInTheDocument();
    expect(desktopNav.getByText("FAQ")).toBeInTheDocument();
    expect(desktopNav.getByText("GitHub")).toBeInTheDocument();
  });

  it("renders a Launch app link to the live app, with a Testnet tag, opening in the same tab", () => {
    render(<Header />);
    // Two copies exist (desktop button + mobile menu's), same as every
    // other nav item here - assert against the desktop one specifically,
    // the one actually visible outside the mobile menu.
    const desktopNav = screen.getByRole("navigation", { name: /primary/i });
    const launchLinks = screen.getAllByRole("link", { name: /launch app/i });
    expect(launchLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of launchLinks) {
      expect(link).toHaveAttribute("href", "https://app.sylox.xyz");
      // No target="_blank" - opens in the same tab, unlike the GitHub link.
      expect(link).not.toHaveAttribute("target");
    }
    expect(desktopNav.parentElement).toHaveTextContent(/testnet/i);
  });

  it("opens the mobile menu as a dialog and closes it on Escape", async () => {
    render(<Header />);
    const toggle = screen.getByRole("button", { name: /open menu/i });

    fireEvent.click(toggle);
    // The panel starts CSS visibility:hidden and only flips to visible
    // inside an async `await import("gsap")` effect (see Header.tsx),
    // so it isn't in the accessible role tree on the same tick as the
    // click. findByRole polls until that resolves instead of asserting
    // on the pre-animation DOM state.
    const dialog = await screen.findByRole("dialog", { name: /menu/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /menu/i })).not.toBeInTheDocument();
  });

  it("returns focus to the menu button after closing with Escape", async () => {
    render(<Header />);
    const toggle = screen.getByRole("button", { name: /open menu/i });

    fireEvent.click(toggle);
    await screen.findByRole("dialog", { name: /menu/i });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: /open menu/i })).toHaveFocus();
  });
});
