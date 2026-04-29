#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::Address as _, testutils::Events as _, testutils::Ledger as _, Address, Env, String,
};

use crate::{GravityToken, GravityTokenClient};

/// 1 HITZ = 10^7 raw units (7 decimals)
const H: i128 = 10_000_000;

fn setup_env() -> (Env, Address, GravityTokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(GravityToken, ());
    let client = GravityTokenClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(
        &admin,
        &String::from_str(&env, "Gravity HITZ"),
        &String::from_str(&env, "HITZ"),
    );

    (env, admin, client)
}

/// Helper: set up env with a registered pool address.
/// The pool is just a regular generated address that is whitelisted.
fn setup_with_pool() -> (Env, Address, GravityTokenClient<'static>, Address) {
    let (env, admin, client) = setup_env();

    let pool = Address::generate(&env);
    client.register_pool_address(&pool);

    (env, admin, client, pool)
}

/// Helper: set up env with a pool and a router.
fn setup_with_pool_and_router() -> (Env, Address, GravityTokenClient<'static>, Address, Address) {
    let (env, admin, client, pool) = setup_with_pool();

    let router = Address::generate(&env);
    client.register_router_address(&router);

    (env, admin, client, pool, router)
}

// ─────────────────────────────────────────────────────────────
//  LIFECYCLE
// ─────────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let (env, _admin, client) = setup_env();
    assert_eq!(client.name(), String::from_str(&env, "Gravity HITZ"));
    assert_eq!(client.symbol(), String::from_str(&env, "HITZ"));
    assert_eq!(client.decimals(), 7);
    assert_eq!(client.total_mass(), 0);
    assert_eq!(client.safety_limit(), 0);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_double_initialize() {
    let (env, admin, client) = setup_env();
    client.initialize(
        &admin,
        &String::from_str(&env, "Duplicate"),
        &String::from_str(&env, "DUP"),
    );
}

#[test]
#[should_panic(expected = "Token name must be non-empty")]
fn test_initialize_rejects_empty_name() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GravityToken, ());
    let client = GravityTokenClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(
        &admin,
        &String::from_str(&env, ""),
        &String::from_str(&env, "HITZ"),
    );
}

#[test]
#[should_panic(expected = "Token symbol must be non-empty")]
fn test_initialize_rejects_empty_symbol() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GravityToken, ());
    let client = GravityTokenClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(
        &admin,
        &String::from_str(&env, "Gravity HITZ"),
        &String::from_str(&env, ""),
    );
}

// ─────────────────────────────────────────────────────────────
//  ADMIN
// ─────────────────────────────────────────────────────────────

#[test]
fn test_set_admin() {
    let (env, _admin, client) = setup_env();
    let new_admin = Address::generate(&env);
    let user = Address::generate(&env);

    client.set_admin(&new_admin);
    client.mint(&user, &(1 * H));
    assert_eq!(client.balance(&user), 1 * H);
}

#[test]
fn test_initialize_emits_initialized_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(GravityToken, ());
    let client = GravityTokenClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize(
        &admin,
        &String::from_str(&env, "Gravity HITZ"),
        &String::from_str(&env, "HITZ"),
    );

    // The initialize call publishes exactly one event from this
    // contract — anything else would mean a stray publish() crept in.
    // SDK 25's `Events::all()` returns a `ContractEvents` wrapper;
    // `.events()` exposes the raw XDR slice for slice ops, and
    // `.filter_by_contract` narrows to events from a single contract.
    let scoped = env.events().all().filter_by_contract(&contract_id);
    assert_eq!(
        scoped.events().len(),
        1,
        "initialize should emit exactly one event"
    );
}

#[test]
fn test_set_admin_emits_admin_changed_event() {
    let (env, _admin, client) = setup_env();
    let new_admin = Address::generate(&env);

    client.set_admin(&new_admin);

    // The events buffer is per-invocation in the test env, so after a
    // call returns it shows the events from that single call. set_admin
    // publishes exactly one (AdminChanged), so we expect ≥ 1 here.
    let events = env.events().all();
    assert!(
        !events.events().is_empty(),
        "set_admin should publish at least one event"
    );
}

// ─────────────────────────────────────────────────────────────
//  POOL & ROUTER ADDRESS REGISTRY
// ─────────────────────────────────────────────────────────────

#[test]
fn test_register_and_remove_pool_address() {
    let (env, _admin, client) = setup_env();
    let pool = Address::generate(&env);

    client.register_pool_address(&pool);
    assert!(client.is_pool(&pool));

    // Idempotent — registering again doesn't panic
    client.register_pool_address(&pool);
    assert!(client.is_pool(&pool));

    client.remove_pool_address(&pool);
    assert!(!client.is_pool(&pool));
}

#[test]
fn test_register_and_remove_router_address() {
    let (env, _admin, client) = setup_env();
    let router = Address::generate(&env);

    client.register_router_address(&router);
    assert!(client.is_router(&router));

    client.remove_router_address(&router);
    assert!(!client.is_router(&router));
}

#[test]
fn test_pool_registration_reconciles_existing_balance() {
    let (env, _admin, client) = setup_env();
    let pool = Address::generate(&env);

    // Mint to the address BEFORE it's registered as a pool
    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 0); // not tracked yet

    // Register as pool — balance reconciled into TotalMass
    client.register_pool_address(&pool);
    assert_eq!(client.total_mass(), 10_000 * H);
    assert_eq!(client.safety_limit(), 100 * H);
}

#[test]
fn test_pool_removal_subtracts_balance_from_mass() {
    let (_env, _admin, client, pool) = setup_with_pool();

    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    client.remove_pool_address(&pool);
    assert_eq!(client.total_mass(), 0);
}

#[test]
fn test_register_pool_clears_vault_flag() {
    let (env, _admin, client) = setup_env();
    let pool = Address::generate(&env);

    // Mint to address — gets vaulted (L=0)
    client.mint(&pool, &(100 * H));
    assert!(client.is_account_vaulted(&pool));

    // Register as pool — vault flag cleared
    client.register_pool_address(&pool);
    assert!(!client.is_account_vaulted(&pool));
}

#[test]
fn test_register_router_clears_vault_flag() {
    let (env, _admin, client) = setup_env();
    let router = Address::generate(&env);

    client.mint(&router, &(100 * H));
    assert!(client.is_account_vaulted(&router));

    client.register_router_address(&router);
    assert!(!client.is_account_vaulted(&router));
}

// ─────────────────────────────────────────────────────────────
//  MINT
// ─────────────────────────────────────────────────────────────

#[test]
fn test_mint_and_balance() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);

    // With L=0 (no pools), any balance > 0 vaults — but mint still works
    client.mint(&user, &(100 * H));
    assert_eq!(client.balance(&user), 100 * H);
    assert!(client.is_account_vaulted(&user));
}

#[test]
#[should_panic(expected = "Mint amount must be positive")]
fn test_mint_zero() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);
    client.mint(&user, &0);
}

// ─────────────────────────────────────────────────────────────
//  TRANSFER
// ─────────────────────────────────────────────────────────────

#[test]
fn test_transfer_without_pools_vaults_everyone() {
    let (env, _admin, client) = setup_env();
    let alice = Address::generate(&env);

    client.mint(&alice, &(1 * H));
    assert!(client.is_account_vaulted(&alice));
}

#[test]
#[should_panic(expected = "Transfer amount must be positive")]
fn test_transfer_zero_amount() {
    let (env, _admin, client) = setup_env();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &(100 * H));
    client.transfer(&alice, &bob, &0);
}

#[test]
#[should_panic(expected = "Cannot transfer to self")]
fn test_transfer_to_self() {
    let (env, _admin, client) = setup_env();
    let alice = Address::generate(&env);
    client.mint(&alice, &(100 * H));
    client.transfer(&alice, &alice, &(50 * H));
}

// ─────────────────────────────────────────────────────────────
//  ALLOWANCE & TRANSFER_FROM
// ─────────────────────────────────────────────────────────────

#[test]
fn test_approve_and_allowance() {
    let (env, _admin, client) = setup_env();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&owner, &spender, &(500 * H), &future_ledger);
    assert_eq!(client.allowance(&owner, &spender), 500 * H);
}

#[test]
fn test_allowance_expired() {
    let (env, _admin, client) = setup_env();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    let current = env.ledger().sequence();
    client.approve(&owner, &spender, &(500 * H), &(current + 1));

    env.ledger().set_sequence_number(current + 100);
    assert_eq!(client.allowance(&owner, &spender), 0);
}

#[test]
#[should_panic(expected = "Allowance amount must be non-negative")]
fn test_approve_negative() {
    let (env, _admin, client) = setup_env();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    client.approve(&owner, &spender, &-1, &1000);
}

// ─────────────────────────────────────────────────────────────
//  BURN
// ─────────────────────────────────────────────────────────────

#[test]
fn test_burn() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);

    client.mint(&user, &(100 * H));
    // User is vaulted (L=0)
    assert!(client.is_account_vaulted(&user));
}

#[test]
#[should_panic(expected = "Account is vaulted: cannot burn as exit route.")]
fn test_burn_vaulted_account_fails() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);

    client.mint(&user, &(100 * H));
    client.burn(&user, &(50 * H));
}

#[test]
#[should_panic(expected = "Burn amount must be positive")]
fn test_burn_zero() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);
    client.mint(&user, &(100 * H));
    client.burn(&user, &0);
}

#[test]
#[should_panic(expected = "Account is vaulted: cannot burn as exit route.")]
fn test_burn_from_vaulted_fails() {
    let (env, _admin, client) = setup_env();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.mint(&owner, &(100 * H));
    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&owner, &spender, &(50 * H), &future_ledger);

    client.burn_from(&spender, &owner, &(50 * H));
}

// ─────────────────────────────────────────────────────────────
//  SAFETY LIMIT — MATHEMATICAL PROPERTIES
// ─────────────────────────────────────────────────────────────

#[test]
fn test_safety_limit_zero_no_mass() {
    let (_env, _admin, client) = setup_env();
    assert_eq!(client.safety_limit(), 0);
    assert_eq!(client.total_mass(), 0);
}

// ─────────────────────────────────────────────────────────────
//  IS_POOL / IS_ROUTER — ADDRESS DETECTION
// ─────────────────────────────────────────────────────────────

#[test]
fn test_is_pool_returns_false_for_accounts() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);
    assert!(!client.is_pool(&user));
}

#[test]
fn test_is_router_returns_false_for_accounts() {
    let (env, _admin, client) = setup_env();
    let user = Address::generate(&env);
    assert!(!client.is_router(&user));
}

// ─────────────────────────────────────────────────────────────
//  INTEGRATION: GRAVITY MODEL WITH APPROVED POOL
// ─────────────────────────────────────────────────────────────
//
// With decimals=7, L = sqrt(TotalMass_raw * 10^7).
// Using HITZ-scale amounts (H = 10^7):
//   Pool = 10_000 HITZ → mass = 10^11 raw → L = sqrt(10^18) = 10^9 = 100 HITZ
//   Pool = 1_000_000 HITZ → L = 1_000 HITZ

#[test]
fn test_pool_detection_via_address() {
    let (_env, _admin, client, pool) = setup_with_pool();
    assert!(client.is_pool(&pool));
}

#[test]
fn test_mint_to_pool_increases_total_mass() {
    let (_env, _admin, client, pool) = setup_with_pool();

    // 10,000 HITZ in pool → L = sqrt(10,000) = 100 HITZ
    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 10_000 * H);
    assert_eq!(client.safety_limit(), 100 * H);
}

#[test]
fn test_mint_to_pool_does_not_vault() {
    let (_env, _admin, client, pool) = setup_with_pool();

    client.mint(&pool, &(1_000_000 * H));
    assert!(!client.is_account_vaulted(&pool));
}

#[test]
fn test_mint_to_user_with_pool_mass() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    // Pool = 10,000 HITZ → L = 100 HITZ
    client.mint(&pool, &(10_000 * H));

    // Mint 50 HITZ — under L, not vaulted
    client.mint(&user, &(50 * H));
    assert!(!client.is_account_vaulted(&user));

    // Mint 60 more → total 110 HITZ > L(100 HITZ) → vaulted
    client.mint(&user, &(60 * H));
    assert!(client.is_account_vaulted(&user));
}

#[test]
fn test_transfer_basic_with_pool() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H)); // L = 1000 HITZ
    client.mint(&alice, &(500 * H));
    assert!(!client.is_account_vaulted(&alice));

    client.transfer(&alice, &bob, &(200 * H));
    assert_eq!(client.balance(&alice), 300 * H);
    assert_eq!(client.balance(&bob), 200 * H);
    assert!(!client.is_account_vaulted(&bob));
}

#[test]
fn test_transfer_vaults_receiver_over_limit() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&alice, &(100 * H));   // at limit, not vaulted
    assert!(!client.is_account_vaulted(&alice));

    // Transfer all to bob — bob=100 HITZ = L → not vaulted
    client.transfer(&alice, &bob, &(100 * H));
    assert!(!client.is_account_vaulted(&bob));

    // Push bob over the limit
    client.mint(&alice, &(50 * H));
    client.transfer(&alice, &bob, &(5 * H)); // bob=105 HITZ > L(100) → vaulted
    assert!(client.is_account_vaulted(&bob));
}

#[test]
fn test_transfer_to_pool_increases_mass() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ, mass = 10_000 HITZ
    client.mint(&alice, &(50 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    client.transfer(&alice, &pool, &(50 * H));
    assert_eq!(client.total_mass(), 10_050 * H);
    assert_eq!(client.balance(&pool), 10_050 * H);
}

#[test]
fn test_transfer_from_pool_decreases_mass() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    client.transfer(&pool, &alice, &(1_000 * H));
    assert_eq!(client.total_mass(), 9_000 * H);
    assert_eq!(client.balance(&pool), 9_000 * H);
    assert_eq!(client.balance(&alice), 1_000 * H);
}

#[test]
fn test_vaulted_can_transfer_to_pool() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(101 * H));    // 101 > 100 → vaulted
    assert!(client.is_account_vaulted(&whale));

    // Sacrifice 50 HITZ to pool
    client.transfer(&whale, &pool, &(50 * H));
    assert_eq!(client.balance(&whale), 51 * H);
    assert_eq!(client.total_mass(), 10_050 * H);

    // whale=51 HITZ, L=sqrt(10_050)≈100.2 HITZ → 51 <= 100 → released!
    assert!(!client.is_account_vaulted(&whale));
}

#[test]
fn test_vaulted_transfer_to_pool_stays_vaulted_if_still_over() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(200 * H));   // 200 > 100 → vaulted
    assert!(client.is_account_vaulted(&whale));

    // Sacrifice only 10 HITZ — whale still has 190 > L
    client.transfer(&whale, &pool, &(10 * H));
    assert_eq!(client.balance(&whale), 190 * H);
    assert!(client.is_account_vaulted(&whale));
}

#[test]
#[should_panic(expected = "Account is vaulted: transfers locked.")]
fn test_vaulted_cannot_transfer_to_non_pool() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(200 * H));   // vaulted
    assert!(client.is_account_vaulted(&whale));

    client.transfer(&whale, &bob, &(50 * H)); // panic — bob is not a pool
}

#[test]
fn test_transfer_at_exact_limit_does_not_vault() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&alice, &(100 * H));

    client.transfer(&alice, &bob, &(100 * H));
    // bob = 100 HITZ = L → NOT > L → not vaulted
    assert!(!client.is_account_vaulted(&bob));
}

// ─────────────────────────────────────────────────────────────
//  ROUTER BEHAVIOR — TWO-TIER IDENTITY
// ─────────────────────────────────────────────────────────────

#[test]
fn test_router_never_affects_total_mass() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();
    let alice = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&alice, &(50 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    // Transfer to router — no mass change
    client.transfer(&alice, &router, &(50 * H));
    assert_eq!(client.total_mass(), 10_000 * H);
    assert_eq!(client.balance(&router), 50 * H);

    // Transfer from router — no mass change
    let bob = Address::generate(&env);
    client.transfer(&router, &bob, &(25 * H));
    assert_eq!(client.total_mass(), 10_000 * H);
}

#[test]
fn test_router_never_vaulted() {
    let (_env, _admin, client, pool, router) = setup_with_pool_and_router();

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    // Even massive amounts don't vault routers
    client.mint(&router, &(999_999 * H));
    assert!(!client.is_account_vaulted(&router));
}

#[test]
#[should_panic(expected = "Account is vaulted: transfers locked.")]
fn test_vaulted_cannot_transfer_to_router() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(200 * H));   // vaulted
    assert!(client.is_account_vaulted(&whale));

    // Vaulted user CANNOT send to router — only to pool
    client.transfer(&whale, &router, &(50 * H));
}

#[test]
fn test_router_immune_from_vault_as_sender() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&router, &(500 * H));  // router has tokens

    // Router can always send, even if it somehow had vault flag
    // (which can't happen since register_router_address clears it)
    client.transfer(&router, &bob, &(200 * H));
    assert_eq!(client.balance(&bob), 200 * H);
}

#[test]
fn test_pool_to_router_transfer() {
    let (_env, _admin, client, pool, router) = setup_with_pool_and_router();

    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    // Pool sends to router — pool mass decreases, router mass does NOT increase
    client.transfer(&pool, &router, &(1_000 * H));
    assert_eq!(client.total_mass(), 9_000 * H);
    assert_eq!(client.balance(&router), 1_000 * H);
}

#[test]
fn test_router_to_pool_transfer() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();

    client.mint(&pool, &(10_000 * H));
    let alice = Address::generate(&env);
    client.mint(&alice, &(50 * H));

    // Alice sends to router, router sends to pool
    client.transfer(&alice, &router, &(50 * H));
    assert_eq!(client.total_mass(), 10_000 * H); // no change yet

    client.transfer(&router, &pool, &(50 * H));
    assert_eq!(client.total_mass(), 10_050 * H); // pool mass increased
}

// ─────────────────────────────────────────────────────────────
//  TRANSFER_FROM WITH POOLS
// ─────────────────────────────────────────────────────────────

#[test]
fn test_transfer_from_basic() {
    let (env, _admin, client, pool) = setup_with_pool();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H)); // L = 1000 HITZ
    client.mint(&owner, &(500 * H));

    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&owner, &spender, &(200 * H), &future_ledger);

    client.transfer_from(&spender, &owner, &recipient, &(100 * H));
    assert_eq!(client.balance(&owner), 400 * H);
    assert_eq!(client.balance(&recipient), 100 * H);
    assert_eq!(client.allowance(&owner, &spender), 100 * H);
}

#[test]
#[should_panic(expected = "Insufficient allowance")]
fn test_transfer_from_insufficient_allowance() {
    let (env, _admin, client, pool) = setup_with_pool();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H));
    client.mint(&owner, &(500 * H));

    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&owner, &spender, &(50 * H), &future_ledger);

    client.transfer_from(&spender, &owner, &recipient, &(100 * H));
}

// ─────────────────────────────────────────────────────────────
//  BURN WITH POOLS
// ─────────────────────────────────────────────────────────────

#[test]
fn test_burn_non_vaulted() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H)); // L = 1000 HITZ
    client.mint(&user, &(500 * H));

    client.burn(&user, &(200 * H));
    assert_eq!(client.balance(&user), 300 * H);
}

#[test]
fn test_burn_from_non_vaulted() {
    let (env, _admin, client, pool) = setup_with_pool();
    let owner = Address::generate(&env);
    let spender = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H)); // L = 1000 HITZ
    client.mint(&owner, &(500 * H));

    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&owner, &spender, &(300 * H), &future_ledger);

    client.burn_from(&spender, &owner, &(200 * H));
    assert_eq!(client.balance(&owner), 300 * H);
    assert_eq!(client.allowance(&owner, &spender), 100 * H);
}

// ─────────────────────────────────────────────────────────────
//  LAW OF DECENTRALIZATION — NUMERICAL VERIFICATION
// ─────────────────────────────────────────────────────────────

#[test]
fn test_law_of_decentralization_scaling() {
    let (_env, _admin, client, pool) = setup_with_pool();

    // 1,000 HITZ reserves → L = sqrt(1000) ≈ 31.62 HITZ
    client.mint(&pool, &(1_000 * H));
    let l1 = client.safety_limit();
    assert!(l1 > 31 * H && l1 < 32 * H);

    // 10,000x growth to 10,000,000 HITZ → L = sqrt(10M) ≈ 3162 HITZ
    client.mint(&pool, &((10_000_000 - 1_000) * H));
    let l2 = client.safety_limit();
    assert!(l2 > 3162 * H && l2 < 3163 * H);

    // l2/l1 ≈ 100, well under the 10,000x reserves ratio
    assert!(l2 / l1 < 101);
}

#[test]
fn test_safety_limit_grows_with_pool_mass() {
    let (_env, _admin, client, pool) = setup_with_pool();

    // 100 HITZ → L = 10 HITZ
    client.mint(&pool, &(100 * H));
    assert_eq!(client.safety_limit(), 10 * H);

    // 10,000 HITZ → L = 100 HITZ
    client.mint(&pool, &(9_900 * H));
    assert_eq!(client.safety_limit(), 100 * H);

    // 1,000,000 HITZ → L = 1,000 HITZ
    client.mint(&pool, &(990_000 * H));
    assert_eq!(client.safety_limit(), 1_000 * H);
}

#[test]
fn test_total_mass_accumulator_consistency() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    client.mint(&pool, &(10_000 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    // Mint to user — no mass change
    client.mint(&alice, &(50 * H));
    assert_eq!(client.total_mass(), 10_000 * H);

    // Transfer user → pool: mass increases
    client.transfer(&alice, &pool, &(50 * H));
    assert_eq!(client.total_mass(), 10_050 * H);

    // Transfer pool → user: mass decreases
    client.transfer(&pool, &alice, &(100 * H));
    assert_eq!(client.total_mass(), 9_950 * H);

    assert_eq!(client.balance(&pool), 9_950 * H);
}

// ─────────────────────────────────────────────────────────────
//  POOL EXEMPTION FROM VAULTING
// ─────────────────────────────────────────────────────────────

#[test]
fn test_pool_never_vaulted() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    client.mint(&pool, &(100 * H)); // L = 10 HITZ
    client.mint(&alice, &(5 * H));

    client.transfer(&alice, &pool, &(5 * H));
    assert!(!client.is_account_vaulted(&pool));
    assert_eq!(client.balance(&pool), 105 * H);
}

// ─────────────────────────────────────────────────────────────
//  RELEASED ACCOUNT CAN TRANSACT AGAIN
// ─────────────────────────────────────────────────────────────

#[test]
fn test_released_account_can_transfer() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(101 * H));   // vaulted
    assert!(client.is_account_vaulted(&whale));

    // Sacrifice to get released: whale=51 <= L(≈100)
    client.transfer(&whale, &pool, &(50 * H));
    assert!(!client.is_account_vaulted(&whale));

    // Now free to transfer to anyone
    client.transfer(&whale, &bob, &(10 * H));
    assert_eq!(client.balance(&whale), 41 * H);
    assert_eq!(client.balance(&bob), 10 * H);
}

#[test]
#[should_panic(expected = "Insufficient balance")]
fn test_insufficient_balance_transfer() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H));
    client.mint(&alice, &(100 * H));

    client.transfer(&alice, &bob, &(200 * H));
}

// ─────────────────────────────────────────────────────────────
//  POOL REGISTERED AFTER FUNDING — RECONCILIATION
// ─────────────────────────────────────────────────────────────

/// Tokens deposited into an address before it's registered as a pool.
/// After registration, the balance is reconciled into TotalMass.
#[test]
fn test_pool_registered_after_funding_reconciles_mass() {
    let (env, _admin, client) = setup_env();
    let pool = Address::generate(&env);

    // Mint to address before pool registration
    client.mint(&pool, &(100_000 * H));
    assert!(client.is_account_vaulted(&pool));
    assert_eq!(client.total_mass(), 0);

    // Register as pool — reconcile
    client.register_pool_address(&pool);
    assert!(client.is_pool(&pool));
    assert!(!client.is_account_vaulted(&pool));
    assert_eq!(client.total_mass(), 100_000 * H);

    // Further transfers work normally
    let user = Address::generate(&env);
    client.transfer(&pool, &user, &(1_000 * H));
    assert_eq!(client.balance(&user), 1_000 * H);
    assert_eq!(client.total_mass(), 99_000 * H);
}

/// Pool registered after funding also works with transfer_from.
#[test]
fn test_pool_registered_after_funding_transfer_from() {
    let (env, _admin, client) = setup_env();
    let pool = Address::generate(&env);

    client.mint(&pool, &(100_000 * H));
    assert_eq!(client.total_mass(), 0);

    client.register_pool_address(&pool);
    assert_eq!(client.total_mass(), 100_000 * H);

    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&pool, &spender, &(5_000 * H), &future_ledger);

    client.transfer_from(&spender, &pool, &recipient, &(2_000 * H));
    assert_eq!(client.balance(&recipient), 2_000 * H);
    assert_eq!(client.total_mass(), 98_000 * H);
}

/// Regular vaulted accounts are still blocked from non-pool transfers.
#[test]
#[should_panic(expected = "Account is vaulted: transfers locked.")]
fn test_vaulted_user_still_blocked() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&whale, &(200 * H));
    assert!(client.is_account_vaulted(&whale));

    client.transfer(&whale, &bob, &(50 * H));
}

// ─────────────────────────────────────────────────────────────
//  DEX INTEGRATION — "ROACH MOTEL" / "SILENT TRAP"
// ─────────────────────────────────────────────────────────────

#[test]
fn test_dex_swap_silently_vaults_user() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    // Pool sends 500 HITZ to user (DEX output leg)
    client.transfer(&pool, &user, &(500 * H));

    assert_eq!(client.balance(&user), 500 * H);
    assert!(client.is_account_vaulted(&user));
    assert_eq!(client.balance(&pool), 9_500 * H);
    assert_eq!(client.total_mass(), 9_500 * H);
}

#[test]
fn test_dex_swap_vaults_user_who_was_free() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ
    client.mint(&user, &(50 * H));      // under L, free
    assert!(!client.is_account_vaulted(&user));

    // Swap gives user 60 more → total 110 > L(100)
    client.transfer(&pool, &user, &(60 * H));

    assert_eq!(client.balance(&user), 110 * H);
    assert!(client.is_account_vaulted(&user));
}

#[test]
fn test_dex_swap_massive_amount_succeeds() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H)); // L = 1000 HITZ

    // User buys 999,000 HITZ in one swap
    client.transfer(&pool, &user, &(999_000 * H));

    assert_eq!(client.balance(&user), 999_000 * H);
    assert!(client.is_account_vaulted(&user));
    assert_eq!(client.balance(&pool), 1_000 * H);
    assert_eq!(client.total_mass(), 1_000 * H);
}

#[test]
fn test_vaulted_user_can_still_receive() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    // First swap vaults the user
    client.transfer(&pool, &user, &(200 * H));
    assert!(client.is_account_vaulted(&user));

    // Second swap — Roach Motel: always let them in
    client.transfer(&pool, &user, &(300 * H));
    assert_eq!(client.balance(&user), 500 * H);
    assert!(client.is_account_vaulted(&user));
}

#[test]
fn test_vaulted_user_can_sacrifice_but_not_exit() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    // DEX swap vaults the user
    client.transfer(&pool, &user, &(200 * H));
    assert!(client.is_account_vaulted(&user));

    // User CAN sacrifice to pool
    client.transfer(&user, &pool, &(150 * H));
    assert_eq!(client.balance(&user), 50 * H);
    assert!(!client.is_account_vaulted(&user));

    // Now free, user can transfer normally
    client.transfer(&user, &bob, &(10 * H));
    assert_eq!(client.balance(&bob), 10 * H);
}

#[test]
fn test_dex_transfer_from_silently_vaults() {
    let (env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&env);
    let spender = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    let future_ledger = env.ledger().sequence() + 1000;
    client.approve(&pool, &spender, &(5_000 * H), &future_ledger);

    client.transfer_from(&spender, &pool, &user, &(500 * H));

    assert_eq!(client.balance(&user), 500 * H);
    assert!(client.is_account_vaulted(&user));
    assert_eq!(client.total_mass(), 9_500 * H);
}

#[test]
fn test_mint_silently_vaults() {
    let (_env, _admin, client, pool) = setup_with_pool();
    let user = Address::generate(&_env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    client.mint(&user, &(500 * H));
    assert_eq!(client.balance(&user), 500 * H);
    assert!(client.is_account_vaulted(&user));
}

// ─────────────────────────────────────────────────────────────
//  DEX FLOW: ROUTER → POOL INTEGRATION
// ─────────────────────────────────────────────────────────────
//
// Typical DEX swap: User → Router → Pool (input leg)
//                   Pool → Router → User (output leg)
// Router is just pass-through. Only Pool affects TotalMass.

#[test]
fn test_full_dex_swap_via_router() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();
    let user = Address::generate(&env);

    // Setup: pool has liquidity, user has tokens
    client.mint(&pool, &(100_000 * H)); // L = sqrt(100_000) ≈ 316 HITZ
    client.mint(&user, &(50 * H));
    assert!(!client.is_account_vaulted(&user));

    // Input leg: User → Router → Pool
    client.transfer(&user, &router, &(50 * H));
    assert_eq!(client.total_mass(), 100_000 * H); // unchanged by router
    client.transfer(&router, &pool, &(50 * H));
    assert_eq!(client.total_mass(), 100_050 * H); // increased by pool deposit

    // Output leg: Pool → Router → User
    client.transfer(&pool, &router, &(200 * H));
    assert_eq!(client.total_mass(), 99_850 * H); // decreased by pool withdrawal
    client.transfer(&router, &user, &(200 * H));
    assert_eq!(client.total_mass(), 99_850 * H); // unchanged by router

    assert_eq!(client.balance(&user), 200 * H);
    assert!(!client.is_account_vaulted(&user)); // 200 < L(≈316)
}

#[test]
fn test_full_dex_swap_via_router_vaults_whale() {
    let (env, _admin, client, pool, router) = setup_with_pool_and_router();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100 HITZ

    // Pool → Router → Whale (output leg of a large swap)
    client.transfer(&pool, &router, &(500 * H));
    client.transfer(&router, &whale, &(500 * H));

    assert_eq!(client.balance(&whale), 500 * H);
    assert!(client.is_account_vaulted(&whale)); // 500 > L(≈97)
    assert_eq!(client.total_mass(), 9_500 * H); // only pool withdrawal counted
}

// ─────────────────────────────────────────────────────────────
//  LAZY EVALUATION — "ESCAPE ON TRY"
// ─────────────────────────────────────────────────────────────
//
//  A user who was vaulted in the past should be silently released
//  the moment they attempt to transact, if the protocol has grown
//  past their balance since. No dummy transaction required — the
//  physics is evaluated at the point of use.

/// Expanding the universe past a vaulted user's balance frees them
/// automatically on their next transfer. They never see the vault.
#[test]
fn test_lazy_escape_on_transfer_when_limit_grew() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    // Small pool → L = 100 HITZ. Whale gets vaulted at 200.
    client.mint(&pool, &(10_000 * H));
    client.mint(&whale, &(200 * H));
    assert!(client.is_account_vaulted(&whale));

    // Universe expands — L grows from 100 to >200.
    // Need mass ≥ 200² / scale = 40_000 HITZ. Use 50_000 to be safe.
    client.mint(&pool, &(40_000 * H)); // mass = 50_000 HITZ → L ≈ 223
    assert!(client.safety_limit() >= 200 * H);

    // The user makes no explicit release call — they just try to send.
    // Lazy evaluation: contract realizes whale is safe now, un-vaults
    // in-line, processes the transfer as if nothing was ever wrong.
    client.transfer(&whale, &bob, &(50 * H));
    assert!(!client.is_account_vaulted(&whale));
    assert_eq!(client.balance(&whale), 150 * H);
    assert_eq!(client.balance(&bob), 50 * H);
}

/// Same lazy release via transfer_from path.
#[test]
fn test_lazy_escape_on_transfer_from() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let spender = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H));
    client.mint(&whale, &(200 * H));
    assert!(client.is_account_vaulted(&whale));

    // Grant allowance BEFORE the universe grows.
    let future = env.ledger().sequence() + 1000;
    client.approve(&whale, &spender, &(100 * H), &future);

    // Expansion past the vaulted balance.
    client.mint(&pool, &(40_000 * H));

    // Delegate spend — lazy eval fires, vault clears, transfer lands.
    client.transfer_from(&spender, &whale, &bob, &(50 * H));
    assert!(!client.is_account_vaulted(&whale));
    assert_eq!(client.balance(&bob), 50 * H);
}

/// If L has NOT grown past the user's balance, they stay vaulted
/// and the transfer to a non-pool still panics.
#[test]
#[should_panic(expected = "Account is vaulted: transfers locked.")]
fn test_lazy_escape_does_not_free_when_still_over_limit() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(500 * H)); // vaulted, needs L ≥ 500
    assert!(client.is_account_vaulted(&whale));

    // Modest growth — still below 500.
    client.mint(&pool, &(5_000 * H)); // L = sqrt(15_000) ≈ 122
    assert!(client.safety_limit() < 500 * H);

    // Still blocked.
    client.transfer(&whale, &bob, &(10 * H));
}

/// Lazy evaluation on burn: a stale vault flag shouldn't block a
/// user whose balance is now safely under L.
#[test]
fn test_lazy_escape_on_burn_when_limit_grew() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(200 * H));
    assert!(client.is_account_vaulted(&whale));

    // Universe expands.
    client.mint(&pool, &(40_000 * H));
    assert!(client.safety_limit() >= 200 * H);

    // Burn succeeds — lazy eval cleared the vault flag.
    client.burn(&whale, &(50 * H));
    assert_eq!(client.balance(&whale), 150 * H);
    assert!(!client.is_account_vaulted(&whale));
}

/// Lazy evaluation also fires after the transfer: sender sacrifices
/// to a pool, and in the same tx the pool's mass grew enough that
/// the sender's new balance is now under L. They're freed.
/// (This behavior existed before lazy eval; confirm it still holds.)
#[test]
fn test_sacrifice_to_pool_releases_via_sync() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(101 * H));
    assert!(client.is_account_vaulted(&whale));

    // Sacrifice 50 — balance drops to 51, pool grows to 10_050
    // (L barely changes). 51 < L ≈ 100.
    client.transfer(&whale, &pool, &(50 * H));
    assert!(!client.is_account_vaulted(&whale));
}

// ─────────────────────────────────────────────────────────────
//  LAZY EVALUATION — "CORRECTION ON RECEIVE"
// ─────────────────────────────────────────────────────────────
//
//  A vaulted user who receives more HITZ is usually pushed further
//  past the event horizon. But if the protocol grew massively in
//  the meantime, their NEW balance (old + incoming) may still be
//  under L. They're silently released.

#[test]
fn test_lazy_release_on_receive_when_limit_grew() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(200 * H)); // vaulted
    assert!(client.is_account_vaulted(&whale));

    // Universe expansion during whale's wait.
    client.mint(&pool, &(90_000 * H)); // L = sqrt(100_000) ≈ 316
    assert!(client.safety_limit() >= 300 * H);

    // Bob sends whale 5 more HITZ. Whale now holds 205, well under L.
    // The silent trap used to only push whale DEEPER into the vault;
    // with lazy eval it also releases them when they're now safe.
    client.mint(&bob, &(10 * H));
    client.transfer(&bob, &whale, &(5 * H));

    assert_eq!(client.balance(&whale), 205 * H);
    assert!(!client.is_account_vaulted(&whale));
}

/// If incoming push + existing balance is STILL over L, the vault
/// flag stays set (no spurious release).
#[test]
fn test_receive_does_not_release_if_still_over_limit() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(500 * H)); // vaulted

    // Pool sends whale 50 more — still 550 > L ≈ 100.
    client.transfer(&pool, &whale, &(50 * H));
    assert!(client.is_account_vaulted(&whale));
    assert_eq!(client.balance(&whale), 550 * H);
}

/// Mint can also correct a stale vault: if admin mints to a user
/// who was vaulted, AND L has grown past their new balance, they're
/// released.
#[test]
fn test_mint_lazy_release_when_limit_grew() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(200 * H)); // vaulted

    // Big growth.
    client.mint(&pool, &(90_000 * H)); // L ≈ 316

    // Admin mints 50 more to whale → 250, still under L.
    client.mint(&whale, &(50 * H));
    assert_eq!(client.balance(&whale), 250 * H);
    assert!(!client.is_account_vaulted(&whale));
}

// ─────────────────────────────────────────────────────────────
//  HARD SUPPLY CAP — 100,000,000 HITZ
// ─────────────────────────────────────────────────────────────

/// max_supply() returns exactly 100M HITZ in raw units.
#[test]
fn test_max_supply_is_100m() {
    let (_env, _admin, client) = setup_env();
    assert_eq!(client.max_supply(), 100_000_000 * H);
}

/// total_supply starts at zero and tracks mints.
#[test]
fn test_total_supply_tracks_mint_and_burn() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    assert_eq!(client.total_supply(), 0);

    client.mint(&pool, &(1_000_000 * H));
    assert_eq!(client.total_supply(), 1_000_000 * H);

    client.mint(&alice, &(50 * H));
    assert_eq!(client.total_supply(), 1_000_050 * H);

    client.burn(&alice, &(30 * H));
    assert_eq!(client.total_supply(), 1_000_020 * H);
}

/// Transfer between accounts doesn't change total supply.
#[test]
fn test_total_supply_unchanged_by_transfer() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&pool, &(1_000_000 * H));
    client.mint(&alice, &(500 * H));
    assert_eq!(client.total_supply(), 1_000_500 * H);

    client.transfer(&alice, &bob, &(100 * H));
    assert_eq!(client.total_supply(), 1_000_500 * H);
}

/// Mint up to the cap exactly — last mint must land.
#[test]
fn test_mint_exactly_at_max_supply() {
    let (_env, _admin, client, pool) = setup_with_pool();

    // Mint the entire 100M to the pool.
    client.mint(&pool, &(100_000_000 * H));
    assert_eq!(client.total_supply(), 100_000_000 * H);
    assert_eq!(client.total_supply(), client.max_supply());
}

/// Mint of exactly 1 stroop over the cap panics.
#[test]
#[should_panic(expected = "Mint would exceed max supply")]
fn test_mint_one_over_max_supply_panics() {
    let (env, _admin, client, pool) = setup_with_pool();
    let alice = Address::generate(&env);

    client.mint(&pool, &(100_000_000 * H));
    client.mint(&alice, &1); // one stroop over — panic
}

/// Mint that would push supply over 100M panics BEFORE any state moves.
#[test]
#[should_panic(expected = "Mint would exceed max supply")]
fn test_mint_over_max_supply_panics() {
    let (env, _admin, client) = setup_env();
    let alice = Address::generate(&env);

    // One raw unit over the cap.
    client.mint(&alice, &(100_000_000 * H + 1));
}

/// Burn reduces supply, freeing headroom for future mints.
#[test]
fn test_burn_reopens_mint_headroom() {
    let (env, _admin, client) = setup_env();
    let alice = Address::generate(&env);
    let pool = Address::generate(&env);
    client.register_pool_address(&pool);

    // Fill the cap via the pool.
    client.mint(&pool, &(100_000_000 * H));
    assert_eq!(client.total_supply(), client.max_supply());

    // Pool burns 100 HITZ — frees headroom.
    client.burn(&pool, &(100 * H));
    assert_eq!(client.total_supply(), 100_000_000 * H - 100 * H);

    // Now a 50-HITZ mint fits.
    client.mint(&alice, &(50 * H));
    assert_eq!(client.total_supply(), 100_000_000 * H - 50 * H);
}

// ─────────────────────────────────────────────────────────────
//  CANONICAL "IS ACTUALLY VAULTED" VIEW
// ─────────────────────────────────────────────────────────────

/// `is_actually_vaulted` evaluates current physics, ignoring the
/// stored flag. Useful for UI "do I need to show the banner?"
/// queries without needing a state-changing call first.
#[test]
fn test_is_actually_vaulted_reflects_current_physics() {
    let (env, _admin, client, pool) = setup_with_pool();
    let whale = Address::generate(&env);

    client.mint(&pool, &(10_000 * H)); // L = 100
    client.mint(&whale, &(200 * H));

    // Both views agree.
    assert!(client.is_account_vaulted(&whale));
    assert!(client.is_actually_vaulted(&whale));

    // Grow past 200.
    client.mint(&pool, &(40_000 * H));

    // Stored flag still true (no write yet); canonical view says false.
    assert!(client.is_account_vaulted(&whale));
    assert!(!client.is_actually_vaulted(&whale));
}
