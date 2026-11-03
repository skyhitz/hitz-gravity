//! The integration patterns in INTEGRATION.md, run against the real vault
//! and the real HITZ token. If one of these breaks, the guide is wrong.

use gravity_token::{GravityToken, GravityTokenClient};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    vec,
    xdr::{ContractEventBody, ScVal},
    Address, Env, IntoVal, String, Symbol,
};
use sovereign_vault::{
    fee_for_dislocation, SovereignVault, SovereignVaultClient, ANCHOR_TAU_SECS, UPGRADE_DELAY_SECS,
};

const U: i128 = 10_000_000;

// ─────────────────────────────────────────────────────────────
//  The example bot from INTEGRATION.md
// ─────────────────────────────────────────────────────────────

/// Authorize, ahead of time, the one token transfer the vault will make
/// out of this contract during `swap`.
fn allow_vault_pull(env: &Env, token: &Address, vault: &Address, amount: i128) {
    env.authorize_as_current_contract(vec![
        env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: (env.current_contract_address(), vault.clone(), amount).into_val(env),
            },
            sub_invocations: vec![env],
        }),
    ]);
}

#[contract]
pub struct ExampleBot;

#[contractimpl]
impl ExampleBot {
    /// Swap this contract's own `amount_in` of `token_in` through the vault.
    pub fn trade(
        env: Env,
        vault: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
        min_out: i128,
    ) -> i128 {
        let me = env.current_contract_address();
        allow_vault_pull(&env, &token_in, &vault, amount_in);
        SovereignVaultClient::new(&env, &vault)
            .swap(&me, &me, &token_in, &token_out, &amount_in, &min_out)
    }

    /// XLM -> HITZ -> USDC as two separate swaps in one call. The bot holds
    /// the HITZ for a moment, gets vaulted if it exceeds L, and can still
    /// sell it into the vault.
    pub fn trade_through_hitz(
        env: Env,
        vault: Address,
        xlm: Address,
        hitz: Address,
        usdc: Address,
        amount_in: i128,
    ) -> i128 {
        let me = env.current_contract_address();
        let v = SovereignVaultClient::new(&env, &vault);
        allow_vault_pull(&env, &xlm, &vault, amount_in);
        let got = v.swap(&me, &me, &xlm, &hitz, &amount_in, &0);
        allow_vault_pull(&env, &hitz, &vault, got);
        v.swap(&me, &me, &hitz, &usdc, &got, &0)
    }

    /// The same as `trade` without the pre-authorization: refused.
    pub fn trade_without_authorizing(
        env: Env,
        vault: Address,
        token_in: Address,
        token_out: Address,
        amount_in: i128,
    ) -> i128 {
        let me = env.current_contract_address();
        SovereignVaultClient::new(&env, &vault)
            .swap(&me, &me, &token_in, &token_out, &amount_in, &0)
    }
}

// ─────────────────────────────────────────────────────────────
//  Setup
// ─────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    admin: Address,
    vault: SovereignVaultClient<'static>,
    hitz: GravityTokenClient<'static>,
    xlm: Address,
    usdc: Address,
}

fn setup() -> Setup {
    // No snapshot: these tests check integration patterns, not ledger state.
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    env.ledger().with_mut(|l| l.timestamp = 1_800_000_000);
    let admin = Address::generate(&env);
    let hitz_id = env.register(GravityToken, ());
    let hitz = GravityTokenClient::new(&env, &hitz_id);
    hitz.initialize(
        &admin,
        &String::from_str(&env, "HITZ"),
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
    hitz.register_pool_address(&vault_id);
    hitz.mint(&admin, &(88_000_000 * U));
    StellarAssetClient::new(&env, &xlm).mint(&admin, &(10_000 * U));
    StellarAssetClient::new(&env, &usdc).mint(&admin, &(1_000 * U));
    vault.seed(&xlm, &(57_000_000 * U), &(10_000 * U));
    vault.seed(&usdc, &(31_000_000 * U), &(1_000 * U));
    Setup {
        env,
        admin,
        vault,
        hitz,
        xlm,
        usdc,
    }
}

fn bal(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

// ─────────────────────────────────────────────────────────────
//  Contract callers
// ─────────────────────────────────────────────────────────────

#[test]
fn a_contract_swaps_its_own_funds_after_one_preauthorization() {
    let s = setup();
    let bot = s.env.register(ExampleBot, ());
    let client = ExampleBotClient::new(&s.env, &bot);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&bot, &(100 * U));
    let quote = s.vault.quote(&s.xlm, &s.usdc, &(10 * U));

    // From here on, real authorization: nothing is mocked.
    s.env.set_auths(&[]);
    let out = client.trade(&s.vault.address, &s.xlm, &s.usdc, &(10 * U), &quote);
    assert_eq!(out, quote);
    assert_eq!(bal(&s.env, &s.usdc, &bot), out);
    assert_eq!(bal(&s.env, &s.xlm, &bot), 90 * U);

    // Without the pre-authorization the vault can't pull the input.
    assert!(client
        .try_trade_without_authorizing(&s.vault.address, &s.xlm, &s.usdc, &(10 * U))
        .is_err());
}

#[test]
fn a_bot_can_hold_hitz_mid_transaction_and_still_sell_it() {
    let s = setup();
    let bot = s.env.register(ExampleBot, ());
    let client = ExampleBotClient::new(&s.env, &bot);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&bot, &(100 * U));

    s.env.set_auths(&[]);
    let out = client.trade_through_hitz(
        &s.vault.address,
        &s.xlm,
        &s.hitz.address,
        &s.usdc,
        &(10 * U),
    );
    // The bot held far more than L for a moment: the token vaulted it on
    // receipt and released it once it sold into the vault.
    assert_eq!(vaulted_flags(&s, &bot), [true, false]);
    assert!(out > 0);
    assert_eq!(bal(&s.env, &s.usdc, &bot), out);
    assert_eq!(s.hitz.balance(&bot), 0);
}

/// The token's `vaulted_event` values for `who` in the last invocation.
fn vaulted_flags(s: &Setup, who: &Address) -> std::vec::Vec<bool> {
    let who: ScVal = who.into();
    let all = s.env.events().all();
    let evs = all.filter_by_contract(&s.hitz.address);
    evs.events()
        .iter()
        .filter_map(|e| {
            let ContractEventBody::V0(body) = &e.body;
            let named = matches!(&body.topics[0], ScVal::Symbol(sym) if sym.0.to_utf8_string_lossy() == "vaulted_event");
            match (&body.data, named && body.topics.get(1) == Some(&who)) {
                (ScVal::Bool(flag), true) => Some(*flag),
                _ => None,
            }
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────
//  Events and state, as documented
// ─────────────────────────────────────────────────────────────

fn i128_of(v: &ScVal) -> i128 {
    match v {
        ScVal::I128(p) => ((p.hi as i128) << 64) | p.lo as i128,
        other => panic!("not an i128: {other:?}"),
    }
}

/// An event as (name, topics after the name, data as (key, value) pairs).
type Event = (
    std::string::String,
    std::vec::Vec<ScVal>,
    std::vec::Vec<(std::string::String, ScVal)>,
);

/// Every event the vault emitted in the last invocation.
fn vault_events(s: &Setup) -> std::vec::Vec<Event> {
    let all = s.env.events().all();
    let evs = all.filter_by_contract(&s.vault.address);
    evs.events()
        .iter()
        .map(|e| {
            let ContractEventBody::V0(body) = &e.body;
            let name = match &body.topics[0] {
                ScVal::Symbol(sym) => sym.0.to_utf8_string_lossy(),
                other => panic!("event name is not a symbol: {other:?}"),
            };
            let data = match &body.data {
                ScVal::Map(Some(m)) => {
                    m.0.iter()
                        .map(|entry| match &entry.key {
                            ScVal::Symbol(k) => (k.0.to_utf8_string_lossy(), entry.val.clone()),
                            other => panic!("map key is not a symbol: {other:?}"),
                        })
                        .collect()
                }
                ScVal::Void => std::vec::Vec::new(),
                other => panic!("event data is not a map: {other:?}"),
            };
            (name, body.topics[1..].to_vec(), data)
        })
        .collect()
}

#[test]
fn swap_events_carry_what_the_guide_says() {
    let s = setup();
    let alice = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&alice, &(10 * U));
    let out = s.vault.swap(&alice, &alice, &s.xlm, &s.usdc, &(10 * U), &0);
    // Events are kept for the last invocation only: read them first.
    let evs = vault_events(&s);
    let (x, u) = (s.vault.pool(&s.xlm), s.vault.pool(&s.usdc));

    let names: std::vec::Vec<&str> = evs.iter().map(|e| e.0.as_str()).collect();
    assert_eq!(names, ["hop", "hop", "swap"]);

    let hop_keys = [
        "amount_in",
        "amount_out",
        "dislocation",
        "fee_amount",
        "fee_rate",
        "hitz_in",
        "reserve_asset",
        "reserve_hitz",
    ];
    // XLM in through the XLM pool, USDC out of the USDC pool.
    for ((_, topics, data), asset) in evs[..2].iter().zip([&s.xlm, &s.usdc]) {
        let asset_val: ScVal = asset.into();
        assert_eq!(topics, &[asset_val]);
        let keys: std::vec::Vec<&str> = data.iter().map(|d| d.0.as_str()).collect();
        assert_eq!(keys, hop_keys);
        // The fee rate is the curve at the dislocation the hop reports.
        assert_eq!(
            i128_of(&data[4].1),
            fee_for_dislocation(i128_of(&data[2].1))
        );
    }
    // Each hop carries its pool's reserves after the swap.
    let usdc_hop = &evs[1].2;
    assert_eq!(i128_of(&usdc_hop[1].1), out);
    assert_eq!(i128_of(&usdc_hop[6].1), u.reserve);
    assert_eq!(i128_of(&usdc_hop[7].1), u.hitz);
    let xlm_hop = &evs[0].2;
    assert_eq!(i128_of(&xlm_hop[6].1), x.reserve);
    assert_eq!(i128_of(&xlm_hop[7].1), x.hitz);

    let (_, topics, data) = &evs[2];
    let alice_val: ScVal = (&alice).into();
    assert_eq!(topics, &[alice_val.clone(), alice_val]);
    let keys: std::vec::Vec<&str> = data.iter().map(|d| d.0.as_str()).collect();
    assert_eq!(keys, ["amount_in", "amount_out", "token_in", "token_out"]);
}

#[test]
fn a_dislocation_decays_as_documented() {
    let s = setup();
    let alice = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.xlm).mint(&alice, &(100 * U));
    s.vault.swap(&alice, &alice, &s.xlm, &s.usdc, &(40 * U), &0);

    s.env.ledger().with_mut(|l| l.timestamp += 600);
    let first = s.vault.dislocation(&s.xlm, &s.usdc);
    let first_fee = s.vault.pool(&s.usdc).fee;
    let dt = 3_000u64;
    s.env.ledger().with_mut(|l| l.timestamp += dt);
    let later = s.vault.dislocation(&s.xlm, &s.usdc);

    // dislocation(t + dt) = dislocation(t) * e^(-dt / 7200)
    let predicted = first as f64 * (-(dt as f64) / ANCHOR_TAU_SECS as f64).exp();
    assert!(
        (later as f64 - predicted).abs() <= predicted.abs() * 1e-6,
        "{later} vs {predicted}"
    );
    // With two assets each pool's D is that pair, and the small-trade fee
    // is the curve at it.
    let pool = s.vault.pool(&s.usdc);
    assert_eq!(pool.dislocation, later.abs());
    assert_eq!(pool.fee, fee_for_dislocation(later));
    assert!(pool.fee < first_fee && first_fee > 10_000_000);
}

fn keys(data: &[(std::string::String, ScVal)]) -> std::vec::Vec<&str> {
    data.iter().map(|d| d.0.as_str()).collect()
}

#[test]
fn listing_liquidity_and_admin_events_carry_what_the_guide_says() {
    let s = setup();
    let eurc = s
        .env
        .register_stellar_asset_contract_v2(s.admin.clone())
        .address();
    let eurc_val: ScVal = (&eurc).into();
    let one = |name: &str| {
        let evs = vault_events(&s);
        assert_eq!(evs.len(), 1, "{name}");
        assert_eq!(evs[0].0, name);
        evs.into_iter().next().unwrap()
    };

    s.vault.propose_listing(&eurc);
    let (_, topics, data) = one("listing_proposed");
    assert_eq!(topics, std::slice::from_ref(&eurc_val));
    assert_eq!(keys(&data), ["eta"]);
    s.vault.cancel_listing();
    let (_, topics, data) = one("listing_cancelled");
    assert_eq!((topics, data.len()), (std::vec![eurc_val.clone()], 0));

    s.vault.propose_listing(&eurc);
    s.env
        .ledger()
        .with_mut(|l| l.timestamp += UPGRADE_DELAY_SECS);
    s.vault.list_asset(&eurc);
    let (_, topics, data) = one("listed");
    assert_eq!((topics, data.len()), (std::vec![eurc_val.clone()], 0));
    assert_eq!(
        s.vault.assets(),
        vec![&s.env, s.xlm.clone(), s.usdc.clone(), eurc.clone()]
    );

    s.hitz.mint(&s.admin, &(10_000_000 * U));
    StellarAssetClient::new(&s.env, &eurc).mint(&s.admin, &(400 * U));
    s.vault.seed(&eurc, &(10_000_000 * U), &(400 * U));
    let (_, topics, data) = one("seeded");
    assert_eq!(topics, std::slice::from_ref(&eurc_val));
    assert_eq!(keys(&data), ["amount", "hitz"]);
    assert_eq!(
        (i128_of(&data[0].1), i128_of(&data[1].1)),
        (400 * U, 10_000_000 * U)
    );

    let fan = Address::generate(&s.env);
    s.hitz.mint(&fan, &(3_000 * U));
    StellarAssetClient::new(&s.env, &eurc).mint(&fan, &U);
    let amount = s.vault.deposit(&fan, &eurc, &(3_000 * U), &0, &U);
    let (_, topics, data) = one("deposit");
    let fan_val: ScVal = (&fan).into();
    assert_eq!(topics, [fan_val, eurc_val.clone()]);
    assert_eq!(keys(&data), ["amount", "hitz"]);
    assert_eq!(
        (i128_of(&data[0].1), i128_of(&data[1].1)),
        (amount, 3_000 * U)
    );

    // The new asset trades against the others, one hop event per pool.
    let alice = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &eurc).mint(&alice, &U);
    s.vault.swap(&alice, &alice, &eurc, &s.xlm, &U, &0);
    let evs = vault_events(&s);
    let xlm_val: ScVal = (&s.xlm).into();
    assert_eq!(evs[0].1, [eurc_val]);
    assert_eq!(evs[1].1, [xlm_val]);

    // Freezing the code keeps listing; renouncing ends both.
    let admin_val: ScVal = (&s.admin).into();
    s.vault.renounce_upgrades();
    let (_, topics, data) = one("upgrades_renounced");
    assert_eq!((topics, data.len()), (std::vec![admin_val.clone()], 0));
    assert!(!s.vault.upgradable());
    s.vault.renounce();
    let (_, topics, data) = one("renounced");
    assert_eq!((topics, data.len()), (std::vec![admin_val], 0));
}
