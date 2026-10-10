import { Client } from "./event-registry/src/index";
import { testnetDeployment, RPC_URL, NETWORK_PASSPHRASE } from "./deployment";

export * from "./event-registry/src/index";

export function eventRegistryClient() {
  return new Client({
    contractId: testnetDeployment.contracts.event_registry.id,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}
