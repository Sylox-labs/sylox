use soroban_sdk::{testutils::Address as _, vec, Address, Env};

use crate::{Governor, GovernorClient};

#[test]
#[should_panic]
fn initialize_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(Governor, ());
    let client = GovernorClient::new(&env, &contract_id);
    let signer = Address::generate(&env);
    let committee = Address::generate(&env);
    client.initialize(&vec![&env, signer], &1, &604_800, &committee);
}
