import { Client } from "./event-registry/src/index";
import { testnetDeployment, RPC_URL, NETWORK_PASSPHRASE } from "./deployment";

export * from "./event-registry/src/index";

/**
 * `publicKey` sets the transaction's own source account at
 * construction time (confirmed against @stellar/stellar-sdk's own
 * docs: "the account that constructed the transaction (publicKey)").
 * Every read-only call site (Explorer, Asset, Event's own display
 * data) omits it - irrelevant for simulation-only reads. Every WRITE
 * call site (lib/event-actions.ts's prepare*) must pass the connected
 * wallet's address here, or the simulated/signed transaction's source
 * account won't match the wallet that's about to sign it.
 */
export function eventRegistryClient(publicKey?: string) {
  return new Client({
    contractId: testnetDeployment.contracts.event_registry.id,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey,
  });
}
