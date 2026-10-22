// Copyright 2024 VoteChain Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Security regression tests (issue #87).
//!
//! One block per vulnerability documented in `docs/security/`. Each test must
//! fail if the corresponding fix is reverted.

use crate::test_helpers::{create_test_proposal, setup_env};
use crate::types::{ContractError, Vote};
use crate::{GovernanceContract, GovernanceContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env};
use votechain_token::TokenContractClient;

// ── Test-only token doubles ──────────────────────────────────────────────────

mod spoof {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    /// SEC-008: a spoofed token that reports an enormous balance for everyone.
    #[contract]
    pub struct SpoofToken;

    #[contractimpl]
    impl SpoofToken {
        pub fn balance(_env: Env, _id: Address) -> i128 {
            1_000_000_000
        }
    }
}
use spoof::{SpoofToken, SpoofTokenClient};

mod reentrant {
    use crate::types::Vote;
    use crate::GovernanceContractClient;
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum ReentrantKey {
        Gov,
        Proposal,
    }

    /// SEC-010: a malicious token whose `balance` and `transfer` hooks try to
    /// re-enter `GovernanceContract::cast_vote`.
    #[contract]
    pub struct ReentrantToken;

    #[contractimpl]
    impl ReentrantToken {
        pub fn setup(env: Env, gov: Address, proposal_id: u64) {
            env.storage().instance().set(&ReentrantKey::Gov, &gov);
            env.storage().instance().set(&ReentrantKey::Proposal, &proposal_id);
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            Self::reenter(&env, &id);
            1_000
        }

        pub fn transfer(env: Env, from: Address, _to: Address, _amount: i128) {
            Self::reenter(&env, &from);
        }

        fn reenter(env: &Env, voter: &Address) {
            let gov: Option<Address> = env.storage().instance().get(&ReentrantKey::Gov);
            let pid: Option<u64> = env.storage().instance().get(&ReentrantKey::Proposal);
            if let (Some(gov), Some(pid)) = (gov, pid) {
                GovernanceContractClient::new(env, &gov).cast_vote(voter, &pid, &Vote::Yes, &None);
            }
        }
    }
}
use reentrant::{ReentrantToken, ReentrantTokenClient};

// ── SEC-008: token balance fetch ─────────────────────────────────────────────

/// SEC-008: vote weight is read from the configured token contract, not from
/// a spoofed token contract holding an inflated balance.
#[test]
fn sec_008_balance_read_from_configured_token_not_spoof() {
    let t = setup_env();
    let spoof_id = t.env.register(SpoofToken, ());
    let spoof = SpoofTokenClient::new(&t.env, &spoof_id);

    let voter = Address::generate(&t.env);
    TokenContractClient::new(&t.env, &t.token_id).mint(&t.admin, &voter, &42);
    assert_eq!(spoof.balance(&voter), 1_000_000_000);

    let pid = create_test_proposal(&t, &t.admin);
    t.client.cast_vote(&voter, &pid, &Vote::Yes, &None);

    assert_eq!(t.client.get_vote(&pid, &voter).unwrap().weight, 42);
    assert_eq!(t.client.get_proposal(&pid).votes_yes, 42);
}

/// SEC-008: a voter with zero balance in the real token cannot vote, even if a
/// spoofed token would report a large balance for them.
#[test]
fn sec_008_spoofed_balance_does_not_grant_voting_power() {
    let t = setup_env();
    t.env.register(SpoofToken, ());
    let voter = Address::generate(&t.env);
    let pid = create_test_proposal(&t, &t.admin);

    let res = t.client.try_cast_vote(&voter, &pid, &Vote::Yes, &None);
    assert_eq!(res, Err(Ok(ContractError::NoVotingPower)));
}

/// SEC-008 / SEC-009: re-initialising to point at a spoofed token is rejected,
/// so the stored voting token cannot be swapped.
#[test]
fn sec_008_cannot_swap_voting_token_to_spoof() {
    let t = setup_env();
    let spoof_id = t.env.register(SpoofToken, ());
    let res = t.client.try_initialize(
        &t.admin, &spoof_id, &0_i128, &0_u64, &60_u64, &2_592_000_u64, &false, &0_u64, &0_u64,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));

    let voter = Address::generate(&t.env);
    let pid = create_test_proposal(&t, &t.admin);
    assert_eq!(
        t.client.try_cast_vote(&voter, &pid, &Vote::Yes, &None),
        Err(Ok(ContractError::NoVotingPower))
    );
}

// ── SEC-009: re-initialisation guard ─────────────────────────────────────────

fn sec_009_try_reinit(caller_is_admin: bool) {
    let t = setup_env();
    let caller = if caller_is_admin {
        t.admin.clone()
    } else {
        Address::generate(&t.env)
    };
    let new_token = Address::generate(&t.env);
    let res = t.client.try_initialize(
        &caller, &new_token, &1_i128, &10_u64, &1_u64, &10_u64, &true, &5_u64, &3_u64,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));

    // State is untouched: the original token still drives voting weight.
    let voter = Address::generate(&t.env);
    TokenContractClient::new(&t.env, &t.token_id).mint(&t.admin, &voter, &7);
    let pid = create_test_proposal(&t, &t.admin);
    t.client.cast_vote(&voter, &pid, &Vote::Yes, &None);
    assert_eq!(t.client.get_vote(&pid, &voter).unwrap().weight, 7);
}

/// SEC-009: re-initialisation by the original admin reverts with
/// `AlreadyInitialized` and leaves configuration unchanged.
#[test]
fn sec_009_reinit_by_admin_reverts() {
    sec_009_try_reinit(true);
}

/// SEC-009: re-initialisation by any other address reverts with
/// `AlreadyInitialized` and leaves configuration unchanged.
#[test]
fn sec_009_reinit_by_attacker_reverts() {
    sec_009_try_reinit(false);
}

/// SEC-009: repeated re-initialisation attempts all revert.
#[test]
fn sec_009_repeated_reinit_attempts_revert() {
    let t = setup_env();
    for _ in 0..3 {
        let attacker = Address::generate(&t.env);
        let res = t.client.try_initialize(
            &attacker, &t.token_id, &0_i128, &0_u64, &60_u64, &2_592_000_u64, &false, &0_u64,
            &0_u64,
        );
        assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));
    }
}

// ── SEC-010: reentrancy in cast_vote ─────────────────────────────────────────

fn sec_010_setup() -> (Env, GovernanceContractClient<'static>, ReentrantTokenClient<'static>, u64) {
    let env = Env::default();
    // Allow non-root auth so any failure is caused by re-entry, not by auth.
    env.mock_all_auths_allowing_non_root_auth();

    let gov_id = env.register(GovernanceContract, ());
    let gov = GovernanceContractClient::new(&env, &gov_id);
    let tok_id = env.register(ReentrantToken, ());
    let tok = ReentrantTokenClient::new(&env, &tok_id);

    let admin = Address::generate(&env);
    gov.initialize(
        &admin, &tok_id, &0_i128, &0_u64, &60_u64, &2_592_000_u64, &false, &0_u64, &0_u64,
    );
    let pid = gov.create_proposal(
        &admin,
        &soroban_sdk::String::from_str(&env, "Reentrancy"),
        &soroban_sdk::String::from_str(&env, "SEC-010"),
        &100,
        &3600,
    );
    tok.setup(&gov_id, &pid);
    (env, gov, tok, pid)
}

/// SEC-010: a token that re-enters `cast_vote` while governance fetches the
/// voter's balance must cause the whole vote to revert, with no tally change.
#[test]
fn sec_010_reentrant_cast_vote_from_token_hook_reverts() {
    let (env, gov, _tok, pid) = sec_010_setup();
    let voter = Address::generate(&env);

    assert!(gov.try_cast_vote(&voter, &pid, &Vote::Yes, &None).is_err());

    assert!(!gov.has_voted(&pid, &voter));
    let p = gov.get_proposal(&pid);
    assert_eq!(p.votes_yes, 0);
    assert_eq!(p.votes_no, 0);
    assert_eq!(p.votes_abstain, 0);
}

/// SEC-010: a token `transfer` hook that calls back into `cast_vote` must not
/// be able to record a vote.
#[test]
fn sec_010_reentrant_cast_vote_from_transfer_hook_reverts() {
    let (env, gov, tok, pid) = sec_010_setup();
    let voter = Address::generate(&env);
    let to = Address::generate(&env);

    // The transfer hook calls cast_vote, which in turn calls back into the
    // token's balance() — a re-entry into the token contract the host rejects.
    assert!(tok.try_transfer(&voter, &to, &1).is_err());
    assert!(!gov.has_voted(&pid, &voter));
    assert_eq!(gov.get_proposal(&pid).votes_yes, 0);
}

// ── SEC-009: network isolation — voting token immutability (#322) ─────────────

/// #322: Verifies that the `VotingToken` address cannot be changed after
/// initialisation.  The test:
///
/// 1. Deploys two token contracts and initialises governance with the first.
/// 2. Records the voting token via `get_config`.
/// 3. Attempts to re-initialise with the second token (different address).
/// 4. Confirms the call reverts with `AlreadyInitialized`.
/// 5. Confirms `get_config` still reports the original voting token.
/// 6. Confirms voting weight is still derived from the original token, not
///    the second token — i.e. the contract is isolated from the re-init attempt.
#[test]
fn sec_009_network_isolation_voting_token_immutable() {
    let t = setup_env();

    // Deploy a second token that we will try (and fail) to swap in.
    let alt_token_id = t.env.register(votechain_token::TokenContract, ());
    let alt_token = votechain_token::TokenContractClient::new(&t.env, &alt_token_id);
    let alt_admin = Address::generate(&t.env);
    alt_token.initialize(&alt_admin, &10_000_000);

    // Record the original voting token address.
    let original_config = t.client.get_config().unwrap();
    let original_token = original_config.voting_token;
    assert_eq!(original_token, t.token_id);

    // Attempt re-initialisation with the alternative token — must fail.
    let res = t.client.try_initialize(
        &t.admin,
        &alt_token_id,
        &0_i128,
        &0_u64,
        &60_u64,
        &2_592_000_u64,
        &false,
        &0_u64,
        &0_u64,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));

    // The voting token address must be unchanged.
    let config_after = t.client.get_config().unwrap();
    assert_eq!(
        config_after.voting_token, original_token,
        "VotingToken must not change after a failed re-init attempt"
    );

    // Voting weight must still come from the original token.
    // Mint tokens on the original token → vote should succeed with that weight.
    // Mint tokens on the alt token → they must not grant voting power.
    let voter = Address::generate(&t.env);
    TokenContractClient::new(&t.env, &t.token_id).mint(&t.admin, &voter, &100);
    alt_token.mint(&alt_admin, &voter, &999_999);

    let pid = create_test_proposal(&t, &t.admin);
    t.client.cast_vote(&voter, &pid, &Vote::Yes, &None);

    let vote_record = t.client.get_vote(&pid, &voter).unwrap();
    assert_eq!(
        vote_record.weight, 100,
        "vote weight must be 100 (original token balance), not 999_999 (alt token)"
    );
    assert_eq!(t.client.get_proposal(&pid).votes_yes, 100);
}

/// #322: Verifies that multiple re-initialisation attempts with different
/// parameters (token, admin, durations) all fail and leave the original
/// configuration completely untouched.
#[test]
fn sec_009_network_isolation_repeated_reinit_preserves_config() {
    let t = setup_env();
    let original_config = t.client.get_config().unwrap();

    let alt_token = Address::generate(&t.env);
    let alt_admin = Address::generate(&t.env);

    // Three attempts with varying parameters.
    for i in 0..3 {
        let res = t.client.try_initialize(
            &alt_admin,
            &alt_token,
            &(1_000_000_i128),
            &(3600_u64),
            &(120_u64),
            &(1_000_000_u64),
            &true,
            &(600_u64),
            &((i + 1) as u64),
        );
        assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));
    }

    // Every config field must be unchanged.
    let config_after = t.client.get_config().unwrap();
    assert_eq!(config_after.admin, original_config.admin);
    assert_eq!(config_after.voting_token, original_config.voting_token);
    assert_eq!(
        config_after.min_proposal_balance,
        original_config.min_proposal_balance
    );
    assert_eq!(
        config_after.proposal_cooldown,
        original_config.proposal_cooldown
    );
    assert_eq!(
        config_after.restrict_admin_vote,
        original_config.restrict_admin_vote
    );
    assert_eq!(
        config_after.timelock_duration,
        original_config.timelock_duration
    );
    assert_eq!(config_after.min_duration, original_config.min_duration);
    assert_eq!(config_after.max_duration, original_config.max_duration);
}
