#![no_std]
//! # HITZ Sovereign Vault
//!
//! HITZ's own exchange. Every trusted asset has one constant-product pool
//! against HITZ, and all pools share HITZ, so any two listed assets trade
//! through HITZ inside the vault. It starts with XLM and USDC; more trusted
//! assets are listed later through a 7-day timelock, without new code, up to
//! MAX_ASSETS. HITZ is backed by every listed asset and compounds with their
//! volatility.
//!
//! ## Dislocation fee
//! Each pool prices HITZ in its asset. Two pools together give the vault's
//! exchange rate between their assets. Every pool keeps an exponential
//! average of its own price in log space (2-hour time constant), and stores
//! how far its log price sits from that average: its *deviation*. Because
//! the averages are logarithmic, the averages of two pools give exactly the
//! average of their exchange rate, consistently for every pair, so a pair's
//! *dislocation* is the difference of the two deviations. A move in HITZ
//! itself shifts every pool alike and dislocates nothing.
//!
//! A hop through the pool of asset A pays
//!
//! ```text
//! fee = FEE_FLOOR × e^(STEEPNESS × D)     capped at FEE_CAP
//! D   = the largest |dislocation| of A against any reference asset,
//!       measured in the state the hop leaves behind
//! ```
//!
//! - **One asset relative to another.** D is always a pair's dislocation;
//!   HITZ's own price never enters it. With two assets, D is the XLM/USDC
//!   dislocation for both hops: e^(100·D) is (price ÷ average)^100.
//! - **The worst pair.** A hop pays for its asset's most dislocated pair, not
//!   only the pair being traded, so no route through a third asset and no
//!   split into single hops can price a dislocation cheaper.
//! - **References.** A pool counts as a reference for another only if it
//!   holds at least 1/REFERENCE_DEPTH_RATIO of that pool's HITZ, so a shallow,
//!   cheaply moved pool can't raise the fees of deep ones. A shallow pool
//!   still pays for its own dislocation against the deep ones.
//! - **Decay.** Deviations decay toward zero with the 2-hour time constant,
//!   so after a move the fee falls back to the floor.
//!
//! The fee is withheld from each hop's output, so it stays in the reserve
//! being drained. k never decreases in any pool.
//!
//! ## Liquidity
//! The admin seeds each listed asset's pool once, at its market price.
//! After that anyone can add liquidity at the pool's current ratio. There are
//! no LP shares and no withdrawals: nothing leaves the vault except swap
//! outputs.
//!
//! ## Admin
//! Two powers, both public for 7 days before they run: upgrading the code
//! and listing a new trusted asset. Seeding a listed asset is the admin's
//! too. `renounce_upgrades` ends upgrades for good and keeps listing, so the
//! code can be frozen while trusted assets are still added later; `renounce`
//! ends everything.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, Vec, U256,
};

#[cfg(test)]
mod test;

// ─────────────────────────────────────────────────────────────
//  PARAMETERS (changeable only through a timelocked upgrade)
// ─────────────────────────────────────────────────────────────

/// 1.0 for fee rates and exchange rates (9 decimals).
pub const ONE: i128 = 1_000_000_000;

/// 1.0 for natural logs: deviations and dislocations (18 decimals).
pub const WAD: i128 = 1_000_000_000_000_000_000;

/// Fee when nothing is dislocated: 1.00%.
pub const FEE_FLOOR: i128 = 10_000_000;

/// Ceiling on any fee: 10.00%.
pub const FEE_CAP: i128 = 100_000_000;

/// The fee is FEE_FLOOR × e^(STEEPNESS × D): a 1% dislocation multiplies it
/// by ~2.7, a 2% one by ~7.4.
pub const STEEPNESS: i128 = 100;

/// Averages close ~63% of the gap to the current price every
/// ANCHOR_TAU_SECS (2 hours); deviations shrink by e^-1 in that time.
pub const ANCHOR_TAU_SECS: u64 = 7_200;

/// e^(-1 / ANCHOR_TAU_SECS) in 9 decimals: the per-second memory. Applied as
/// a power of elapsed seconds, so the average is a true exponential average
/// however often it is updated.
pub const ANCHOR_DECAY_PER_SEC: i128 = 999_861_121;

/// A pool is a reference for another pool's dislocation only if it holds at
/// least 1/REFERENCE_DEPTH_RATIO of that pool's HITZ.
pub const REFERENCE_DEPTH_RATIO: i128 = 8;

/// Most trusted assets the vault can list.
pub const MAX_ASSETS: u32 = 16;

/// Delay between proposing and running an upgrade or a listing (7 days).
pub const UPGRADE_DELAY_SECS: u64 = 7 * 24 * 60 * 60;

/// ln 2 in 18 decimals.
const LN2_WAD: i128 = 693_147_180_559_945_309;

/// ln(FEE_CAP / FEE_FLOOR) = ln 10 in 18 decimals: from here the fee is capped.
const LN_CAP_OVER_FLOOR_WAD: i128 = 2_302_585_092_994_045_684;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

// ─────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    UnsupportedPair = 2,
    Slippage = 3,
    NotSeeded = 4,
    AlreadySeeded = 5,
    PriceOutOfRange = 6,
    InvalidAddress = 7,
    DuplicateToken = 8,
    InvalidPool = 9,
    TradeTooSmall = 10,
    Overflow = 11,
    NoPendingUpgrade = 12,
    TimelockActive = 13,
    UpgradeHashMismatch = 14,
    Renounced = 15,
    TooManyAssets = 16,
    NoPendingListing = 17,
    ListingMismatch = 18,
}

/// One trusted asset's pool. Pools are kept in listing order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub asset: Address,
    /// HITZ in the pool.
    pub hitz: i128,
    /// The asset in the pool.
    pub reserve: i128,
    /// ln(reserve / hitz) minus its exponential average, in 18 decimals,
    /// as of `updated`. It decays toward zero between trades.
    pub deviation: i128,
    /// Ledger timestamp `deviation` refers to.
    pub updated: u64,
}

/// A pool as the views report it, brought up to the current ledger time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolState {
    pub asset: Address,
    pub hitz: i128,
    pub reserve: i128,
    /// The pool's deviation now (18 decimals).
    pub deviation: i128,
    /// The largest |dislocation| of this asset against its references now
    /// (18 decimals): what a very small hop through this pool is priced at.
    pub dislocation: i128,
    /// The fee a very small hop through this pool pays now (9 decimals:
    /// 10_000_000 = 1%).
    pub fee: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingListing {
    pub asset: Address,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Hitz,
    Pools,
    PendingUpgrade,
    PendingListing,
    /// Set by `renounce_upgrades`: the code can never change again.
    UpgradesRenounced,
}

// ─────────────────────────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────────────────────────

/// One per swap.
#[contractevent]
pub struct Swap {
    #[topic]
    from: Address,
    #[topic]
    to: Address,
    token_in: Address,
    token_out: Address,
    amount_in: i128,
    amount_out: i128,
}

/// One per pool a swap passes through (asset-to-asset swaps emit two).
/// `fee_amount` is in the hop's output token and stays in that pool;
/// `dislocation` is the D the fee was priced at (18 decimals).
#[contractevent]
pub struct Hop {
    #[topic]
    asset: Address,
    hitz_in: bool,
    amount_in: i128,
    amount_out: i128,
    dislocation: i128,
    fee_rate: i128,
    fee_amount: i128,
    reserve_hitz: i128,
    reserve_asset: i128,
}

#[contractevent]
pub struct Deposit {
    #[topic]
    from: Address,
    #[topic]
    asset: Address,
    hitz: i128,
    amount: i128,
}

#[contractevent]
pub struct Seeded {
    #[topic]
    asset: Address,
    hitz: i128,
    amount: i128,
}

#[contractevent]
pub struct ListingProposed {
    #[topic]
    asset: Address,
    eta: u64,
}

#[contractevent]
pub struct ListingCancelled {
    #[topic]
    asset: Address,
}

#[contractevent]
pub struct Listed {
    #[topic]
    asset: Address,
}

#[contractevent]
pub struct UpgradeProposed {
    wasm_hash: BytesN<32>,
    eta: u64,
}

#[contractevent]
pub struct UpgradeCancelled {
    wasm_hash: BytesN<32>,
}

#[contractevent]
pub struct Upgraded {
    wasm_hash: BytesN<32>,
}

#[contractevent]
pub struct UpgradesRenounced {
    #[topic]
    admin: Address,
}

#[contractevent]
pub struct Renounced {
    #[topic]
    previous_admin: Address,
}

// ─────────────────────────────────────────────────────────────
//  CONTRACT
// ─────────────────────────────────────────────────────────────

/// A leg through one pool: (pool index, HITZ is the input).
type Leg = (u32, bool);

struct HopResult {
    pool: u32,
    hitz_in: bool,
    amount_in: i128,
    amount_out: i128,
    dislocation: i128,
    fee_rate: i128,
    fee_amount: i128,
}

#[contract]
pub struct SovereignVault;

#[contractimpl]
impl SovereignVault {
    /// `assets` are the trusted assets the vault starts with (XLM and USDC
    /// on mainnet), each with an empty pool until the admin seeds it.
    pub fn __constructor(env: Env, admin: Address, hitz: Address, assets: Vec<Address>) {
        if assets.is_empty() {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if assets.len() > MAX_ASSETS {
            panic_with_error!(&env, Error::TooManyAssets);
        }
        let now = env.ledger().timestamp();
        let mut pools: Vec<Pool> = Vec::new(&env);
        for asset in assets.iter() {
            if asset == hitz || index_of(&pools, &asset).is_some() {
                panic_with_error!(&env, Error::DuplicateToken);
            }
            pools.push_back(empty_pool(asset, now));
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Hitz, &hitz);
        s.set(&DataKey::Pools, &pools);
        bump(&env);
    }

    // ── Trading ──────────────────────────────────────────────

    /// Swap an exact `amount_in` of `token_in` for at least `min_out` of
    /// `token_out`, paid to `to`. Any listed asset trades with HITZ (one hop)
    /// and with any other listed asset (two hops, through HITZ). Expiry comes
    /// from the transaction's own time bounds.
    pub fn swap(
        env: Env,
        from: Address,
        to: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
    ) -> i128 {
        from.require_auth();
        let me = env.current_contract_address();
        if from == me || to == me {
            panic_with_error!(&env, Error::InvalidAddress);
        }
        if amount_in <= 0 || min_out < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut pools = read_pools(&env);
        let (legs, n) = route(&env, &pools, &token_in, &token_out);
        let now = env.ledger().timestamp();
        let (out, hops) = run_route(&env, &mut pools, &legs[..n], amount_in, now);
        if out < min_out {
            panic_with_error!(&env, Error::Slippage);
        }

        // Effects, then interactions.
        env.storage().instance().set(&DataKey::Pools, &pools);
        token::Client::new(&env, &token_in).transfer(&from, &me, &amount_in);
        token::Client::new(&env, &token_out).transfer(&me, &to, &out);

        for h in hops.iter().take(n) {
            let p = pools.get(h.pool).unwrap();
            Hop {
                asset: p.asset,
                hitz_in: h.hitz_in,
                amount_in: h.amount_in,
                amount_out: h.amount_out,
                dislocation: h.dislocation,
                fee_rate: h.fee_rate,
                fee_amount: h.fee_amount,
                reserve_hitz: p.hitz,
                reserve_asset: p.reserve,
            }
            .publish(&env);
        }
        Swap {
            from,
            to,
            token_in,
            token_out,
            amount_in,
            amount_out: out,
        }
        .publish(&env);
        bump(&env);
        out
    }

    /// What `swap` would pay out right now for `amount_in`, after fees.
    pub fn quote(env: Env, token_in: Address, token_out: Address, amount_in: i128) -> i128 {
        if amount_in <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut pools = read_pools(&env);
        let (legs, n) = route(&env, &pools, &token_in, &token_out);
        let now = env.ledger().timestamp();
        run_route(&env, &mut pools, &legs[..n], amount_in, now).0
    }

    // ── Liquidity ────────────────────────────────────────────

    /// Add liquidity to `asset`'s pool at its current ratio. Anyone can.
    /// `hitz` is exact; the matching amount of the asset (rounded up, in the
    /// vault's favour) must land in `[min_amount, max_amount]`, which bounds
    /// the price the deposit accepts so it can't be sandwiched. No shares, no
    /// withdrawal. The price doesn't move, so the pool's deviation doesn't
    /// either.
    pub fn deposit(
        env: Env,
        from: Address,
        asset: Address,
        hitz: i128,
        min_amount: i128,
        max_amount: i128,
    ) -> i128 {
        from.require_auth();
        if from == env.current_contract_address() {
            panic_with_error!(&env, Error::InvalidAddress);
        }
        if hitz <= 0 || min_amount < 0 || max_amount < min_amount {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut pools = read_pools(&env);
        let i = pool_index(&env, &pools, &asset);
        let mut p = pools.get(i).unwrap();
        require_seeded(&env, &p);
        let amount = mul_div_ceil(&env, hitz, p.reserve, p.hitz);
        if amount < min_amount || amount > max_amount {
            panic_with_error!(&env, Error::PriceOutOfRange);
        }
        p.hitz = checked_add(&env, p.hitz, hitz);
        p.reserve = checked_add(&env, p.reserve, amount);
        pools.set(i, p);
        env.storage().instance().set(&DataKey::Pools, &pools);

        let me = env.current_contract_address();
        token::Client::new(&env, &read_hitz(&env)).transfer(&from, &me, &hitz);
        token::Client::new(&env, &asset).transfer(&from, &me, &amount);

        Deposit {
            from,
            asset,
            hitz,
            amount,
        }
        .publish(&env);
        bump(&env);
        amount
    }

    /// One-time initial liquidity for `asset`'s pool, by the admin, at the
    /// asset's market price: `amount / hitz` is the pool's starting price.
    /// The pool's deviation starts at the HITZ-weighted average of the other
    /// pools' deviations, so a recent HITZ move that every pool already shows
    /// isn't read as a dislocation of the new asset.
    pub fn seed(env: Env, asset: Address, hitz: i128, amount: i128) {
        let admin = require_admin(&env);
        if hitz <= 0 || amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut pools = read_pools(&env);
        let i = pool_index(&env, &pools, &asset);
        let p = pools.get(i).unwrap();
        if p.hitz != 0 || p.reserve != 0 {
            panic_with_error!(&env, Error::AlreadySeeded);
        }
        let now = env.ledger().timestamp();
        let deviation = average_deviation(&env, &pools, now);
        pools.set(
            i,
            Pool {
                asset: asset.clone(),
                hitz,
                reserve: amount,
                deviation,
                updated: now,
            },
        );
        env.storage().instance().set(&DataKey::Pools, &pools);

        let me = env.current_contract_address();
        token::Client::new(&env, &read_hitz(&env)).transfer(&admin, &me, &hitz);
        token::Client::new(&env, &asset).transfer(&admin, &me, &amount);

        Seeded {
            asset,
            hitz,
            amount,
        }
        .publish(&env);
        bump(&env);
    }

    // ── Views ────────────────────────────────────────────────

    /// The HITZ token.
    pub fn hitz(env: Env) -> Address {
        read_hitz(&env)
    }

    /// The listed trusted assets, in listing order.
    pub fn assets(env: Env) -> Vec<Address> {
        let mut out = Vec::new(&env);
        for p in read_pools(&env).iter() {
            out.push_back(p.asset);
        }
        out
    }

    /// One pool, brought up to the current ledger time.
    pub fn pool(env: Env, asset: Address) -> PoolState {
        let pools = read_pools(&env);
        let i = pool_index(&env, &pools, &asset);
        pool_state(&pools, i, env.ledger().timestamp())
    }

    /// Every pool, in listing order.
    pub fn pools(env: Env) -> Vec<PoolState> {
        let pools = read_pools(&env);
        let now = env.ledger().timestamp();
        let mut out = Vec::new(&env);
        for i in 0..pools.len() {
            out.push_back(pool_state(&pools, i, now));
        }
        out
    }

    /// The vault's exchange rate: how much `quote` one unit of `base` is
    /// worth, from the two pools (9 decimals, raw token units).
    pub fn rate(env: Env, base: Address, quote: Address) -> i128 {
        let pools = read_pools(&env);
        let b = pools.get(pool_index(&env, &pools, &base)).unwrap();
        let q = pools.get(pool_index(&env, &pools, &quote)).unwrap();
        require_seeded(&env, &b);
        require_seeded(&env, &q);
        let u = |v: i128| U256::from_u128(&env, v as u128);
        let num = u(q.reserve).mul(&u(b.hitz)).mul(&u(ONE));
        let den = u(q.hitz).mul(&u(b.reserve));
        let r = num
            .div(&den)
            .to_u128()
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        if r > i128::MAX as u128 {
            panic_with_error!(&env, Error::Overflow);
        }
        r as i128
    }

    /// How far `rate(base, quote)` sits from its average, as a natural log in
    /// 18 decimals: positive when `base` is worth more `quote` than usual.
    pub fn dislocation(env: Env, base: Address, quote: Address) -> i128 {
        let pools = read_pools(&env);
        let now = env.ledger().timestamp();
        let b = pools.get(pool_index(&env, &pools, &base)).unwrap();
        let q = pools.get(pool_index(&env, &pools, &quote)).unwrap();
        require_seeded(&env, &b);
        require_seeded(&env, &q);
        decayed(q.deviation, now - q.updated) - decayed(b.deviation, now - b.updated)
    }

    /// The admin, or `None` once renounced.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// Whether the code can still change: false once `renounce_upgrades` or
    /// `renounce` has run.
    pub fn upgradable(env: Env) -> bool {
        let s = env.storage().instance();
        s.has(&DataKey::Admin) && !s.has(&DataKey::UpgradesRenounced)
    }

    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    pub fn pending_listing(env: Env) -> Option<PendingListing> {
        env.storage().instance().get(&DataKey::PendingListing)
    }

    // ── Admin: timelocked listing ────────────────────────────

    /// Propose listing a new trusted asset. It can be listed with
    /// `list_asset` after 7 days, then seeded. A new proposal replaces the
    /// pending one and restarts the clock.
    pub fn propose_listing(env: Env, asset: Address) {
        require_admin(&env);
        check_listable(&env, &read_pools(&env), &asset);
        let eta = env
            .ledger()
            .timestamp()
            .checked_add(UPGRADE_DELAY_SECS)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        env.storage().instance().set(
            &DataKey::PendingListing,
            &PendingListing {
                asset: asset.clone(),
                eta,
            },
        );
        ListingProposed { asset, eta }.publish(&env);
        bump(&env);
    }

    pub fn cancel_listing(env: Env) {
        require_admin(&env);
        let p: PendingListing = env
            .storage()
            .instance()
            .get(&DataKey::PendingListing)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingListing));
        env.storage().instance().remove(&DataKey::PendingListing);
        ListingCancelled { asset: p.asset }.publish(&env);
        bump(&env);
    }

    /// List the proposed asset once the 7 days have passed. Its pool starts
    /// empty and takes no part in trading or in other pools' fees until
    /// `seed`.
    pub fn list_asset(env: Env, asset: Address) {
        require_admin(&env);
        let p: PendingListing = env
            .storage()
            .instance()
            .get(&DataKey::PendingListing)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingListing));
        if p.asset != asset {
            panic_with_error!(&env, Error::ListingMismatch);
        }
        let now = env.ledger().timestamp();
        if now < p.eta {
            panic_with_error!(&env, Error::TimelockActive);
        }
        let mut pools = read_pools(&env);
        check_listable(&env, &pools, &asset);
        pools.push_back(empty_pool(asset.clone(), now));
        let s = env.storage().instance();
        s.set(&DataKey::Pools, &pools);
        s.remove(&DataKey::PendingListing);
        Listed { asset }.publish(&env);
        bump(&env);
    }

    // ── Admin: timelocked upgrade, renounce ──────────────────

    /// Propose new vault code. It can be installed with `upgrade` after
    /// 7 days. A new proposal replaces the pending one and restarts the clock.
    pub fn propose_upgrade(env: Env, wasm_hash: BytesN<32>) {
        require_admin(&env);
        require_upgradable(&env);
        let eta = env
            .ledger()
            .timestamp()
            .checked_add(UPGRADE_DELAY_SECS)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        env.storage().instance().set(
            &DataKey::PendingUpgrade,
            &PendingUpgrade {
                wasm_hash: wasm_hash.clone(),
                eta,
            },
        );
        UpgradeProposed { wasm_hash, eta }.publish(&env);
        bump(&env);
    }

    pub fn cancel_upgrade(env: Env) {
        require_admin(&env);
        let p: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingUpgrade));
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        UpgradeCancelled {
            wasm_hash: p.wasm_hash,
        }
        .publish(&env);
        bump(&env);
    }

    /// Install the proposed code once the 7 days have passed.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        require_admin(&env);
        require_upgradable(&env);
        let p: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingUpgrade));
        if p.wasm_hash != wasm_hash {
            panic_with_error!(&env, Error::UpgradeHashMismatch);
        }
        if env.ledger().timestamp() < p.eta {
            panic_with_error!(&env, Error::TimelockActive);
        }
        env.storage().instance().remove(&DataKey::PendingUpgrade);
        Upgraded {
            wasm_hash: wasm_hash.clone(),
        }
        .publish(&env);
        bump(&env);
        env.deployer().update_current_contract_wasm(wasm_hash);
    }

    /// Give up upgrades for good: the code can never change again, and any
    /// pending upgrade is dropped. The admin keeps listing new trusted assets
    /// (still timelocked) and seeding them, until `renounce`.
    pub fn renounce_upgrades(env: Env) {
        let admin = require_admin(&env);
        let s = env.storage().instance();
        s.set(&DataKey::UpgradesRenounced, &true);
        s.remove(&DataKey::PendingUpgrade);
        UpgradesRenounced { admin }.publish(&env);
        bump(&env);
    }

    /// Give up the admin role for good: no upgrade, listing or seeding can
    /// ever run again.
    pub fn renounce(env: Env) {
        let previous_admin = require_admin(&env);
        let s = env.storage().instance();
        s.remove(&DataKey::Admin);
        s.remove(&DataKey::PendingUpgrade);
        s.remove(&DataKey::PendingListing);
        Renounced { previous_admin }.publish(&env);
        bump(&env);
    }
}

// ─────────────────────────────────────────────────────────────
//  ROUTING AND SWAP MATH
// ─────────────────────────────────────────────────────────────

fn route(
    env: &Env,
    pools: &Vec<Pool>,
    token_in: &Address,
    token_out: &Address,
) -> ([Leg; 2], usize) {
    let hitz = read_hitz(env);
    let none: Leg = (0, false);
    let find = |t: &Address| -> u32 {
        index_of(pools, t).unwrap_or_else(|| panic_with_error!(env, Error::UnsupportedPair))
    };
    let (legs, n) = if *token_in == hitz && *token_out != hitz {
        ([(find(token_out), true), none], 1)
    } else if *token_out == hitz && *token_in != hitz {
        ([(find(token_in), false), none], 1)
    } else if token_in != token_out && *token_in != hitz {
        ([(find(token_in), false), (find(token_out), true)], 2)
    } else {
        panic_with_error!(env, Error::UnsupportedPair)
    };
    for (pool, _) in legs.iter().take(n) {
        require_seeded(env, &pools.get(*pool).unwrap());
    }
    (legs, n)
}

/// Run the legs in order, updating `pools`. Returns the final output and
/// the per-pool results.
fn run_route(
    env: &Env,
    pools: &mut Vec<Pool>,
    legs: &[Leg],
    amount_in: i128,
    now: u64,
) -> (i128, [HopResult; 2]) {
    let empty = || HopResult {
        pool: 0,
        hitz_in: false,
        amount_in: 0,
        amount_out: 0,
        dislocation: 0,
        fee_rate: 0,
        fee_amount: 0,
    };
    let mut hops = [empty(), empty()];
    let mut amount = amount_in;
    for (i, (pool, hitz_in)) in legs.iter().enumerate() {
        hops[i] = hop(env, pools, *pool, *hitz_in, amount, now);
        amount = hops[i].amount_out;
    }
    (amount, hops)
}

/// One constant-product leg. The fee is priced at the dislocation the leg
/// would leave behind without a fee, then withheld from the output, so it
/// stays in the reserve being drained. k never decreases.
fn hop(
    env: &Env,
    pools: &mut Vec<Pool>,
    i: u32,
    hitz_in: bool,
    amount_in: i128,
    now: u64,
) -> HopResult {
    let p = pools.get(i).unwrap();
    let (r_in, r_out) = if hitz_in {
        (p.hitz, p.reserve)
    } else {
        (p.reserve, p.hitz)
    };
    let new_in = checked_add(env, r_in, amount_in);
    let gross = mul_div_floor(env, r_out, amount_in, new_in);

    let deviation_now = decayed(p.deviation, now - p.updated);
    let (h_end, q_end) = sides(hitz_in, new_in, r_out - gross);
    let deviation_end = deviation_now + ln_price_change(p.hitz, p.reserve, h_end, q_end);
    let dislocation = worst_dislocation(pools, i, h_end, deviation_end, now);
    let fee_rate = fee_for_dislocation(dislocation);

    let fee_amount = mul_div_ceil(env, gross, fee_rate, ONE);
    let amount_out = gross - fee_amount;
    if amount_out <= 0 {
        panic_with_error!(env, Error::TradeTooSmall);
    }
    let (h, q) = sides(hitz_in, new_in, r_out - amount_out);
    pools.set(
        i,
        Pool {
            asset: p.asset,
            hitz: h,
            reserve: q,
            deviation: deviation_now + ln_price_change(p.hitz, p.reserve, h, q),
            updated: now,
        },
    );
    HopResult {
        pool: i,
        hitz_in,
        amount_in,
        amount_out,
        dislocation,
        fee_rate,
        fee_amount,
    }
}

/// (hitz, reserve) after a leg, from its new input and output reserves.
fn sides(hitz_in: bool, new_in: i128, new_out: i128) -> (i128, i128) {
    if hitz_in {
        (new_in, new_out)
    } else {
        (new_out, new_in)
    }
}

// ─────────────────────────────────────────────────────────────
//  DISLOCATION AND FEE
// ─────────────────────────────────────────────────────────────

/// D for pool `i` with HITZ `hitz` and deviation `deviation`: the largest
/// |deviation − deviation_j| over its references j, i.e. the most dislocated
/// pair this asset is in. References are the other seeded pools holding at
/// least 1/REFERENCE_DEPTH_RATIO of this pool's HITZ. Zero with no reference.
fn worst_dislocation(pools: &Vec<Pool>, i: u32, hitz: i128, deviation: i128, now: u64) -> i128 {
    let mut worst = 0;
    for (j, p) in pools.iter().enumerate() {
        if j as u32 == i || p.hitz <= 0 || p.reserve <= 0 {
            continue;
        }
        if p.hitz.saturating_mul(REFERENCE_DEPTH_RATIO) < hitz {
            continue;
        }
        let gap = (deviation - decayed(p.deviation, now - p.updated)).abs();
        if gap > worst {
            worst = gap;
        }
    }
    worst
}

/// FEE_FLOOR × e^(STEEPNESS × dislocation), capped at FEE_CAP, rounded up.
/// `dislocation` is a natural log in 18 decimals and is taken by size.
pub fn fee_for_dislocation(dislocation: i128) -> i128 {
    let x = dislocation.abs().saturating_mul(STEEPNESS);
    if x >= LN_CAP_OVER_FLOOR_WAD {
        return FEE_CAP;
    }
    let multiplier = exp_wad(x);
    let fee = (FEE_FLOOR * multiplier + (WAD - 1)) / WAD;
    if fee > FEE_CAP {
        FEE_CAP
    } else {
        fee
    }
}

/// The deviations' HITZ-weighted average over the seeded pools, brought to
/// `now`: where a newly seeded pool starts.
fn average_deviation(env: &Env, pools: &Vec<Pool>, now: u64) -> i128 {
    let mut weighted = 0i128;
    let mut weight = 0i128;
    for p in pools.iter() {
        if p.hitz <= 0 || p.reserve <= 0 {
            continue;
        }
        let d = decayed(p.deviation, now - p.updated);
        weighted = checked_add(
            env,
            weighted,
            d.checked_mul(p.hitz)
                .unwrap_or_else(|| panic_with_error!(env, Error::Overflow)),
        );
        weight = checked_add(env, weight, p.hitz);
    }
    if weight == 0 {
        0
    } else {
        weighted / weight
    }
}

fn pool_state(pools: &Vec<Pool>, i: u32, now: u64) -> PoolState {
    let p = pools.get(i).unwrap();
    let deviation = decayed(p.deviation, now - p.updated);
    let dislocation = if p.hitz > 0 && p.reserve > 0 {
        worst_dislocation(pools, i, p.hitz, deviation, now)
    } else {
        0
    };
    PoolState {
        asset: p.asset,
        hitz: p.hitz,
        reserve: p.reserve,
        deviation,
        dislocation,
        fee: fee_for_dislocation(dislocation),
    }
}

/// A deviation `elapsed` seconds later: deviations decay toward zero as the
/// pool's average catches up with its price.
pub fn decayed(deviation: i128, elapsed: u64) -> i128 {
    if elapsed == 0 || deviation == 0 {
        return deviation;
    }
    deviation * pow_sat(ANCHOR_DECAY_PER_SEC, elapsed, ONE) / ONE
}

/// ln(new price ÷ old price) for a pool's price reserve / hitz, 18 decimals.
fn ln_price_change(hitz0: i128, reserve0: i128, hitz1: i128, reserve1: i128) -> i128 {
    ln_ratio(reserve1, reserve0) + ln_ratio(hitz0, hitz1)
}

// ─────────────────────────────────────────────────────────────
//  FIXED-POINT MATH
// ─────────────────────────────────────────────────────────────

/// ln(a / b) in 18 decimals, for a, b > 0. Splits each into 2^n × m with m
/// in [1, 2), then ln(a/b) = (n_a − n_b)·ln 2 + ln(m_a / m_b).
pub fn ln_ratio(a: i128, b: i128) -> i128 {
    let (na, ma) = log2_parts(a as u128);
    let (nb, mb) = log2_parts(b as u128);
    // ma, mb are in [WAD, 2·WAD); their ratio is in (WAD/2, 2·WAD).
    let r = (ma * WAD as u128 / mb) as i128;
    (na as i128 - nb as i128) * LN2_WAD + ln_near_one(r)
}

/// (floor(log2 x), x / 2^floor(log2 x) in 18 decimals), from x's top 61 bits.
fn log2_parts(x: u128) -> (u32, u128) {
    let n = 127 - x.leading_zeros();
    let top = if n >= 60 {
        x >> (n - 60)
    } else {
        x << (60 - n)
    };
    (n, (top * WAD as u128) >> 60)
}

/// ln(r / WAD) for r in (WAD/2, 2·WAD): 2·atanh(z), z = (r − 1)/(r + 1).
fn ln_near_one(r: i128) -> i128 {
    let z = (r - WAD) * WAD / (r + WAD);
    let z2 = z * z / WAD;
    let mut term = z;
    let mut sum = 0;
    let mut k = 1;
    while term != 0 {
        sum += term / k;
        term = term * z2 / WAD;
        k += 2;
    }
    2 * sum
}

/// e^x in 18 decimals for 0 ≤ x < ln 10, rounded up: x = n·ln 2 + r, then a
/// Taylor series for e^r, shifted by n.
fn exp_wad(x: i128) -> i128 {
    if x == 0 {
        // Exact, so a pair with no dislocation pays exactly the floor.
        return WAD;
    }
    let n = x / LN2_WAD;
    let r = x - n * LN2_WAD;
    let mut term = WAD;
    let mut sum = WAD;
    let mut k = 1;
    while term > 0 {
        term = term * r / (k * WAD);
        sum += term;
        k += 1;
    }
    // Every term was truncated: add one unit per term to stay above e^r.
    (sum + k) << n
}

/// `base^exp` in 9-decimal fixed point by repeated squaring, saturating at
/// `cap` (which must be ≥ ONE). With `base` < ONE it decays toward zero.
pub fn pow_sat(base: i128, exp: u64, cap: i128) -> i128 {
    let mut b = if base > cap { cap } else { base };
    let mut e = exp;
    let mut acc = ONE;
    loop {
        if e & 1 == 1 {
            acc = acc * b / ONE;
            if acc >= cap {
                return cap;
            }
        }
        e >>= 1;
        if e == 0 || acc == 0 {
            return acc;
        }
        b = b * b / ONE;
        if b > cap {
            b = cap;
        }
    }
}

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
}

fn mul_div_floor(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    a.checked_mul(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow))
        / c
}

fn mul_div_ceil(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    let p = a
        .checked_mul(b)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow));
    p / c + if p % c == 0 { 0 } else { 1 }
}

fn empty_pool(asset: Address, now: u64) -> Pool {
    Pool {
        asset,
        hitz: 0,
        reserve: 0,
        deviation: 0,
        updated: now,
    }
}

fn index_of(pools: &Vec<Pool>, asset: &Address) -> Option<u32> {
    for (i, p) in pools.iter().enumerate() {
        if p.asset == *asset {
            return Some(i as u32);
        }
    }
    None
}

fn pool_index(env: &Env, pools: &Vec<Pool>, asset: &Address) -> u32 {
    index_of(pools, asset).unwrap_or_else(|| panic_with_error!(env, Error::InvalidPool))
}

/// A listing candidate must be new, not HITZ, fit under MAX_ASSETS, and
/// answer as a token.
fn check_listable(env: &Env, pools: &Vec<Pool>, asset: &Address) {
    if *asset == read_hitz(env) || index_of(pools, asset).is_some() {
        panic_with_error!(env, Error::DuplicateToken);
    }
    if pools.len() >= MAX_ASSETS {
        panic_with_error!(env, Error::TooManyAssets);
    }
    token::Client::new(env, asset).decimals();
}

fn read_pools(env: &Env) -> Vec<Pool> {
    env.storage().instance().get(&DataKey::Pools).unwrap()
}

fn read_hitz(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Hitz).unwrap()
}

fn require_seeded(env: &Env, p: &Pool) {
    if p.hitz <= 0 || p.reserve <= 0 {
        panic_with_error!(env, Error::NotSeeded);
    }
}

fn require_upgradable(env: &Env) {
    if env.storage().instance().has(&DataKey::UpgradesRenounced) {
        panic_with_error!(env, Error::Renounced);
    }
}

fn require_admin(env: &Env) -> Address {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::Renounced));
    admin.require_auth();
    admin
}

fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}
