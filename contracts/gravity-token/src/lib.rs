#![no_std]
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, BytesN, Env, Executable,
    String, Vec,
};

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────

/// TTL constants (in ledgers, ~5s each on mainnet)
const TTL_THRESHOLD: u32 = 17_280; // ~1 day
const TTL_EXTEND_TO: u32 = 518_400; // ~30 days

/// ───────────────────────────────────────────────────────────
///  HARD SUPPLY CAP — 100,000,000 HITZ
/// ───────────────────────────────────────────────────────────
/// With 7 decimals (Stellar standard) that's 10^15 raw "stroops".
/// `mint` refuses any call that would push `TotalSupply` past this
/// value. `burn` reduces `TotalSupply`, freeing headroom — so the
/// cap is a ceiling on circulating supply, not on cumulative mints.
/// The value is a compile-time constant so it cannot be raised by
/// a runtime admin action; only a contract upgrade can change it,
/// and once the upgrade entrypoint is retired for mainnet the cap
/// becomes truly immutable.
const MAX_SUPPLY: i128 = 100_000_000 * 10_000_000;

#[contracttype]
#[derive(Clone, Debug)]
pub enum DataKey {
    Admin,
    Name,
    Symbol,
    Decimals,
    /// Sum of balances held by approved pools — drives L.
    TotalMass,
    /// Sum of ALL outstanding balances — enforces MAX_SUPPLY.
    /// Distinct from TotalMass: `TotalSupply` includes user
    /// balances and never double-counts a mint.
    TotalSupply,
    Balance(Address),
    Vaulted(Address),
    Allowance(Address, Address),
    AllowanceExpiry(Address, Address),
    // ──────────────────────────────────────────────────────────
    //  APPROVED INFRASTRUCTURE REGISTRY
    // ──────────────────────────────────────────────────────────
    //
    //  Each registered pool / router stores the WASM hash of the
    //  contract bytecode that was live at registration time. Storing
    //  the hash — not just a `bool` flag — binds the approval to a
    //  specific bytecode. If the pool / router's owner calls Soroban's
    //  `update_current_contract_wasm`, the on-chain executable hash
    //  changes and this token's integrity guard panics on the next
    //  state-changing interaction, forcing the admin to explicitly
    //  re-register the new bytecode. Without this bind, a trusted
    //  router could be silently swapped for malicious code while
    //  preserving infrastructure immunity and mass accounting — a
    //  complete bypass of the Gravity model.
    //
    //  For non-Wasm addresses (classic Stellar accounts, e.g. the
    //  admin funding address treated as a pool for bootstrap), the
    //  stored value is the zero hash — a sentinel that disables the
    //  integrity check since there's no WASM to compare against.
    //
    //  The value is BytesN<32>; absence of the key means the
    //  contract is not registered.
    ApprovedPools(Address),
    ApprovedRouters(Address),
    // ──────────────────────────────────────────────────────────
    //  ENUMERATION INDEXES
    // ──────────────────────────────────────────────────────────
    //
    //  Soroban's persistent storage has no iteration API — you can
    //  check a key's presence but you can't list all keys matching a
    //  prefix. So we maintain parallel `Vec<Address>` enumerations
    //  that are kept in sync with the `ApprovedPools` /
    //  `ApprovedRouters` persistent writes.
    //
    //  Invariant: for every address A, `PoolList.contains(&A)` ⇔
    //  `ApprovedPools(A)` is set. Same for routers. The persistent
    //  key remains the source of truth for classification (integrity
    //  hash lives there); the list exists only so clients can
    //  enumerate without needing event scraping + localStorage
    //  heuristics.
    //
    //  Stored in instance storage because the list is small
    //  (typically < 20 entries) and gets read on every UI load.
    //  Instance storage keeps it close to the TotalMass accumulator
    //  and avoids a per-read TTL check.
    PoolList,
    RouterList,
}

// ─────────────────────────────────────────────────────────────
//  EVENTS (SEP-41 + Gravity-specific)
// ─────────────────────────────────────────────────────────────

#[contractevent(data_format = "single-value")]
pub struct TransferEvent {
    #[topic]
    from: Address,
    #[topic]
    to: Address,
    amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct MintEvent {
    #[topic]
    to: Address,
    amount: i128,
}

#[contractevent(data_format = "single-value")]
pub struct BurnEvent {
    #[topic]
    from: Address,
    amount: i128,
}

#[contractevent]
pub struct ApproveEvent {
    #[topic]
    from: Address,
    #[topic]
    spender: Address,
    amount: i128,
    expiration_ledger: u32,
}

#[contractevent(data_format = "single-value")]
pub struct VaultedEvent {
    #[topic]
    account: Address,
    vaulted: bool,
}

/// Registration events include the approved WASM hash so off-chain
/// indexers can snapshot the exact bytecode bound to each address.
/// On removal the hash emitted is the hash that WAS registered (so
/// the event log preserves what got unbound), or the zero hash when
/// the address was never registered (spurious removes), or the zero
/// hash when the registered address is a non-Wasm (classic) account.
#[contractevent]
pub struct PoolRegisteredEvent {
    #[topic]
    address: Address,
    wasm_hash: BytesN<32>,
    registered: bool,
}

#[contractevent]
pub struct RouterRegisteredEvent {
    #[topic]
    address: Address,
    wasm_hash: BytesN<32>,
    registered: bool,
}

/// Emitted exactly once per contract instance, on `initialize`. Lets
/// indexers mark the deployment cleanly without polling for the first
/// admin / metadata write.
#[contractevent]
pub struct InitializedEvent {
    #[topic]
    admin: Address,
    name: String,
    symbol: String,
}

/// Emitted on every successful `set_admin`. The `previous` topic lets
/// monitors filter on outgoing-from-current-admin to alert on any
/// transfer of the most powerful role in the contract; the `new` topic
/// lets the incoming admin's tooling pick up the role transition
/// without scraping storage diffs.
#[contractevent]
pub struct AdminChangedEvent {
    #[topic]
    previous: Address,
    #[topic]
    new: Address,
}

#[contract]
pub struct GravityToken;

#[contractimpl]
impl GravityToken {
    // ─────────────────────────────────────────────────────────────
    //  LIFECYCLE
    // ─────────────────────────────────────────────────────────────

    /// Initialize the Gravity HITZ token with admin, name, symbol.
    /// Decimals are fixed at 7 (Stellar standard).
    pub fn initialize(env: Env, admin: Address, name: String, symbol: String) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        // Reject empty metadata at deploy time — a typo in the deploy
        // script would otherwise produce a permanently nameless token,
        // and there's no `set_name`/`set_symbol` repair path. Cheaper to
        // catch here than to redeploy.
        if name.is_empty() {
            panic!("Token name must be non-empty");
        }
        if symbol.is_empty() {
            panic!("Token symbol must be non-empty");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &7u32);
        env.storage().instance().set(&DataKey::TotalMass, &0i128);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);

        InitializedEvent {
            admin: admin.clone(),
            name: name.clone(),
            symbol: symbol.clone(),
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    // ─────────────────────────────────────────────────────────────
    //  ADMIN FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /// Mint new HITZ tokens. Only callable by admin.
    ///
    /// TWO HARD GUARDS:
    ///   1. Supply cap — refuses any mint that would push
    ///      `TotalSupply` past `MAX_SUPPLY` (100,000,000 HITZ).
    ///      This closes the historical "blank check" where mint
    ///      had no upper bound.
    ///   2. Integrity — if the recipient is a registered pool /
    ///      router, its on-chain WASM must still match what was
    ///      approved; a bytecode swap aborts the mint before any
    ///      balance write.
    ///
    /// "Roach Motel" semantics: within those guards, mint never
    /// fails due to vault logic. If the recipient breaches L they
    /// are silently vaulted.
    pub fn mint(env: Env, to: Address, amount: i128) {
        Self::require_admin(&env);

        if amount <= 0 {
            panic!("Mint amount must be positive");
        }

        // ── Supply cap enforcement ──
        // Check BEFORE any state change so a rejected mint leaves
        // storage untouched and emits no events.
        let current_supply = Self::read_total_supply(&env);
        let new_supply = current_supply
            .checked_add(amount)
            .expect("supply overflow");
        if new_supply > MAX_SUPPLY {
            panic!("Mint would exceed max supply of 100,000,000 HITZ");
        }

        // Security guard — if the recipient is a registered pool /
        // router, its on-chain WASM must still match what admin
        // approved. Halts before the balance write so a swapped pool
        // can't trick admin into crediting its TotalMass under the new
        // bytecode.
        let to_is_pool = Self::checked_is_pool(&env, &to);
        let to_is_router = Self::checked_is_router(&env, &to);

        let balance = Self::read_balance(&env, &to);
        // Balance overflow is impossible once the supply cap holds —
        // any single balance is at most MAX_SUPPLY, far below i128::MAX.
        // We still use `checked_add` as belt-and-braces.
        let new_balance = balance.checked_add(amount).expect("balance overflow");
        Self::write_balance(&env, &to, new_balance);

        // Supply accumulator — tracked AFTER the balance write so
        // an accounting inspector observing mid-tx state always sees
        // supply ≥ sum(balances).
        Self::write_total_supply(&env, new_supply);

        // If minting to an approved pool, increase TotalMass
        if to_is_pool {
            Self::adjust_total_mass(&env, amount);
        }

        // Lazy vault sync: if the recipient is a regular account
        // (non-pool, non-router), re-evaluate their flag against the
        // current L. This will vault them if they just crossed the
        // line, OR un-vault a previously-trapped user whose balance
        // is now below L because the protocol grew.
        if !to_is_pool && !to_is_router {
            Self::sync_vault_flag(&env, &to, new_balance);
        }

        MintEvent {
            to: to.clone(),
            amount,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
        Self::extend_balance_ttl(&env, &to);
    }

    /// Register an address as an approved pool. Admin-gated.
    /// Pools affect TotalMass and are the ONLY destination vaulted
    /// users can send to (sacrifice mass to widen the road).
    ///
    /// The current on-chain WASM hash of `address` is captured at
    /// registration and bound as the approved bytecode — any later
    /// in-place upgrade of the pool will trip the integrity check.
    /// For classic accounts (no WASM) a zero-hash sentinel is stored
    /// and the integrity check is skipped on subsequent state moves.
    /// Re-registering an existing pool rebinds the current hash —
    /// intended path after a deliberate, reviewed pool upgrade.
    pub fn register_pool_address(env: Env, address: Address) {
        Self::require_admin(&env);

        let wasm_hash = Self::capture_wasm_hash(&env, &address);

        let key = DataKey::ApprovedPools(address.clone());
        // Detect first-time registration BEFORE the set(), so we know
        // whether this pool's balance has already been reconciled into
        // TotalMass. Re-registration (same or new hash) must not
        // double-count.
        let prior: Option<BytesN<32>> = env.storage().persistent().get(&key);
        env.storage().persistent().set(&key, &wasm_hash);
        Self::extend_persistent_ttl(&env, &key);

        // Keep the enumeration index in sync. `pool_list_insert` is
        // idempotent (dedupes via contains()), so we call it
        // unconditionally — this also serves as the post-upgrade
        // backfill path: an admin whose contract pre-dates the enum
        // index simply re-registers each existing pool to populate
        // the new list. `prior.is_some()` still short-circuits the
        // mass reconciliation below, so re-registration is safe.
        Self::pool_list_insert(&env, &address);

        // Reconcile: if tokens were deposited to this address BEFORE
        // it was registered as a pool, those balances weren't tracked
        // in TotalMass. On first-time registration, fold them in.
        if prior.is_none() {
            let pool_bal = Self::read_balance(&env, &address);
            if pool_bal > 0 {
                Self::adjust_total_mass(&env, pool_bal);
            }
        }

        // Clear any accidental vault flag on the pool
        if Self::is_vaulted(&env, &address) {
            Self::set_vaulted(&env, &address, false);
        }

        PoolRegisteredEvent {
            address,
            wasm_hash,
            registered: true,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    /// Remove an address from the approved pools list. Admin-gated.
    /// The pool's current balance is subtracted from TotalMass.
    pub fn remove_pool_address(env: Env, address: Address) {
        Self::require_admin(&env);

        let key = DataKey::ApprovedPools(address.clone());
        let prior: Option<BytesN<32>> = env.storage().persistent().get(&key);

        if prior.is_some() {
            // Subtract pool's balance from TotalMass before removal
            let pool_bal = Self::read_balance(&env, &address);
            if pool_bal > 0 {
                Self::adjust_total_mass(
                    &env,
                    pool_bal.checked_neg().expect("negation overflow"),
                );
            }

            env.storage().persistent().remove(&key);
            Self::pool_list_remove(&env, &address);
        }

        // Emit the event with the hash that WAS registered (or zero
        // when there was nothing to remove) so indexers see what got
        // unbound without having to reconcile across a prior state.
        let wasm_hash = prior.unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));

        PoolRegisteredEvent {
            address,
            wasm_hash,
            registered: false,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    /// Register an address as an approved router. Admin-gated.
    /// Routers are pass-through entities (DEX aggregators, swap
    /// contracts). They NEVER affect TotalMass and vaulted users
    /// CANNOT send to them.
    ///
    /// The current on-chain WASM hash of `address` is captured at
    /// registration — see `register_pool_address` for the integrity
    /// semantics and the non-Wasm fallback.
    pub fn register_router_address(env: Env, address: Address) {
        Self::require_admin(&env);

        let wasm_hash = Self::capture_wasm_hash(&env, &address);

        let key = DataKey::ApprovedRouters(address.clone());
        env.storage().persistent().set(&key, &wasm_hash);
        Self::extend_persistent_ttl(&env, &key);

        // Idempotent — dedupes via contains(). Also serves as the
        // post-upgrade backfill path for the enumeration index.
        Self::router_list_insert(&env, &address);

        // Clear any accidental vault flag on the router
        if Self::is_vaulted(&env, &address) {
            Self::set_vaulted(&env, &address, false);
        }

        RouterRegisteredEvent {
            address,
            wasm_hash,
            registered: true,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    /// Remove an address from the approved routers list. Admin-gated.
    pub fn remove_router_address(env: Env, address: Address) {
        Self::require_admin(&env);

        let key = DataKey::ApprovedRouters(address.clone());
        let prior: Option<BytesN<32>> = env.storage().persistent().get(&key);
        if prior.is_some() {
            env.storage().persistent().remove(&key);
            Self::router_list_remove(&env, &address);
        }

        let wasm_hash = prior.unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));

        RouterRegisteredEvent {
            address,
            wasm_hash,
            registered: false,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    /// Upgrade the contract WASM in-place. Admin-only.
    ///
    /// TEMPORARY — to be removed before mainnet immutable deployment.
    pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Transfer admin role to a new address.
    /// Requires auth from BOTH current admin and new admin.
    pub fn set_admin(env: Env, new_admin: Address) {
        // Capture previous admin BEFORE the require_admin call mutates
        // nothing — order is just for clarity. Both old and new must
        // co-sign, so a stolen old key alone can't rotate to an
        // attacker-controlled address.
        let previous: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        previous.require_auth();
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);

        AdminChangedEvent {
            previous,
            new: new_admin,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    // ─────────────────────────────────────────────────────────────
    //  CORE TRANSFER — THE ROACH MOTEL + LAZY EVALUATION
    // ─────────────────────────────────────────────────────────────
    //
    //  INCOMING is always allowed:
    //    Anyone can receive any amount of HITZ. If their new balance
    //    exceeds L, they are silently vaulted. The transfer NEVER
    //    reverts due to the recipient's balance. This guarantees
    //    DEX routers (Aqua, Soroswap, etc.) always get a clean
    //    SEP-41 Void return on the output leg of a swap.
    //
    //  LAZY EVALUATION — "Escape on Try":
    //    Before gating a vaulted sender, we recompute L and compare
    //    it to the sender's CURRENT balance. If the protocol has
    //    grown past them since they were trapped, the vault flag is
    //    cleared in-line and the transfer proceeds as if they were
    //    never stuck. No dummy transaction, no explicit release
    //    call — the physics of the Gravity model is evaluated
    //    precisely at the moment the user acts on their money.
    //    This is the "Just-In-Time Correction" pattern: asynchronous
    //    state (L) is resolved synchronously at the point of use.
    //
    //  OUTGOING is blocked (after lazy eval):
    //    A vaulted sender panics — UNLESS the destination is an
    //    approved pool (sacrifice to widen the road) or the sender
    //    itself is an approved pool or router (infrastructure
    //    immunity). After the transfer completes, the sender's
    //    vault flag is re-synced against their new balance — so
    //    sacrificing enough to drop below L releases them
    //    automatically.
    //
    //  LAZY EVALUATION — "Correction on Receive":
    //    When a vaulted user receives tokens, we also re-sync their
    //    flag against the new balance. In the usual case this keeps
    //    them vaulted (receiving more pushes them further past L),
    //    but if L has grown massively in the meantime the new
    //    balance may now be UNDER L, in which case they're quietly
    //    released. The flag always reflects current physics.
    //
    //  ROUTERS: Pass-through only. They never affect TotalMass.
    //    Vaulted users CANNOT send to routers — only to pools.
    //
    //  INTEGRITY: Every classification of an address as pool / router
    //    is enforced against the CURRENT on-chain WASM hash. A
    //    pool/router whose bytecode has been upgraded since approval
    //    fails integrity and the transaction panics — there's no
    //    silent downgrade to "regular account" because that would
    //    hide a security event from operators. The fix-forward path
    //    is `register_pool_address` / `register_router_address` with
    //    the new hash after a deliberate review.
    //

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        if amount <= 0 {
            panic!("Transfer amount must be positive");
        }
        if from == to {
            panic!("Cannot transfer to self");
        }

        // Classify + verify integrity in one pass. Each `checked_is_*`
        // call panics if the address is registered but the deployed
        // WASM hash no longer matches what was approved — closing the
        // upgrade-substitution attack vector before ANY state moves.
        let to_is_pool = Self::checked_is_pool(&env, &to);
        let from_is_pool = Self::checked_is_pool(&env, &from);
        let from_is_router = Self::checked_is_router(&env, &from);
        let to_is_router = Self::checked_is_router(&env, &to);

        // ── LAZY EVALUATION (Escape on Try) ──
        // Re-evaluate the sender's vault flag against the CURRENT L
        // BEFORE the gate check. If the protocol has expanded past
        // their balance, they're released in-line — no dummy tx.
        if !from_is_pool && !from_is_router {
            let from_balance_now = Self::read_balance(&env, &from);
            Self::sync_vault_flag(&env, &from, from_balance_now);
        }

        // ── SENDER GATE (the only place we ever panic for vault logic) ──
        // Vaulted accounts cannot transfer out UNLESS:
        //   1. The destination is an approved pool (sacrifice mass), OR
        //   2. The sender IS an approved pool or router (infrastructure immunity).
        // NOTE: Routers are NOT a valid destination for vaulted senders.
        if !from_is_pool && !from_is_router && Self::is_vaulted(&env, &from) && !to_is_pool {
            panic!("Account is vaulted: transfers locked.");
        }

        let from_balance = Self::read_balance(&env, &from);
        if from_balance < amount {
            panic!("Insufficient balance");
        }
        let to_balance = Self::read_balance(&env, &to);

        let new_from = from_balance.checked_sub(amount).expect("underflow");
        let new_to = to_balance.checked_add(amount).expect("balance overflow");

        Self::write_balance(&env, &from, new_from);
        Self::write_balance(&env, &to, new_to);

        // O(1) TotalMass accumulator updates — ONLY for pools
        // Routers NEVER affect TotalMass
        if from_is_pool {
            Self::adjust_total_mass(&env, amount.checked_neg().expect("negation overflow"));
        }
        if to_is_pool {
            Self::adjust_total_mass(&env, amount);
        }

        // ── POST-TRANSFER VAULT SYNC (for both parties) ──
        // Sender: if they sacrificed to a pool, they may have dropped
        //   below L and should be released. If they were non-vaulted
        //   and transferred less than pushed them over (impossible
        //   here since balance only decreases on send), the flag
        //   stays off. `sync_vault_flag` is the single authority.
        // Receiver: standard silent trap — if new_to > L, vault;
        //   if they were vaulted but L grew past new_to (e.g. pool
        //   just absorbed mass in the same tx), un-vault.
        if !from_is_pool && !from_is_router {
            Self::sync_vault_flag(&env, &from, new_from);
        }
        if !to_is_pool && !to_is_router {
            Self::sync_vault_flag(&env, &to, new_to);
        }

        TransferEvent {
            from: from.clone(),
            to: to.clone(),
            amount,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
        Self::extend_balance_ttl(&env, &from);
        Self::extend_balance_ttl(&env, &to);
    }

    /// SEP-41 transfer_from: delegated transfer via allowance.
    /// Same Roach Motel rules + lazy evaluation — vault check on
    /// `from`, not `spender`.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();

        if amount <= 0 {
            panic!("Transfer amount must be positive");
        }
        if from == to {
            panic!("Cannot transfer to self");
        }

        // Spender gets the same integrity treatment — a user who
        // granted an allowance to a registered pool / router expects
        // that allowance to cover the approved bytecode, NOT whatever
        // replacement an attacker swapped in.
        Self::enforce_integrity_if_registered(&env, &spender);

        Self::spend_allowance(&env, &from, &spender, amount);

        let to_is_pool = Self::checked_is_pool(&env, &to);
        let from_is_pool = Self::checked_is_pool(&env, &from);
        let from_is_router = Self::checked_is_router(&env, &from);
        let to_is_router = Self::checked_is_router(&env, &to);

        // ── LAZY EVALUATION (Escape on Try) ──
        if !from_is_pool && !from_is_router {
            let from_balance_now = Self::read_balance(&env, &from);
            Self::sync_vault_flag(&env, &from, from_balance_now);
        }

        // ── SENDER GATE ──
        if !from_is_pool && !from_is_router && Self::is_vaulted(&env, &from) && !to_is_pool {
            panic!("Account is vaulted: transfers locked.");
        }

        let from_balance = Self::read_balance(&env, &from);
        if from_balance < amount {
            panic!("Insufficient balance");
        }
        let to_balance = Self::read_balance(&env, &to);

        let new_from = from_balance.checked_sub(amount).expect("underflow");
        let new_to = to_balance.checked_add(amount).expect("balance overflow");

        Self::write_balance(&env, &from, new_from);
        Self::write_balance(&env, &to, new_to);

        // Only pools affect TotalMass
        if from_is_pool {
            Self::adjust_total_mass(&env, amount.checked_neg().expect("negation overflow"));
        }
        if to_is_pool {
            Self::adjust_total_mass(&env, amount);
        }

        // ── POST-TRANSFER VAULT SYNC ──
        if !from_is_pool && !from_is_router {
            Self::sync_vault_flag(&env, &from, new_from);
        }
        if !to_is_pool && !to_is_router {
            Self::sync_vault_flag(&env, &to, new_to);
        }

        TransferEvent {
            from: from.clone(),
            to: to.clone(),
            amount,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
        Self::extend_balance_ttl(&env, &from);
        Self::extend_balance_ttl(&env, &to);
    }

    // ─────────────────────────────────────────────────────────────
    //  ALLOWANCE SYSTEM
    // ─────────────────────────────────────────────────────────────

    /// SEP-41 approve: set allowance for a spender with expiration.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();

        if amount < 0 {
            panic!("Allowance amount must be non-negative");
        }
        if expiration_ledger < env.ledger().sequence() {
            panic!("Expiration must be in the future");
        }

        let key = DataKey::Allowance(from.clone(), spender.clone());
        let expiry_key = DataKey::AllowanceExpiry(from.clone(), spender.clone());

        env.storage().persistent().set(&key, &amount);
        env.storage().persistent().set(&expiry_key, &expiration_ledger);

        Self::extend_persistent_ttl(&env, &key);
        Self::extend_persistent_ttl(&env, &expiry_key);

        ApproveEvent {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
    }

    /// SEP-41 allowance: returns current allowance (0 if expired).
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&env, &from, &spender)
    }

    // ─────────────────────────────────────────────────────────────
    //  BURN
    // ─────────────────────────────────────────────────────────────

    /// Burn tokens from caller's own balance.
    /// Vaulted accounts CANNOT burn (no exit route).
    ///
    /// Lazy evaluation applies here too: if the protocol grew past
    /// the caller's balance between when they were vaulted and now,
    /// the first read re-syncs the flag and the burn proceeds. If
    /// they remain genuinely over L, the burn is blocked — burning
    /// would be a sneaky exit path (destroy HITZ to avoid sacrifice).
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();

        if amount <= 0 {
            panic!("Burn amount must be positive");
        }

        // Lazy evaluation: re-sync the vault flag so that an already-
        // safe user isn't blocked from burning on a stale flag.
        let from_is_pool = Self::checked_is_pool(&env, &from);
        let from_is_router = Self::checked_is_router(&env, &from);
        if !from_is_pool && !from_is_router {
            let bal_now = Self::read_balance(&env, &from);
            Self::sync_vault_flag(&env, &from, bal_now);
        }

        if Self::is_vaulted(&env, &from) {
            panic!("Account is vaulted: cannot burn as exit route.");
        }

        let balance = Self::read_balance(&env, &from);
        if balance < amount {
            panic!("Insufficient balance");
        }

        let new_balance = balance.checked_sub(amount).expect("underflow");
        Self::write_balance(&env, &from, new_balance);

        // Supply contracts — burn frees MAX_SUPPLY headroom
        Self::adjust_total_supply(&env, amount.checked_neg().expect("negation overflow"));

        if from_is_pool {
            Self::adjust_total_mass(&env, amount.checked_neg().expect("negation overflow"));
        }

        BurnEvent {
            from: from.clone(),
            amount,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
        Self::extend_balance_ttl(&env, &from);
    }

    /// Burn tokens from another account via allowance.
    /// Vaulted accounts CANNOT be burned from (no exit route).
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();

        if amount <= 0 {
            panic!("Burn amount must be positive");
        }

        // Integrity on spender (if registered) and classification of
        // from before the lazy sync.
        Self::enforce_integrity_if_registered(&env, &spender);
        let from_is_pool = Self::checked_is_pool(&env, &from);
        let from_is_router = Self::checked_is_router(&env, &from);

        // Lazy evaluation on the account being burned from.
        if !from_is_pool && !from_is_router {
            let bal_now = Self::read_balance(&env, &from);
            Self::sync_vault_flag(&env, &from, bal_now);
        }

        if Self::is_vaulted(&env, &from) {
            panic!("Account is vaulted: cannot burn as exit route.");
        }

        Self::spend_allowance(&env, &from, &spender, amount);

        let balance = Self::read_balance(&env, &from);
        if balance < amount {
            panic!("Insufficient balance");
        }

        let new_balance = balance.checked_sub(amount).expect("underflow");
        Self::write_balance(&env, &from, new_balance);

        Self::adjust_total_supply(&env, amount.checked_neg().expect("negation overflow"));

        if from_is_pool {
            Self::adjust_total_mass(&env, amount.checked_neg().expect("negation overflow"));
        }

        BurnEvent {
            from: from.clone(),
            amount,
        }
        .publish(&env);

        Self::extend_instance_ttl(&env);
        Self::extend_balance_ttl(&env, &from);
    }

    // ─────────────────────────────────────────────────────────────
    //  SEP-41 READ INTERFACE
    // ─────────────────────────────────────────────────────────────

    pub fn balance(env: Env, id: Address) -> i128 {
        Self::read_balance(&env, &id)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap()
    }

    // ─────────────────────────────────────────────────────────────
    //  GRAVITY-SPECIFIC QUERIES
    // ─────────────────────────────────────────────────────────────

    /// Returns the current Safety Limit L = sqrt(TotalMass × 10^decimals).
    /// O(1) — reads the pre-computed accumulator.
    pub fn safety_limit(env: Env) -> i128 {
        Self::current_limit_safe(&env)
    }

    /// Returns the raw TotalMass accumulator (sum of approved pool balances).
    pub fn total_mass(env: Env) -> i128 {
        Self::read_total_mass(&env)
    }

    /// Circulating supply — sum of all outstanding balances.
    /// Always ≤ `max_supply()`.
    pub fn total_supply(env: Env) -> i128 {
        Self::read_total_supply(&env)
    }

    /// The hard-coded supply cap in raw units (7 decimals).
    /// Equal to 100,000,000 HITZ.
    pub fn max_supply(_env: Env) -> i128 {
        MAX_SUPPLY
    }

    /// Returns whether an account is currently vaulted.
    ///
    /// NOTE: This is a passive read — it reflects the LAST WRITTEN
    /// flag. If the protocol has grown since the user was trapped,
    /// their real ("lazy-evaluated") status may be "safe" even
    /// though this returns true. The flag will be corrected the
    /// moment they transact. For a canonical realtime answer see
    /// `would_be_vaulted_if(balance)`.
    pub fn is_account_vaulted(env: Env, id: Address) -> bool {
        Self::is_vaulted(&env, &id)
    }

    /// Canonical "is this account actually stuck right now?" query —
    /// evaluates the physics against their CURRENT balance and the
    /// CURRENT L. Independent of the stored flag.
    ///
    /// Returns true iff the account is non-infrastructure and holds
    /// more than L. UIs can call this to decide whether to show the
    /// "vaulted" banner without relying on stale flags.
    pub fn is_actually_vaulted(env: Env, id: Address) -> bool {
        if Self::is_pool_registered(&env, &id) || Self::is_router_registered(&env, &id) {
            return false;
        }
        let bal = Self::read_balance(&env, &id);
        let l = Self::current_limit_safe(&env);
        bal > l
    }

    /// Check if an address is registered as an approved pool.
    ///
    /// This is a pure read — it does NOT run the WASM integrity check.
    /// Use `pool_wasm_hash` to fetch the bound hash, or call any
    /// state-changing transfer / burn to trigger the enforced check.
    pub fn is_pool(env: Env, address: Address) -> bool {
        Self::is_pool_registered(&env, &address)
    }

    /// Check if an address is registered as an approved router.
    /// Pure read — see `is_pool` for the integrity-check semantics.
    pub fn is_router(env: Env, address: Address) -> bool {
        Self::is_router_registered(&env, &address)
    }

    /// Returns the WASM hash the admin bound to `pool` at registration,
    /// or `None` if not registered. Off-chain observers can compare this
    /// to the pool's current on-chain executable to audit integrity
    /// without submitting a fee-bearing transaction.
    /// A returned value of all zeros means "classic account, no
    /// integrity binding".
    pub fn pool_wasm_hash(env: Env, address: Address) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedPools(address))
    }

    /// Returns the WASM hash bound to `router` at registration, or None.
    pub fn router_wasm_hash(env: Env, address: Address) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::ApprovedRouters(address))
    }

    /// Enumerate every currently-registered pool.
    ///
    /// Authoritative, O(n) in the list size. Clients should prefer this
    /// over event-log scraping + localStorage heuristics — the list is
    /// updated in lockstep with every `register_pool_address` /
    /// `remove_pool_address` call, so it always reflects the current
    /// on-chain state regardless of RPC event retention windows.
    pub fn list_pools(env: Env) -> Vec<Address> {
        Self::read_pool_list(&env)
    }

    /// Enumerate every currently-registered router. See `list_pools`.
    pub fn list_routers(env: Env) -> Vec<Address> {
        Self::read_router_list(&env)
    }

    // ─────────────────────────────────────────────────────────────
    //  INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    fn read_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn write_balance(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(id.clone()), &amount);
    }

    fn is_vaulted(env: &Env, id: &Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Vaulted(id.clone()))
            .unwrap_or(false)
    }

    fn set_vaulted(env: &Env, id: &Address, vaulted: bool) {
        let key = DataKey::Vaulted(id.clone());
        env.storage().persistent().set(&key, &vaulted);

        // Extend TTL for the vault flag so it never silently expires
        Self::extend_persistent_ttl(env, &key);

        VaultedEvent {
            account: id.clone(),
            vaulted,
        }
        .publish(env);
    }

    /// ──────────────────────────────────────────────────────────
    ///  LAZY EVALUATION (Just-In-Time Correction)
    /// ──────────────────────────────────────────────────────────
    ///
    /// Single authority on whether an address is vaulted. Called
    /// inline on every balance-changing operation for BOTH the
    /// sender and the receiver, ensuring the flag always reflects
    /// the current physics.
    ///
    /// Semantics:
    ///   balance > L  → should be vaulted
    ///   balance ≤ L  → should be free
    ///
    /// Pools and routers are exempt — their flag is forced false.
    /// Infallible: never panics, never reverts. Only emits the
    /// `VaultedEvent` when the flag actually changes, so indexers
    /// don't see noise on every transfer.
    ///
    /// This is the structural implementation of "Escape on Try" and
    /// "Correction on Receive": the contract double-checks the math
    /// the exact moment the user touches their money.
    fn sync_vault_flag(env: &Env, addr: &Address, balance: i128) {
        // Pools / routers: infrastructure immunity. If a flag was
        // ever accidentally set (shouldn't happen post-registration
        // since we clear it there), reset it.
        if Self::is_pool_registered(env, addr) || Self::is_router_registered(env, addr) {
            if Self::is_vaulted(env, addr) {
                Self::set_vaulted(env, addr, false);
            }
            return;
        }

        let safety_limit = Self::current_limit_safe(env);
        let currently_vaulted = Self::is_vaulted(env, addr);

        if balance > safety_limit {
            if !currently_vaulted {
                Self::set_vaulted(env, addr, true);
            }
        } else if currently_vaulted {
            Self::set_vaulted(env, addr, false);
        }
    }

    fn read_total_mass(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalMass)
            .unwrap_or(0)
    }

    fn adjust_total_mass(env: &Env, delta: i128) {
        let mass = Self::read_total_mass(env);
        let new_mass = mass.checked_add(delta).expect("mass overflow");
        if new_mass < 0 {
            panic!("TotalMass underflow");
        }
        env.storage().instance().set(&DataKey::TotalMass, &new_mass);
    }

    fn read_total_supply(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    fn write_total_supply(env: &Env, supply: i128) {
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &supply);
    }

    fn adjust_total_supply(env: &Env, delta: i128) {
        let supply = Self::read_total_supply(env);
        let new_supply = supply.checked_add(delta).expect("supply overflow");
        if new_supply < 0 {
            panic!("TotalSupply underflow");
        }
        Self::write_total_supply(env, new_supply);
    }

    // ──────────────────────────────────────────────────────────
    //  APPROVED-INFRASTRUCTURE: REGISTRATION + INTEGRITY
    // ──────────────────────────────────────────────────────────

    /// Capture the on-chain WASM hash of `address` for integrity
    /// binding. For classic (non-Wasm) addresses, returns the zero
    /// hash sentinel, which `assert_wasm_matches` treats as
    /// "integrity check disabled". This is required because Stellar
    /// classic accounts have no bytecode to hash against — but we
    /// still want to allow them to be registered (e.g. the admin's
    /// own funding account as a bootstrap pool).
    fn capture_wasm_hash(env: &Env, address: &Address) -> BytesN<32> {
        match address.executable() {
            Some(Executable::Wasm(h)) => h,
            _ => BytesN::from_array(env, &[0u8; 32]),
        }
    }

    /// Pure storage predicate — is `address` registered as a pool?
    /// Never panics; never reads the on-chain executable. Use this
    /// in silent-trap / passive paths where a panic would violate
    /// the Roach-Motel invariant, and in public read views.
    fn is_pool_registered(env: &Env, address: &Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::ApprovedPools(address.clone()))
    }

    fn is_router_registered(env: &Env, address: &Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::ApprovedRouters(address.clone()))
    }

    // ──────────────────────────────────────────────────────────
    //  ENUMERATION INDEX HELPERS
    // ──────────────────────────────────────────────────────────
    //
    //  Keep the `PoolList` / `RouterList` vectors in sync with the
    //  persistent `ApprovedPools(_)` / `ApprovedRouters(_)` keys.
    //  `insert` is idempotent (O(n) scan) so a double-register from
    //  a race or retry cannot duplicate an entry; `remove` is O(n)
    //  and silently no-ops on missing entries.
    //
    //  These are only called from the admin register / remove paths
    //  (which are serialized per-transaction), so the cost is paid
    //  once per registration — never on a hot transfer path.

    fn read_pool_list(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::PoolList)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn write_pool_list(env: &Env, list: &Vec<Address>) {
        env.storage().instance().set(&DataKey::PoolList, list);
    }

    fn pool_list_insert(env: &Env, address: &Address) {
        let mut list = Self::read_pool_list(env);
        if !list.contains(address) {
            list.push_back(address.clone());
            Self::write_pool_list(env, &list);
        }
    }

    fn pool_list_remove(env: &Env, address: &Address) {
        let list = Self::read_pool_list(env);
        if let Some(idx) = list.first_index_of(address) {
            let mut next = list;
            next.remove(idx);
            Self::write_pool_list(env, &next);
        }
    }

    fn read_router_list(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::RouterList)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn write_router_list(env: &Env, list: &Vec<Address>) {
        env.storage().instance().set(&DataKey::RouterList, list);
    }

    fn router_list_insert(env: &Env, address: &Address) {
        let mut list = Self::read_router_list(env);
        if !list.contains(address) {
            list.push_back(address.clone());
            Self::write_router_list(env, &list);
        }
    }

    fn router_list_remove(env: &Env, address: &Address) {
        let list = Self::read_router_list(env);
        if let Some(idx) = list.first_index_of(address) {
            let mut next = list;
            next.remove(idx);
            Self::write_router_list(env, &next);
        }
    }

    /// Returns `true` iff `address` is registered as a pool AND its
    /// current on-chain WASM matches the registered hash. Panics if
    /// registration is present but the bytecode has changed — the
    /// admin must explicitly re-approve after any deliberate upgrade.
    /// Returns `false` for unregistered addresses (no panic).
    ///
    /// Use this in every state-changing path. Pair with
    /// `is_pool_registered` only when a panic is unacceptable (silent
    /// trap) — in that case the upstream caller is responsible for
    /// having already run the checked variant.
    fn checked_is_pool(env: &Env, address: &Address) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&DataKey::ApprovedPools(address.clone()))
        {
            Some(expected) => {
                Self::assert_wasm_matches(address, &expected);
                true
            }
            None => false,
        }
    }

    fn checked_is_router(env: &Env, address: &Address) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&DataKey::ApprovedRouters(address.clone()))
        {
            Some(expected) => {
                Self::assert_wasm_matches(address, &expected);
                true
            }
            None => false,
        }
    }

    /// Run the integrity check on `address` for the side effect only —
    /// if the address is registered as a pool or router AND its current
    /// on-chain bytecode no longer matches the approved hash, panic.
    /// No-op when the address is unregistered.
    ///
    /// Used in delegated paths (`transfer_from`, `burn_from`) where the
    /// spender's classification doesn't change the accounting but we
    /// still want to refuse to honour an allowance against a swapped-out
    /// pool/router. The intent is encoded in the function name so a
    /// future cleanup pass cannot mistake the call for dead code, the
    /// way `let _spender_is_pool = …` discards previously could.
    fn enforce_integrity_if_registered(env: &Env, address: &Address) {
        let _ = Self::checked_is_pool(env, address);
        let _ = Self::checked_is_router(env, address);
    }

    /// Core integrity primitive — fetch the address's CURRENT on-chain
    /// executable hash, compare to `expected`, panic on any mismatch.
    ///
    /// The zero hash is a sentinel meaning "classic account, no
    /// integrity binding" — set when the registered address has no
    /// WASM to bind against. In that case we skip the check entirely
    /// (there's nothing to compare and panicking would lock classic
    /// pools out of the system).
    ///
    /// Kept deliberately simple: one compare, one panic site.
    fn assert_wasm_matches(address: &Address, expected: &BytesN<32>) {
        // Zero-hash sentinel = non-Wasm address, integrity check
        // doesn't apply.
        let zero = [0u8; 32];
        if expected.to_array() == zero {
            return;
        }
        match address.executable() {
            Some(Executable::Wasm(actual)) => {
                if actual != *expected {
                    panic!("approved contract wasm hash mismatch");
                }
            }
            Some(Executable::StellarAsset) => {
                panic!("approved contract is a Stellar Asset, not Wasm");
            }
            Some(Executable::Account) => {
                panic!("approved contract address is an account, not Wasm");
            }
            None => {
                panic!("approved contract no longer exists on chain");
            }
        }
    }

    /// Infallible safety limit: L = floor(sqrt(TotalMass × 10^decimals)).
    /// Returns i128::MAX on overflow so that no one gets spuriously vaulted.
    fn current_limit_safe(env: &Env) -> i128 {
        let mass = Self::read_total_mass(env);
        if mass <= 0 {
            return 0;
        }
        let decimals: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7);
        let scale = 10i128.pow(decimals);
        match mass.checked_mul(scale) {
            Some(scaled) => Self::integer_sqrt(scaled),
            None => i128::MAX, // overflow → treat as infinite limit
        }
    }

    fn read_allowance(env: &Env, from: &Address, spender: &Address) -> i128 {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let expiry_key = DataKey::AllowanceExpiry(from.clone(), spender.clone());

        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if amount == 0 {
            return 0;
        }

        let expiry: u32 = env.storage().persistent().get(&expiry_key).unwrap_or(0);
        if env.ledger().sequence() > expiry {
            return 0;
        }

        amount
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let allowance = Self::read_allowance(env, from, spender);
        if allowance < amount {
            panic!("Insufficient allowance");
        }

        let new_allowance = allowance.checked_sub(amount).expect("allowance underflow");
        let key = DataKey::Allowance(from.clone(), spender.clone());
        env.storage().persistent().set(&key, &new_allowance);
        Self::extend_persistent_ttl(env, &key);
    }

    /// Newton's method integer square root for i128.
    fn integer_sqrt(n: i128) -> i128 {
        if n <= 0 {
            return 0;
        }
        if n == 1 {
            return 1;
        }
        let mut x = n / 2 + 1;
        let mut y = (x + n / x) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
    }

    fn extend_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    }

    fn extend_persistent_ttl(env: &Env, key: &DataKey) {
        if env.storage().persistent().has(key) {
            env.storage()
                .persistent()
                .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
    }

    /// Extend TTL for a balance key AND its associated vault key.
    fn extend_balance_ttl(env: &Env, id: &Address) {
        let bal_key = DataKey::Balance(id.clone());
        Self::extend_persistent_ttl(env, &bal_key);

        let vault_key = DataKey::Vaulted(id.clone());
        Self::extend_persistent_ttl(env, &vault_key);
    }
}

mod test;
