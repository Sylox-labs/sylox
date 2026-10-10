"use client";

import { useEffect, useRef } from "react";
import { Card } from "./Card";
import { Eyebrow } from "./Eyebrow";

/**
 * This package never imports the Stellar Wallets Kit (or any wallet
 * SDK) - the modal is pure presentation, driven entirely by these
 * plain props. The consumer (web/app) maps the kit's own wallet
 * objects onto this shape, so web/shared/ui stays wallet-library
 * agnostic and reusable by anything that needs a wallet picker, not
 * just this one kit's integration.
 */
export interface WalletOption {
  id: string;
  name: string;
  /** URL to the wallet's icon image. */
  icon: string;
  installed: boolean;
  /** Where to install the wallet from, shown only when `installed` is false. */
  installUrl?: string;
}

export interface WalletPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  wallets: WalletOption[];
  /** Called when the visitor picks an installed wallet. Never called for an uninstalled one - that row links out to installUrl instead. */
  onSelectWallet: (id: string) => void;
  /** True while a connection attempt is in flight, after onSelectWallet fires. Disables every row so a second click can't race the first. */
  isConnecting?: boolean;
  /** Plain-language connection failure, e.g. "Freighter isn't installed. Install it, then try again." Announced to screen readers via role="alert". */
  error?: string | null;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled])';

/**
 * A from-scratch wallet picker, styled with the shared design system
 * (Card, Eyebrow, Space Mono labels, hairline borders) instead of the
 * Stellar Wallets Kit's own built-in modal - the kit is used strictly
 * for its headless SDK calls (list wallets, select, sign), never its
 * UI, so every Sylox surface keeps one visual language.
 *
 * Keyboard contract: focus moves into the dialog on open, Tab wraps at
 * the first/last focusable row (never escapes to the page behind it),
 * and Escape closes and returns focus to whatever opened the modal -
 * the same pattern web/landing's mobile nav panel already uses.
 */
export function WalletPickerModal({
  isOpen,
  onClose,
  wallets,
  onSelectWallet,
  isConnecting = false,
  error = null,
}: WalletPickerModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="w-full max-w-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <Card className="max-h-[80vh] overflow-y-auto bg-slate-black">
          <div className="flex items-center justify-between gap-3">
            <Eyebrow>+ CONNECT WALLET</Eyebrow>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="font-mono text-sm text-cyber-tin transition-colors hover:text-silo-oatmeal"
            >
              ESC
            </button>
          </div>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-sm border border-risk-crimson/40 bg-risk-crimson/10 px-3 py-2 font-mono text-xs text-risk-crimson-tint"
            >
              {error}
            </p>
          )}

          <ul className="mt-4 flex flex-col gap-2">
            {wallets.map((wallet) => (
              <li key={wallet.id}>
                {wallet.installed ? (
                  <button
                    type="button"
                    disabled={isConnecting}
                    onClick={() => onSelectWallet(wallet.id)}
                    className="flex w-full items-center gap-3 rounded-sm border border-cement-grey/30 px-4 py-3 text-left font-mono text-sm text-silo-oatmeal transition-colors hover:border-risk-crimson/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- shared/ui has no next/image dependency; icon comes from the kit's own hosted URL, not a local asset. */}
                    <img src={wallet.icon} alt="" aria-hidden="true" className="h-6 w-6 shrink-0" />
                    <span className="flex-1">{wallet.name}</span>
                  </button>
                ) : (
                  <a
                    href={wallet.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center gap-3 rounded-sm border border-cement-grey/30 px-4 py-3 text-left font-mono text-sm text-cyber-tin transition-colors hover:border-silo-oatmeal/50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- shared/ui has no next/image dependency; icon comes from the kit's own hosted URL, not a local asset. */}
                    <img src={wallet.icon} alt="" aria-hidden="true" className="h-6 w-6 shrink-0 opacity-50" />
                    <span className="flex-1">{wallet.name}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-cyber-tin/70">
                      Install
                    </span>
                  </a>
                )}
              </li>
            ))}
          </ul>

          {wallets.length === 0 && (
            <p className="mt-4 font-mono text-sm text-cyber-tin">No wallets available.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
