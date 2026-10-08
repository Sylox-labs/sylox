use soroban_sdk::{testutils::Address as _, Env};

use crate::{RiskOracle, RiskOracleClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(RiskOracle, ());
    let client = RiskOracleClient::new(&env, &contract_id);
    let governor = soroban_sdk::Address::generate(&env);
    let registry = soroban_sdk::Address::generate(&env);
    let staking = soroban_sdk::Address::generate(&env);
    client.initialize(&governor, &registry, &staking);
}
