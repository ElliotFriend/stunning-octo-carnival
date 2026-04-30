#![no_std]
use soroban_sdk::{Address, BytesN, Env, String, Vec, contract, contractclient, contractimpl, token, vec};

// #[contractclient(name = "TmmClient")]
// pub trait Tmm {
//     fn deposit_for_burn(
//         caller: Address,
//         amount: i128,
//         destination_domain: u32,
//         mint_recipient: BytesN<32>,
//         burn_token: Address,
//         destination_caller: BytesN<32>,
//         max_fee: i128,
//         min_finality_threshold: u32
//     );
// }
mod tmm_interface;
use crate::tmm_interface::TmmClient;
mod mtv2_interface;
// use crate::mtv2_interface::Mtv2Client;

#[contract]
pub struct CctpWrapperContract;

#[contractimpl]
impl CctpWrapperContract {
    pub fn approve_and_deposit(env: Env,
        caller: Address,
        usdc: Address,
        tmm: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        caller.require_auth();

        // approve an allowance so the TokenMessengerMinter contract can `transfer_from` our caller address
        let expiration_ledger = (env.ledger().sequence() + 50).next_multiple_of(50);
        token::Client::new(&env, &usdc).approve(&caller, &tmm, &amount, &expiration_ledger);

        let tmm_client = TmmClient::new(&env, &tmm);
        tmm_client.deposit_for_burn(&caller, &amount, &destination_domain, &mint_recipient, &usdc, &destination_caller, &max_fee, &min_finality_threshold);
    }
}

mod test;
