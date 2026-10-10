import { Client } from "./token/src/index";
import { NETWORK_PASSPHRASE, RPC_URL } from "./deployment";

export * from "./token/src/index";

// Generated once from TUSD's contract spec, but every Stellar Asset
// Contract shares the same SEP-41 interface (name/symbol/decimals/...),
// so this one set of generated bindings works as a client for any
// asset's address at runtime - exactly like riskOracleClient()/
// eventRegistryClient() already build a Client with a runtime
// contractId from one set of generated bindings, just pointed at a
// different address each time instead of a fixed one.
export function tokenClient(contractId: string) {
  return new Client({
    contractId,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}

// A token's name never changes once issued, so this is cached for the
// whole session rather than re-fetched on every Explorer load - same
// reasoning as any other static on-chain metadata.
const nameCache = new Map<string, string>();

/**
 * The asset's SEP-41 name() (format "CODE:ISSUER" for a classic-asset
 * Stellar Asset Contract, e.g. "USDC:GBBD..."). Falls back to a
 * shortened contract address if the read fails, rather than failing
 * whatever card/screen is trying to show it - a name is a label, not
 * risk data, so it's never worth blocking on.
 */
export async function assetDisplayName(contractId: string): Promise<string> {
  const cached = nameCache.get(contractId);
  if (cached) return cached;

  try {
    const tx = await tokenClient(contractId).name();
    const name = tx.result;
    nameCache.set(contractId, name);
    return name;
  } catch {
    return `${contractId.slice(0, 4)}…${contractId.slice(-4)}`;
  }
}
