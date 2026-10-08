use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{Treasury, TreasuryClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);
    let governor = Address::generate(&env);
    let staking = Address::generate(&env);
    let usdc = Address::generate(&env);
    client.initialize(&governor, &staking, &usdc);
}
