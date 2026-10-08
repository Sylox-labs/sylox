use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{EventRegistry, EventRegistryClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(EventRegistry, ());
    let client = EventRegistryClient::new(&env, &contract_id);
    let governor = Address::generate(&env);
    let oracle = Address::generate(&env);
    let usdc = Address::generate(&env);
    client.initialize(&governor, &oracle, &usdc);
}
