#![cfg(test)]
extern crate std;

use super::*;
use gravity_token::{GravityToken, GravityTokenClient};
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, String, Symbol,
};

/// One unit of any 7-decimal Stellar asset (HITZ, XLM, USDC).
const U: i128 = 10_000_000;

/// Reserves shaped like the Sep 22 Aquarius pools (~$3.5k of backing).
const SEED_HITZ_XLM: i128 = 57_300_000 * U;
const SEED_XLM: i128 = 10_200 * U;
const SEED_HITZ_USDC: i128 = 31_200_000 * U;
const SEED_USDC: i128 = 1_230 * U;

struct World {
    env: Env,
    admin: Address,
    vault: SovereignVaultClient<'static>,
    hitz: GravityTokenClient<'static>,
    xlm: Address,
    usdc: Address,
}

impl World {
    fn new() -> World {
        let w = World::unseeded();
        w.vault
            .seed(&SEED_HITZ_XLM, &SEED_XLM, &SEED_HITZ_USDC, &SEED_USDC);
        w
    }

    fn unseeded() -> World {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().with_mut(|l| l.timestamp = 1_800_000_000);

        let admin = Address::generate(&env);
        let hitz_id = env.register(GravityToken, ());
        let hitz = GravityTokenClient::new(&env, &hitz_id);
        hitz.initialize(
            &admin,
            &String::from_str(&env, "Gravity HITZ"),
            &String::from_str(&env, "HITZ"),
        );
        let xlm = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();

        let vault_id = env.register(
            SovereignVault,
            (admin.clone(), hitz_id.clone(), xlm.clone(), usdc.clone()),
        );
        let vault = SovereignVaultClient::new(&env, &vault_id);

        // The vault is HITZ's pool: its HITZ is the mass, and vaulted
        // holders can always sell into it.
        hitz.register_pool_address(&vault_id);

        hitz.mint(&admin, &(SEED_HITZ_XLM + SEED_HITZ_USDC));
        StellarAssetClient::new(&env, &xlm).mint(&admin, &SEED_XLM);
        StellarAssetClient::new(&env, &usdc).mint(&admin, &SEED_USDC);

        World {
            env,
            admin,
            vault,
            hitz,
            xlm,
            usdc,
        }
    }

    fn user(&self, hitz: i128, xlm: i128, usdc: i128) -> Address {
        let a = Address::generate(&self.env);
        if hitz > 0 {
            self.hitz.mint(&a, &hitz);
        }
        if xlm > 0 {
            StellarAssetClient::new(&self.env, &self.xlm).mint(&a, &xlm);
        }
        if usdc > 0 {
            StellarAssetClient::new(&self.env, &self.usdc).mint(&a, &usdc);
        }
        a
    }

    fn hitz_addr(&self) -> Address {
        self.hitz.address.clone()
    }

    fn bal(&self, token: &Address, who: &Address) -> i128 {
        TokenClient::new(&self.env, token).balance(who)
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|l| l.timestamp += secs);
    }

    fn swap(&self, who: &Address, tin: &Address, tout: &Address, amount: i128) -> i128 {
        self.vault.swap(who, who, tin, tout, &amount, &0)
    }

    /// Reserves must equal what the vault actually holds, and the token's
    /// mass must equal the vault's HITZ (it is the only registered pool).
    fn assert_books_balance(&self) {
        let r = self.vault.reserves();
        let me = self.vault.address.clone();
        assert_eq!(r.hitz_xlm + r.hitz_usdc, self.hitz.balance(&me));
        assert_eq!(r.xlm, self.bal(&self.xlm, &me));
        assert_eq!(r.usdc, self.bal(&self.usdc, &me));
        assert_eq!(self.hitz.total_mass(), self.hitz.balance(&me));
    }
}

/// The host error a `panic_with_error!(Error::X)` surfaces as.
fn ce(e: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

fn k(h: i128, q: i128) -> u128 {
    (h as u128) * (q as u128)
}

/// What a fee-free constant-product leg would pay.
fn gross_out(r_in: i128, r_out: i128, amount_in: i128) -> i128 {
    r_out * amount_in / (r_in + amount_in)
}

fn approx(a: i128, b: i128, tol: i128) -> bool {
    (a - b).abs() <= tol
}

// ─────────────────────────────────────────────────────────────
//  FIXED-POINT MATH
// ─────────────────────────────────────────────────────────────

#[test]
fn anchor_memory_is_a_true_exponential() {
    // After one time constant the old anchor keeps e^-1 of its weight.
    let w = pow_sat(ANCHOR_DECAY_PER_SEC, ANCHOR_TAU_SECS, ONE);
    let e_inv = (ONE as f64 * (-1f64).exp()) as i128;
    assert!(approx(w, e_inv, ONE / 1_000_000), "{w} vs {e_inv}");
    // Updating in pieces gives the same answer as updating once, so
    // nobody can speed the anchor up by trading more often.
    let whole = pow_sat(ANCHOR_DECAY_PER_SEC, 5_000, ONE);
    let parts =
        pow_sat(ANCHOR_DECAY_PER_SEC, 1_234, ONE) * pow_sat(ANCHOR_DECAY_PER_SEC, 3_766, ONE) / ONE;
    assert!(approx(whole, parts, 20));
    assert_eq!(pow_sat(ANCHOR_DECAY_PER_SEC, 0, ONE), ONE);
    assert_eq!(pow_sat(ANCHOR_DECAY_PER_SEC, 10_000_000, ONE), 0);
}

#[test]
fn fee_curve_is_floor_at_anchor_and_exponential_away_from_it() {
    let a = 220_000_000; // 0.22 USDC per XLM
    assert_eq!(fee_for_price(a, a), FEE_FLOOR);
    // Symmetric in log terms: x1.01 and /1.01 cost the same.
    let up = fee_for_price(a * 101 / 100, a);
    let down = fee_for_price(a * 100 / 101, a);
    assert!(approx(up, down, 2_000), "{up} vs {down}");
    // 1% away: ~2.7x the floor. 2% away: ~7.2x.
    assert!(approx(up, 27_048_138, 20_000), "{up}");
    let two = fee_for_price(a * 102 / 100, a);
    assert!(approx(two, 72_446_461, 60_000), "{two}");
    // Capped at 10%.
    assert_eq!(fee_for_price(a * 105 / 100, a), FEE_CAP);
    assert_eq!(fee_for_price(a * 2, a), FEE_CAP);
    // Monotonic.
    let mut last = 0;
    for bps in 0..400 {
        let f = fee_for_price(a + a * bps / 10_000, a);
        assert!(f >= last);
        last = f;
    }
}

// ─────────────────────────────────────────────────────────────
//  SEEDING
// ─────────────────────────────────────────────────────────────

#[test]
fn seeding_sets_prices_and_a_calm_anchor() {
    let w = World::new();
    let m = w.vault.market();
    assert_eq!(m.fee, FEE_FLOOR);
    assert_eq!(m.anchor_price, m.xlm_price);
    // (1230 / 31.2M) / (10200 / 57.3M) = 0.22147 USDC per XLM
    assert!(approx(m.xlm_price, 221_464_932, 2), "{}", m.xlm_price);
    assert_eq!(w.hitz.total_mass(), SEED_HITZ_XLM + SEED_HITZ_USDC);
    w.assert_books_balance();
}

#[test]
fn seeding_happens_once() {
    let w = World::new();
    StellarAssetClient::new(&w.env, &w.xlm).mint(&w.admin, &U);
    StellarAssetClient::new(&w.env, &w.usdc).mint(&w.admin, &U);
    w.hitz.mint(&w.admin, &(2 * U));
    assert_eq!(
        w.vault.try_seed(&U, &U, &U, &U),
        Err(Ok(ce(Error::AlreadySeeded)))
    );
}

#[test]
fn nothing_trades_before_seeding() {
    let w = World::unseeded();
    let alice = w.user(0, 100 * U, 0);
    assert_eq!(
        w.vault
            .try_swap(&alice, &alice, &w.xlm, &w.hitz_addr(), &U, &0),
        Err(Ok(ce(Error::NotSeeded)))
    );
    assert_eq!(
        w.vault.try_deposit(&alice, &XLM_POOL, &U, &0, &U),
        Err(Ok(ce(Error::NotSeeded)))
    );
}

// ─────────────────────────────────────────────────────────────
//  SWAPS AND THE FEE
// ─────────────────────────────────────────────────────────────

#[test]
fn small_trades_pay_the_floor_and_the_fee_stays_on_the_drained_side() {
    let w = World::new();
    let alice = w.user(0, 10 * U, 0);
    let before = w.vault.reserves();

    // Buy HITZ with 10 XLM: HITZ is the side being drained.
    let out = w.swap(&alice, &w.xlm, &w.hitz_addr(), 10 * U);
    let gross = gross_out(before.xlm, before.hitz_xlm, 10 * U);
    // Moves the vault's XLM price ~0.2%: fee ~1.2%, close to the floor.
    let fee = gross - out;
    assert!(
        fee * 1000 / gross >= 10 && fee * 1000 / gross <= 13,
        "fee {fee} of {gross}"
    );

    let after = w.vault.reserves();
    assert_eq!(after.xlm, before.xlm + 10 * U);
    // Only `out` left the HITZ reserve: the fee stayed in HITZ.
    assert_eq!(after.hitz_xlm, before.hitz_xlm - out);
    assert_eq!(w.hitz.balance(&alice), out);
    assert!(k(after.hitz_xlm, after.xlm) > k(before.hitz_xlm, before.xlm));
    // The other pool is untouched.
    assert_eq!(after.hitz_usdc, before.hitz_usdc);
    assert_eq!(after.usdc, before.usdc);
    w.assert_books_balance();
}

#[test]
fn every_pair_routes_and_quotes_match() {
    let w = World::new();
    let h = w.hitz_addr();
    let alice = w.user(1_000_000 * U, 100 * U, 100 * U);
    let pairs = [
        (h.clone(), w.xlm.clone(), 100_000 * U),
        (w.xlm.clone(), h.clone(), 5 * U),
        (h.clone(), w.usdc.clone(), 100_000 * U),
        (w.usdc.clone(), h.clone(), U),
        (w.xlm.clone(), w.usdc.clone(), 5 * U),
        (w.usdc.clone(), w.xlm.clone(), U),
    ];
    for (tin, tout, amt) in pairs.iter() {
        let q = w.vault.quote(tin, tout, amt);
        let before = w.bal(tout, &alice);
        let out = w.swap(&alice, tin, tout, *amt);
        assert_eq!(q, out);
        assert_eq!(w.bal(tout, &alice) - before, out);
        assert!(out > 0);
        w.assert_books_balance();
        w.advance(60);
    }
}

#[test]
fn xlm_usdc_swaps_pass_through_hitz_without_moving_it() {
    let w = World::new();
    let alice = w.user(0, 20 * U, 0);
    let before = w.vault.reserves();
    let mass = w.hitz.total_mass();

    let out = w.swap(&alice, &w.xlm, &w.usdc, 20 * U);
    assert!(out > 0);
    let after = w.vault.reserves();
    // HITZ moved from one pool to the other inside the vault, minus the
    // HITZ fee kept by the XLM pool.
    assert!(after.hitz_xlm < before.hitz_xlm);
    assert!(after.hitz_usdc > before.hitz_usdc);
    assert_eq!(
        after.hitz_xlm + after.hitz_usdc,
        before.hitz_xlm + before.hitz_usdc
    );
    // No HITZ left the vault, so the mass did not change.
    assert_eq!(w.hitz.total_mass(), mass);
    assert_eq!(w.bal(&w.usdc, &alice), out);
    w.assert_books_balance();
}

#[test]
fn the_fee_climbs_with_the_move_and_decays_back() {
    let w = World::new();
    let alice = w.user(0, 1_000 * U, 0);
    let r0 = w.vault.reserves();

    // A big XLM -> HITZ buy drags the vault's XLM price ~2% below the anchor.
    let amt = 105 * U;
    let out = w.swap(&alice, &w.xlm, &w.hitz_addr(), amt);
    let gross = gross_out(r0.xlm, r0.hitz_xlm, amt);
    let paid = (gross - out) * ONE / gross;
    assert!(paid > 6 * FEE_FLOOR && paid <= FEE_CAP, "fee rate {paid}");

    // The next small trade sees an elevated fee too...
    let m1 = w.vault.market();
    assert!(m1.fee > 5 * FEE_FLOOR, "{}", m1.fee);
    // ...which decays as the anchor catches up: after one time constant
    // the gap in log terms is ~e^-1 of what it was.
    w.advance(ANCHOR_TAU_SECS);
    let m2 = w.vault.market();
    assert!(m2.fee < m1.fee && m2.fee > FEE_FLOOR);
    // After a day the market is calm again.
    w.advance(22 * 3600);
    assert!(approx(w.vault.market().fee, FEE_FLOOR, FEE_FLOOR / 1000));
}

#[test]
fn splitting_cannot_dodge_the_fee_you_pay_for_how_far_the_price_moves() {
    // One trade that drags the price 2%...
    let a = World::new();
    let alice = a.user(0, 1_000 * U, 0);
    let one_shot = a.swap(&alice, &a.xlm, &a.hitz_addr(), 105 * U);

    // ...versus the same size in ten pieces in the same ledger.
    let b = World::new();
    let bob = b.user(0, 1_000 * U, 0);
    let mut pieces = 0;
    let mut first_fee = 0;
    let mut last_fee = 0;
    for i in 0..10 {
        let r = b.vault.reserves();
        let out = b.swap(&bob, &b.xlm, &b.hitz_addr(), 10 * U + U / 2);
        let gross = gross_out(r.xlm, r.hitz_xlm, 10 * U + U / 2);
        let rate = (gross - out) * ONE / gross;
        if i == 0 {
            first_fee = rate;
        }
        last_fee = rate;
        pieces += out;
    }
    // The later pieces pay the same steep fee the single trade paid at
    // the end; there is no size threshold to slip under.
    assert!(
        last_fee > 6 * first_fee,
        "first {first_fee} last {last_fee}"
    );
    // Splitting only recovers the overcharge of pricing a whole trade at
    // its end point: the pieces still pay far above the floor overall.
    let r0_gross = gross_out(SEED_XLM, SEED_HITZ_XLM, 105 * U);
    let piece_fee = (r0_gross - pieces) * ONE / r0_gross;
    let shot_fee = (r0_gross - one_shot) * ONE / r0_gross;
    assert!(pieces >= one_shot);
    assert!(
        piece_fee > 3 * FEE_FLOOR,
        "split pays {piece_fee}, one shot {shot_fee}"
    );
}

#[test]
fn round_trips_lose_money() {
    let w = World::new();
    let alice = w.user(0, 100 * U, 0);
    let h = w.hitz_addr();
    let got = w.swap(&alice, &w.xlm, &h, 50 * U);
    let back = w.swap(&alice, &h, &w.xlm, got);
    assert!(back < 50 * U);
    let usdc = w.swap(&alice, &w.xlm, &w.usdc, 20 * U);
    let xlm_back = w.swap(&alice, &w.usdc, &w.xlm, usdc);
    assert!(xlm_back < 20 * U);
    w.assert_books_balance();
}

#[test]
fn bad_inputs_are_rejected() {
    let w = World::new();
    let h = w.hitz_addr();
    let alice = w.user(0, 100 * U, 0);
    let me = w.vault.address.clone();
    let q = w.vault.quote(&w.xlm, &h, &U);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &h, &U, &(q + 1)),
        Err(Ok(ce(Error::Slippage)))
    );
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &h, &0, &0),
        Err(Ok(ce(Error::InvalidAmount)))
    );
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &h, &h, &U, &0),
        Err(Ok(ce(Error::UnsupportedPair)))
    );
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &stranger, &h, &U, &0),
        Err(Ok(ce(Error::UnsupportedPair)))
    );
    assert_eq!(
        w.vault.try_swap(&me, &alice, &w.xlm, &h, &U, &0),
        Err(Ok(ce(Error::InvalidAddress)))
    );
    assert_eq!(
        w.vault.try_swap(&alice, &me, &w.xlm, &h, &U, &0),
        Err(Ok(ce(Error::InvalidAddress)))
    );
    // A trade too small to produce any output after the fee.
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &h, &w.usdc, &1, &0),
        Err(Ok(ce(Error::TradeTooSmall)))
    );
}

// ─────────────────────────────────────────────────────────────
//  DEPOSITS
// ─────────────────────────────────────────────────────────────

#[test]
fn deposits_add_at_the_current_ratio_and_never_come_out() {
    let w = World::new();
    let fan = w.user(1_000_000 * U, 1_000 * U, 0);
    let before = w.vault.reserves();
    let price = w.vault.market().xlm_price;

    let need = (1_000_000 * U * before.xlm + before.hitz_xlm - 1) / before.hitz_xlm;
    let paid = w.vault.deposit(
        &fan,
        &XLM_POOL,
        &(1_000_000 * U),
        &(need - 10),
        &(need + 10),
    );
    assert_eq!(paid, need);

    let after = w.vault.reserves();
    assert_eq!(after.hitz_xlm, before.hitz_xlm + 1_000_000 * U);
    assert_eq!(after.xlm, before.xlm + need);
    // The price doesn't move (rounding is in the vault's favour).
    assert!(approx(w.vault.market().xlm_price, price, 2));
    w.assert_books_balance();
}

#[test]
fn deposits_refuse_a_moved_price() {
    let w = World::new();
    let fan = w.user(1_000_000 * U, 1_000 * U, 1_000 * U);
    let r = w.vault.reserves();
    let need = (1_000_000 * U * r.xlm + r.hitz_xlm - 1) / r.hitz_xlm;
    // Someone moved the price: the deposit's range no longer matches.
    assert_eq!(
        w.vault
            .try_deposit(&fan, &XLM_POOL, &(1_000_000 * U), &0, &(need - 1)),
        Err(Ok(ce(Error::PriceOutOfRange)))
    );
    assert_eq!(
        w.vault.try_deposit(
            &fan,
            &XLM_POOL,
            &(1_000_000 * U),
            &(need + 1),
            &(need + 100)
        ),
        Err(Ok(ce(Error::PriceOutOfRange)))
    );
    assert_eq!(
        w.vault.try_deposit(&fan, &7, &U, &0, &U),
        Err(Ok(ce(Error::InvalidPool)))
    );
    // USDC pool works the same way.
    let r = w.vault.reserves();
    let need_usdc = (1_000 * U * r.usdc + r.hitz_usdc - 1) / r.hitz_usdc;
    assert_eq!(
        w.vault
            .deposit(&fan, &USDC_POOL, &(1_000 * U), &need_usdc, &need_usdc),
        need_usdc
    );
    w.assert_books_balance();
}

// ─────────────────────────────────────────────────────────────
//  GRAVITY
// ─────────────────────────────────────────────────────────────

#[test]
fn vaulted_holders_can_always_sell_into_the_vault() {
    let w = World::new();
    // L = sqrt(S) ~ 9,400 HITZ at this mass. The whale holds far more.
    let whale = w.user(0, 0, 0);
    w.hitz.mint(&whale, &(5_000_000 * U));
    assert!(w.hitz.is_account_vaulted(&whale));
    let friend = Address::generate(&w.env);
    assert!(w.hitz.try_transfer(&whale, &friend, &U).is_err());

    // Selling into the vault is the one door that's always open.
    let out = w.swap(&whale, &w.hitz_addr(), &w.usdc, 50_000 * U);
    assert!(out > 0);
    w.assert_books_balance();
}

#[test]
fn big_buyers_get_vaulted_but_the_swap_goes_through() {
    let w = World::new();
    let buyer = w.user(0, 0, 200 * U);
    let out = w.swap(&buyer, &w.usdc, &w.hitz_addr(), 200 * U);
    assert!(out > w.hitz.safety_limit());
    assert!(w.hitz.is_account_vaulted(&buyer));
    w.assert_books_balance();
}

// ─────────────────────────────────────────────────────────────
//  INVARIANTS UNDER RANDOM TRADING
// ─────────────────────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn invariants_hold_under_random_trading() {
    for seed in 1..=4u64 {
        let w = World::new();
        let h = w.hitz_addr();
        let trader = w.user(10_000_000 * U, 5_000 * U, 1_000 * U);
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let tokens = [h.clone(), w.xlm.clone(), w.usdc.clone()];
        let mut last = w.vault.reserves();
        let mut done = 0;
        let mut peak_fee = 0;
        for _ in 0..150 {
            w.advance(rng.below(900));
            let i = rng.below(3) as usize;
            let mut j = rng.below(3) as usize;
            if j == i {
                j = (j + 1) % 3;
            }
            let held = w.bal(&tokens[i], &trader);
            // 0.01% to 5% of the trader's balance in that token
            let amt = held * (1 + rng.below(500) as i128) / 10_000;
            if amt <= 0 {
                continue;
            }
            match w
                .vault
                .try_swap(&trader, &trader, &tokens[i], &tokens[j], &amt, &0)
            {
                Ok(Ok(_)) => {}
                Err(Ok(e)) if e == ce(Error::TradeTooSmall) => continue,
                other => panic!("unexpected {:?}", other),
            }
            let r = w.vault.reserves();
            // k never falls in either pool.
            assert!(k(r.hitz_xlm, r.xlm) >= k(last.hitz_xlm, last.xlm));
            assert!(k(r.hitz_usdc, r.usdc) >= k(last.hitz_usdc, last.usdc));
            let m = w.vault.market();
            assert!(m.fee >= FEE_FLOOR && m.fee <= FEE_CAP);
            peak_fee = peak_fee.max(m.fee);
            w.assert_books_balance();
            last = r;
            done += 1;
        }
        // The run really traded, and moved the fee off the floor.
        assert!(done > 120, "only {done} swaps");
        assert!(peak_fee > 2 * FEE_FLOOR, "peak fee {peak_fee}");
    }
}

// ─────────────────────────────────────────────────────────────
//  ADMIN: TIMELOCKED UPGRADE, RENOUNCE
// ─────────────────────────────────────────────────────────────

const OTHER_WASM: &[u8] = include_bytes!("../../gravity-token/test_fixtures/pool_v1.wasm");

#[test]
fn upgrades_wait_seven_days() {
    let w = World::new();
    let hash = w.env.deployer().upload_contract_wasm(OTHER_WASM);
    assert_eq!(
        w.vault.try_upgrade(&hash),
        Err(Ok(ce(Error::NoPendingUpgrade)))
    );

    w.vault.propose_upgrade(&hash);
    let p = w.vault.pending_upgrade().unwrap();
    assert_eq!(p.wasm_hash, hash);
    w.advance(UPGRADE_DELAY_SECS - 1);
    assert_eq!(
        w.vault.try_upgrade(&hash),
        Err(Ok(ce(Error::TimelockActive)))
    );
    w.advance(1);
    let other = w.env.deployer().upload_contract_wasm(
        include_bytes!("../../gravity-token/test_fixtures/pool_v2.wasm").as_slice(),
    );
    assert_eq!(
        w.vault.try_upgrade(&other),
        Err(Ok(ce(Error::UpgradeHashMismatch)))
    );
    w.vault.upgrade(&hash);
    match w.vault.address.executable() {
        Some(soroban_sdk::Executable::Wasm(h)) => assert_eq!(h, hash),
        _ => panic!("vault should run the proposed code"),
    }
}

#[test]
fn cancelling_clears_the_proposal() {
    let w = World::new();
    let hash = w.env.deployer().upload_contract_wasm(OTHER_WASM);
    w.vault.propose_upgrade(&hash);
    w.vault.cancel_upgrade();
    assert_eq!(w.vault.pending_upgrade(), None);
    w.advance(UPGRADE_DELAY_SECS);
    assert_eq!(
        w.vault.try_upgrade(&hash),
        Err(Ok(ce(Error::NoPendingUpgrade)))
    );
    assert_eq!(
        w.vault.try_cancel_upgrade(),
        Err(Ok(ce(Error::NoPendingUpgrade)))
    );
}

#[test]
fn renouncing_makes_the_vault_immutable_and_trading_carries_on() {
    let w = World::new();
    let hash = w.env.deployer().upload_contract_wasm(OTHER_WASM);
    w.vault.propose_upgrade(&hash);
    w.vault.renounce();
    assert_eq!(w.vault.admin(), None);
    assert_eq!(w.vault.pending_upgrade(), None);
    w.advance(UPGRADE_DELAY_SECS);
    assert_eq!(w.vault.try_upgrade(&hash), Err(Ok(ce(Error::Renounced))));
    assert_eq!(
        w.vault.try_propose_upgrade(&hash),
        Err(Ok(ce(Error::Renounced)))
    );
    assert_eq!(w.vault.try_renounce(), Err(Ok(ce(Error::Renounced))));

    let alice = w.user(0, 10 * U, 0);
    assert!(w.swap(&alice, &w.xlm, &w.hitz_addr(), 10 * U) > 0);
    w.assert_books_balance();
}

#[test]
fn renouncing_before_seeding_leaves_an_empty_vault() {
    let w = World::unseeded();
    w.vault.renounce();
    assert_eq!(
        w.vault
            .try_seed(&SEED_HITZ_XLM, &SEED_XLM, &SEED_HITZ_USDC, &SEED_USDC),
        Err(Ok(ce(Error::Renounced)))
    );
}

// ─────────────────────────────────────────────────────────────
//  AUTHORIZATION (the tests above mock every signature)
// ─────────────────────────────────────────────────────────────

#[test]
fn swaps_need_exactly_the_traders_signature() {
    let w = World::new();
    let alice = w.user(0, 100 * U, 0);
    let bob = Address::generate(&w.env);
    w.vault.swap(&alice, &bob, &w.xlm, &w.usdc, &(10 * U), &0);
    // Alice signs the swap with all its terms (recipient, pair, size,
    // minimum out) and the one transfer it pulls from her. The payout to
    // Bob needs nobody's signature but the vault's own.
    assert_eq!(
        w.env.auths(),
        std::vec![(
            alice.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    w.vault.address.clone(),
                    Symbol::new(&w.env, "swap"),
                    (
                        alice.clone(),
                        bob.clone(),
                        w.xlm.clone(),
                        w.usdc.clone(),
                        10 * U,
                        0i128
                    )
                        .into_val(&w.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        w.xlm.clone(),
                        Symbol::new(&w.env, "transfer"),
                        (alice.clone(), w.vault.address.clone(), 10 * U).into_val(&w.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            }
        )]
    );

    // Without her signature nothing moves.
    w.env.set_auths(&[]);
    assert!(w
        .vault
        .try_swap(&alice, &alice, &w.xlm, &w.usdc, &U, &0)
        .is_err());
    assert!(w.vault.try_deposit(&alice, &XLM_POOL, &U, &0, &U).is_err());
}

#[test]
fn deposits_need_the_depositors_signature() {
    let w = World::new();
    let fan = w.user(1_000 * U, 10 * U, 0);
    w.vault
        .deposit(&fan, &XLM_POOL, &(1_000 * U), &0, &(10 * U));
    let auths = w.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, fan);
}

#[test]
fn admin_actions_need_the_admins_signature() {
    let hash_of = |w: &World| w.env.deployer().upload_contract_wasm(OTHER_WASM);
    let signer = |w: &World| {
        let a = w.env.auths();
        assert_eq!(a.len(), 1);
        a[0].0.clone()
    };

    let w = World::unseeded();
    w.vault
        .seed(&SEED_HITZ_XLM, &SEED_XLM, &SEED_HITZ_USDC, &SEED_USDC);
    assert_eq!(signer(&w), w.admin);
    let hash = hash_of(&w);
    w.vault.propose_upgrade(&hash);
    assert_eq!(signer(&w), w.admin);
    w.vault.cancel_upgrade();
    assert_eq!(signer(&w), w.admin);
    w.vault.renounce();
    assert_eq!(signer(&w), w.admin);

    // Nobody else's signature is enough.
    let w = World::unseeded();
    let hash = hash_of(&w);
    w.env.set_auths(&[]);
    assert!(w
        .vault
        .try_seed(&SEED_HITZ_XLM, &SEED_XLM, &SEED_HITZ_USDC, &SEED_USDC)
        .is_err());
    assert!(w.vault.try_propose_upgrade(&hash).is_err());
    assert!(w.vault.try_renounce().is_err());
    assert_eq!(w.vault.admin(), Some(w.admin.clone()));
}

// ─────────────────────────────────────────────────────────────
//  GOLDEN VECTORS (shared with research/vault-backtest)
// ─────────────────────────────────────────────────────────────

/// A fixed trade sequence on reserves shaped like the live Aquarius pools.
/// Each row: amount out, the four reserves, then `market()` (XLM price,
/// anchor, fee). Any change to the swap or fee math changes these numbers,
/// and research/vault-backtest/vaultmath.py must reproduce them exactly
/// (`python3 research/vault-backtest/vaultmath.py --check`).
#[test]
fn fee_math_matches_the_golden_vectors() {
    let w = World::unseeded();
    let (hx, x, hu, u) = (
        576_979_786_994_794,
        108_590_621_387,
        307_270_480_999_958,
        12_733_312_293,
    );
    // The world pre-mints the default seed; top up what these reserves need.
    assert!(hx + hu <= SEED_HITZ_XLM + SEED_HITZ_USDC);
    StellarAssetClient::new(&w.env, &w.xlm).mint(&w.admin, &(x - SEED_XLM));
    StellarAssetClient::new(&w.env, &w.usdc).mint(&w.admin, &(u - SEED_USDC));
    w.vault.seed(&hx, &x, &hu, &u);
    let t = w.user(10_000_000 * U, 100_000 * U, 100_000 * U);
    let (h, xl, us) = (w.hitz_addr(), w.xlm.clone(), w.usdc.clone());
    let steps: [(u64, &Address, &Address, i128); 12] = [
        (0, &xl, &us, 50 * U),
        (300, &us, &xl, 10 * U),
        (3_600, &xl, &h, 100 * U),
        (0, &h, &us, 1_000_000 * U),
        (7_200, &us, &h, 5 * U),
        (86_400, &xl, &us, 500 * U),
        (5, &xl, &us, 3 * U + 1_234),
        (1_800, &us, &xl, 40 * U),
        (17, &us, &xl, 7 * U),
        (100_000, &h, &xl, 3_000_000 * U),
        (61, &xl, &us, U),
        (3, &us, &xl, 123_456_789),
    ];
    let expected: [[i128; 8]; 12] = [
        [
            95_357_378,
            574_401_566_309_723,
            109_090_621_387,
            309_848_701_685_029,
            12_637_954_915,
            214_760_952,
            220_185_558,
            100_000_000,
        ],
        [
            445_114_018,
            576_778_952_628_527,
            108_645_507_369,
            307_471_315_366_225,
            12_737_954_915,
            219_934_182,
            219_964_176,
            10_137_302,
        ],
        [
            4_928_942_487_090,
            571_850_010_141_437,
            109_645_507_369,
            307_471_315_366_225,
            12_737_954_915,
            216_065_980,
            219_952_374,
            59_460_177,
        ],
        [
            361_108_511,
            571_850_010_141_437,
            109_645_507_369,
            317_471_315_366_225,
            12_376_846_404,
            203_327_818,
            219_952_374,
            100_000_000,
        ],
        [
            1_166_910_435_081,
            571_850_010_141_437,
            109_645_507_369,
            316_304_404_931_144,
            12_426_846_404,
            204_902_370,
            209_443_648,
            89_540_845,
        ],
        [
            741_073_549,
            549_404_080_033_126,
            114_645_507_369,
            338_750_335_039_455,
            11_685_772_855,
            165_315_108,
            204_902_397,
            100_000_000,
        ],
        [
            4_014_738,
            549_274_719_191_306,
            114_675_508_603,
            338_879_695_881_275,
            11_681_758_117,
            165_113_124,
            204_874_915,
            100_000_000,
        ],
        [
            1_863_074_107,
            559_372_313_377_171,
            112_812_434_496,
            328_782_101_695_410,
            12_081_758_117,
            182_207_380,
            196_079_636,
            100_000_000,
        ],
        [
            308_451_382,
            561_076_862_810_049,
            112_503_983_114,
            327_077_552_262_532,
            12_151_758_117,
            185_286_099,
            196_046_920,
            100_000_000,
        ],
        [
            5_139_107_508,
            591_076_862_810_049,
            107_364_875_606,
            327_077_552_262_532,
            12_151_758_117,
            204_536_166,
            185_286_108,
            100_000_000,
        ],
        [
            1_656_337,
            591_027_319_639_590,
            107_374_875_606,
            327_127_095_432_991,
            12_150_101_780,
            204_441_133,
            185_448_510,
            100_000_000,
        ],
        [
            481_804_063,
            593_988_763_503_894,
            106_893_071_543,
            324_165_651_568_687,
            12_273_558_569,
            210_393_431,
            185_456_422,
            100_000_000,
        ],
    ];
    for ((dt, tin, tout, amt), want) in steps.iter().zip(expected.iter()) {
        w.advance(*dt);
        let out = w.swap(&t, tin, tout, *amt);
        let r = w.vault.reserves();
        let m = w.vault.market();
        let got = [
            out,
            r.hitz_xlm,
            r.xlm,
            r.hitz_usdc,
            r.usdc,
            m.xlm_price,
            m.anchor_price,
            m.fee,
        ];
        assert_eq!(&got, want);
    }
}
