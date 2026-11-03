//! Rehearsal of the mainnet migration, starting from the token bytecode
//! that is live on mainnet today and the registry it holds.
//!
//! Needs the token's release Wasm, so it only runs with the feature:
//!
//! ```text
//! cargo build --target wasm32v1-none --release -p gravity-token
//! cargo test -p sovereign-vault --features migration-rehearsal --test mainnet_migration
//! ```
//!
//! The steps, in order (see contracts/sovereign-vault/MIGRATION.md):
//!   A. old code: remove both Aquarius pools from the registry
//!   B. withdraw the Aquarius liquidity into the admin wallet
//!   C. one-step `upgrade` to the new token code
//!   D. deploy + register the vault, seed it at the market cross-rate
//!   E. prune the registry to the vault and renounce
//!   later: freeze the vault's code and list a third trusted asset
#![cfg(feature = "migration-rehearsal")]

use gravity_token::GravityTokenClient;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec,
    xdr::{ContractEventBody, ScVal},
    Address, BytesN, Env, String,
};
use sovereign_vault::{SovereignVault, SovereignVaultClient, ONE, UPGRADE_DELAY_SECS};

const MAINNET_TOKEN: &[u8] =
    include_bytes!("../../gravity-token/test_fixtures/gravity_token_mainnet_v1.0.0.wasm");
const NEW_TOKEN: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/gravity_token.wasm"
));
const POOL_V1: &[u8] = include_bytes!("../../gravity-token/test_fixtures/pool_v1.wasm");
const POOL_V2: &[u8] = include_bytes!("../../gravity-token/test_fixtures/pool_v2.wasm");

const H: i128 = 10_000_000;

// Balances as on mainnet (Nov 1, 2026), rounded to whole HITZ.
const ADMIN_WALLET: i128 = 9_963_900 * H;
const AQUA_USDC_POOL: i128 = 30_776_176 * H;
const AQUA_XLM_POOL: i128 = 57_748_996 * H;
const SPONSOR: i128 = 32_965 * H;
// Aquarius keeps its protocol fees inside the pool contracts; they are not
// the LP's to withdraw (~49k and ~51k HITZ on mainnet).
const AQUA_PROTOCOL_FEES: i128 = 50_000 * H;

#[test]
fn mainnet_migration_keeps_s_and_l_and_ends_with_a_final_registry() {
    // No snapshot: it would embed the release Wasm, which differs per toolchain.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_793_500_000;
        l.sequence_number = 65_300_000;
    });

    // ── Mainnet today ────────────────────────────────────────────
    let admin = Address::generate(&env);
    let token_id = env.register(MAINNET_TOKEN, ());
    let hitz = GravityTokenClient::new(&env, &token_id);
    hitz.initialize(
        &admin,
        &String::from_str(&env, "HITZ"),
        &String::from_str(&env, "HITZ"),
    );
    let v2: BytesN<32> = env.deployer().upload_contract_wasm(POOL_V2);
    let aqua_usdc = env.register(POOL_V1, ());
    let aqua_xlm = env.register(POOL_V1, ());
    let aqua_router = env.register(POOL_V1, ());
    let sponsor = Address::generate(&env);
    hitz.register_pool_address(&admin);
    hitz.register_pool_address(&aqua_usdc);
    hitz.register_pool_address(&aqua_xlm);
    hitz.register_router_address(&sponsor);
    hitz.register_router_address(&aqua_router);
    hitz.mint(&admin, &ADMIN_WALLET);
    hitz.mint(&aqua_usdc, &AQUA_USDC_POOL);
    hitz.mint(&aqua_xlm, &AQUA_XLM_POOL);
    hitz.mint(&sponsor, &SPONSOR);
    let holder = Address::generate(&env);
    hitz.mint(&holder, &(5_000 * H));
    let rest = 100_000_000 * H - hitz.total_supply();
    let others = Address::generate(&env);
    hitz.mint(&others, &rest);
    let s0 = hitz.total_mass();
    let l0 = hitz.safety_limit();
    assert_eq!(s0, ADMIN_WALLET + AQUA_USDC_POOL + AQUA_XLM_POOL);

    // Oct 2: Aquarius upgrades its pools and router; the old code halts.
    for c in [&aqua_usdc, &aqua_xlm, &aqua_router] {
        env.as_contract(c, || {
            env.deployer().update_current_contract_wasm(v2.clone())
        });
    }
    assert!(hitz.try_transfer(&holder, &aqua_xlm, &H).is_err());

    // ── A. Remove the Aquarius pools (old code) ──────────────────
    hitz.remove_pool_address(&aqua_usdc);
    hitz.remove_pool_address(&aqua_xlm);
    assert_eq!(hitz.total_mass(), ADMIN_WALLET);
    // The pools hold far more than L, so they can no longer pay HITZ out
    // to traders: the stale 27% gap between them can't be arbitraged.
    let arb = Address::generate(&env);
    assert!(hitz.try_transfer(&aqua_xlm, &arb, &(1_000 * H)).is_err());

    // ── B. Withdraw the liquidity into the admin wallet ──────────
    // A vaulted account can always send to a registered pool, so the
    // pools' HITZ moves to the admin wallet, and S comes back with it.
    let lp_usdc = AQUA_USDC_POOL - AQUA_PROTOCOL_FEES;
    let lp_xlm = AQUA_XLM_POOL - AQUA_PROTOCOL_FEES;
    hitz.transfer(&aqua_usdc, &admin, &lp_usdc);
    hitz.transfer(&aqua_xlm, &admin, &lp_xlm);
    // The live code names the event `transfer_event` (the pool is also
    // vaulted on this, its first transfer since step A).
    assert_eq!(
        event_names(&env, &token_id),
        ["vaulted_event", "transfer_event"]
    );
    let wallet = ADMIN_WALLET + lp_usdc + lp_xlm;
    assert_eq!(hitz.balance(&admin), wallet);
    assert_eq!(hitz.total_mass(), wallet);

    // ── C. One-step upgrade to the new token ─────────────────────
    let new_hash = env.deployer().upload_contract_wasm(NEW_TOKEN);
    hitz.upgrade(&new_hash);
    assert_eq!(hitz.total_mass(), wallet);
    assert_eq!(hitz.total_supply(), 100_000_000 * H);
    assert_eq!(hitz.admin(), Some(admin.clone()));
    // Every later upgrade waits 7 days.
    assert!(hitz.try_upgrade(&new_hash).is_err());
    // From here on the token's SEP-41 events carry the standard names.
    hitz.transfer(&holder, &Address::generate(&env), &H);
    assert_eq!(event_names(&env, &token_id), ["transfer"]);

    // ── D. Deploy, register and seed the vault ───────────────────
    let xlm = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let usdc = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(
        SovereignVault,
        (
            admin.clone(),
            token_id.clone(),
            vec![&env, xlm.clone(), usdc.clone()],
        ),
    );
    let vault = SovereignVaultClient::new(&env, &vault_id);
    hitz.register_pool_address(&vault_id);

    // Split the HITZ like the Aquarius pools, and price USDC so the
    // vault's cross-rate equals the market (XLM = 0.1678 USDC).
    let backing_xlm: i128 = 10_859 * H;
    let hitz_usdc = wallet * 35 / 100;
    let hitz_xlm = wallet - hitz_usdc;
    let market = 167_800_000; // 0.1678 USDC per XLM, 9 decimals
    let usdc_amt = backing_xlm * market / ONE * hitz_usdc / hitz_xlm;
    StellarAssetClient::new(&env, &xlm).mint(&admin, &backing_xlm);
    StellarAssetClient::new(&env, &usdc).mint(&admin, &usdc_amt);
    vault.seed(&xlm, &hitz_xlm, &backing_xlm);
    vault.seed(&usdc, &hitz_usdc, &usdc_amt);
    let rate = vault.rate(&xlm, &usdc);
    assert!((rate - market).abs() * 1_000 < market, "seeded off market");
    assert_eq!(vault.dislocation(&xlm, &usdc), 0);
    assert_eq!(hitz.total_mass(), wallet);

    // ── E. Final registry, then renounce ─────────────────────────
    // Refused while the bootstrap wallet, the sponsor or a drifted
    // router is still registered.
    assert!(hitz.try_renounce_admin().is_err());
    hitz.remove_pool_address(&admin);
    hitz.remove_router_address(&sponsor);
    assert!(hitz.try_renounce_admin().is_err());
    hitz.remove_router_address(&aqua_router);
    hitz.renounce_admin();
    assert_eq!(hitz.admin(), None);
    assert_eq!(hitz.list_pools().len(), 1);
    assert_eq!(hitz.list_routers().len(), 0);

    // S is now exactly the vault's HITZ; L moved only by the Aquarius
    // protocol fees left behind (~0.1%).
    assert_eq!(hitz.total_mass(), hitz.balance(&vault_id));
    let l1 = hitz.safety_limit();
    assert!((l0 - l1) * 1_000 < l0, "L moved too much: {l0} -> {l1}");

    // The vault trades on the renounced token.
    let trader = Address::generate(&env);
    StellarAssetClient::new(&env, &xlm).mint(&trader, &(10 * H));
    let out = vault.swap(&trader, &trader, &xlm, &token_id, &(10 * H), &0);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&trader), out);
    let out = vault.swap(&trader, &trader, &token_id, &usdc, &out, &0);
    assert!(out > 0);

    // ── Later: freeze the vault's code, then list a third asset ──
    vault.renounce_upgrades();
    assert!(!vault.upgradable());
    let eurc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    vault.propose_listing(&eurc);
    env.ledger().with_mut(|l| l.timestamp += UPGRADE_DELAY_SECS);
    vault.list_asset(&eurc);
    // The admin wallet is an ordinary account now: it buys HITZ from the
    // vault, is vaulted for holding more than L, and can still seed.
    StellarAssetClient::new(&env, &usdc).mint(&admin, &(20 * H));
    let seed_hitz = vault.swap(&admin, &admin, &usdc, &token_id, &(20 * H), &0);
    assert!(hitz.is_account_vaulted(&admin));
    let u = vault.pool(&usdc);
    let eur = 1_160_000_000; // 1.16 USDC per EURC, 9 decimals
    let seed_eurc = seed_hitz * u.reserve / u.hitz * ONE / eur;
    StellarAssetClient::new(&env, &eurc).mint(&admin, &seed_eurc);
    vault.seed(&eurc, &seed_hitz, &seed_eurc);
    let rate = vault.rate(&eurc, &usdc);
    assert!((rate - eur).abs() * 1_000 < eur, "EURC seeded off market");
    assert_eq!(hitz.total_mass(), hitz.balance(&vault_id));

    StellarAssetClient::new(&env, &eurc).mint(&trader, &(10 * H));
    assert!(vault.swap(&trader, &trader, &eurc, &xlm, &(10 * H), &0) > 0);
    vault.renounce();
    assert_eq!(vault.admin(), None);
}

/// Names of the events `contract` emitted in the last invocation.
fn event_names(env: &Env, contract: &Address) -> std::vec::Vec<std::string::String> {
    let all = env.events().all();
    let scoped = all.filter_by_contract(contract);
    scoped
        .events()
        .iter()
        .map(|e| {
            let ContractEventBody::V0(body) = &e.body;
            match &body.topics[0] {
                ScVal::Symbol(s) => s.0.to_utf8_string_lossy(),
                other => panic!("event name is not a symbol: {other:?}"),
            }
        })
        .collect()
}
