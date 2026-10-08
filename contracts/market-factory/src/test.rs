use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

use crate::{MarketFactory, MarketFactoryClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(MarketFactory, ());
    let client = MarketFactoryClient::new(&env, &contract_id);
    let governor = Address::generate(&env);
    let oracle = Address::generate(&env);
    let registry = Address::generate(&env);
    let usdc = Address::generate(&env);
    let series_wasm = BytesN::from_array(&env, &[0u8; 32]);
    client.initialize(&governor, &oracle, &registry, &usdc, &series_wasm);
}
