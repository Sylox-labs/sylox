use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{Series, SeriesClient};

#[test]
#[should_panic]
fn deposit_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(Series, ());
    let client = SeriesClient::new(&env, &contract_id);
    let seller = Address::generate(&env);
    client.deposit(&seller, &10_000_000_000);
}
