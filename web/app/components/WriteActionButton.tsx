"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet/WalletContext";
import { stellarExpertTxUrl } from "@/lib/stellar-expert";
import type { Prepared } from "@/lib/event-actions";

type Step =
  | { kind: "idle" }
  | { kind: "simulating" }
  | { kind: "ready-to-confirm" }
  | { kind: "confirming" }
  | { kind: "done"; txHash: string }
  | { kind: "error"; message: string };

export interface WriteActionButtonProps<T> {
  label: string;
  /** Simulates the write for the given (already-connected) address and throws a plain-language error if it would be rejected. Called on the first click, and again automatically if the connected address changes before confirm. */
  prepare: (address: string) => Promise<Prepared<T>>;
  /** Signs and sends the already-prepared transaction. Called only after the simulated result was shown and the visitor confirms. */
  confirm: (prepared: Prepared<T>, signer: { publicKey: string; signTransaction: ReturnType<typeof useWallet>["signTransaction"] }) => Promise<{ txHash: string }>;
  /** True while this action doesn't apply right now (e.g. Finalize before the challenge window closes) - disables the button with no network call at all. */
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * One button, the full simulate-then-sign flow: click simulates via
 * `prepare` (only ever called with a connected address - the
 * disconnected state below never reaches it) and shows its outcome in
 * plain words; a bad simulation stops there, with no wallet prompt. A
 * good simulation shows a "Confirm & sign" step; only that click calls
 * `confirm`, which is the only place a signature is actually
 * requested. If the connected wallet changed between the two clicks
 * (a real scenario: switching accounts in the extension), confirm
 * re-prepares against the new address instead of signing a
 * transaction built for the old one - eventRegistryClient(publicKey)
 * bakes the address into the transaction's own source account, so a
 * stale `prepared` can never just be reused. A successful send links
 * to the transaction on stellar.expert.
 */
export function WriteActionButton<T>({
  label,
  prepare,
  confirm,
  disabled = false,
  disabledReason,
}: WriteActionButtonProps<T>) {
  const { address, openPicker, signTransaction } = useWallet();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [prepared, setPrepared] = useState<Prepared<T> | null>(null);

  const handleSimulate = async () => {
    if (!address) return; // Render-gated below too, but never trust the gate alone for the actual call.
    setStep({ kind: "simulating" });
    try {
      const result = await prepare(address);
      setPrepared(result);
      setStep({ kind: "ready-to-confirm" });
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleConfirm = async () => {
    if (!address || prepared === null) return;
    setStep({ kind: "confirming" });
    try {
      let toConfirm = prepared;
      if (prepared.preparedFor !== address) {
        // The connected wallet changed since Simulate - the old
        // transaction's source account no longer matches who's about
        // to sign, so it's discarded and re-simulated against the
        // current address rather than ever being signed as-is.
        toConfirm = await prepare(address);
        setPrepared(toConfirm);
      }
      const { txHash } = await confirm(toConfirm, { publicKey: address, signTransaction });
      setStep({ kind: "done", txHash });
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (step.kind === "done") {
    return (
      <div className="flex flex-col gap-1">
        <p className="font-mono text-sm text-silo-oatmeal">{label}: done.</p>
        <a
          href={stellarExpertTxUrl(step.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-cyber-tin underline transition-colors hover:text-silo-oatmeal"
        >
          View on stellar.expert
        </a>
      </div>
    );
  }

  if (disabled) {
    return (
      <div>
        <button
          type="button"
          disabled
          className="rounded-sm border border-cement-grey/30 px-4 py-2 font-mono text-sm text-cyber-tin opacity-50"
        >
          {label}
        </button>
        {disabledReason && <p className="mt-1 font-mono text-xs text-cyber-tin">{disabledReason}</p>}
      </div>
    );
  }

  if (!address) {
    return (
      <button
        type="button"
        onClick={openPicker}
        className="rounded-sm border border-cement-grey/30 px-4 py-2 font-mono text-sm text-silo-oatmeal transition-colors hover:border-risk-crimson/50"
      >
        Connect wallet to {label.toLowerCase()}
      </button>
    );
  }

  if (step.kind === "ready-to-confirm") {
    return (
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs text-cyber-tin">Simulation passed. Confirm to sign and send.</p>
        <button
          type="button"
          onClick={handleConfirm}
          className="rounded-full bg-risk-crimson px-4 py-2 font-mono text-sm text-slate-black transition-colors hover:bg-risk-crimson-tint"
        >
          Confirm &amp; sign {label}
        </button>
      </div>
    );
  }

  if (step.kind === "confirming") {
    return (
      <button type="button" disabled className="rounded-full bg-risk-crimson px-4 py-2 font-mono text-sm text-slate-black opacity-70">
        Signing…
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={step.kind === "simulating"}
        onClick={handleSimulate}
        className="rounded-sm border border-cement-grey/30 px-4 py-2 font-mono text-sm text-silo-oatmeal transition-colors hover:border-risk-crimson/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {step.kind === "simulating" ? "Checking…" : label}
      </button>
      {step.kind === "error" && (
        <p role="alert" className="font-mono text-xs text-risk-crimson-tint">
          {step.message}
        </p>
      )}
    </div>
  );
}
