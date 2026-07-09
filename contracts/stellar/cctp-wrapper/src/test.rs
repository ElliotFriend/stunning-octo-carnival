#![cfg(test)]

use super::*;
use soroban_sdk::bytes;
use soroban_sdk::{bytesn, testutils::Address as _, token, vec, Env};

use crate::mtv2_interface::{MessageTransmitterV2ContractInitParams, WASM as MTV2_WASM};
use crate::tmm_interface::{TmmClient, TokenMessengerMinterV2ContractInitParams, WASM as TMM_WASM};

#[test]
fn test() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(CctpWrapperContract, ());
    let wrapper_client = CctpWrapperContractClient::new(&env, &contract_id);

    // create a fake USDC token
    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer.clone());
    let _usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // create a mock transmitter contract
    let mtv2_contract_address = env.register(
        MTV2_WASM,
        (MessageTransmitterV2ContractInitParams {
            admin: issuer.clone(),
            attester_manager: issuer.clone(),
            attesters: vec![
                &env,
                bytesn!(&env, 0x8867a67cda4bc788c6e819baeaec60b867865287),
                bytesn!(&env, 0x49fd63506e0d88e07511ad95bae7b2a31af98b28),
            ],
            local_domain: 27,
            max_message_body_size: 8192,
            owner: issuer.clone(),
            pauser: issuer.clone(),
            rescuer: issuer.clone(),
            signature_threshold: 2,
            version: 1,
        },),
    );

    // create a mock tmm contract
    let tmm_contract_address = env.register(
        TMM_WASM,
        (TokenMessengerMinterV2ContractInitParams {
            admin: issuer.clone(),
            denylister: issuer.clone(),
            fee_recipient: issuer.clone(),
            message_body_version: 1,
            message_transmitter: mtv2_contract_address,
            min_fee_controller: issuer.clone(),
            owner: issuer.clone(),
            pauser: issuer.clone(),
            remote_domains: vec![&env, 26],
            remote_token_messengers: vec![
                &env,
                bytesn!(
                    &env,
                    0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa
                ),
            ],
            rescuer: issuer.clone(),
            token_controller: issuer.clone(),
        },),
    );

    // do some configuration for the token messenger minter (test won't pass without)
    let tmm_client = TmmClient::new(&env, &tmm_contract_address);
    tmm_client.set_token_decimal_config(&usdc.address(), &7, &6);
    tmm_client.set_max_burn_amount_per_message(&usdc.address(), &(1_000_000i128 * 10_000_000));

    // create a "user"
    let caller = Address::generate(&env);
    usdc_admin_client.mint(&caller, &(100i128 * 10_000_000));

    wrapper_client.approve_and_deposit(
        &caller,
        &usdc.address(),
        &tmm_contract_address,
        &(10i128 * 10_000_000),
        &26,
        &bytesn!(
            &env,
            0xfded3f55dec47250a52a8c0bb7038e72fa6ffaae33562f77cd2b629ef7fd424d
        ),
        &bytesn!(
            &env,
            0x0000000000000000000000000000000000000000000000000000000000000000
        ),
        &100_000,
        &2_000,
    );
}

#[test]
fn test_with_hook() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(CctpWrapperContract, ());
    let wrapper_client = CctpWrapperContractClient::new(&env, &contract_id);

    // create a fake USDC token
    let issuer = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(issuer.clone());
    let _usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // create a mock transmitter contract
    let mtv2_contract_address = env.register(
        MTV2_WASM,
        (MessageTransmitterV2ContractInitParams {
            admin: issuer.clone(),
            attester_manager: issuer.clone(),
            attesters: vec![
                &env,
                bytesn!(&env, 0x8867a67cda4bc788c6e819baeaec60b867865287),
                bytesn!(&env, 0x49fd63506e0d88e07511ad95bae7b2a31af98b28),
            ],
            local_domain: 27,
            max_message_body_size: 8192,
            owner: issuer.clone(),
            pauser: issuer.clone(),
            rescuer: issuer.clone(),
            signature_threshold: 2,
            version: 1,
        },),
    );

    // create a mock tmm contract
    let tmm_contract_address = env.register(
        TMM_WASM,
        (TokenMessengerMinterV2ContractInitParams {
            admin: issuer.clone(),
            denylister: issuer.clone(),
            fee_recipient: issuer.clone(),
            message_body_version: 1,
            message_transmitter: mtv2_contract_address,
            min_fee_controller: issuer.clone(),
            owner: issuer.clone(),
            pauser: issuer.clone(),
            remote_domains: vec![&env, 26],
            remote_token_messengers: vec![
                &env,
                bytesn!(
                    &env,
                    0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa
                ),
            ],
            rescuer: issuer.clone(),
            token_controller: issuer.clone(),
        },),
    );

    // do some configuration for the token messenger minter (test won't pass without)
    let tmm_client = TmmClient::new(&env, &tmm_contract_address);
    tmm_client.set_token_decimal_config(&usdc.address(), &7, &6);
    tmm_client.set_max_burn_amount_per_message(&usdc.address(), &(1_000_000i128 * 10_000_000));

    // create a "user"
    let caller = Address::generate(&env);
    usdc_admin_client.mint(&caller, &(100i128 * 10_000_000));

    wrapper_client.approve_and_deposit_with_hook(
        &caller,
        &usdc.address(),
        &tmm_contract_address,
        &(10i128 * 10_000_000),
        &26,
        &bytesn!(
            &env,
            0xfded3f55dec47250a52a8c0bb7038e72fa6ffaae33562f77cd2b629ef7fd424d
        ),
        &bytesn!(
            &env,
            0x0000000000000000000000000000000000000000000000000000000000000000
        ),
        &100_000,
        &2_000,
        &bytes!(
            &env,
            0x636374702d666f72776172640000000000000000000000000000000000000000
        )
    );
}
