#![no_std]
//! # HITZ Sovereign Vault
//!
//! HITZ's own exchange. Two constant-product pools share HITZ:
//! the XLM pool (HITZ/XLM) and the USDC pool (HITZ/USDC). Together they make
//! the vault an XLM/USDC market with HITZ as the bridge, so every XLM move
//! sends arbitrage through the vault, and the fee keeps that value in the
//! reserves. HITZ is backed by XLM and USDC and compounds with volatility.
//!
//! ## Fee
//! The vault's XLM price is the USDC per XLM implied by its two pools. The
//! anchor is that price averaged over time (2-hour memory). A trade pays
//!
//! ```text
//! fee = FEE_FLOOR × (price after the trade ÷ anchor)^STEEPNESS   (ratio taken ≥ 1)
//! ```
//!
//! capped at FEE_CAP: 1% in a calm market, rising exponentially while XLM
//! moves and decaying back to 1% as the anchor catches up. No oracle. The fee
//! is priced at the state the trade leaves behind, so splitting a trade does
//! not lower it. It is taken from the output, so it stays in the reserve
//! being drained.
//!
//! ## Liquidity
//! Anyone can add liquidity at the current ratio. There are no LP shares and
//! no withdrawals. Nothing leaves the vault except swap outputs.
//!
//! ## Admin
//! One power: upgrading the code, public for 7 days before it can run.
//! `renounce` ends it for good and the vault becomes immutable.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, U256,
};

#[cfg(test)]
mod test;

// ─────────────────────────────────────────────────────────────
//  PARAMETERS (changeable only through a timelocked upgrade)
// ─────────────────────────────────────────────────────────────

/// 1.0 in the vault's fixed-point math (9 decimals).
pub const ONE: i128 = 1_000_000_000;

/// Fee when the vault's XLM price sits at its anchor: 1.00%.
pub const FEE_FLOOR: i128 = 10_000_000;

/// Ceiling on any fee: 10.00%.
pub const FEE_CAP: i128 = 100_000_000;

/// Exponent of the fee curve. A 1% move away from the anchor multiplies
/// the fee by ~2.7, a 2% move by ~7.2.
pub const STEEPNESS: u64 = 100;

/// Anchor memory: it closes ~63% of the gap to the vault's price every
/// ANCHOR_TAU_SECS (2 hours).
pub const ANCHOR_TAU_SECS: u64 = 7_200;

/// e^(-1 / ANCHOR_TAU_SECS) in fixed point: the anchor's per-second memory.
/// Applied as a power of elapsed seconds, so the anchor is a true
/// exponential average no matter how often it is updated.
pub const ANCHOR_DECAY_PER_SEC: i128 = 999_861_121;

/// Delay between `propose_upgrade` and `upgrade` (7 days).
pub const UPGRADE_DELAY_SECS: u64 = 7 * 24 * 60 * 60;

/// Pool ids.
pub const XLM_POOL: u32 = 0;
pub const USDC_POOL: u32 = 1;

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
}

/// The four reserves. Each pool holds its own HITZ.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reserves {
    /// HITZ in the XLM pool.
    pub hitz_xlm: i128,
    /// XLM in the XLM pool.
    pub xlm: i128,
    /// HITZ in the USDC pool.
    pub hitz_usdc: i128,
    /// USDC in the USDC pool.
    pub usdc: i128,
}

/// Time-weighted average of the vault's XLM price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Anchor {
    /// USDC per XLM, 9 decimals.
    pub price: i128,
    /// Ledger timestamp of the last update.
    pub time: u64,
}

/// Everything a UI needs to price and display the vault.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub reserves: Reserves,
    /// The vault's XLM price now (USDC per XLM, 9 decimals).
    pub xlm_price: i128,
    /// The anchor, brought up to the current ledger time.
    pub anchor_price: i128,
    /// Fee a very small trade would pay right now (9 decimals: 10_000_000 = 1%).
    pub fee: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Hitz,
    Xlm,
    Usdc,
    Reserves,
    Anchor,
    PendingUpgrade,
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

/// One per pool a swap passes through (XLM <-> USDC swaps emit two).
/// `fee_amount` is in the output token and stays in that pool.
#[contractevent]
pub struct Hop {
    #[topic]
    pool: u32,
    hitz_in: bool,
    amount_in: i128,
    amount_out: i128,
    fee_rate: i128,
    fee_amount: i128,
    reserve_hitz: i128,
    reserve_quote: i128,
}

#[contractevent]
pub struct Deposit {
    #[topic]
    from: Address,
    #[topic]
    pool: u32,
    hitz: i128,
    quote: i128,
}

#[contractevent]
pub struct Seeded {
    hitz_xlm: i128,
    xlm: i128,
    hitz_usdc: i128,
    usdc: i128,
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
pub struct Renounced {
    #[topic]
    previous_admin: Address,
}

// ─────────────────────────────────────────────────────────────
//  CONTRACT
// ─────────────────────────────────────────────────────────────

/// A leg through one pool: (pool, HITZ is the input).
type Leg = (u32, bool);

struct HopResult {
    pool: u32,
    hitz_in: bool,
    amount_in: i128,
    amount_out: i128,
    fee_rate: i128,
    fee_amount: i128,
}

#[contract]
pub struct SovereignVault;

#[contractimpl]
impl SovereignVault {
    pub fn __constructor(env: Env, admin: Address, hitz: Address, xlm: Address, usdc: Address) {
        if hitz == xlm || hitz == usdc || xlm == usdc {
            panic_with_error!(&env, Error::DuplicateToken);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Hitz, &hitz);
        s.set(&DataKey::Xlm, &xlm);
        s.set(&DataKey::Usdc, &usdc);
        s.set(
            &DataKey::Reserves,
            &Reserves {
                hitz_xlm: 0,
                xlm: 0,
                hitz_usdc: 0,
                usdc: 0,
            },
        );
        bump(&env);
    }

    // ── Trading ──────────────────────────────────────────────

    /// Swap an exact `amount_in` of `token_in` for at least `min_out` of
    /// `token_out`, paid to `to`. Pairs: HITZ<->XLM, HITZ<->USDC and
    /// XLM<->USDC (through HITZ, two hops). Expiry comes from the
    /// transaction's own time bounds.
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
        let (legs, n) = route(&env, &token_in, &token_out);

        let mut r = read_reserves(&env);
        require_seeded(&env, &r);
        let anchor = anchor_now(&env, &r);
        let (out, hops) = run_route(&env, &mut r, anchor, &legs[..n], amount_in);
        if out < min_out {
            panic_with_error!(&env, Error::Slippage);
        }

        // Effects, then interactions.
        let s = env.storage().instance();
        s.set(&DataKey::Reserves, &r);
        s.set(
            &DataKey::Anchor,
            &Anchor {
                price: anchor,
                time: env.ledger().timestamp(),
            },
        );
        token::Client::new(&env, &token_in).transfer(&from, &me, &amount_in);
        token::Client::new(&env, &token_out).transfer(&me, &to, &out);

        for h in hops.iter().take(n) {
            let (rh, rq) = pool_reserves(&r, h.pool);
            Hop {
                pool: h.pool,
                hitz_in: h.hitz_in,
                amount_in: h.amount_in,
                amount_out: h.amount_out,
                fee_rate: h.fee_rate,
                fee_amount: h.fee_amount,
                reserve_hitz: rh,
                reserve_quote: rq,
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
        let (legs, n) = route(&env, &token_in, &token_out);
        let mut r = read_reserves(&env);
        require_seeded(&env, &r);
        let anchor = anchor_now(&env, &r);
        run_route(&env, &mut r, anchor, &legs[..n], amount_in).0
    }

    // ── Liquidity ────────────────────────────────────────────

    /// Add liquidity to one pool at its current ratio. Anyone can. `hitz` is
    /// exact; the matching XLM or USDC (rounded up, in the vault's favour)
    /// must land in `[min_quote, max_quote]`, which bounds the price the
    /// deposit accepts so it can't be sandwiched. No shares, no withdrawal.
    pub fn deposit(
        env: Env,
        from: Address,
        pool: u32,
        hitz: i128,
        min_quote: i128,
        max_quote: i128,
    ) -> i128 {
        from.require_auth();
        if from == env.current_contract_address() {
            panic_with_error!(&env, Error::InvalidAddress);
        }
        if hitz <= 0 || min_quote < 0 || max_quote < min_quote {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut r = read_reserves(&env);
        require_seeded(&env, &r);
        let (rh, rq) = pool_reserves_checked(&env, &r, pool);
        let quote = mul_div_ceil(&env, hitz, rq, rh);
        if quote < min_quote || quote > max_quote {
            panic_with_error!(&env, Error::PriceOutOfRange);
        }
        set_pool(&mut r, pool, rh + hitz, rq + quote);
        env.storage().instance().set(&DataKey::Reserves, &r);

        let me = env.current_contract_address();
        token::Client::new(&env, &read_addr(&env, DataKey::Hitz)).transfer(&from, &me, &hitz);
        token::Client::new(&env, &quote_token(&env, pool)).transfer(&from, &me, &quote);

        Deposit {
            from,
            pool,
            hitz,
            quote,
        }
        .publish(&env);
        bump(&env);
        quote
    }

    /// One-time initial liquidity for both pools, by the admin. The ratios
    /// set the starting prices, and the anchor starts at the implied XLM
    /// price.
    pub fn seed(env: Env, hitz_xlm: i128, xlm: i128, hitz_usdc: i128, usdc: i128) {
        let admin = require_admin(&env);
        if hitz_xlm <= 0 || xlm <= 0 || hitz_usdc <= 0 || usdc <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let current = read_reserves(&env);
        if current.hitz_xlm != 0 || current.xlm != 0 || current.hitz_usdc != 0 || current.usdc != 0
        {
            panic_with_error!(&env, Error::AlreadySeeded);
        }
        let r = Reserves {
            hitz_xlm,
            xlm,
            hitz_usdc,
            usdc,
        };
        let s = env.storage().instance();
        s.set(&DataKey::Reserves, &r);
        s.set(
            &DataKey::Anchor,
            &Anchor {
                price: xlm_price(&env, &r),
                time: env.ledger().timestamp(),
            },
        );

        let me = env.current_contract_address();
        let total_hitz = hitz_xlm
            .checked_add(hitz_usdc)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        token::Client::new(&env, &read_addr(&env, DataKey::Hitz)).transfer(
            &admin,
            &me,
            &total_hitz,
        );
        token::Client::new(&env, &read_addr(&env, DataKey::Xlm)).transfer(&admin, &me, &xlm);
        token::Client::new(&env, &read_addr(&env, DataKey::Usdc)).transfer(&admin, &me, &usdc);

        Seeded {
            hitz_xlm,
            xlm,
            hitz_usdc,
            usdc,
        }
        .publish(&env);
        bump(&env);
    }

    // ── Views ────────────────────────────────────────────────

    pub fn reserves(env: Env) -> Reserves {
        read_reserves(&env)
    }

    pub fn market(env: Env) -> Market {
        let r = read_reserves(&env);
        require_seeded(&env, &r);
        let price = xlm_price(&env, &r);
        let anchor = anchor_now(&env, &r);
        Market {
            fee: fee_for_price(price, anchor),
            reserves: r,
            xlm_price: price,
            anchor_price: anchor,
        }
    }

    /// (HITZ, XLM, USDC) token addresses.
    pub fn tokens(env: Env) -> (Address, Address, Address) {
        (
            read_addr(&env, DataKey::Hitz),
            read_addr(&env, DataKey::Xlm),
            read_addr(&env, DataKey::Usdc),
        )
    }

    /// The admin, or `None` once renounced.
    pub fn admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        env.storage().instance().get(&DataKey::PendingUpgrade)
    }

    // ── Admin: timelocked upgrade, renounce ──────────────────

    /// Propose new vault code. It can be installed with `upgrade` after
    /// 7 days. A new proposal replaces the pending one and restarts the clock.
    pub fn propose_upgrade(env: Env, wasm_hash: BytesN<32>) {
        require_admin(&env);
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

    /// Give up the admin role for good. No upgrade can ever run again.
    pub fn renounce(env: Env) {
        let previous_admin = require_admin(&env);
        let s = env.storage().instance();
        s.remove(&DataKey::Admin);
        s.remove(&DataKey::PendingUpgrade);
        Renounced { previous_admin }.publish(&env);
        bump(&env);
    }
}

// ─────────────────────────────────────────────────────────────
//  ROUTING AND SWAP MATH
// ─────────────────────────────────────────────────────────────

fn route(env: &Env, token_in: &Address, token_out: &Address) -> ([Leg; 2], usize) {
    let hitz = read_addr(env, DataKey::Hitz);
    let xlm = read_addr(env, DataKey::Xlm);
    let usdc = read_addr(env, DataKey::Usdc);
    let none: Leg = (0, false);
    if *token_in == hitz && *token_out == xlm {
        ([(XLM_POOL, true), none], 1)
    } else if *token_in == xlm && *token_out == hitz {
        ([(XLM_POOL, false), none], 1)
    } else if *token_in == hitz && *token_out == usdc {
        ([(USDC_POOL, true), none], 1)
    } else if *token_in == usdc && *token_out == hitz {
        ([(USDC_POOL, false), none], 1)
    } else if *token_in == xlm && *token_out == usdc {
        ([(XLM_POOL, false), (USDC_POOL, true)], 2)
    } else if *token_in == usdc && *token_out == xlm {
        ([(USDC_POOL, false), (XLM_POOL, true)], 2)
    } else {
        panic_with_error!(env, Error::UnsupportedPair)
    }
}

/// Run the legs in order, mutating `r`. Returns the final output and the
/// per-pool results.
fn run_route(
    env: &Env,
    r: &mut Reserves,
    anchor: i128,
    legs: &[Leg],
    amount_in: i128,
) -> (i128, [HopResult; 2]) {
    let empty = || HopResult {
        pool: 0,
        hitz_in: false,
        amount_in: 0,
        amount_out: 0,
        fee_rate: 0,
        fee_amount: 0,
    };
    let mut hops = [empty(), empty()];
    let mut amount = amount_in;
    for (i, (pool, hitz_in)) in legs.iter().enumerate() {
        hops[i] = hop(env, r, anchor, *pool, *hitz_in, amount);
        amount = hops[i].amount_out;
    }
    (amount, hops)
}

/// One constant-product leg. The fee is priced at the XLM price the leg
/// would leave behind without a fee, then withheld from the output, so it
/// stays in the reserve being drained. k never decreases.
fn hop(
    env: &Env,
    r: &mut Reserves,
    anchor: i128,
    pool: u32,
    hitz_in: bool,
    amount_in: i128,
) -> HopResult {
    let (rh, rq) = pool_reserves(r, pool);
    let (r_in, r_out) = if hitz_in { (rh, rq) } else { (rq, rh) };
    let new_in = r_in
        .checked_add(amount_in)
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow));
    let gross = mul_div_floor(env, r_out, amount_in, new_in);

    let mut after = r.clone();
    apply(&mut after, pool, hitz_in, new_in, r_out - gross);
    let fee_rate = fee_for_price(xlm_price(env, &after), anchor);

    let fee_amount = mul_div_ceil(env, gross, fee_rate, ONE);
    let amount_out = gross - fee_amount;
    if amount_out <= 0 {
        panic_with_error!(env, Error::TradeTooSmall);
    }
    apply(r, pool, hitz_in, new_in, r_out - amount_out);
    HopResult {
        pool,
        hitz_in,
        amount_in,
        amount_out,
        fee_rate,
        fee_amount,
    }
}

fn apply(r: &mut Reserves, pool: u32, hitz_in: bool, new_in: i128, new_out: i128) {
    let (h, q) = if hitz_in {
        (new_in, new_out)
    } else {
        (new_out, new_in)
    };
    set_pool(r, pool, h, q);
}

// ─────────────────────────────────────────────────────────────
//  PRICE, ANCHOR AND FEE
// ─────────────────────────────────────────────────────────────

/// The vault's XLM price: USDC per XLM implied by the two pools,
/// (usdc / hitz_usdc) / (xlm / hitz_xlm), in 9 decimals.
pub fn xlm_price(env: &Env, r: &Reserves) -> i128 {
    let u = |v: i128| U256::from_u128(env, v as u128);
    let num = u(r.usdc).mul(&u(r.hitz_xlm)).mul(&u(ONE));
    let den = u(r.hitz_usdc).mul(&u(r.xlm));
    let p = num
        .div(&den)
        .to_u128()
        .unwrap_or_else(|| panic_with_error!(env, Error::Overflow));
    if p == 0 || p > i128::MAX as u128 {
        panic_with_error!(env, Error::Overflow);
    }
    p as i128
}

/// The anchor brought forward to now: an exponential average of the vault's
/// XLM price, whose current value has held since the last trade.
fn anchor_now(env: &Env, r: &Reserves) -> i128 {
    let a: Anchor = env
        .storage()
        .instance()
        .get(&DataKey::Anchor)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotSeeded));
    let now = env.ledger().timestamp();
    if now <= a.time {
        return a.price;
    }
    let price = xlm_price(env, r);
    let memory = pow_sat(ANCHOR_DECAY_PER_SEC, now - a.time, ONE);
    price + (a.price - price) * memory / ONE
}

/// FEE_FLOOR × (price / anchor)^STEEPNESS with the ratio taken ≥ 1,
/// capped at FEE_CAP. The ratio rounds up, so the fee never rounds below
/// the curve.
pub fn fee_for_price(price: i128, anchor: i128) -> i128 {
    let (num, den) = if price >= anchor {
        (price, anchor)
    } else {
        (anchor, price)
    };
    let ratio = (num * ONE + den - 1) / den;
    let multiplier = pow_sat(ratio, STEEPNESS, FEE_CAP * ONE / FEE_FLOOR);
    let fee = FEE_FLOOR * multiplier / ONE;
    if fee > FEE_CAP {
        FEE_CAP
    } else {
        fee
    }
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

fn pool_reserves(r: &Reserves, pool: u32) -> (i128, i128) {
    if pool == XLM_POOL {
        (r.hitz_xlm, r.xlm)
    } else {
        (r.hitz_usdc, r.usdc)
    }
}

fn pool_reserves_checked(env: &Env, r: &Reserves, pool: u32) -> (i128, i128) {
    if pool != XLM_POOL && pool != USDC_POOL {
        panic_with_error!(env, Error::InvalidPool);
    }
    pool_reserves(r, pool)
}

fn set_pool(r: &mut Reserves, pool: u32, hitz: i128, quote: i128) {
    if pool == XLM_POOL {
        r.hitz_xlm = hitz;
        r.xlm = quote;
    } else {
        r.hitz_usdc = hitz;
        r.usdc = quote;
    }
}

fn quote_token(env: &Env, pool: u32) -> Address {
    if pool == XLM_POOL {
        read_addr(env, DataKey::Xlm)
    } else {
        read_addr(env, DataKey::Usdc)
    }
}

fn read_reserves(env: &Env) -> Reserves {
    env.storage().instance().get(&DataKey::Reserves).unwrap()
}

fn require_seeded(env: &Env, r: &Reserves) {
    if r.hitz_xlm <= 0 || r.xlm <= 0 || r.hitz_usdc <= 0 || r.usdc <= 0 {
        panic_with_error!(env, Error::NotSeeded);
    }
}

fn read_addr(env: &Env, key: DataKey) -> Address {
    env.storage().instance().get(&key).unwrap()
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
