import { Client } from "./risk-oracle/src/index";
import { testnetDeployment, RPC_URL, NETWORK_PASSPHRASE } from "./deployment";

export * from "./risk-oracle/src/index";

export function riskOracleClient() {
  return new Client({
    contractId: testnetDeployment.contracts.risk_oracle.id,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  });
}
