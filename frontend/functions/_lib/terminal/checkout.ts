// Paying for a plan: dollars, paid in USDC or XLM, settled in HITZ. A checkout builds one vault swap
// that sells the plan's price and sends the HITZ it buys straight to the treasury (a registered pool, so
// the buyer never holds HITZ and the Event Horizon never binds). It is confirmed by what the paying
// transaction did on chain, not only by its hash, so a fee bump or the email gateway's own transaction
// for the same swap pays it too.
//
// The chain is passed in (chain.ts talks to Soroban RPC), so this file is pure enough for Node tests.

import { markExpired, markPaid, getCheckout, insertCheckout, pendingCheckouts, planOf, type CheckoutRow } from "./store.ts";
import { isPaidPlan, isPayAsset, PERIODS, PLANS, priceUsd, type PayAsset, type PlanId } from "./plans.ts";

export class CheckoutError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A vault swap as a transaction carried it. */
export interface SwapCall {
  from: string;
  to: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

export interface PaidTx {
  hash: string;
  status: "SUCCESS" | "FAILED";
  /** The ledger's close time, ms. */
  closedAt: number;
  /** The single vault swap in it, or null for anything else. */
  call: SwapCall | null;
  /** HITZ the swap returned, in stroops, on success. */
  bought: bigint | null;
}

export interface Chain {
  /** The treasury, checked to be a registered pool; throws when payments cannot be taken. */
  treasury(): Promise<string>;
  /** XLM's dollar price, fresh; null when no fresh price is known. */
  xlmUsd(): Promise<number | null>;
  contractOf(asset: PayAsset): string;
  hitzContract: string;
  buildSwap(input: { account: string; sell: PayAsset; amount: string; to: string }): Promise<{ xdr: string; hash: string; validUntil: number | null; expectedHitz: string | null; argsXdr: string[] }>;
  submit(xdr: string): Promise<{ hash: string }>;
  /** null while the network has not seen the transaction. */
  readTx(hash: string): Promise<PaidTx | null>;
  /** The inner transaction hash of a signed envelope (fee bumps unwrapped). */
  hashOf(xdr: string): string;
  vaultId: string;
}

const DECIMALS = 7n;
const UNIT = 10n ** DECIMALS;
/** A payment may land this long before the checkout was made (clock skew) or after it expired (a slow ledger). */
const SLACK_MS = 120_000;

/** Dollars in an asset's smallest unit (7 decimals), rounded up so a payment is never short. */
export function amountFor(asset: PayAsset, usd: number, xlmUsd: number | null): { amount: string; raw: bigint } {
  if (!(usd > 0)) throw new CheckoutError(400, "invalid_price", "Nothing to pay.");
  let raw: bigint;
  if (asset === "USDC") raw = BigInt(Math.round(usd * 1e7));
  else {
    if (!xlmUsd || !(xlmUsd > 0)) throw new CheckoutError(503, "no_price", "No fresh XLM price right now. Pay in USDC, or try again in a few minutes.");
    raw = BigInt(Math.ceil((usd / xlmUsd) * 1e7));
  }
  const whole = raw / UNIT;
  const frac = (raw % UNIT).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  return { amount: frac ? `${whole}.${frac}` : `${whole}`, raw };
}

/** Does this transaction pay this checkout? */
export function checkPayment(tx: PaidTx, c: CheckoutRow, chain: Pick<Chain, "contractOf" | "hitzContract">): { ok: true } | { ok: false; code: string; message: string } {
  const no = (code: string, message: string) => ({ ok: false as const, code, message });
  if (tx.status !== "SUCCESS") return no("payment_failed", "The payment transaction failed on chain; nothing was paid. Start a new checkout.");
  const call = tx.call;
  if (!call) return no("not_a_payment", "That transaction is not a vault swap.");
  if (call.from !== c.account) return no("wrong_account", "That swap was not paid from this account.");
  if (call.to !== c.treasury) return no("wrong_recipient", "That swap did not send its HITZ to the treasury.");
  if (call.tokenIn !== chain.contractOf(c.asset as PayAsset) || call.tokenOut !== chain.hitzContract) return no("wrong_asset", `That swap did not sell ${c.asset} for HITZ.`);
  if (call.amountIn < BigInt(c.amount_raw)) return no("short_payment", `That swap sold less than ${c.amount} ${c.asset}.`);
  if (tx.closedAt < c.created_at - SLACK_MS || tx.closedAt > c.expires_at + SLACK_MS) return no("outside_window", "That swap was not made during this checkout.");
  return { ok: true };
}

const fmtHitz = (raw: bigint | null) => {
  if (raw === null) return null;
  const frac = (raw % UNIT).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${raw / UNIT}.${frac}` : `${raw / UNIT}`;
};

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CheckoutInput {
  account: string;
  plan: unknown;
  periods: unknown;
  asset: unknown;
}

export async function startCheckout(db: D1Database, chain: Chain, input: CheckoutInput, nowMs: number) {
  if (!isPaidPlan(input.plan)) throw new CheckoutError(400, "invalid_plan", "plan is trader, pro or institutional.");
  const periods = Number(input.periods ?? 1);
  if (!PERIODS.includes(periods)) throw new CheckoutError(400, "invalid_periods", "periods is 1 (30 days) or 12 (a year, priced as 10).");
  if (!isPayAsset(input.asset)) throw new CheckoutError(400, "invalid_asset", "asset is USDC or XLM.");
  const plan = input.plan as PlanId;
  const usd = priceUsd(plan, periods);
  const treasury = await chain.treasury();
  const { amount, raw } = amountFor(input.asset, usd, input.asset === "XLM" ? await chain.xlmUsd() : null);
  const built = await chain.buildSwap({ account: input.account, sell: input.asset, amount, to: treasury });
  const id = randomId();
  const expires = built.validUntil ?? nowMs + 600_000;
  await insertCheckout(db, {
    id,
    account: input.account,
    plan,
    periods,
    asset: input.asset,
    amount,
    amount_raw: raw.toString(),
    usd,
    treasury,
    tx_hash: built.hash,
    created_at: nowMs,
    expires_at: expires,
  });
  const current = await planOf(db, input.account, nowMs);
  return {
    checkout_id: id,
    plan,
    plan_name: PLANS[plan].name,
    periods,
    usd,
    pay: { asset: input.asset, amount },
    treasury,
    expected_hitz_to_treasury: built.expectedHitz,
    current_plan: current.plan,
    xdr: built.xdr,
    tx_hash: built.hash,
    valid_until: new Date(expires).toISOString(),
    // Email accounts pay through the gateway with the same call.
    gateway_call: { contractId: chain.vaultId, method: "swap", argsXdr: built.argsXdr },
    next: "Sign xdr in your wallet and POST it to /api/terminal/checkout/confirm as {id, xdr}, or submit it yourself and send {id, tx_hash}.",
  };
}

export interface ConfirmInput {
  id: unknown;
  xdr?: unknown;
  tx_hash?: unknown;
}

/** Confirm a checkout: submit its signed transaction if given, then read the payment from the chain. */
export async function confirmCheckout(db: D1Database, chain: Chain, account: string, input: ConfirmInput, nowMs: number) {
  const id = typeof input.id === "string" ? input.id : "";
  const c = id ? await getCheckout(db, id) : null;
  if (!c || c.account !== account) throw new CheckoutError(404, "unknown_checkout", "No such checkout for this account.");
  const view = async (status: string, extra: Record<string, unknown> = {}) => ({
    checkout_id: c.id,
    status,
    plan: c.plan,
    ...extra,
    subscription: await planOf(db, account, nowMs).then((p) => ({ plan: p.plan, until: p.until ? new Date(p.until).toISOString() : null })),
  });
  if (c.status === "paid") return view("paid", { tx_hash: c.paid_tx, hitz_to_treasury: c.hitz_bought });

  let hash = typeof input.tx_hash === "string" ? input.tx_hash.trim().toLowerCase() : "";
  if (typeof input.xdr === "string" && input.xdr.trim()) {
    if (chain.hashOf(input.xdr.trim()) !== c.tx_hash) throw new CheckoutError(400, "not_this_checkout", "That signed transaction is not this checkout's. Sign the xdr the checkout returned.");
    hash = (await chain.submit(input.xdr.trim())).hash;
  }
  if (!hash) hash = c.tx_hash ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new CheckoutError(400, "invalid_hash", "tx_hash must be a 64-character transaction hash.");

  const tx = await chain.readTx(hash);
  if (!tx) {
    if (nowMs > c.expires_at + SLACK_MS && hash === c.tx_hash) {
      await markExpired(db, c.id);
      return view("expired", { message: "The checkout expired before its payment was seen. Start a new one." });
    }
    return view("pending", { tx_hash: hash, message: "Not on chain yet. Confirm again in a few seconds." });
  }
  const verdict = checkPayment(tx, c, chain);
  if (!verdict.ok) {
    if (hash === c.tx_hash && tx.status === "FAILED") await markExpired(db, c.id);
    throw new CheckoutError(402, verdict.code, verdict.message);
  }
  const paid = await markPaid(db, c, tx.hash, fmtHitz(tx.bought), tx.closedAt);
  if (!paid.ok) {
    throw new CheckoutError(409, paid.code, paid.code === "tx_used" ? "That transaction already paid another checkout." : "This checkout is no longer pending.");
  }
  return view("paid", { tx_hash: tx.hash, hitz_to_treasury: fmtHitz(tx.bought) });
}

/**
 * The cron's sweep: pending checkouts of the last 7 days (Soroban RPC keeps about that long), confirmed
 * from their own transaction when it landed, expired when it never did.
 */
export async function reconcileCheckouts(db: D1Database, chain: Chain, nowMs: number) {
  const report = { checked: 0, paid: 0, expired: 0 };
  for (const c of await pendingCheckouts(db, nowMs - 7 * 86_400_000)) {
    if (!c.tx_hash) continue;
    report.checked += 1;
    try {
      const tx = await chain.readTx(c.tx_hash);
      if (tx && checkPayment(tx, c, chain).ok) {
        if ((await markPaid(db, c, tx.hash, fmtHitz(tx.bought), tx.closedAt)).ok) report.paid += 1;
      } else if ((tx && tx.status === "FAILED") || (!tx && nowMs > c.expires_at + 10 * 60_000)) {
        await markExpired(db, c.id);
        report.expired += 1;
      }
    } catch (err) {
      console.warn("[terminal] reconcile", c.id, err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}
