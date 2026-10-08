use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{Staking, StakingClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(Staking, ());
    let client = StakingClient::new(&env, &contract_id);
    let governor = Address::generate(&env);
    let oracle = Address::generate(&env);
    let registry = Address::generate(&env);
    let treasury = Address::generate(&env);
    let usdc = Address::generate(&env);
    client.initialize(&governor, &oracle, &registry, &treasury, &usdc);
}
