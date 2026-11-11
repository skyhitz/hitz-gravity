// Server-side Stellar helpers for the gateway.
//
// Responsibilities:
//   1. Run a contract call for an email account: simulate it, check it,
//      create the account if this is its first real action, inner-sign with
//      the derived key, fee-bump with the sponsor, submit, poll.
//   2. Create an email account: fully sponsored, with a zero balance, and
//      recorded in D1 so its reserve can be reclaimed.
//   3. Sponsor-sourced calls and payments for the legacy reparation claims.
//   4. Transparently restore archived Soroban state when the simulation
//      comes back with a `restorePreamble`.
//
// The sponsor pays every fee and holds every reserve; an email account never
// needs XLM of its own. What the sponsor never does is give XLM away, or act
// for a caller it hasn't verified. It is a hot wallet behind public
// endpoints: anything it hands out for the asking can be collected in bulk.

import * as StellarSdk from "@stellar/stellar-sdk";
import { emailDigest, getServerKeys } from "./derive";
import { recordSponsored } from "./gateway-accounts.ts";
import { FEE_BUMP_BASE_FEE, MAX_RESOURCE_FEE, onlySourceAuth, type AllowedCall, type GatewayPolicy } from "./gateway-policy.ts";
import { NEW_ACCOUNTS_PER_DAY, newAccountLimits, sponsoredLimits } from "./limits.ts";
import { hit } from "./rate-limit.ts";
import { nativeFunds, type NativeFunds } from "./reserves.ts";
import type { Env } from "./types";

/** A refusal the caller can act on, with the HTTP status to send it with. */
export class GatewayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A numeric [vars] setting, or its default when unset or unreadable. */
function numberVar(value: string | undefined, fallback: number): number {
  const n = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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
  if (BigInt(restoreSim.minResourceFee) > MAX_RESOURCE_FEE) {
    throw new GatewayError(400, "Restoring this account's archived data costs more than the gateway sponsors.");
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

export interface ExecuteResult {
  hash: string;
}

/** A contract call the gateway has agreed to make for an email account. */
export interface SponsoredCall {
  /** The account's keypair, derived from the session's email. */
  userKp: StellarSdk.Keypair;
  email: string;
  contractId: string;
  method: string;
  args: StellarSdk.xdr.ScVal[];
  /** What the call does, as read by `checkCall`. */
  call: AllowedCall;
  policy: GatewayPolicy;
  /** The caller's address, for the per-address limit on new accounts. */
  ip: string;
}

/** Refuse a simulated call the sponsor shouldn't pay for. */
function checkSimulation(
  sim: StellarSdk.rpc.Api.SimulateTransactionResponse
): asserts sim is StellarSdk.rpc.Api.SimulateTransactionSuccessResponse {
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new GatewayError(400, `simulation failed: ${sim.error}`);
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new GatewayError(400, "simulation failed: no result");
  }
  // Recording-mode simulation lists every signature the call would need.
  // Anything beyond the account's own would fail on chain, at the sponsor's cost.
  if (!onlySourceAuth(sim.result.auth)) {
    throw new GatewayError(403, "This call needs a signature from another address.");
  }
  if (BigInt(sim.minResourceFee) > MAX_RESOURCE_FEE) {
    throw new GatewayError(400, "This call costs more in network fees than the gateway sponsors.");
  }
}

/**
 * End-to-end: run a checked contract call for an email account, the sponsor
 * paying through a fee bump.
 *
 *   1. Refuse while the sponsor is below its operating floor.
 *   2. For a swap that pays USDC to the account, make sure it can hold USDC.
 *   3. Simulate. The account doesn't have to exist yet for this, so a call
 *      that can't succeed (nothing to send, a bad swap) costs the sponsor
 *      nothing and creates nothing.
 *   4. If this is the email's first real action, create its account: fully
 *      sponsored, zero balance, recorded in D1.
 *   5. Build with the account's sequence, simulate again, assemble, sign with
 *      the derived key, fee-bump with the sponsor, submit, poll.
 *
 * The day's total of sponsored transactions (limits.ts) is charged once, at
 * the first point the sponsor is about to pay for something: calls that fail
 * before that don't use it up.
 */
export async function runSponsoredContractCall(
  env: Env,
  req: SponsoredCall
): Promise<ExecuteResult> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  const self = req.userKp.publicKey();

  // (1)
  await requireSponsorFunds(env);

  let charged = false;
  const charge = async (): Promise<void> => {
    if (charged) return;
    charged = true;
    const verdict = await hit(env.DB, sponsoredLimits());
    if (!verdict.ok) {
      const hours = Math.max(1, Math.ceil((verdict.retryAfter ?? 3600) / 3600));
      throw new GatewayError(429, `The gateway has sponsored as many transactions as it does in a day. Try again in ${hours} hours.`);
    }
  };

  // (2)
  if (req.call.kind === "swap" && req.call.tokenOut === req.policy.usdc && req.call.to === self) {
    await ensureUsdcTrustline(env, server, sponsor, req, charge);
  }

  // Each build bumps the Account object it is given, so every attempt gets
  // its own, at the sequence number read from the ledger.
  const contract = new StellarSdk.Contract(req.contractId);
  const simulate = async (sequence: string) => {
    const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(self, sequence), {
      fee: "100", // the sponsor's fee bump supersedes it
      networkPassphrase: env.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(req.method, ...req.args))
      .setTimeout(60)
      .build();
    return { tx, sim: await server.simulateTransaction(tx) };
  };

  // (3)
  let existing = await maybeGetAccount(server, self);
  let { tx, sim } = await simulate(existing?.sequenceNumber() ?? "0");
  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
    // Archived state: the sponsor restores it, then we look again.
    await charge();
    await maybeRestoreFootprint(env, server, sponsor, sim);
    ({ tx, sim } = await simulate(existing?.sequenceNumber() ?? "0"));
    if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
      throw new Error("restore preamble persisted after restore tx");
    }
  }
  checkSimulation(sim);
  await charge();

  // (4)
  if (!existing) {
    await ensureAccount(env, server, sponsor, req.userKp, req.email, {
      reason: "execute",
      ip: req.ip,
      capped: true,
    });
    existing = await server.getAccount(self);
    ({ tx, sim } = await simulate(existing.sequenceNumber()));
    checkSimulation(sim);
  }

  // (5) `baseFee` is the sponsor's inclusion bid per operation; the SDK adds
  // the inner transaction's resource fee on top.
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(req.userKp);
  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    FEE_BUMP_BASE_FEE,
    prepared,
    env.NETWORK_PASSPHRASE
  );
  feeBump.sign(sponsor);

  const resp = await server.sendTransaction(feeBump);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`feebump submit error${xdr ? `: ${xdr}` : ""}`);
  }
  const finalHash = await pollForSuccess(server, resp.hash);
  return { hash: finalHash };
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
 * The sponsor's XLM: what it holds, what is locked in reserves (its own and
 * the ones it sponsors for email accounts), and what it can actually spend.
 * Throws if the account is missing.
 *
 * Alerts and the operating floor go by `spendable`. The total is no guide:
 * nearly all of it can be locked in reserves with almost nothing left to
 * pay with.
 */
export async function getSponsorFunds(env: Env): Promise<NativeFunds> {
  const { sponsorKeypair: sponsor } = await getServerKeys(env.MASTER_SECRET);
  const info = await getAccountInfo(env, sponsor.publicKey());
  if (!info.exists) {
    throw new Error(
      `gas sponsor account ${sponsor.publicKey()} is not funded on chain.`
    );
  }
  return nativeFunds(info);
}

/**
 * Refuse sponsored work while the sponsor can spend less than its operating
 * floor (`GATEWAY_MIN_SPONSOR_XLM`, 5 XLM unless set). Running it to zero
 * leaves claims half-paid and nothing for the operator to act with.
 */
export async function requireSponsorFunds(env: Env): Promise<void> {
  const floor = numberVar(env.GATEWAY_MIN_SPONSOR_XLM, 5);
  const funds = await getSponsorFunds(env);
  if (Number(funds.spendable) / 1e7 < floor) {
    throw new GatewayError(
      503,
      "The gateway's gas sponsor needs a top-up. Sponsored transactions are paused until then."
    );
  }
}

// ─── Read-only contract views ────────────────────────────────────────────

// Any syntactically valid account works as the source of a simulation —
// nothing is signed or submitted, and the account needn't exist.
const VIEW_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/**
 * Call a read-only contract method via simulation and return the decoded
 * native value (`scValToNative`). Throws on simulation error. Used by the
 * ingestion cron for `list_pools`, `get_tokens` and token `name()`.
 */
export async function simulateView(
  env: Env,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<unknown> {
  const server = new StellarSdk.rpc.Server(env.RPC_URL);
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(VIEW_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(new StellarSdk.Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`${method} simulation returned no result`);
  }
  return StellarSdk.scValToNative(sim.result.retval);
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
  /** Committed to open offers (display units). */
  selling_liabilities?: string;
}

export interface AccountInfo {
  exists: boolean;
  balances: BalanceLine[];
  /** Reserve counters, as Horizon reports them (zero for a missing account). */
  subentry_count: number;
  num_sponsoring: number;
  num_sponsored: number;
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
    return { exists: false, balances: [], subentry_count: 0, num_sponsoring: 0, num_sponsored: 0 };
  }
  if (!resp.ok) {
    throw new Error(`horizon ${resp.status} fetching ${publicKey}`);
  }
  const data = (await resp.json()) as Partial<AccountInfo>;
  return {
    exists: true,
    balances: data.balances ?? [],
    subentry_count: data.subentry_count ?? 0,
    num_sponsoring: data.num_sponsoring ?? 0,
    num_sponsored: data.num_sponsored ?? 0,
  };
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

// ─── Sponsored accounts and trustlines ───────────────────────────────────
//
// An email account pays for nothing: the sponsor holds the reserve of the
// account entry (1 XLM) and of its USDC trustline (0.5 XLM), and the account
// starts with a zero balance. That XLM is locked, not spent: it comes back
// to the sponsor when the account is merged, which the Worker can do for any
// account recorded in D1 `gateway_accounts`.
//
//   createSponsoredAccount     one tx: sponsor begins sponsoring, creates the
//                              account with 0 XLM, optionally the account
//                              adds its USDC trustline, sponsoring ends.
//   addSponsoredUsdcTrustline  the trustline alone, for an existing account.
//   ensureAccount              create if missing, within the daily limits,
//                              and record it.
//   ensureUsdcTrustline        for a swap that pays USDC to the account.
//
// Both transactions carry two signatures (the sponsor's and the account's).
// They are classic operations, so no fee-bump wrapper.

const TRUSTLINE_LIMIT = "922337203685.4775807"; // i64 max in display units

function usdcAsset(env: Env): StellarSdk.Asset {
  return new StellarSdk.Asset("USDC", env.USDC_ISSUER);
}

/**
 * One atomic tx: the sponsor takes on the new account's reserves and creates
 * it with a zero balance; with `withUsdcTrustline` the account also adds its
 * USDC trustline, under the same sponsorship.
 *
 * The account gets no XLM. It needs none: its reserves are sponsored and its
 * transactions are fee-bumped.
 */
async function createSponsoredAccount(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  userKp: StellarSdk.Keypair,
  withUsdcTrustline: boolean
): Promise<string> {
  const sponsorAcct = await loadSponsorAccount(server, sponsor);
  const builder = new StellarSdk.TransactionBuilder(sponsorAcct, {
    fee: "10000", // per operation: 0.001 XLM
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
        startingBalance: "0",
      })
    );
  if (withUsdcTrustline) {
    builder.addOperation(
      StellarSdk.Operation.changeTrust({
        asset: usdcAsset(env),
        limit: TRUSTLINE_LIMIT,
        source: userKp.publicKey(),
      })
    );
  }
  const tx = builder
    .addOperation(
      StellarSdk.Operation.endSponsoringFutureReserves({
        source: userKp.publicKey(),
      })
    )
    .setTimeout(60)
    .build();

  // Both signatures: the sponsor pays the fee and creates the account, the
  // new account signs the operations sourced from it.
  tx.sign(sponsor);
  tx.sign(userKp);

  const resp = await server.sendTransaction(tx);
  if (resp.status === "ERROR") {
    const xdr = resp.errorResult?.toXDR("base64");
    throw new Error(`account creation submit error${xdr ? `: ${xdr}` : ""}`);
  }
  return pollForSuccess(server, resp.hash);
}

/**
 * Add a sponsored USDC trustline to an account that already exists on
 * chain. Three ops: sponsor begins sponsoring, user changes trust, user
 * ends sponsoring. Both signatures required.
 */
async function addSponsoredUsdcTrustline(
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
 * Create the email's account if it doesn't exist. Returns true when it did.
 *
 * `capped` applies the daily limits on new accounts (all callers together,
 * and per address): each one locks 1 XLM of the sponsor's balance, and with
 * the trustline 1.5. Legacy reparation claims are not capped: the operator
 * queued those emails.
 *
 * The account is recorded before it is created (gateway-accounts.ts), so no
 * account can exist that the Worker couldn't find and merge back later.
 */
export async function ensureAccount(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  userKp: StellarSdk.Keypair,
  email: string,
  opts: { reason: "execute" | "reparation"; ip?: string; capped: boolean; withUsdcTrustline?: boolean }
): Promise<boolean> {
  const address = userKp.publicKey();
  if ((await getAccountInfo(env, address)).exists) return false;

  if (opts.capped) {
    const perDay = numberVar(env.GATEWAY_MAX_NEW_ACCOUNTS_PER_DAY, NEW_ACCOUNTS_PER_DAY);
    const verdict = await hit(env.DB, newAccountLimits(opts.ip, perDay));
    if (!verdict.ok) {
      throw new GatewayError(429, "The gateway has opened as many new accounts as it does in a day. Try again tomorrow.");
    }
  }

  await recordSponsored(env.DB, { address, emailDigest: await emailDigest(email), reason: opts.reason });

  try {
    await createSponsoredAccount(env, server, sponsor, userKp, opts.withUsdcTrustline ?? false);
  } catch (err) {
    // Two requests for the same new account: the other one created it.
    if ((await getAccountInfo(env, address)).exists) return false;
    throw err;
  }
  return true;
}

/**
 * Make sure the account can hold USDC before a swap that pays USDC to it.
 * The sponsor only commits a reserve for a swap that can happen: the account
 * must hold what it sells, and the vault must quote at least the minimum.
 */
async function ensureUsdcTrustline(
  env: Env,
  server: StellarSdk.rpc.Server,
  sponsor: StellarSdk.Keypair,
  req: SponsoredCall,
  /** Charges the day's total of sponsored transactions; called once the swap is known to be possible. */
  charge: () => Promise<void>
): Promise<void> {
  if (req.call.kind !== "swap") return;
  const self = req.userKp.publicKey();
  const info = await getAccountInfo(env, self);
  if (info.exists && hasTrustline(info.balances, "USDC", env.USDC_ISSUER)) return;

  const address = (a: string) => StellarSdk.Address.fromString(a).toScVal();
  const i128 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "i128" });
  let held = 0n;
  try {
    held = BigInt((await simulateView(env, req.call.tokenIn, "balance", [address(self)])) as bigint);
  } catch {
    held = 0n; // the token can't report a balance for this account: it holds none
  }
  if (held < req.call.amountIn) {
    throw new GatewayError(400, "simulation failed: the account doesn't hold enough to make this swap");
  }
  let quoted: bigint;
  try {
    quoted = BigInt(
      (await simulateView(env, req.policy.vault, "quote", [
        address(req.call.tokenIn),
        address(req.call.tokenOut),
        i128(req.call.amountIn),
      ])) as bigint
    );
  } catch (err) {
    throw new GatewayError(400, `simulation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (quoted < req.call.minOut) {
    throw new GatewayError(400, "simulation failed: the price moved past your slippage tolerance");
  }

  await charge();
  if (!info.exists) {
    await ensureAccount(env, server, sponsor, req.userKp, req.email, {
      reason: "execute",
      ip: req.ip,
      capped: true,
      withUsdcTrustline: true,
    });
  } else {
    // An account the gateway didn't create (opened by an incoming XLM
    // transfer, or older than the record): written down before the sponsor
    // locks the trustline's reserve for it.
    await recordSponsored(env.DB, { address: self, emailDigest: await emailDigest(req.email), reason: "trustline" });
    await addSponsoredUsdcTrustline(env, server, sponsor, req.userKp);
  }
}
