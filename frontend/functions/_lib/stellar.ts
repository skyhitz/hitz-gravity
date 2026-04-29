// Server-side Stellar helpers for the gateway.
//
// Responsibilities:
//   1. Bootstrap a brand-new derived account (first outbound tx only).
//   2. Given a high-level contract call {contractId, method, argsXdr[]},
//      build it with source=derived, simulate, assemble, sign-inner,
//      fee-bump with sponsor, submit, poll for final status.
//   3. Submit plain classic ops (for account bootstrap / claim flows)
//      fee-paid directly by the sponsor.
//   4. Transparently restore archived Soroban state when the simulation
//      comes back with a `restorePreamble`. Soroban ledger entries have a
//      ~30 day TTL; once archived they can't be read/written until a
//      RestoreFootprintOp pays to bring them back. We do that inline as
//      part of the gas station — the user never sees it.
//
// The sponsor covers all fees. Derived accounts hold 1 XLM (reserve) but
// never pay Soroban fees — the fee-bump outer envelope is signed by the
// sponsor and its fee field absorbs the cost. This matches the "gas
// station" architecture: custodial users never touch XLM.

import * as StellarSdk from "@stellar/stellar-sdk";
import { getServerKeys } from "./derive";
import type { Env } from "./types";

/**
 * If `sim.restorePreamble` is set, the user's transaction touched archived
 * ledger entries — we must submit a RestoreFootprintOp first or the real
 * call will fail with `EntryArchived`. Soroban txs are single-op, so the
 * restore can't be bundled into the same envelope; it goes first, the
 * original follows.
 *
 * The sponsor is both the source and signer of the restore tx. Restore ops
 * don't require Soroban auth from the data's owner — anyone can pay to
 * bring entries back, so doing it sponsor-side keeps the user sequence
 * clean and avoids an extra round-trip to the user's signer.
 *
 * No-op when `restorePreamble` is absent (the common case).
 */
async function maybeRestoreFootprint(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  sim: StellarSdk.rpc.Api.SimulateTransactionSuccessResponse
): Promise<void> {
  if (!StellarSdk.rpc.Api.isSimulationRestore(sim)) return;

  const preamble = sim.restorePreamble;
  const sponsorAcct = await loadSponsorAccount(server, sponsor);

  // Build with a placeholder fee; re-simulate + assemble to get final
  // resource fee rather than trusting the preamble's minResourceFee
  // alone (which doesn't include the classic inclusion fee).
  const draft = new StellarSdk.TransactionBuilder(sponsorAcct, {
    fee: "100",
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(StellarSdk.Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();

  const restoreSim = await server.simulateTransaction(draft);
  if (StellarSdk.rpc.Api.isSimulationError(restoreSim)) {
    throw new Error(`restore simulation failed: ${restoreSim.error}`);
  }
  const assembled = StellarSdk.rpc.assembleTransaction(draft, restoreSim).build();
  assembled.sign(sponsor);

  const resp = await server.sendTransaction(assembled);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`restore submit error${xdr ? `: ${xdr}` : ""}`);
  }
  await pollForSuccess(server, resp.hash);
}

/**
 * Build a contract-call inner transaction with the given source, simulate
 * it against the RPC, and return a fully-prepared unsigned Transaction.
 *
 * If simulation indicates archived state (`restorePreamble` present), we
 * submit a sponsor-paid RestoreFootprintOp first, re-fetch the source
 * account (sequence may have been touched by a retry), and re-simulate
 * the contract call so the final assembled tx reflects live state. This
 * makes TTL archival invisible to callers.
 */
async function prepareContractCall(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  sourcePublicKey: string,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<StellarSdk.Transaction> {
  const contract = new StellarSdk.Contract(contractId);

  async function buildAndSimulate(): Promise<{
    tx: StellarSdk.Transaction;
    sim: StellarSdk.rpc.Api.SimulateTransactionResponse;
  }> {
    const source = await server.getAccount(sourcePublicKey);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: "100", // inner fee is irrelevant — sponsor's fee-bump supersedes it
      networkPassphrase: env.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    return { tx, sim };
  }

  let { tx, sim } = await buildAndSimulate();
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulation failed: ${sim.error}`);
  }

  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
    // Archived state — restore first, then re-simulate against live state.
    await maybeRestoreFootprint(env, server, sponsor, sim);
    ({ tx, sim } = await buildAndSimulate());
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      throw new Error(`post-restore simulation failed: ${sim.error}`);
    }
    if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
      // Shouldn't happen — a successful restore makes the footprint live.
      // Treat as a hard error rather than looping.
      throw new Error("restore preamble persisted after restore tx");
    }
  }

  return StellarSdk.rpc.assembleTransaction(tx, sim).build();
}

/**
 * Return the Account object for `publicKey`, or null if it doesn't exist
 * on chain yet. Stellar SDK throws on 404 — we unwrap that into a nullable.
 */
async function maybeGetAccount(
  server: StellarSdk.rpc.Server,
  publicKey: string
): Promise<StellarSdk.Account | null> {
  try {
    return await server.getAccount(publicKey);
  } catch (err) {
    // Horizon / Soroban RPC both throw a 404-ish error we recognize by
    // message. We treat "not found" as a signal to bootstrap.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not\s*found|404/i.test(msg)) return null;
    throw err;
  }
}

/**
 * Load the sponsor classic account, or throw a message that tells the
 * operator exactly which G-address needs to be funded. The raw SDK error
 * `Account not found: G…` is easy to misread as a recipient problem —
 * this wrapper makes the cause unambiguous.
 */
async function loadSponsorAccount(
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair
): Promise<StellarSdk.Account> {
  try {
    return await server.getAccount(sponsor.publicKey());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not\s*found|404/i.test(msg)) {
      throw new Error(
        `gas sponsor account ${sponsor.publicKey()} is not funded on chain. ` +
          `Fund it with testnet XLM (e.g. via Friendbot) and retry.`
      );
    }
    throw err;
  }
}

/**
 * Send a classic tx signed + fee-paid by the sponsor. Used for account
 * bootstraps where the target doesn't exist yet (so it can't be the source).
 */
async function sendClassicFromSponsor(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  buildOp: () => StellarSdk.xdr.Operation
): Promise<string> {
  const sponsorAcct = await loadSponsorAccount(server, sponsor);
  const tx = new StellarSdk.TransactionBuilder(sponsorAcct, {
    fee: "10000", // 0.001 XLM — plenty for a single classic op
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(buildOp())
    .setTimeout(60)
    .build();
  tx.sign(sponsor);
  const resp = await server.sendTransaction(tx);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`classic submit error${xdr ? `: ${xdr}` : ""}`);
  }
  return pollForSuccess(server, resp.hash);
}

async function pollForSuccess(
  server: StellarSdk.rpc.Server,
  hash: string
): Promise<string> {
  // Soroban RPC finalizes within a few ledgers (~6s). We poll at 1s until
  // we see a terminal status. 40 tries ≈ 40s is more than enough; missing
  // past that, we return — the client will see the in-flight hash.
  for (let i = 0; i < 40; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return hash;
    if (res.status === "FAILED") {
      const xdr = res.resultXdr?.toXDR("base64");
      throw new Error(`tx ${hash} failed${xdr ? `: ${xdr}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${hash} timed out waiting for finalization`);
}

/**
 * Create the derived account on chain if it doesn't exist. Idempotent —
 * a no-op when the account is already funded. Always safe to call before
 * any outbound action from a derived address.
 */
export async function ensureAccountBootstrapped(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  targetPublicKey: string
): Promise<void> {
  const existing = await maybeGetAccount(server, targetPublicKey);
  if (existing) return;
  await sendClassicFromSponsor(env, server, sponsor, () =>
    StellarSdk.Operation.createAccount({
      destination: targetPublicKey,
      startingBalance: env.BOOTSTRAP_STARTING_BALANCE,
    })
  );
}

export interface ExecuteResult {
  hash: string;
}

/**
 * End-to-end: run a contract call on behalf of `userKp` with sponsor
 * paying via fee bump. Handles the bootstrap-if-missing path transparently.
 *
 *   1. Bootstrap the derived account if it doesn't exist yet.
 *   2. Build inner tx (source = user) via simulate + assembleTransaction.
 *   3. Inner sign with user's keypair.
 *   4. Wrap in FeeBumpTransaction (fee source = sponsor).
 *   5. Submit fee-bump, poll, return hash.
 */
export async function runSponsoredContractCall(
  env: Env,
  userKp: StellarSdk.Keypair,
  contractId: string,
  method: string,
  argsXdrBase64: string[]
): Promise<ExecuteResult> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);

  // (1) Bootstrap if needed
  await ensureAccountBootstrapped(env, server, sponsor, userKp.publicKey());

  // (2) Decode args and build prepared inner. prepareContractCall will
  // transparently submit a sponsor-paid RestoreFootprintOp first if the
  // user's state is archived (Soroban TTL, ~30 days of inactivity).
  const args = argsXdrBase64.map((b64) =>
    StellarSdk.xdr.ScVal.fromXDR(b64, "base64")
  );
  const prepared = await prepareContractCall(
    env,
    server,
    sponsor,
    userKp.publicKey(),
    contractId,
    method,
    args
  );

  // (3) Inner sign
  prepared.sign(userKp);

  // (4) Fee-bump wrap. `baseFee` is PER OPERATION — Soroban inner txs have
  // one op, but fee-bump's baseFee must be ≥ 2x inner base fee by protocol
  // rule. We use a generous 1 XLM / 10M stroops which is well above any
  // realistic Soroban call on testnet.
  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    "10000000",
    prepared,
    env.NETWORK_PASSPHRASE
  );
  feeBump.sign(sponsor);

  // (5) Submit + poll
  const resp = await server.sendTransaction(feeBump);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`feebump submit error${xdr ? `: ${xdr}` : ""}`);
  }
  const finalHash = await pollForSuccess(server, resp.hash);
  return { hash: finalHash };
}

/**
 * Classic payment (native XLM) from sponsor — unused today, kept for
 * symmetry in case we add claim flows that need it. The notify endpoint
 * doesn't send anything on-chain; the sender's transfer already did.
 */
export async function sendSponsoredCreateAccount(
  env: Env,
  destination: string
): Promise<string> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  return sendClassicFromSponsor(env, server, sponsor, () =>
    StellarSdk.Operation.createAccount({
      destination,
      startingBalance: env.BOOTSTRAP_STARTING_BALANCE,
    })
  );
}

/**
 * Convenience used by operational tools / admin routes: the G-address the
 * operator must fund with XLM for the gas station to work. Printed by the
 * sponsor-address helper endpoint so it's trivial to look up without ever
 * reading the secret.
 */
export async function getSponsorAddress(env: Env): Promise<string> {
  const { sponsorKeypair } = await getServerKeys(env.MASTER_SECRET);
  return sponsorKeypair.publicKey();
}

/**
 * Run a contract call where the sponsor is BOTH the source and signer.
 * Used for legacy reparation transfers: the sponsor holds the reparation
 * pool of HITZ (transferred from admin once, pre-flight) and pays it out
 * to derived user addresses one claim at a time.
 *
 * Pre-requisite (one-time, run by operator before the campaign):
 *   1. `register_router_address(sponsor)` on the HITZ contract — exempts
 *      the sponsor from vault rules as a sender and keeps it out of the
 *      TotalMass calculation.
 *   2. `transfer(admin, sponsor, total_pool)` — fund the sponsor with the
 *      sum of all `new_hitz_amount` rows.
 *
 * No fee-bump wrap is needed because the sponsor IS the source — the
 * normal classic fee field on the inner tx covers the cost.
 */
async function runSponsorContractCall(
  env: Env,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);

  const prepared = await prepareContractCall(
    env,
    server,
    sponsor,
    sponsor.publicKey(),
    contractId,
    method,
    args
  );
  prepared.sign(sponsor);

  const resp = await server.sendTransaction(prepared);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`sponsor submit error${xdr ? `: ${xdr}` : ""}`);
  }
  return pollForSuccess(server, resp.hash);
}

/**
 * Move HITZ from the sponsor account to a derived user address. Used by
 * the lazy reparation redemption flow at claim time. Bootstrap of the
 * destination account must have already happened (it's a SAC transfer,
 * which requires the destination to exist as a classic account).
 *
 * `amount` is a decimal string in display units (e.g. "1234.5"). HITZ
 * uses 7 decimals, matching Stellar classic, so we multiply by 1e7 and
 * encode as i128.
 */
export async function transferHitzFromSponsor(
  env: Env,
  destinationPublicKey: string,
  amount: string
): Promise<string> {
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  const stroops = toStroopsI128(amount);

  const args: StellarSdk.xdr.ScVal[] = [
    new StellarSdk.Address(sponsor.publicKey()).toScVal(),
    new StellarSdk.Address(destinationPublicKey).toScVal(),
    StellarSdk.xdr.ScVal.scvI128(stroops),
  ];

  return runSponsorContractCall(env, env.HITZ_CONTRACT_ID, "transfer", args);
}

/**
 * Send native XLM from the sponsor account to a destination via a classic
 * Payment op. Used by the v6+ reparation campaign which combines a HITZ
 * SAC transfer with an XLM top-up on the same recipient account.
 *
 * `amount` is a decimal string in display units (e.g. "704.0387755"). The
 * destination must already exist on chain — bootstrap is the caller's
 * responsibility (the reparation flow runs `ensureBootstrappedWithUsdc-
 * Trustline` first, so by the time we get here the account is live).
 *
 * Two-tx separation rationale: Soroban host-function ops can't share a
 * tx with classic ops, so we can't bundle this with the HITZ SAC transfer.
 * Doing them sequentially is fine — each leg is idempotency-tracked
 * separately in the reparation record (txHash for HITZ, xlmTxHash for
 * XLM) so a partial failure doesn't double-pay on retry.
 */
export async function sendXlmFromSponsor(
  env: Env,
  destinationPublicKey: string,
  amount: string
): Promise<string> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  return sendClassicFromSponsor(env, server, sponsor, () =>
    StellarSdk.Operation.payment({
      destination: destinationPublicKey,
      asset: StellarSdk.Asset.native(),
      amount,
    })
  );
}

/**
 * Convert a decimal-string display amount into an i128 ScVal in stroops
 * (1 token = 1e7 stroops, matching Stellar's 7-decimal default). Negative
 * amounts and >7 fractional digits are rejected so we never silently
 * truncate value.
 */
function toStroopsI128(amount: string): StellarSdk.xdr.Int128Parts {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid amount "${amount}"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 7) {
    throw new Error(`amount "${amount}" has more than 7 fractional digits`);
  }
  const padded = (frac + "0000000").slice(0, 7);
  const stroopsStr = (whole + padded).replace(/^0+(?=\d)/, "");
  const big = BigInt(stroopsStr || "0");
  // i128 = (hi: i64) << 64 | (lo: u64)
  const mask = (1n << 64n) - 1n;
  const hi = big >> 64n;
  const lo = big & mask;
  return new StellarSdk.xdr.Int128Parts({
    hi: StellarSdk.xdr.Int64.fromString(hi.toString()),
    lo: StellarSdk.xdr.Uint64.fromString(lo.toString()),
  });
}

/**
 * Read the sponsor account's native (XLM) balance from Horizon. Returns
 * the balance as a decimal string (e.g. "143.7651234"). Throws if the
 * account is missing — the operator must fund the sponsor before any
 * claim flow can run.
 *
 * We use Horizon (REST) rather than RPC because RPC's getAccount returns
 * only sequence + signers, not balances. Horizon is the canonical place
 * for classic balance queries.
 */
export async function getSponsorXlmBalance(env: Env): Promise<string> {
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  const info = await getAccountInfo(env, sponsor.publicKey());
  if (!info.exists) {
    throw new Error(
      `gas sponsor account ${sponsor.publicKey()} is not funded on chain.`
    );
  }
  const native = info.balances.find((b) => b.asset_type === "native");
  if (!native) throw new Error("sponsor account has no native balance entry");
  return native.balance;
}

// ─── Account inspection (Horizon) ────────────────────────────────────────

export interface BalanceLine {
  asset_type:
    | "native"
    | "credit_alphanum4"
    | "credit_alphanum12"
    | "liquidity_pool_shares";
  /** Display balance string with up to 7 decimals (e.g. "12.3456789"). */
  balance: string;
  /** Asset code for non-native lines. Absent for native and pool shares. */
  asset_code?: string;
  /** Issuer for non-native asset lines. Absent for native and pool shares. */
  asset_issuer?: string;
  /** Trustline limit (display units). Absent for native. */
  limit?: string;
}

export interface AccountInfo {
  exists: boolean;
  balances: BalanceLine[];
}

/**
 * Read an account's classic balances + trustlines from Horizon. Returns
 * `{exists: false, balances: []}` for accounts that don't exist on chain
 * (Horizon 404), so callers can branch on `exists` rather than catching
 * exceptions. Any other failure throws.
 *
 * We use Horizon because RPC's `getAccount` exposes only sequence +
 * signers — balances and trustlines live on Horizon's REST surface.
 */
export async function getAccountInfo(
  env: Env,
  publicKey: string
): Promise<AccountInfo> {
  const url = `${env.HORIZON_URL.replace(/\/$/, "")}/accounts/${publicKey}`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (resp.status === 404) {
    return { exists: false, balances: [] };
  }
  if (!resp.ok) {
    throw new Error(`horizon ${resp.status} fetching ${publicKey}`);
  }
  const data = (await resp.json()) as { balances?: BalanceLine[] };
  return { exists: true, balances: data.balances ?? [] };
}

/**
 * True if `publicKey` already trusts USDC with the configured issuer.
 * We compare on (code, issuer) rather than just code — multiple anchors
 * issue assets called "USDC" and we only care about the configured one.
 */
function hasTrustline(
  balances: BalanceLine[],
  code: string,
  issuer: string
): boolean {
  return balances.some(
    (b) =>
      (b.asset_type === "credit_alphanum4" ||
        b.asset_type === "credit_alphanum12") &&
      b.asset_code === code &&
      b.asset_issuer === issuer
  );
}

// ─── Sponsored trustline ─────────────────────────────────────────────────
//
// A sponsored trustline lets the sponsor pay the 0.5 XLM subentry reserve
// instead of the user. This is the canonical Stellar pattern for custodial
// accounts: the user's 1 XLM starting balance stays fully usable, and the
// reserve is held in the sponsor's account (reclaimable if we ever decide
// to remove the sponsorship later).
//
// Two flows:
//
//   bootstrapAccountWithTrustline  — atomic createAccount + ChangeTrust in
//                                    one tx. Used when the destination
//                                    doesn't exist yet (lazy claim, first
//                                    contact).
//   addTrustlineSponsored          — separate tx adding a sponsored
//                                    trustline to an existing account. Used
//                                    for legacy users who bootstrapped
//                                    before this flow shipped.
//
// Both txs require both signatures (sponsor as fee/source signer, user as
// op-source signer for ChangeTrust + EndSponsoring). Soroban isn't
// involved — these are classic ops only, so no fee-bump wrapper.

const TRUSTLINE_LIMIT = "922337203685.4775807"; // i64 max in display units

function usdcAsset(env: Env): StellarSdk.Asset {
  return new StellarSdk.Asset("USDC", env.USDC_ISSUER);
}

/**
 * One atomic tx: sponsor sponsors the user's reserves, sponsor creates
 * the user's account with `BOOTSTRAP_STARTING_BALANCE` XLM, user adds a
 * USDC trustline (reserve sponsored), user ends sponsorship.
 *
 * Used when the user's account does NOT exist on chain yet — replaces a
 * bare `createAccount` so we never end up with bootstrapped accounts that
 * lack the trustline.
 */
async function bootstrapAccountWithTrustline(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  userKp: StellarSdk.Keypair
): Promise<string> {
  const sponsorAcct = await loadSponsorAccount(server, sponsor);
  const tx = new StellarSdk.TransactionBuilder(sponsorAcct, {
    // 4 ops × ~100 stroops each + headroom.
    fee: "10000",
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.beginSponsoringFutureReserves({
        sponsoredId: userKp.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.createAccount({
        destination: userKp.publicKey(),
        startingBalance: env.BOOTSTRAP_STARTING_BALANCE,
      })
    )
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset: usdcAsset(env),
        limit: TRUSTLINE_LIMIT,
        source: userKp.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({
        source: userKp.publicKey(),
      })
    )
    .setTimeout(60)
    .build();

  // Both signatures: sponsor pays the fee + signs sponsorship/createAccount,
  // user signs the ops sourced from their (newly-created) account.
  tx.sign(sponsor);
  tx.sign(userKp);

  const resp = await server.sendTransaction(tx);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(
      `bootstrap+trustline submit error${xdr ? `: ${xdr}` : ""}`
    );
  }
  return pollForSuccess(server, resp.hash);
}

/**
 * Add a sponsored USDC trustline to an account that already exists on
 * chain. Three ops: sponsor begins sponsoring, user changes trust, user
 * ends sponsoring. Both signatures required.
 *
 * Used by `ensureBootstrappedWithUsdcTrustline` when the account exists
 * but the trustline is missing (e.g. legacy user who bootstrapped before
 * this code shipped).
 */
async function addTrustlineSponsored(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  userKp: StellarSdk.Keypair
): Promise<string> {
  const sponsorAcct = await loadSponsorAccount(server, sponsor);
  const tx = new StellarSdk.TransactionBuilder(sponsorAcct, {
    fee: "10000",
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.beginSponsoringFutureReserves({
        sponsoredId: userKp.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset: usdcAsset(env),
        limit: TRUSTLINE_LIMIT,
        source: userKp.publicKey(),
      })
    )
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({
        source: userKp.publicKey(),
      })
    )
    .setTimeout(60)
    .build();

  tx.sign(sponsor);
  tx.sign(userKp);

  const resp = await server.sendTransaction(tx);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(
      `trustline add submit error${xdr ? `: ${xdr}` : ""}`
    );
  }
  return pollForSuccess(server, resp.hash);
}

/**
 * Make sure `userKp`'s account exists AND has the configured USDC
 * trustline. Idempotent. Three branches:
 *
 *   1. Account doesn't exist  → atomic create+trustline (one tx)
 *   2. Account exists, missing → sponsored ChangeTrust (one tx)
 *   3. Account exists, present → no-op
 *
 * Returns true if any on-chain change was made (useful for callers that
 * want to log/notify), false if the account was already in the desired
 * state.
 */
export async function ensureBootstrappedWithUsdcTrustline(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  userKp: StellarSdk.Keypair
): Promise<boolean> {
  const info = await getAccountInfo(env, userKp.publicKey());
  if (!info.exists) {
    await bootstrapAccountWithTrustline(env, server, sponsor, userKp);
    return true;
  }
  if (!hasTrustline(info.balances, "USDC", env.USDC_ISSUER)) {
    await addTrustlineSponsored(env, server, sponsor, userKp);
    return true;
  }
  return false;
}
