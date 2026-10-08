import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Header } from "./Header";

describe("Header", () => {
  it("renders the primary nav links and the early access CTA", () => {
    render(<Header />);
    expect(screen.getByText("How it works")).toBeInTheDocument();
    expect(screen.getByText("Who it's for")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("FAQ")).toBeInTheDocument();
    expect(screen.getAllByText("Get early access").length).toBeGreaterThan(0);
  });

  it("opens the mobile menu as a dialog and closes it on Escape", () => {
    render(<Header />);
    const toggle = screen.getByRole("button", { name: /open menu/i });

    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog", { name: /menu/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /menu/i })).not.toBeInTheDocument();
  });

  it("returns focus to the menu button after closing with Escape", () => {
    render(<Header />);
    const toggle = screen.getByRole("button", { name: /open menu/i });

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("button", { name: /open menu/i })).toHaveFocus();
  });
});
