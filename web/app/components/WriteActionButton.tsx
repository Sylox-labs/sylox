"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet/WalletContext";
import { stellarExpertTxUrl } from "@/lib/stellar-expert";

type Step =
  | { kind: "idle" }
  | { kind: "simulating" }
  | { kind: "ready-to-confirm" }
  | { kind: "confirming" }
  | { kind: "done"; txHash: string }
  | { kind: "error"; message: string };

export interface WriteActionButtonProps<Prepared> {
  label: string;
  /** Simulates the write (the contract's own auto-simulation on construction) and throws a plain-language error if it would be rejected. Called on the first click. */
  prepare: () => Promise<Prepared>;
  /** Signs and sends the already-prepared transaction. Called only after the simulated result was shown and the visitor confirms. */
  confirm: (prepared: Prepared, signer: { publicKey: string; signTransaction: ReturnType<typeof useWallet>["signTransaction"] }) => Promise<{ txHash: string }>;
  /** True while this action doesn't apply right now (e.g. Finalize before the challenge window closes) - disables the button with no network call at all. */
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * One button, the full simulate-then-sign flow: click simulates via
 * `prepare` and shows its outcome in plain words; a bad simulation
 * stops there, with no wallet prompt. A good simulation shows a
 * "Confirm & sign" step; only that click calls `confirm`, which is
 * the only place a signature is actually requested. A successful send
 * links to the transaction on stellar.expert.
 */
export function WriteActionButton<Prepared>({
  label,
  prepare,
  confirm,
  disabled = false,
  disabledReason,
}: WriteActionButtonProps<Prepared>) {
  const { address, openPicker, signTransaction } = useWallet();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  const handleSimulate = async () => {
    setStep({ kind: "simulating" });
    try {
      const result = await prepare();
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
      const { txHash } = await confirm(prepared, { publicKey: address, signTransaction });
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
