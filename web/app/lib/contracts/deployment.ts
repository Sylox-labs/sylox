import deployment from "../../../../deployments/testnet.json";

// The one place in the app that reads deployments/testnet.json. Every
// contract client is built from this, never from a literal contract ID
// written in app code (brief: "contract addresses come from
// deployments/testnet.json at build time and are never hardcoded").
// Testnet gets redeployed with new addresses from time to time; this
// file is what makes that a non-event for the app.

export interface TestnetDeployment {
  network: string;
  passphrase: string;
  rpc_url: string;
  deployed_at: string;
  contracts: {
    risk_oracle: { id: string };
    event_registry: { id: string };
    staking?: { id: string };
    treasury?: { id: string };
  };
}

export const testnetDeployment = deployment as TestnetDeployment;

export const RPC_URL = testnetDeployment.rpc_url;
export const NETWORK_PASSPHRASE = testnetDeployment.passphrase;
