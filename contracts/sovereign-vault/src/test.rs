#![cfg(test)]
extern crate std;

use super::*;
use gravity_token::{GravityToken, GravityTokenClient};
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, Env, IntoVal, String, Symbol,
};

/// One unit of any 7-decimal Stellar asset (HITZ, XLM, USDC, EURC).
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
    /// XLM and USDC, seeded like the Aquarius pools.
    fn new() -> World {
        let w = World::unseeded();
        w.seed(&w.xlm.clone(), SEED_HITZ_XLM, SEED_XLM);
        w.seed(&w.usdc.clone(), SEED_HITZ_USDC, SEED_USDC);
        w
    }

    /// XLM and USDC at half that size, leaving HITZ supply for a third pool.
    fn half() -> World {
        let w = World::unseeded();
        w.seed(&w.xlm.clone(), SEED_HITZ_XLM / 2, SEED_XLM / 2);
        w.seed(&w.usdc.clone(), SEED_HITZ_USDC / 2, SEED_USDC / 2);
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
            (
                admin.clone(),
                hitz_id.clone(),
                vec![&env, xlm.clone(), usdc.clone()],
            ),
        );
        let vault = SovereignVaultClient::new(&env, &vault_id);

        // The vault is HITZ's pool: its HITZ is the mass, and vaulted
        // holders can always sell into it.
        hitz.register_pool_address(&vault_id);

        World {
            env,
            admin,
            vault,
            hitz,
            xlm,
            usdc,
        }
    }

    /// Mint the seed to the admin and seed `asset`'s pool with it.
    fn seed(&self, asset: &Address, hitz: i128, amount: i128) {
        self.hitz.mint(&self.admin, &hitz);
        StellarAssetClient::new(&self.env, asset).mint(&self.admin, &amount);
        self.vault.seed(asset, &hitz, &amount);
    }

    /// A new Stellar asset contract, not listed.
    fn new_asset(&self) -> Address {
        self.env
            .register_stellar_asset_contract_v2(self.admin.clone())
            .address()
    }

    /// Propose, wait out the timelock, list.
    fn list(&self, asset: &Address) {
        self.vault.propose_listing(asset);
        self.advance(UPGRADE_DELAY_SECS);
        self.vault.list_asset(asset);
    }

    fn user(&self, hitz: i128, assets: &[(&Address, i128)]) -> Address {
        let a = Address::generate(&self.env);
        if hitz > 0 {
            self.hitz.mint(&a, &hitz);
        }
        for (asset, amount) in assets {
            StellarAssetClient::new(&self.env, asset).mint(&a, amount);
        }
        a
    }

    fn h(&self) -> Address {
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

    fn pool(&self, asset: &Address) -> PoolState {
        self.vault.pool(asset)
    }

    /// Reserves must equal what the vault actually holds, and the token's
    /// mass must equal the vault's HITZ (it is the only registered pool).
    fn assert_books_balance(&self) {
        let me = self.vault.address.clone();
        let mut hitz = 0;
        for p in self.vault.pools().iter() {
            hitz += p.hitz;
            assert_eq!(p.reserve, self.bal(&p.asset, &me));
        }
        assert_eq!(hitz, self.hitz.balance(&me));
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

/// A natural log in 18 decimals, for readable thresholds.
fn wad(x: f64) -> i128 {
    (x * WAD as f64) as i128
}

// ─────────────────────────────────────────────────────────────
//  FIXED-POINT MATH
// ─────────────────────────────────────────────────────────────

#[test]
fn ln_ratio_matches_the_real_logarithm() {
    let cases: [(i128, i128); 10] = [
        (1, 1),
        (2, 1),
        (1, 2),
        (3, 7),
        (1_000_000_000_000_001, 1_000_000_000_000_000),
        (10_200 * U, 57_300_000 * U),
        (57_300_000 * U, 10_200 * U),
        (i128::MAX / 3, 17),
        (17, i128::MAX / 3),
        (123_456_789_123_456_789, 987_654_321),
    ];
    for (a, b) in cases {
        let got = ln_ratio(a, b) as f64 / WAD as f64;
        let want = (a as f64).ln() - (b as f64).ln();
        assert!(
            (got - want).abs() <= 1e-12 * want.abs().max(1.0),
            "ln({a}/{b}) = {got}, want {want}"
        );
    }
    assert_eq!(ln_ratio(5, 5), 0);
    // Antisymmetric to the last unit or two.
    assert!((ln_ratio(3, 7) + ln_ratio(7, 3)).abs() <= 2);
}

#[test]
fn the_fee_is_floor_times_e_to_the_dislocation_and_rounds_up() {
    assert_eq!(fee_for_dislocation(0), FEE_FLOOR);
    for x in [0.0005f64, 0.001, 0.005, 0.01, 0.015, 0.02, 0.023] {
        let got = fee_for_dislocation(wad(x));
        let exact = FEE_FLOOR as f64 * (STEEPNESS as f64 * x).exp();
        assert!(got as f64 >= exact - 1.0, "fee({x}) = {got} < {exact}");
        assert!(got as f64 <= exact + 2.0, "fee({x}) = {got} vs {exact}");
    }
    // Symmetric: only the size of the dislocation matters.
    assert_eq!(
        fee_for_dislocation(wad(0.01)),
        fee_for_dislocation(-wad(0.01))
    );
    // 1% dislocation: ~2.72x the floor. 2%: ~7.39x.
    assert!(approx(fee_for_dislocation(wad(0.01)), 27_182_818, 3));
    assert!(approx(fee_for_dislocation(wad(0.02)), 73_890_561, 3));
    // Capped from ln(10)/100 = 2.3026% on.
    assert_eq!(fee_for_dislocation(wad(0.0231)), FEE_CAP);
    assert_eq!(fee_for_dislocation(wad(0.5)), FEE_CAP);
    assert_eq!(fee_for_dislocation(i128::MAX), FEE_CAP);
    // Monotonic up to the cap.
    let mut last = 0;
    for bp in 0..300 {
        let f = fee_for_dislocation(wad(bp as f64 / 10_000.0));
        assert!(f >= last);
        last = f;
    }
}

#[test]
fn deviations_decay_as_a_true_exponential() {
    // After one time constant a deviation keeps e^-1 of its size.
    let d = wad(0.02);
    let after = decayed(d, ANCHOR_TAU_SECS) as f64 / d as f64;
    assert!((after - (-1f64).exp()).abs() < 1e-6, "{after}");
    // Decaying in pieces equals decaying once, so trading more often can't
    // speed it up.
    let whole = decayed(d, 5_000);
    let parts = decayed(decayed(d, 1_234), 3_766);
    assert!(approx(whole, parts, d / 1_000_000_000));
    assert_eq!(decayed(d, 0), d);
    assert_eq!(decayed(d, 10_000_000), 0);
    assert_eq!(decayed(-d, ANCHOR_TAU_SECS), -decayed(d, ANCHOR_TAU_SECS));
}

// ─────────────────────────────────────────────────────────────
//  CONSTRUCTION, SEEDING AND LISTING
// ─────────────────────────────────────────────────────────────

fn deploy(assets: fn(&Env, &Address) -> Vec<Address>) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let hitz = Address::generate(&env);
    let list = assets(&env, &hitz);
    env.register(SovereignVault, (admin, hitz, list));
}

#[test]
#[should_panic]
fn the_vault_needs_at_least_one_asset() {
    deploy(|env, _| Vec::new(env));
}

#[test]
#[should_panic]
fn the_vault_refuses_duplicate_assets() {
    deploy(|env, _| {
        let a = Address::generate(env);
        vec![env, a.clone(), a]
    });
}

#[test]
#[should_panic]
fn the_vault_refuses_hitz_as_an_asset() {
    deploy(|env, hitz| vec![env, hitz.clone()]);
}

#[test]
#[should_panic]
fn the_vault_refuses_more_than_max_assets() {
    deploy(|env, _| {
        let mut v = Vec::new(env);
        for _ in 0..=MAX_ASSETS {
            v.push_back(Address::generate(env));
        }
        v
    });
}

#[test]
fn seeding_sets_prices_and_calm_anchors() {
    let w = World::new();
    for p in w.vault.pools().iter() {
        assert_eq!(p.fee, FEE_FLOOR);
        assert_eq!(p.dislocation, 0);
        assert_eq!(p.deviation, 0);
    }
    // (1230 / 31.2M) / (10200 / 57.3M) = 0.22147 USDC per XLM
    assert!(approx(w.vault.rate(&w.xlm, &w.usdc), 221_464_932, 2));
    assert_eq!(w.vault.dislocation(&w.xlm, &w.usdc), 0);
    assert_eq!(w.hitz.total_mass(), SEED_HITZ_XLM + SEED_HITZ_USDC);
    assert_eq!(
        w.vault.assets(),
        vec![&w.env, w.xlm.clone(), w.usdc.clone()]
    );
    assert_eq!(w.vault.hitz(), w.h());
    w.assert_books_balance();
}

#[test]
fn seeding_happens_once_per_asset() {
    let w = World::new();
    w.hitz.mint(&w.admin, &U);
    StellarAssetClient::new(&w.env, &w.xlm).mint(&w.admin, &U);
    assert_eq!(
        w.vault.try_seed(&w.xlm, &U, &U),
        Err(Ok(ce(Error::AlreadySeeded)))
    );
    let stranger = w.new_asset();
    assert_eq!(
        w.vault.try_seed(&stranger, &U, &U),
        Err(Ok(ce(Error::InvalidPool)))
    );
}

#[test]
fn nothing_trades_through_an_unseeded_pool() {
    let w = World::unseeded();
    let alice = w.user(0, &[(&w.xlm, 100 * U)]);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &w.h(), &U, &0),
        Err(Ok(ce(Error::NotSeeded)))
    );
    assert_eq!(
        w.vault.try_deposit(&alice, &w.xlm, &U, &0, &U),
        Err(Ok(ce(Error::NotSeeded)))
    );
    // One seeded pool trades with HITZ; the pair still waits for the other.
    w.seed(&w.xlm.clone(), SEED_HITZ_XLM, SEED_XLM);
    assert!(w.swap(&alice, &w.xlm, &w.h(), U) > 0);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &w.usdc, &U, &0),
        Err(Ok(ce(Error::NotSeeded)))
    );
}

#[test]
fn listing_waits_seven_days_and_must_match_the_proposal() {
    let w = World::new();
    let eurc = w.new_asset();
    assert_eq!(
        w.vault.try_list_asset(&eurc),
        Err(Ok(ce(Error::NoPendingListing)))
    );
    w.vault.propose_listing(&eurc);
    let p = w.vault.pending_listing().unwrap();
    assert_eq!(p.asset, eurc);
    w.advance(UPGRADE_DELAY_SECS - 1);
    assert_eq!(
        w.vault.try_list_asset(&eurc),
        Err(Ok(ce(Error::TimelockActive)))
    );
    w.advance(1);
    let other = w.new_asset();
    assert_eq!(
        w.vault.try_list_asset(&other),
        Err(Ok(ce(Error::ListingMismatch)))
    );
    w.vault.list_asset(&eurc);
    assert_eq!(w.vault.pending_listing(), None);
    assert_eq!(w.vault.assets().len(), 3);
    // Listed but not seeded: no trading, and no part in other pools' fees.
    let p = w.pool(&eurc);
    assert_eq!((p.hitz, p.reserve, p.fee), (0, 0, FEE_FLOOR));
    let alice = w.user(0, &[(&w.xlm, 10 * U)]);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &eurc, &U, &0),
        Err(Ok(ce(Error::NotSeeded)))
    );

    // Cancelling clears a proposal.
    let next = w.new_asset();
    w.vault.propose_listing(&next);
    w.vault.cancel_listing();
    assert_eq!(w.vault.pending_listing(), None);
    assert_eq!(
        w.vault.try_cancel_listing(),
        Err(Ok(ce(Error::NoPendingListing)))
    );
}

#[test]
fn listing_refuses_hitz_duplicates_and_more_than_max_assets() {
    let w = World::new();
    assert_eq!(
        w.vault.try_propose_listing(&w.h()),
        Err(Ok(ce(Error::DuplicateToken)))
    );
    assert_eq!(
        w.vault.try_propose_listing(&w.usdc),
        Err(Ok(ce(Error::DuplicateToken)))
    );
    // Something that doesn't answer as a token can't be proposed.
    let not_a_token = Address::generate(&w.env);
    assert!(w.vault.try_propose_listing(&not_a_token).is_err());
    for _ in 2..MAX_ASSETS {
        let a = w.new_asset();
        w.list(&a);
    }
    assert_eq!(w.vault.assets().len(), MAX_ASSETS);
    let one_more = w.new_asset();
    assert_eq!(
        w.vault.try_propose_listing(&one_more),
        Err(Ok(ce(Error::TooManyAssets)))
    );
}

/// XLM and USDC (half size) plus EURC with `eurc_hitz` HITZ, priced in line.
fn three(eurc_hitz: i128) -> (World, Address) {
    let w = World::half();
    let eurc = w.new_asset();
    w.list(&eurc);
    // ~1.16 USDC per EURC: in line with the USDC pool's HITZ price.
    let eurc_amount = SEED_USDC * eurc_hitz / SEED_HITZ_USDC * 100 / 116;
    w.seed(&eurc, eurc_hitz, eurc_amount);
    (w, eurc)
}

#[test]
fn a_listed_asset_trades_against_every_other_after_seeding() {
    let (w, eurc) = three(15_000_000 * U);
    let alice = w.user(
        1_000_000 * U,
        &[(&w.xlm, 100 * U), (&w.usdc, 100 * U), (&eurc, 100 * U)],
    );
    let tokens = [w.h(), w.xlm.clone(), w.usdc.clone(), eurc.clone()];
    for tin in tokens.iter() {
        for tout in tokens.iter() {
            if tin == tout {
                continue;
            }
            let amt = if *tin == w.h() { 10_000 * U } else { U };
            let q = w.vault.quote(tin, tout, &amt);
            let before = w.bal(tout, &alice);
            let out = w.swap(&alice, tin, tout, amt);
            assert_eq!(q, out);
            assert_eq!(w.bal(tout, &alice) - before, out);
            w.advance(60);
        }
    }
    w.assert_books_balance();
}

#[test]
fn a_new_pool_starts_where_the_others_already_are() {
    let w = World::half();
    let eurc = w.new_asset();
    w.list(&eurc);
    // Move HITZ itself: buy it through both pools by the same fraction of
    // each pool, so both deviations rise and the XLM/USDC rate barely moves.
    let buyer = w.user(0, &[(&w.xlm, 2_000 * U), (&w.usdc, 2_000 * U)]);
    let x_in = w.pool(&w.xlm).reserve / 50;
    let u_in = w.pool(&w.usdc).reserve / 50;
    w.swap(&buyer, &w.xlm, &w.h(), x_in);
    w.swap(&buyer, &w.usdc, &w.h(), u_in);
    let (x, u) = (w.pool(&w.xlm), w.pool(&w.usdc));
    assert!(x.deviation > wad(0.03) && u.deviation > wad(0.03));

    // Seeding EURC now starts it at the pools' HITZ-weighted average
    // deviation, so the move every pool shows isn't read as EURC being
    // dislocated against them.
    w.seed(&eurc, 15_000_000 * U, 510 * U);
    let e = w.pool(&eurc).deviation;
    let avg = (x.deviation * x.hitz + u.deviation * u.hitz) / (x.hitz + u.hitz);
    assert!(approx(e, avg, 1));
    assert!(w.vault.dislocation(&w.xlm, &eurc).abs() < x.deviation / 10);
    assert!(w.vault.dislocation(&eurc, &w.usdc).abs() < x.deviation / 10);
}

// ─────────────────────────────────────────────────────────────
//  SWAPS AND THE FEE
// ─────────────────────────────────────────────────────────────

#[test]
fn small_trades_pay_near_the_floor_and_the_fee_stays_on_the_drained_side() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 10 * U)]);
    let before = w.pool(&w.xlm);

    // Buy HITZ with 10 XLM: HITZ is the side being drained.
    let out = w.swap(&alice, &w.xlm, &w.h(), 10 * U);
    let gross = gross_out(before.reserve, before.hitz, 10 * U);
    // Moves the XLM/USDC rate ~0.2%: fee ~1.2%, close to the floor.
    let fee = gross - out;
    assert!(
        fee * 1000 / gross >= 10 && fee * 1000 / gross <= 13,
        "fee {fee} of {gross}"
    );

    let after = w.pool(&w.xlm);
    assert_eq!(after.reserve, before.reserve + 10 * U);
    // Only `out` left the HITZ reserve: the fee stayed in HITZ.
    assert_eq!(after.hitz, before.hitz - out);
    assert_eq!(w.hitz.balance(&alice), out);
    assert!(k(after.hitz, after.reserve) > k(before.hitz, before.reserve));
    // The other pool is untouched.
    let usdc = w.pool(&w.usdc);
    assert_eq!((usdc.hitz, usdc.reserve), (SEED_HITZ_USDC, SEED_USDC));
    w.assert_books_balance();
}

#[test]
fn every_pair_routes_and_quotes_match() {
    let w = World::new();
    let h = w.h();
    let alice = w.user(1_000_000 * U, &[(&w.xlm, 100 * U), (&w.usdc, 100 * U)]);
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
fn asset_to_asset_swaps_pass_through_hitz_without_moving_it() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 20 * U)]);
    let (x0, u0) = (w.pool(&w.xlm), w.pool(&w.usdc));
    let mass = w.hitz.total_mass();

    let out = w.swap(&alice, &w.xlm, &w.usdc, 20 * U);
    assert!(out > 0);
    let (x1, u1) = (w.pool(&w.xlm), w.pool(&w.usdc));
    // HITZ moved from one pool to the other inside the vault, minus the
    // HITZ fee kept by the XLM pool.
    assert!(x1.hitz < x0.hitz);
    assert!(u1.hitz > u0.hitz);
    assert_eq!(x1.hitz + u1.hitz, x0.hitz + u0.hitz);
    // No HITZ left the vault, so the mass did not change.
    assert_eq!(w.hitz.total_mass(), mass);
    assert_eq!(w.bal(&w.usdc, &alice), out);
    w.assert_books_balance();
}

#[test]
fn with_two_assets_both_hops_pay_for_the_pair() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 1_000 * U)]);
    w.swap(&alice, &w.xlm, &w.h(), 60 * U);
    let d = w.vault.dislocation(&w.xlm, &w.usdc);
    assert!(d < -wad(0.005), "{d}");
    // Each pool's dislocation is the pair's, and the fee is e^(100·|d|).
    for asset in [&w.xlm, &w.usdc] {
        let p = w.pool(asset);
        assert_eq!(p.dislocation, d.abs());
        assert_eq!(p.fee, fee_for_dislocation(d));
    }
    // dislocation(a, b) is ln(rate(a, b)) minus its average: flipping the
    // pair flips the sign.
    assert_eq!(w.vault.dislocation(&w.usdc, &w.xlm), -d);
}

#[test]
fn the_fee_climbs_with_the_dislocation_and_decays_back() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 1_000 * U)]);
    let r0 = w.pool(&w.xlm);

    // A big XLM -> HITZ buy drags the XLM/USDC rate ~2% from its average.
    let amt = 105 * U;
    let out = w.swap(&alice, &w.xlm, &w.h(), amt);
    let gross = gross_out(r0.reserve, r0.hitz, amt);
    let paid = (gross - out) * ONE / gross;
    assert!(paid > 6 * FEE_FLOOR && paid <= FEE_CAP, "fee rate {paid}");

    // The next small trade sees an elevated fee too...
    let f1 = w.pool(&w.usdc).fee;
    assert!(f1 > 5 * FEE_FLOOR, "{f1}");
    // ...which decays as the averages catch up: after one time constant
    // the dislocation is e^-1 of what it was.
    let d1 = w.vault.dislocation(&w.xlm, &w.usdc);
    w.advance(ANCHOR_TAU_SECS);
    let d2 = w.vault.dislocation(&w.xlm, &w.usdc);
    assert!(approx(d2, d1 * 367_879_441 / ONE, d1.abs() / 1_000_000));
    assert!(w.pool(&w.usdc).fee < f1 && w.pool(&w.usdc).fee > FEE_FLOOR);
    // After a day the market is calm again.
    w.advance(22 * 3600);
    assert!(approx(w.pool(&w.usdc).fee, FEE_FLOOR, FEE_FLOOR / 1000));
}

#[test]
fn splitting_cannot_dodge_the_fee_you_pay_for_how_far_the_price_moves() {
    // One trade that drags the rate 2%...
    let a = World::new();
    let alice = a.user(0, &[(&a.xlm, 1_000 * U)]);
    let one_shot = a.swap(&alice, &a.xlm, &a.h(), 105 * U);

    // ...versus the same size in ten pieces in the same ledger.
    let b = World::new();
    let bob = b.user(0, &[(&b.xlm, 1_000 * U)]);
    let mut pieces = 0;
    let mut first_fee = 0;
    let mut last_fee = 0;
    for i in 0..10 {
        let r = b.pool(&b.xlm);
        let out = b.swap(&bob, &b.xlm, &b.h(), 10 * U + U / 2);
        let gross = gross_out(r.reserve, r.hitz, 10 * U + U / 2);
        let rate = (gross - out) * ONE / gross;
        if i == 0 {
            first_fee = rate;
        }
        last_fee = rate;
        pieces += out;
    }
    // The later pieces pay the same steep fee the single trade paid at the
    // end; there is no size threshold to slip under.
    assert!(
        last_fee > 6 * first_fee,
        "first {first_fee} last {last_fee}"
    );
    // Splitting only recovers the overcharge of pricing a whole trade at its
    // end point: the pieces still pay far above the floor overall.
    let r0_gross = gross_out(SEED_XLM, SEED_HITZ_XLM, 105 * U);
    let piece_fee = (r0_gross - pieces) * ONE / r0_gross;
    assert!(pieces >= one_shot);
    assert!(piece_fee > 3 * FEE_FLOOR, "split pays {piece_fee}");
}

#[test]
fn round_trips_lose_money() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 100 * U)]);
    let h = w.h();
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
    let h = w.h();
    let alice = w.user(0, &[(&w.xlm, 100 * U)]);
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
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &w.xlm, &U, &0),
        Err(Ok(ce(Error::UnsupportedPair)))
    );
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &stranger, &h, &U, &0),
        Err(Ok(ce(Error::UnsupportedPair)))
    );
    assert_eq!(
        w.vault.try_swap(&alice, &alice, &w.xlm, &stranger, &U, &0),
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
//  THE DISLOCATION FEE WITH MORE ASSETS
// ─────────────────────────────────────────────────────────────

#[test]
fn pair_dislocations_are_consistent_across_all_pairs() {
    let (w, eurc) = three(15_000_000 * U);
    let alice = w.user(0, &[(&w.xlm, 500 * U), (&eurc, 100 * U)]);
    w.swap(&alice, &w.xlm, &w.usdc, 40 * U);
    w.advance(900);
    w.swap(&alice, &eurc, &w.h(), 3 * U);
    w.advance(300);
    let (x, u, e) = (&w.xlm, &w.usdc, &eurc);
    let d = |a: &Address, b: &Address| w.vault.dislocation(a, b);
    // Antisymmetric, and every triangle closes exactly: one consistent
    // average for every pair, from per-asset averages.
    assert_eq!(d(x, u), -d(u, x));
    assert_eq!(d(x, e), d(x, u) + d(u, e));
    assert_eq!(d(e, u), d(e, x) + d(x, u));
    // Each pool's D is its worst pair.
    assert_eq!(w.pool(x).dislocation, d(x, u).abs().max(d(x, e).abs()));
    assert_eq!(w.pool(e).dislocation, d(e, u).abs().max(d(e, x).abs()));
}

#[test]
fn a_hitz_move_that_every_pool_shows_is_not_a_dislocation() {
    let w = World::half();
    let buyer = w.user(0, &[(&w.xlm, 500 * U), (&w.usdc, 500 * U)]);
    // Buy HITZ through both pools by the same fraction of each, so both
    // pools' own prices move about equally.
    let x_in = w.pool(&w.xlm).reserve / 50;
    let u_in = w.pool(&w.usdc).reserve / 50;
    w.swap(&buyer, &w.xlm, &w.h(), x_in);
    w.swap(&buyer, &w.usdc, &w.h(), u_in);
    let x = w.pool(&w.xlm).deviation;
    let u = w.pool(&w.usdc).deviation;
    // Both pools moved several percent...
    assert!(x > wad(0.03) && u > wad(0.03), "{x} {u}");
    // ...but almost all of it is HITZ's own move: the pair barely moved,
    // and the fee is back near the floor.
    let d = w.vault.dislocation(&w.xlm, &w.usdc).abs();
    assert!(d < x / 10, "dislocation {d} vs deviation {x}");
    assert!(w.pool(&w.xlm).fee < FEE_FLOOR * 12 / 10);
}

#[test]
fn splitting_a_cross_trade_into_single_hops_changes_nothing() {
    // XLM -> USDC as one swap...
    let a = World::new();
    let alice = a.user(0, &[(&a.xlm, 100 * U)]);
    let direct = a.swap(&alice, &a.xlm, &a.usdc, 60 * U);
    // ...or as XLM -> HITZ, then HITZ -> USDC in the same ledger: every hop
    // is priced the same whatever route it belongs to.
    let b = World::new();
    let bob = b.user(0, &[(&b.xlm, 100 * U)]);
    let hitz = b.swap(&bob, &b.xlm, &b.h(), 60 * U);
    let split = b.swap(&bob, &b.h(), &b.usdc, hitz);
    assert_eq!(direct, split);
}

#[test]
fn a_detour_through_a_third_asset_never_prices_a_dislocation_cheaper() {
    // XLM dislocated ~2%, EURC halfway: the setting where pricing only the
    // traded pair would let XLM -> EURC -> USDC undercut XLM -> USDC.
    let setup = || {
        let (w, eurc) = three(15_000_000 * U);
        let mover = w.user(0, &[(&w.xlm, 1_000 * U), (&eurc, 1_000 * U)]);
        w.swap(&mover, &w.xlm, &w.h(), 50 * U);
        w.swap(&mover, &eurc, &w.h(), 25 * U / 10);
        w.advance(60);
        (w, eurc)
    };
    let (w, eurc) = setup();
    let d_xu = w.vault.dislocation(&w.xlm, &w.usdc).abs();
    let d_xe = w.vault.dislocation(&w.xlm, &eurc).abs();
    let d_eu = w.vault.dislocation(&eurc, &w.usdc).abs();
    assert!(
        d_xu > wad(0.012) && d_xe < d_xu && d_eu < d_xu,
        "{d_xu} {d_xe} {d_eu}"
    );

    let alice = w.user(0, &[(&w.xlm, 100 * U)]);
    let direct = w.swap(&alice, &w.xlm, &w.usdc, 20 * U);
    let (w2, eurc2) = setup();
    let bob = w2.user(0, &[(&w2.xlm, 100 * U)]);
    let via = w2.swap(&bob, &w2.xlm, &eurc2, 20 * U);
    let detour = w2.swap(&bob, &eurc2, &w2.usdc, via);
    assert!(detour < direct, "detour {detour} vs direct {direct}");
}

#[test]
fn a_hop_pays_for_its_assets_worst_pair_whatever_it_trades_against() {
    use soroban_sdk::testutils::Events as _;
    use soroban_sdk::xdr::{ContractEventBody, ScVal};
    // XLM is ~2% off against USDC but only ~1% against EURC.
    let (w, eurc) = three(15_000_000 * U);
    let mover = w.user(0, &[(&w.xlm, 1_000 * U), (&eurc, 1_000 * U)]);
    w.swap(&mover, &w.xlm, &w.h(), 50 * U);
    w.swap(&mover, &eurc, &w.h(), 25 * U / 10);
    let d_xu = w.vault.dislocation(&w.xlm, &w.usdc).abs();
    let d_xe = w.vault.dislocation(&w.xlm, &eurc).abs();
    assert!(d_xu > d_xe + wad(0.005), "{d_xu} {d_xe}");

    // Trading XLM for EURC, the XLM hop is still priced at XLM's worst pair
    // (against USDC), not at the calmer pair being traded.
    let alice = w.user(0, &[(&w.xlm, 10 * U)]);
    w.swap(&alice, &w.xlm, &eurc, U / 100);
    let all = w.env.events().all();
    let vault_events = all.filter_by_contract(&w.vault.address);
    let first_hop = vault_events
        .events()
        .iter()
        .find_map(|e| {
            let ContractEventBody::V0(body) = &e.body;
            let is_hop =
                matches!(&body.topics[0], ScVal::Symbol(s) if s.0.to_utf8_string_lossy() == "hop");
            match (&body.data, is_hop) {
                (ScVal::Map(Some(m)), true) => m.0.iter().find_map(|kv| match (&kv.key, &kv.val) {
                    (ScVal::Symbol(k), ScVal::I128(v))
                        if k.0.to_utf8_string_lossy() == "dislocation" =>
                    {
                        Some(((v.hi as i128) << 64) | v.lo as i128)
                    }
                    _ => None,
                }),
                _ => None,
            }
        })
        .unwrap();
    // A tiny trade barely moves the pair: priced at ~d_xu, well above d_xe.
    assert!(approx(first_hop, d_xu, d_xu / 100), "{first_hop} vs {d_xu}");
}

#[test]
fn a_shallow_pool_cannot_raise_the_fees_of_deep_ones() {
    // EURC with 1M HITZ: under 1/8 of either deep pool.
    let (w, eurc) = three(1_000_000 * U);
    let mover = w.user(0, &[(&eurc, 100 * U)]);
    // Push EURC's pool ~20%.
    w.swap(&mover, &eurc, &w.h(), 4 * U);
    assert!(w.vault.dislocation(&eurc, &w.usdc).abs() > wad(0.15));
    // EURC's own trades pay for it...
    assert_eq!(w.pool(&eurc).fee, FEE_CAP);
    // ...but it isn't a reference for the deep pools: their fees don't move.
    assert_eq!(w.pool(&w.xlm).fee, FEE_FLOOR);
    assert_eq!(w.pool(&w.usdc).fee, FEE_FLOOR);

    // Deposits that take it past 1/8 of a pool make it a reference for
    // that pool, and its dislocation then counts there too.
    let fan = w.user(5_000_000 * U, &[(&eurc, 1_000 * U)]);
    let r = w.pool(&eurc);
    let need = (2_500_000 * U * r.reserve + r.hitz - 1) / r.hitz;
    w.vault.deposit(&fan, &eurc, &(2_500_000 * U), &0, &need);
    let deep = w.pool(&eurc).hitz * REFERENCE_DEPTH_RATIO;
    assert!(deep >= w.pool(&w.usdc).hitz && deep < w.pool(&w.xlm).hitz);
    assert!(w.pool(&w.usdc).fee > FEE_FLOOR);
    assert_eq!(w.pool(&w.xlm).fee, FEE_FLOOR);
}

#[test]
fn a_deep_assets_dislocation_counts_in_every_pool() {
    let (w, eurc) = three(15_000_000 * U);
    let mover = w.user(0, &[(&w.xlm, 1_000 * U)]);
    w.swap(&mover, &w.xlm, &w.h(), 50 * U);
    let d = w.vault.dislocation(&w.xlm, &w.usdc).abs();
    assert!(d > wad(0.01));
    // XLM moved against both stablecoins; their pools price that pair too.
    assert!(w.pool(&w.usdc).fee > FEE_FLOOR);
    assert!(w.pool(&eurc).fee > FEE_FLOOR);
    let d_xe = w.vault.dislocation(&w.xlm, &eurc).abs();
    assert_eq!(w.pool(&w.xlm).dislocation, d.max(d_xe));
}

// ─────────────────────────────────────────────────────────────
//  DEPOSITS
// ─────────────────────────────────────────────────────────────

#[test]
fn deposits_add_at_the_current_ratio_and_never_come_out() {
    let w = World::new();
    let fan = w.user(1_000_000 * U, &[(&w.xlm, 1_000 * U)]);
    let before = w.pool(&w.xlm);
    let rate = w.vault.rate(&w.xlm, &w.usdc);

    let need = (1_000_000 * U * before.reserve + before.hitz - 1) / before.hitz;
    let paid = w
        .vault
        .deposit(&fan, &w.xlm, &(1_000_000 * U), &(need - 10), &(need + 10));
    assert_eq!(paid, need);

    let after = w.pool(&w.xlm);
    assert_eq!(after.hitz, before.hitz + 1_000_000 * U);
    assert_eq!(after.reserve, before.reserve + need);
    // The price doesn't move (rounding is in the vault's favour), and
    // neither does the deviation.
    assert!(approx(w.vault.rate(&w.xlm, &w.usdc), rate, 2));
    assert_eq!(after.deviation, before.deviation);
    w.assert_books_balance();
}

#[test]
fn deposits_refuse_a_moved_price() {
    let w = World::new();
    let fan = w.user(1_000_000 * U, &[(&w.xlm, 1_000 * U), (&w.usdc, 1_000 * U)]);
    let r = w.pool(&w.xlm);
    let need = (1_000_000 * U * r.reserve + r.hitz - 1) / r.hitz;
    // Someone moved the price: the deposit's range no longer matches.
    assert_eq!(
        w.vault
            .try_deposit(&fan, &w.xlm, &(1_000_000 * U), &0, &(need - 1)),
        Err(Ok(ce(Error::PriceOutOfRange)))
    );
    assert_eq!(
        w.vault
            .try_deposit(&fan, &w.xlm, &(1_000_000 * U), &(need + 1), &(need + 100)),
        Err(Ok(ce(Error::PriceOutOfRange)))
    );
    let stranger = Address::generate(&w.env);
    assert_eq!(
        w.vault.try_deposit(&fan, &stranger, &U, &0, &U),
        Err(Ok(ce(Error::InvalidPool)))
    );
    // USDC pool works the same way.
    let r = w.pool(&w.usdc);
    let need_usdc = (1_000 * U * r.reserve + r.hitz - 1) / r.hitz;
    assert_eq!(
        w.vault
            .deposit(&fan, &w.usdc, &(1_000 * U), &need_usdc, &need_usdc),
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
    let whale = w.user(0, &[]);
    w.hitz.mint(&whale, &(5_000_000 * U));
    assert!(w.hitz.is_account_vaulted(&whale));
    let friend = Address::generate(&w.env);
    assert!(w.hitz.try_transfer(&whale, &friend, &U).is_err());

    // Selling into the vault is the one door that's always open.
    let out = w.swap(&whale, &w.h(), &w.usdc, 50_000 * U);
    assert!(out > 0);
    w.assert_books_balance();
}

#[test]
fn big_buyers_get_vaulted_but_the_swap_goes_through() {
    let w = World::new();
    let buyer = w.user(0, &[(&w.usdc, 200 * U)]);
    let out = w.swap(&buyer, &w.usdc, &w.h(), 200 * U);
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
fn invariants_hold_under_random_trading_across_three_assets() {
    for seed in 1..=3u64 {
        let (w, eurc) = three(15_000_000 * U);
        let trader = w.user(
            5_000_000 * U,
            &[
                (&w.xlm, 5_000 * U),
                (&w.usdc, 1_000 * U),
                (&eurc, 1_000 * U),
            ],
        );
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let tokens = [w.h(), w.xlm.clone(), w.usdc.clone(), eurc.clone()];
        let ks = |w: &World| -> std::vec::Vec<u128> {
            w.vault
                .pools()
                .iter()
                .map(|p| k(p.hitz, p.reserve))
                .collect()
        };
        let mut last = ks(&w);
        let mut done = 0;
        let mut peak_fee = 0;
        for _ in 0..120 {
            w.advance(rng.below(900));
            let i = rng.below(4) as usize;
            let mut j = rng.below(4) as usize;
            if j == i {
                j = (j + 1) % 4;
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
            let now = ks(&w);
            for (a, b) in now.iter().zip(last.iter()) {
                // k never falls in any pool.
                assert!(a >= b);
            }
            for p in w.vault.pools().iter() {
                assert!(p.fee >= FEE_FLOOR && p.fee <= FEE_CAP);
                peak_fee = peak_fee.max(p.fee);
            }
            let (x, u, e) = (&w.xlm, &w.usdc, &eurc);
            let d = |a: &Address, b: &Address| w.vault.dislocation(a, b);
            assert_eq!(d(x, e), d(x, u) + d(u, e));
            w.assert_books_balance();
            last = now;
            done += 1;
        }
        // The run really traded, and moved the fee off the floor.
        assert!(done > 90, "only {done} swaps");
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
    let eurc = w.new_asset();
    w.vault.propose_upgrade(&hash);
    w.vault.propose_listing(&eurc);
    w.vault.renounce();
    assert_eq!(w.vault.admin(), None);
    assert_eq!(w.vault.pending_upgrade(), None);
    assert_eq!(w.vault.pending_listing(), None);
    w.advance(UPGRADE_DELAY_SECS);
    assert_eq!(w.vault.try_upgrade(&hash), Err(Ok(ce(Error::Renounced))));
    assert_eq!(
        w.vault.try_propose_upgrade(&hash),
        Err(Ok(ce(Error::Renounced)))
    );
    assert_eq!(w.vault.try_list_asset(&eurc), Err(Ok(ce(Error::Renounced))));
    assert_eq!(
        w.vault.try_propose_listing(&eurc),
        Err(Ok(ce(Error::Renounced)))
    );
    assert_eq!(w.vault.try_renounce(), Err(Ok(ce(Error::Renounced))));

    let alice = w.user(0, &[(&w.xlm, 10 * U)]);
    assert!(w.swap(&alice, &w.xlm, &w.h(), 10 * U) > 0);
    w.assert_books_balance();
}

#[test]
fn renouncing_before_seeding_leaves_an_empty_vault() {
    let w = World::unseeded();
    w.vault.renounce();
    assert_eq!(
        w.vault.try_seed(&w.xlm, &SEED_HITZ_XLM, &SEED_XLM),
        Err(Ok(ce(Error::Renounced)))
    );
}

// ─────────────────────────────────────────────────────────────
//  AUTHORIZATION (the tests above mock every signature)
// ─────────────────────────────────────────────────────────────

#[test]
fn swaps_need_exactly_the_traders_signature() {
    let w = World::new();
    let alice = w.user(0, &[(&w.xlm, 100 * U)]);
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
    assert!(w.vault.try_deposit(&alice, &w.xlm, &U, &0, &U).is_err());
}

#[test]
fn deposits_need_the_depositors_signature() {
    let w = World::new();
    let fan = w.user(1_000 * U, &[(&w.xlm, 10 * U)]);
    w.vault.deposit(&fan, &w.xlm, &(1_000 * U), &0, &(10 * U));
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
    w.seed(&w.xlm.clone(), SEED_HITZ_XLM, SEED_XLM);
    assert_eq!(signer(&w), w.admin);
    let hash = hash_of(&w);
    w.vault.propose_upgrade(&hash);
    assert_eq!(signer(&w), w.admin);
    w.vault.cancel_upgrade();
    assert_eq!(signer(&w), w.admin);
    let eurc = w.new_asset();
    w.vault.propose_listing(&eurc);
    assert_eq!(signer(&w), w.admin);
    w.vault.cancel_listing();
    assert_eq!(signer(&w), w.admin);
    w.vault.propose_listing(&eurc);
    w.advance(UPGRADE_DELAY_SECS);
    w.vault.list_asset(&eurc);
    assert_eq!(signer(&w), w.admin);
    w.vault.renounce();
    assert_eq!(signer(&w), w.admin);

    // Nobody else's signature is enough.
    let w = World::unseeded();
    let hash = hash_of(&w);
    let eurc = w.new_asset();
    w.hitz.mint(&w.admin, &SEED_HITZ_XLM);
    StellarAssetClient::new(&w.env, &w.xlm).mint(&w.admin, &SEED_XLM);
    w.env.set_auths(&[]);
    assert!(w.vault.try_seed(&w.xlm, &SEED_HITZ_XLM, &SEED_XLM).is_err());
    assert!(w.vault.try_propose_upgrade(&hash).is_err());
    assert!(w.vault.try_propose_listing(&eurc).is_err());
    assert!(w.vault.try_renounce().is_err());
    assert_eq!(w.vault.admin(), Some(w.admin.clone()));
}

// ─────────────────────────────────────────────────────────────
//  GOLDEN VECTORS (shared with research/vault-backtest)
// ─────────────────────────────────────────────────────────────

/// A fixed sequence over XLM and USDC, then EURC listed and seeded after the
/// timelock, then trades across all three. Each row: amount out, then
/// (hitz, reserve, deviation, fee) per pool in listing order (zeros before
/// EURC is listed). Any change to the swap, fee or listing math changes
/// these numbers, and research/vault-backtest/vaultmath.py must reproduce
/// them exactly (`python3 research/vault-backtest/vaultmath.py --check`).
#[test]
fn fee_math_matches_the_golden_vectors() {
    let w = World::unseeded();
    let eurc = w.new_asset();
    w.seed(&w.xlm.clone(), 288_489_893_497_397, 54_295_310_693);
    w.seed(&w.usdc.clone(), 153_635_240_499_979, 6_366_656_146);
    let t = w.user(
        10_000_000 * U,
        &[
            (&w.xlm, 100_000 * U),
            (&w.usdc, 100_000 * U),
            (&eurc, 100_000 * U),
        ],
    );
    let (h, x, u, e) = (w.h(), w.xlm.clone(), w.usdc.clone(), eurc.clone());
    let expected: [[i128; 13]; 12] = [
        [
            90583437,
            286022114858658,
            54795310693,
            17757676649745520,
            100000000,
            156103019138718,
            6276072709,
            -30264917526016470,
            100000000,
            0,
            0,
            0,
            0,
        ],
        [
            440465227,
            288366558038543,
            54354845466,
            798810344678132,
            11175972,
            153758575958833,
            6376072709,
            1910620077562421,
            11175972,
            0,
            0,
            0,
            0,
        ],
        [
            4688476682571,
            283678081355972,
            55354845466,
            35107300848891364,
            100000000,
            153758575958833,
            6376072709,
            1158849522909780,
            100000000,
            0,
            0,
            0,
            0,
        ],
        [
            350422284,
            283678081355972,
            55354845466,
            35107300848891364,
            100000000,
            163758575958833,
            6025650425,
            -118377629224182636,
            100000000,
            0,
            0,
            0,
            0,
        ],
        [
            0,
            283678081355972,
            55354845466,
            0,
            10000000,
            163758575958833,
            6025650425,
            0,
            10000000,
            120000000000000,
            4300000000,
            0,
            10000000,
        ],
        [
            828946626,
            288478081355971,
            54525898840,
            -31867430416331614,
            100000000,
            163758575958833,
            6025650425,
            0,
            100000000,
            115200000000001,
            4500000000,
            86284368597003772,
            100000000,
        ],
        [
            5013225,
            288335306173639,
            54555900074,
            -30800191278960235,
            100000000,
            163758575958833,
            6025650425,
            0,
            100000000,
            115342775182333,
            4494986775,
            83871198194729064,
            100000000,
        ],
        [
            298078229,
            288335306173639,
            54555900074,
            -23987211698595394,
            100000000,
            154583926943411,
            6425650425,
            121928511313954142,
            100000000,
            124517424197755,
            4196908546,
            -79832891648938117,
            100000000,
        ],
        [
            733357621,
            288335306173639,
            54555900074,
            -23930642003679640,
            100000000,
            154583926943411,
            6425650425,
            121640964135581149,
            100000000,
            154517424197755,
            3463550925,
            -487559680195334898,
            100000000,
        ],
        [
            101258230,
            288335306173639,
            54555900074,
            -22206937912,
            100000000,
            157338832117009,
            6324392195,
            -33548292640501588,
            100000000,
            151762519024157,
            3533550925,
            37998442183763223,
            100000000,
        ],
        [
            1719938,
            288287748674321,
            54565900074,
            348211191514682,
            100000000,
            157386389616327,
            6322672257,
            -33839470698265265,
            100000000,
            151762519024157,
            3533550925,
            37677870758180204,
            100000000,
        ],
        [
            457820900,
            291000597942479,
            54108079174,
            -17443781529266122,
            100000000,
            154673540348169,
            6446129046,
            2899642351966819,
            100000000,
            151762519024157,
            3533550925,
            37662174931659568,
            100000000,
        ],
    ];
    let row = |out: i128| -> [i128; 13] {
        let mut r = [0i128; 13];
        r[0] = out;
        for (i, p) in w.vault.pools().iter().enumerate() {
            r[1 + 4 * i..5 + 4 * i].copy_from_slice(&[p.hitz, p.reserve, p.deviation, p.fee]);
        }
        r
    };
    let first: [(u64, &Address, &Address, i128); 4] = [
        (0, &x, &u, 50 * U),
        (300, &u, &x, 10 * U),
        (3_600, &x, &h, 100 * U),
        (0, &h, &u, 1_000_000 * U),
    ];
    let then: [(u64, &Address, &Address, i128); 7] = [
        (60, &e, &x, 20 * U),
        (5, &x, &e, 3 * U + 1_234),
        (1_800, &u, &e, 40 * U),
        (17, &h, &e, 3_000_000 * U),
        (100_000, &e, &u, 7 * U),
        (61, &x, &u, U),
        (3, &u, &x, 123_456_789),
    ];
    let mut got = std::vec::Vec::new();
    for (dt, tin, tout, amt) in first.iter() {
        w.advance(*dt);
        got.push(row(w.swap(&t, tin, tout, *amt)));
    }
    w.list(&eurc);
    w.seed(&eurc, 120_000_000_000_000, 4_300_000_000);
    got.push(row(0));
    for (dt, tin, tout, amt) in then.iter() {
        w.advance(*dt);
        got.push(row(w.swap(&t, tin, tout, *amt)));
    }
    for (i, (g, want)) in got.iter().zip(expected.iter()).enumerate() {
        assert_eq!(g, want, "row {i}");
    }
}
