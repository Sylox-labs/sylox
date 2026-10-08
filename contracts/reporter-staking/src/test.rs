use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env};

use crate::{ReporterStaking, ReporterStakingClient};

#[test]
#[should_panic]
fn add_reporter_is_not_yet_implemented() {
    let env = Env::default();
    let contract_id = env.register(ReporterStaking, ());
    let client = ReporterStakingClient::new(&env, &contract_id);
    let reporter = Address::generate(&env);
    client.add_reporter(&reporter, &symbol_short!("us"));
}
