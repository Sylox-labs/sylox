import { eventRegistryClient } from "./contracts/event-registry";
import type { CureProgress } from "./contracts/event-registry";

export interface WriteResult<T> {
  result: T;
  /** The transaction hash, for a stellar.expert link - present once the transaction has actually been sent. */
  txHash: string;
}

/**
 * The signer shape every write action below takes: address plus a
 * signTransaction function matching @stellar/stellar-sdk's own
 * SignTransactionLike signature. This app's WalletContext provides one
 * backed by the Stellar Wallets Kit, but nothing here imports the kit -
 * only plain XDR strings cross that boundary (see lib/wallet/kit.ts),
 * and this module only ever sees the already-bridged function.
 */
export interface Signer {
  publicKey: string;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string; signerAddress?: string }>;
}

/**
 * Two explicit steps, not one call, so the UI can show the simulated
 * result BEFORE ever asking the wallet to sign anything: `prepare*`
 * constructs the transaction (which auto-simulates) and throws a
 * plain-language error immediately if the contract would reject the
 * call - a wrong state, the challenge window still open, etc. Only
 * once the caller has seen that outcome and explicitly confirms does
 * `confirm*` ask the wallet to sign and actually send it.
 */

export async function prepareCheckpointCure(eventId: bigint) {
  const registry = eventRegistryClient();
  const tx = await registry.checkpoint_cure({ event_id: eventId });
  if (tx.result.isErr()) {
    throw new Error(describeCheckpointError(tx.result.unwrapErr().message));
  }
  return tx;
}

export async function confirmCheckpointCure(
  tx: Awaited<ReturnType<typeof prepareCheckpointCure>>,
  signer: Signer,
): Promise<WriteResult<CureProgress>> {
  const sent = await tx.signAndSend({ signTransaction: signer.signTransaction });
  if (sent.result.isErr()) {
    throw new Error(describeCheckpointError(sent.result.unwrapErr().message));
  }
  return {
    result: sent.result.unwrap(),
    txHash: sent.sendTransactionResponse?.hash ?? "",
  };
}

export async function prepareFinalize(eventId: bigint) {
  const registry = eventRegistryClient();
  const tx = await registry.finalize({ event_id: eventId });
  if (tx.result.isErr()) {
    throw new Error(describeFinalizeError(tx.result.unwrapErr().message));
  }
  return tx;
}

export async function confirmFinalize(
  tx: Awaited<ReturnType<typeof prepareFinalize>>,
  signer: Signer,
): Promise<WriteResult<void>> {
  const sent = await tx.signAndSend({ signTransaction: signer.signTransaction });
  if (sent.result.isErr()) {
    throw new Error(describeFinalizeError(sent.result.unwrapErr().message));
  }
  return { result: undefined, txHash: sent.sendTransactionResponse?.hash ?? "" };
}

// The contract's own error messages (from its #[contracterror] enum,
// Section 14) are already plain words written for exactly this
// purpose - these just add the specific action's context rather than
// replacing the message with something invented.
function describeCheckpointError(message: string): string {
  return `Couldn't check the cure progress: ${message}`;
}

function describeFinalizeError(message: string): string {
  return `Couldn't finalize this event: ${message}`;
}
