"use client";

import { useWallet } from "@/lib/wallet/WalletContext";

function shortenAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletButton() {
  const { address, openPicker, disconnect } = useWallet();

  if (address) {
    return (
      <button
        type="button"
        onClick={disconnect}
        className="rounded-sm border border-cement-grey/40 px-3 py-1.5 font-mono text-xs text-silo-oatmeal transition-colors hover:border-risk-crimson/50"
        title="Disconnect wallet"
      >
        {shortenAddress(address)}
      </button>
    );
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
