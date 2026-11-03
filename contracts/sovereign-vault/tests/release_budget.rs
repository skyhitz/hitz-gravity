//! The release Wasm with every asset the vault can list (MAX_ASSETS): a swap
//! must fit the network's per-transaction limits with room to spare.
//!
//! A hop reads every pool to find its asset's worst pair, so the cost grows
//! with the number of listed assets. This measures the worst case: all pools
//! seeded and dislocated, and an elapsed time that makes every deviation's
//! decay take the longest path.
//!
//! Needs the release Wasm builds, so it only runs with the feature:
//!
//! ```text
//! cargo build --target wasm32v1-none --release -p gravity-token -p sovereign-vault
//! cargo test -p sovereign-vault --features migration-rehearsal --test release_budget -- --nocapture
//! ```
#![cfg(feature = "migration-rehearsal")]

use gravity_token::GravityTokenClient;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String, Vec,
};
use sovereign_vault::{SovereignVaultClient, MAX_ASSETS};

const VAULT: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/sovereign_vault.wasm"
));
const TOKEN: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32v1-none/release/gravity_token.wasm"
));

const U: i128 = 10_000_000;

/// The per-transaction limits this test holds a swap to. Instructions use
/// the long-standing 100M limit, below what mainnet allows today, so the
/// check stays meaningful if the network limit moves back down.
const MAX_INSTRUCTIONS: i64 = 100_000_000;
const MAX_MEM_BYTES: i64 = 40 * 1024 * 1024;

#[test]
fn a_swap_with_every_asset_listed_fits_the_network_limits() {
    let (two, _) = measure(2);
    let (instructions, mem_bytes) = measure(MAX_ASSETS);
    assert!(
        instructions < MAX_INSTRUCTIONS / 2,
        "{instructions} instructions"
    );
    assert!(mem_bytes < MAX_MEM_BYTES / 2, "{mem_bytes} bytes");
    // Each extra pool adds a small, fixed amount: no blow-up with size.
    assert!(instructions < 4 * two);
}

/// The worst-case asset-to-asset swap in a vault with `n` listed assets:
/// (instructions, memory bytes).
fn measure(n: u32) -> (i64, i64) {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_800_000_000;
        l.sequence_number = 70_000_000;
    });

    let admin = Address::generate(&env);
    let hitz_id = env.register(TOKEN, ());
    let hitz = GravityTokenClient::new(&env, &hitz_id);
    hitz.initialize(
        &admin,
        &String::from_str(&env, "Gravity HITZ"),
        &String::from_str(&env, "HITZ"),
    );
    let mut assets: Vec<Address> = Vec::new(&env);
    for _ in 0..n {
        assets.push_back(
            env.register_stellar_asset_contract_v2(admin.clone())
                .address(),
        );
    }
    let vault_id = env.register(VAULT, (admin.clone(), hitz_id.clone(), assets.clone()));
    let vault = SovereignVaultClient::new(&env, &vault_id);
    hitz.register_pool_address(&vault_id);

    // Every pool seeded, then dislocated by a trade at its own time.
    let trader = Address::generate(&env);
    hitz.mint(&trader, &(1_000_000 * U));
    for (i, asset) in assets.iter().enumerate() {
        hitz.mint(&admin, &(1_000_000 * U));
        StellarAssetClient::new(&env, &asset).mint(&admin, &(100_000 * U));
        vault.seed(&asset, &(1_000_000 * U), &(100_000 * U));
        env.ledger().with_mut(|l| l.timestamp += 60);
        vault.swap(
            &trader,
            &trader,
            &hitz_id,
            &asset,
            &((i as i128 + 1) * 1_000 * U),
            &0,
        );
    }
    for p in vault.pools().iter() {
        assert_ne!(p.deviation, 0);
    }

    // 2^17 - 1 seconds: the longest decay before a deviation rounds to zero.
    env.ledger().with_mut(|l| l.timestamp += 131_071);
    let first = assets.get(0).unwrap();
    let last = assets.get(n - 1).unwrap();
    StellarAssetClient::new(&env, &first).mint(&trader, &(1_000 * U));

    let out = vault.swap(&trader, &trader, &first, &last, &(1_000 * U), &0);
    assert!(out > 0);
    let r = env.cost_estimate().resources();
    let f = env.cost_estimate().fee();
    // The mocked signature leaves a long-lived nonce (temporary rent) that a
    // real signer's short expiry or source-account auth doesn't.
    std::println!(
        "asset-to-asset swap, {n} pools: {} instructions, {} memory bytes, \
         {} entries read, {} written ({} bytes), {} event bytes; \
         resource fee ~{} stroops without the test signature's nonce",
        r.instructions,
        r.mem_bytes,
        r.memory_read_entries + r.disk_read_entries,
        r.write_entries,
        r.write_bytes,
        r.contract_events_size_bytes,
        f.total - f.temporary_entry_rent,
    );
    (r.instructions, r.mem_bytes)
}
