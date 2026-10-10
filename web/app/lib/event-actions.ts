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
 * A prepared transaction, tagged with the address it was simulated
 * for. eventRegistryClient(publicKey) bakes that address into the
 * transaction's own source account at construction time, so a
 * transaction built for one address can never be signed and sent by
 * another - confirm* checks `preparedFor` against the signer it's
 * given and refuses to reuse a stale transaction if the connected
 * wallet changed in between (a real scenario: the visitor switches
 * accounts in their wallet extension between clicking "Checkpoint"
 * and clicking "Confirm & sign").
 */
export interface Prepared<T> {
  tx: T;
  preparedFor: string;
}

/**
 * Two explicit steps, not one call, so the UI can show the simulated
 * result BEFORE ever asking the wallet to sign anything: `prepare*`
 * constructs the transaction (which auto-simulates) and throws a
 * plain-language error immediately if the contract would reject the
 * call - a wrong state, the challenge window still open, etc. Only
 * once the caller has seen that outcome and explicitly confirms does
 * `confirm*` ask the wallet to sign and actually send it. Both
 * require an address up front (never simulate against a placeholder
 * account) - the caller (components/WriteActionButton.tsx) only ever
 * calls these once a wallet is connected.
 */

export async function prepareCheckpointCure(
  eventId: bigint,
  address: string,
): Promise<Prepared<Awaited<ReturnType<ReturnType<typeof eventRegistryClient>["checkpoint_cure"]>>>> {
  const registry = eventRegistryClient(address);
  const tx = await registry.checkpoint_cure({ event_id: eventId });
  if (tx.result.isErr()) {
    throw new Error(describeCheckpointError(tx.result.unwrapErr().message));
  }
  return { tx, preparedFor: address };
}

export async function confirmCheckpointCure(
  prepared: Awaited<ReturnType<typeof prepareCheckpointCure>>,
  signer: Signer,
): Promise<WriteResult<CureProgress>> {
  if (prepared.preparedFor !== signer.publicKey) {
    throw new Error(
      "The connected wallet changed since this was checked. Click Checkpoint again to re-check with the current wallet.",
    );
  }
  const sent = await prepared.tx.signAndSend({ signTransaction: signer.signTransaction });
  if (sent.result.isErr()) {
    throw new Error(describeCheckpointError(sent.result.unwrapErr().message));
  }
  return {
    result: sent.result.unwrap(),
    txHash: sent.sendTransactionResponse?.hash ?? "",
  };
}

export async function prepareFinalize(
  eventId: bigint,
  address: string,
): Promise<Prepared<Awaited<ReturnType<ReturnType<typeof eventRegistryClient>["finalize"]>>>> {
  const registry = eventRegistryClient(address);
  const tx = await registry.finalize({ event_id: eventId });
  if (tx.result.isErr()) {
    throw new Error(describeFinalizeError(tx.result.unwrapErr().message));
  }
  return { tx, preparedFor: address };
}

export async function confirmFinalize(
  prepared: Awaited<ReturnType<typeof prepareFinalize>>,
  signer: Signer,
): Promise<WriteResult<void>> {
  if (prepared.preparedFor !== signer.publicKey) {
    throw new Error(
      "The connected wallet changed since this was checked. Click Finalize again to re-check with the current wallet.",
    );
  }
  const sent = await prepared.tx.signAndSend({ signTransaction: signer.signTransaction });
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
