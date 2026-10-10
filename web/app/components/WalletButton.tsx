"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/lib/wallet/WalletContext";

function shortenAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function ConnectedButton({ address, disconnect }: { address: string; disconnect: () => void }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMenuOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMenuOpen]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, insecure context) -
      // the address is still visible in the button itself, so this
      // is never the only way to get it.
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label={`${shortenAddress(address)}, wallet options`}
        className="flex items-center gap-1.5 rounded-sm border border-cement-grey/40 px-3 py-1.5 font-mono text-xs text-silo-oatmeal transition-colors hover:border-risk-crimson/50"
      >
        {shortenAddress(address)}
        {/* The only visible signal this button opens a menu (Copy
            address, Disconnect) - without it the address reads as a
            static label, not something to click. Rotates on open for
            the same reason native <select> chevrons do: confirms the
            click actually did something. */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className={`shrink-0 text-cyber-tin transition-transform ${isMenuOpen ? "rotate-180" : ""}`}
        >
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isMenuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-2 w-40 rounded-sm border border-cement-grey/30 bg-slate-black py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="block w-full px-3 py-2 text-left font-mono text-xs text-silo-oatmeal transition-colors hover:bg-cement-grey/10"
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIsMenuOpen(false);
              disconnect();
            }}
            className="block w-full px-3 py-2 text-left font-mono text-xs text-risk-crimson-tint transition-colors hover:bg-cement-grey/10"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function WalletButton() {
  const { address, openPicker, disconnect } = useWallet();

  if (address) {
    return <ConnectedButton address={address} disconnect={disconnect} />;
  }

  return (
    <button
      type="button"
      onClick={openPicker}
      className="rounded-full bg-risk-crimson px-4 py-1.5 font-mono text-xs text-slate-black transition-colors hover:bg-risk-crimson-tint"
    >
      Connect wallet
    </button>
  );
}
