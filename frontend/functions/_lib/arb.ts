// Arbitrage between the HITZ Sovereign Vault and the Stellar DEX (SDEX).
//
// The vault prices XLM against USDC through HITZ (XLM → HITZ → USDC in one
// `swap` call) and has no oracle, so its XLM/USDC rate drifts away from the
// market until someone trades it back. Each run:
//
//   1. reads the vault's pools, the bot's balances, and the SDEX price of
//      XLM in USDC (Horizon path quotes, which see the order book and AMMs);
//   2. sizes the vault trade that earns the most once it is bought back on
//      the SDEX, with the exact port of the contract math (vaultMath.ts);
//   3. if that clears the profit floor after the fees the simulation asks
//      for, buys the asset back on the SDEX FIRST (a path payment that must
//      return more than the vault leg will sell), and only then swaps in the
//      vault, with a minimum equal to what the SDEX leg spent.
//
// The order matters. The SDEX price is the one that can move or turn out not
// to be there; the vault's is fixed by its reserves. A buy-back that fails
// costs a 0.00001 XLM fee and nothing reaches the vault, so the vault's fee
// (2% at least) is never paid on a quote that vanished. A round trip that
// finishes is a profit by construction: both minimums are enforced on chain.
// If the vault leg then fails (someone else traded first), what is left is a
// plain conversion at the SDEX price.
//
// When there is nothing to trade and the inventory is lopsided, it converts
// back toward half XLM, half USDC on the SDEX.
//
// The same module runs in the Worker cron (arb-worker.ts), from Node
// (scripts/arb-bot.mjs) and in the replay on past prices
// (scripts/arb-replay.mjs), so it is erasable TypeScript with explicit .ts
// imports, no Worker bindings, and plain `fetch` for Soroban RPC and Horizon.
// Strategy notes and the numbers behind the defaults: frontend/ARB_BOT.md.

import * as StellarSdk from "@stellar/stellar-sdk";
import { poolsFromStates, swap as vaultSwap, VaultMathError, type Pool } from "../../app/lib/vaultMath.ts";

/** What a run needs from the outside world; tests and the replay bring their own. */
export interface Io {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

export interface ArbConfig {
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  /** Sovereign Vault contract. */
  vault: string;
  /** HITZ contract (the vault's shared asset). */
  hitz: string;
  usdcIssuer: string;
  /** The bot's account. */
  address: string;
  /** Signs in live mode; absent for a dry run. */
  keypair?: StellarSdk.Keypair;
  /** Without it, the run plans and simulates but sends nothing. */
  live: boolean;
  /** Smallest profit worth a trade, in XLM, after network fees. */
  minProfitXlm: number;
  /** The profit must also be at least this share of the trade (basis points). */
  minProfitBps: number;
  /** Largest trade, in XLM (a USDC trade is capped at the same value). */
  maxTradeXlm: number;
  /** XLM kept above the account's reserve, for fees. */
  feeBufferXlm: number;
  io?: Partial<Io>;
}

/**
 * The floor is low on purpose: Skyhitz runs the bot to keep the vault's price
 * fair, and what the bot doesn't keep stays in the vault as fees. Replayed on
 * the SDEX's prices of Jun 12 to Nov 11, 2026 at the vault's depth then, 0.02
 * XLM kept the vault 2.1% from the market on average (8.6% with no bot) on
 * about 7 trades a day of 5 XLM, each earning about 0.5% (ARB_BOT.md). The 30
 * basis points cover the SDEX moving while a leg lands: it moved more than
 * that within a minute 1.3% of the time.
 */
export const DEFAULTS = {
  minProfitXlm: 0.02,
  minProfitBps: 30,
  maxTradeXlm: 150,
  feeBufferXlm: 5,
};

export type Side = "XLM" | "USDC";

export interface Leg {
  hash: string;
  /** REJECTED: refused before inclusion · EXPIRED: never included, and it no longer can be ·
   *  UNKNOWN: no final answer could be read. */
  status: "SUCCESS" | "FAILED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
  /** Result code when it didn't succeed. */
  code?: string;
  /** XLM charged in fees. */
  feeXlm?: string;
  /** What the leg delivered. */
  received?: string;
}

export interface ArbReport {
  at: string;
  mode: "live" | "dry-run";
  address: string;
  /** none: nothing worth doing · would-trade: a dry run found a trade · trade: both legs done ·
   *  trade-incomplete: the SDEX leg ran and the vault leg didn't · missed: the SDEX leg didn't go
   *  through, so nothing changed · rebalance · setup: the USDC trustline was added · skip · error */
  action: "none" | "would-trade" | "trade" | "trade-incomplete" | "missed" | "rebalance" | "setup" | "skip" | "error";
  reason?: string;
  ledger?: number;
  balances?: { xlm: string; usdc: string | null };
  /** SDEX: USDC per XLM when selling XLM (bid) and when buying it (ask). */
  market?: { bid: number; ask: number };
  /** The vault's own XLM price in USDC. */
  vaultRate?: number;
  /** vaultRate against the SDEX mid, in percent. */
  gapPct?: number;
  plan?: {
    /** The asset sold into the vault, and the one it pays. */
    sell: Side;
    buy: Side;
    amountIn: string;
    /** What the vault pays for it (simulated). */
    vaultOut: string;
    /** What the SDEX leg spends of the bought asset: also the vault leg's minimum. */
    hedgeIn: string;
    /** What the SDEX leg should return of the sold asset, and the least it may. */
    hedgeOut: string;
    hedgeMin: string;
    /** hedgeOut less amountIn, in the sold asset. */
    profit: string;
    /** In XLM, after fees, counting what the vault pays over hedgeIn. */
    profitXlm: number;
    /** Network fees expected for both legs. */
    feeXlm: number;
  };
  /** The SDEX leg (first), or a rebalance. */
  hedgeLeg?: Leg;
  /** The vault leg (second). */
  vaultLeg?: Leg;
  setupLeg?: Leg;
  /** Realized profit in the sold asset, and in XLM after both legs' fees. */
  profit?: string;
  profitXlm?: number;
  error?: string;
}

// ─── Units ───────────────────────────────────────────────────────────────────

const UNIT = 10_000_000n; // XLM, USDC and HITZ all have 7 decimals

function fmt(raw: bigint): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const frac = abs % UNIT;
  return `${neg ? "-" : ""}${abs / UNIT}${frac ? `.${frac.toString().padStart(7, "0").replace(/0+$/, "")}` : ""}`;
}

/** Horizon's decimal strings (always 7 places or fewer) → raw units. */
function raw(decimal: string): bigint {
  const [w, f = ""] = decimal.split(".");
  return BigInt(w) * UNIT + BigInt((f + "0000000").slice(0, 7));
}

const fromXlm = (xlm: number) => BigInt(Math.floor(xlm * 1e7));
const toNum = (v: bigint) => Number(v) / 1e7;
const minBig = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const other = (side: Side): Side => (side === "XLM" ? "USDC" : "XLM");

/** Smallest trades considered: dust isn't worth a transaction. */
const MIN_IN: Record<Side, bigint> = { XLM: 10_000_000n, USDC: 1_500_000n };
/** Reference sizes for the SDEX price. */
const REF_IN: Record<Side, bigint> = { XLM: 100_000_000n, USDC: 15_000_000n };
/** What is left of a trade after two hops at the vault's 1% fee floor: no trade keeps more. */
const FLOOR_KEEP = 0.99 * 0.99;
/**
 * The SDEX leg spends this much less (basis points) than the least the vault
 * will pay while its leg is valid, so the vault leg always makes it whole.
 * The difference stays in the account as the bought asset.
 */
const VAULT_TOLERANCE_BPS = 2n;
/** The SDEX leg may land this far under its quote, never under break-even. */
const HEDGE_SLIPPAGE_BPS = 30n;
/** Network fees assumed before the simulation gives the real ones, in XLM (a vault swap costs about 0.002). */
const FEE_ESTIMATE_XLM = 0.0025;
/** Inclusion fees the network usually charges, in stroops: 200 for the vault leg, 100 for the SDEX leg. */
const USUAL_INCLUSION = 300n;
/** Inclusion bids, in stroops. The network charges the going rate up to these. */
const SOROBAN_BID = "100000";
const CLASSIC_BID = "10000";
/** How long each leg stays valid, in seconds. The vault leg is built before the SDEX leg is sent. */
const HEDGE_VALID_S = 30;
const VAULT_VALID_S = 60;
/** The ledger's clock may run this far from ours, in seconds. */
const CLOCK_SLACK_S = 10;
/** Following a transaction: time between looks, the ledger time past its validity that settles
 *  "it never landed", and how long past its validity to keep asking an RPC that doesn't answer. */
const POLL_MS = 2000;
const EXPIRY_GRACE_S = 10;
const GIVE_UP_AFTER_S = 60;
const SEND_ATTEMPTS = 4;
/** Rebalance when one side holds less than this share of the inventory's value. */
const REBALANCE_BELOW = 0.2;
/** ...and only at a price within this share of the going one. */
const REBALANCE_MAX_COST = 0.01;
const BASE_RESERVE = 5_000_000n;

// ─── Sizing ──────────────────────────────────────────────────────────────────

/** Arg-max of f over [lo, hi]: a log-spaced scan, then a golden-section search around the best point. */
export function maximize(f: (x: bigint) => bigint, lo: bigint, hi: bigint): { x: bigint; value: bigint } {
  const n = 28;
  const grid: bigint[] = [];
  const ratio = Math.pow(Number(hi) / Number(lo), 1 / (n - 1));
  for (let i = 0; i < n; i++) {
    const x = i === n - 1 ? hi : BigInt(Math.round(Number(lo) * ratio ** i));
    if (!grid.length || x > grid[grid.length - 1]) grid.push(x);
  }
  const values = grid.map(f);
  let k = 0;
  for (let i = 1; i < grid.length; i++) if (values[i] > values[k]) k = i;
  let best = { x: grid[k], value: values[k] };
  let a = grid[Math.max(0, k - 1)];
  let b = grid[Math.min(grid.length - 1, k + 1)];
  const phi = (Math.sqrt(5) - 1) / 2;
  const inner = (from: bigint, span: bigint, share: number) => from + BigInt(Math.round(Number(span) * share));
  let c = inner(a, b - a, 1 - phi);
  let d = inner(a, b - a, phi);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 80 && b - a > 2n; i++) {
    if (fc >= fd) {
      b = d;
      d = c;
      fd = fc;
      c = inner(a, b - a, 1 - phi);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = inner(a, b - a, phi);
      fd = f(d);
    }
    if (fc > best.value) best = { x: c, value: fc };
    if (fd > best.value) best = { x: d, value: fd };
  }
  return best;
}

/** The SDEX, as USDC per XLM: what selling XLM gets (bid) and what buying it costs (ask). */
export interface Market {
  bid: number;
  ask: number;
}

export interface TradePlan {
  /** The asset sold into the vault, and the one the vault pays. */
  sell: Side;
  buy: Side;
  amountIn: bigint;
  /** What the vault pays for amountIn, by the contract's math. */
  vaultOut: bigint;
  /** What the SDEX leg spends of the bought asset: vaultOut less the tolerance. */
  hedgeIn: bigint;
  /** What that buys back of the sold asset at the market's rate. */
  hedgeOut: bigint;
  /** hedgeOut less amountIn, in the sold asset. */
  profit: bigint;
  /** In XLM, before network fees, counting the bought asset left over. */
  profitXlm: number;
  notionalXlm: number;
}

export interface PlanInput {
  /** The vault's pools, quotable at `now` (poolsFromStates of the `pools()` view, or a replay's own). */
  pools: readonly Pool[];
  now: bigint;
  hitz: string;
  /** Contract addresses of the two assets. */
  sac: Record<Side, string>;
  /** What the account can spend of each. */
  balances: { xlm: bigint; usdc: bigint };
  market: Market;
  maxTradeXlm: number;
}

/**
 * The round trip that earns the most: sell one asset into the vault and buy
 * it back on the SDEX, in whichever direction pays, sized with the contract's
 * own math. Null when nothing pays or the account can't fund the smallest
 * trade. Whether the profit is worth a trade is the caller's call.
 */
export function planTrade(input: PlanInput): TradePlan | null {
  const { pools, now, hitz, sac, balances, market } = input;
  const xlmPool = pools.find((p) => p.asset === sac.XLM);
  const usdcPool = pools.find((p) => p.asset === sac.USDC);
  if (!xlmPool || !usdcPool || xlmPool.hitz <= 0n || xlmPool.reserve <= 0n || usdcPool.hitz <= 0n || usdcPool.reserve <= 0n) return null;
  if (!(market.bid > 0) || !(market.ask > 0)) return null;
  // USDC per XLM in the vault, before fees.
  const vaultRate = Number(usdcPool.reserve) / Number(usdcPool.hitz) / (Number(xlmPool.reserve) / Number(xlmPool.hitz));
  const cap = fromXlm(input.maxTradeXlm);
  let best: TradePlan | null = null;
  for (const sell of ["XLM", "USDC"] as const) {
    const buy = other(sell);
    // Units of the sold asset that one unit of the bought asset buys back on the SDEX.
    const backRate = sell === "XLM" ? 1 / market.ask : market.bid;
    const xlmPerSold = sell === "XLM" ? 1 : 1 / market.ask;
    const xlmPerBought = sell === "XLM" ? 1 / market.ask : 1;
    // The vault's price of the sold asset in the bought one. Every trade gets less.
    const spot = sell === "XLM" ? vaultRate : 1 / vaultRate;
    if (spot * FLOOR_KEEP * backRate <= 1) continue;
    const held = sell === "XLM" ? balances.xlm : balances.usdc;
    const heldBought = sell === "XLM" ? balances.usdc : balances.xlm;
    // The SDEX leg spends the bought asset before the vault pays any back.
    const fundable = BigInt(Math.floor(Number(heldBought) / spot));
    const maxIn = minBig(held, fundable, sell === "XLM" ? cap : BigInt(Math.floor(Number(cap) * market.bid)));
    if (maxIn < MIN_IN[sell]) continue;
    const pays = (a: bigint, at = now): bigint => {
      try {
        return vaultSwap(pools, sac[sell], sac[buy], a, at, hitz).amountOut;
      } catch (err) {
        if (err instanceof VaultMathError) return 0n;
        throw err;
      }
    };
    const { x, value } = maximize((a) => BigInt(Math.floor(Number(pays(a)) * backRate)) - a, MIN_IN[sell], maxIn);
    if (value <= 0n) continue;
    const vaultOut = pays(x);
    // The least the vault pays while its leg can land. A dislocation left by a trade the other way
    // fades between ledgers, and a sale that overshoots it then pays a little less; the output moves
    // one way or rises then falls over the wait, so the lower end is the least.
    const sure = minBig(vaultOut, pays(x, now + BigInt(VAULT_VALID_S + CLOCK_SLACK_S)));
    const hedgeIn = sure - (sure * VAULT_TOLERANCE_BPS + 9_999n) / 10_000n;
    if (hedgeIn <= 0n) continue;
    const hedgeOut = BigInt(Math.floor(Number(hedgeIn) * backRate));
    const plan: TradePlan = {
      sell,
      buy,
      amountIn: x,
      vaultOut,
      hedgeIn,
      hedgeOut,
      profit: hedgeOut - x,
      profitXlm: toNum(hedgeOut - x) * xlmPerSold + toNum(vaultOut - hedgeIn) * xlmPerBought,
      notionalXlm: toNum(x) * xlmPerSold,
    };
    if (!best || plan.profitXlm > best.profitXlm) best = plan;
  }
  return best;
}

/** The least a round trip must earn after network fees, in XLM: the fixed floor, or the share of the trade if that is more. */
export function floorXlm(plan: Pick<TradePlan, "notionalXlm">, cfg: Pick<ArbConfig, "minProfitXlm" | "minProfitBps">): number {
  return Math.max(cfg.minProfitXlm, (cfg.minProfitBps / 10_000) * plan.notionalXlm);
}

/** With one side under a fifth of the inventory's value: the conversion back toward half and half. */
function planRebalance(balances: { xlm: bigint; usdc: bigint }, market: Market): { sell: Side; buy: Side; amount: bigint } | null {
  const xlmValue = toNum(balances.xlm);
  const usdcValue = toNum(balances.usdc) / market.ask;
  const total = xlmValue + usdcValue;
  if (total <= 0 || Math.min(xlmValue, usdcValue) >= total * REBALANCE_BELOW) return null;
  const sell: Side = xlmValue > usdcValue ? "XLM" : "USDC";
  const excessXlm = (Math.max(xlmValue, usdcValue) - total / 2) * 0.98;
  const amount = sell === "XLM" ? fromXlm(excessXlm) : fromXlm(excessXlm * market.bid);
  return amount < MIN_IN[sell] ? null : { sell, buy: other(sell), amount };
}

// ─── Soroban RPC and Horizon over fetch ──────────────────────────────────────

interface Net {
  cfg: ArbConfig;
  io: Io;
  asset: Record<Side, StellarSdk.Asset>;
  sac: Record<Side, string>;
}

const defaultIo: Io = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

function netOf(cfg: ArbConfig): Net {
  const xlm = StellarSdk.Asset.native();
  const usdc = new StellarSdk.Asset("USDC", cfg.usdcIssuer);
  return {
    cfg,
    io: { ...defaultIo, ...cfg.io },
    asset: { XLM: xlm, USDC: usdc },
    sac: { XLM: xlm.contractId(cfg.networkPassphrase), USDC: usdc.contractId(cfg.networkPassphrase) },
  };
}

async function rpcCall<T>(net: Net, method: string, params: unknown): Promise<T> {
  const res = await net.io.fetch(net.cfg.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

async function simulate(net: Net, tx: StellarSdk.Transaction): Promise<StellarSdk.rpc.Api.SimulateTransactionResponse> {
  const response = await rpcCall<StellarSdk.rpc.Api.RawSimulateTransactionResponse>(net, "simulateTransaction", { transaction: tx.toXDR() });
  return StellarSdk.rpc.parseRawSimulation(response);
}

/** A Soroban call's return value, from its transaction meta. */
export function returnValueOf(metaXdr: string | undefined): StellarSdk.xdr.ScVal | undefined {
  if (!metaXdr) return undefined;
  try {
    const meta = StellarSdk.xdr.TransactionMeta.fromXDR(metaXdr, "base64");
    const soroban = meta.switch() === 4 ? meta.v4().sorobanMeta() : meta.switch() === 3 ? meta.v3().sorobanMeta() : null;
    return soroban?.returnValue() ?? undefined;
  } catch {
    return undefined;
  }
}

/** What a successful path payment delivered, from its result. */
export function pathPaymentReceived(result: StellarSdk.xdr.TransactionResult | undefined): bigint | null {
  try {
    const op = result!.result().results()[0].tr();
    return BigInt(op.pathPaymentStrictSendResult().success().last().amount().toString());
  } catch {
    return null;
  }
}

interface VaultView {
  ledger: number;
  pools: Pool[];
}

const txOptions = (net: Net, fee: string, validFor: number) => ({
  fee,
  networkPassphrase: net.cfg.networkPassphrase,
  timebounds: { minTime: 0, maxTime: Math.floor(net.io.now() / 1000) + validFor },
});

async function readVault(net: Net): Promise<VaultView> {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(net.cfg.address, "0"), txOptions(net, "100", 30))
    .addOperation(new StellarSdk.Contract(net.cfg.vault).call("pools"))
    .build();
  const sim = await simulate(net, tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`reading pools failed: ${"error" in sim ? sim.error.split("\n")[0] : "no result"}`);
  }
  const states = (StellarSdk.scValToNative(sim.result.retval) as Record<string, unknown>[]).map((p) => ({
    asset: String(p.asset),
    hitz: BigInt(p.hitz as bigint),
    reserve: BigInt(p.reserve as bigint),
    deviation: BigInt(p.deviation as bigint),
    dislocation: BigInt(p.dislocation as bigint),
    fee: BigInt(p.fee as bigint),
  }));
  // The view's deviations are already brought to this ledger: quote at the same instant.
  return { ledger: sim.latestLedger, pools: poolsFromStates(states, 0n) };
}

interface AccountView {
  /** XLM the bot can spend: balance minus reserve, liabilities and the fee buffer. */
  xlm: bigint;
  /** null without a USDC trustline. */
  usdc: bigint | null;
  sequence: bigint;
}

async function readAccount(net: Net): Promise<AccountView> {
  const { cfg } = net;
  const res = await net.io.fetch(`${cfg.horizonUrl}/accounts/${cfg.address}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) throw new Error(`account ${cfg.address} doesn't exist`);
  if (!res.ok) throw new Error(`horizon ${res.status} reading the account`);
  const acct = (await res.json()) as {
    sequence: string;
    subentry_count: number;
    num_sponsoring?: number;
    num_sponsored?: number;
    balances: { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; selling_liabilities?: string }[];
  };
  const native = acct.balances.find((b) => b.asset_type === "native");
  const entries = 2n + BigInt(acct.subentry_count) + BigInt(acct.num_sponsoring ?? 0) - BigInt(acct.num_sponsored ?? 0);
  const xlm = native ? raw(native.balance) - entries * BASE_RESERVE - raw(native.selling_liabilities ?? "0") - fromXlm(cfg.feeBufferXlm) : 0n;
  const usdcLine = acct.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === cfg.usdcIssuer);
  return {
    xlm: xlm > 0n ? xlm : 0n,
    usdc: usdcLine ? raw(usdcLine.balance) - raw(usdcLine.selling_liabilities ?? "0") : null,
    sequence: BigInt(acct.sequence),
  };
}

const horizonAsset = (prefix: string, a: StellarSdk.Asset) =>
  a.isNative()
    ? `${prefix}_asset_type=native`
    : `${prefix}_asset_type=credit_alphanum4&${prefix}_asset_code=${a.getCode()}&${prefix}_asset_issuer=${a.getIssuer()}`;

interface Route {
  out: bigint;
  path: StellarSdk.Asset[];
}

/** Best SDEX route selling `amount` of `sell` for the other asset (order book and AMMs), or null. */
async function sdexQuote(net: Net, sell: Side, amount: bigint): Promise<Route | null> {
  const buy = net.asset[other(sell)];
  const dest = buy.isNative() ? "native" : `${buy.getCode()}:${buy.getIssuer()}`;
  const url = `${net.cfg.horizonUrl}/paths/strict-send?${horizonAsset("source", net.asset[sell])}&source_amount=${fmt(amount)}&destination_assets=${encodeURIComponent(dest)}`;
  const res = await net.io.fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`horizon ${res.status} quoting the SDEX`);
  const records = ((await res.json()) as { _embedded: { records: { destination_amount: string; path: { asset_type: string; asset_code?: string; asset_issuer?: string }[] }[] } })._embedded.records;
  let best: Route | null = null;
  for (const r of records) {
    const out = raw(r.destination_amount);
    if (!best || out > best.out) {
      best = {
        out,
        path: r.path.map((p) => (p.asset_type === "native" ? StellarSdk.Asset.native() : new StellarSdk.Asset(p.asset_code!, p.asset_issuer!))),
      };
    }
  }
  return best;
}

// ─── Transactions ────────────────────────────────────────────────────────────

/** The account as it will stand `ahead` transactions from now: each of a run's transactions takes its own number. */
const accountAt = (net: Net, account: AccountView, ahead: bigint) => new StellarSdk.Account(net.cfg.address, (account.sequence + ahead).toString());

function resultCode(result: StellarSdk.xdr.TransactionResult | undefined): string {
  if (!result) return "unknown";
  try {
    const inner = result.result();
    const code: string = inner.switch().name;
    if (code !== "txFailed") return code;
    const op = inner.results()[0];
    return `${code} (${op.switch().name === "opInner" ? op.tr().value().switch().name : op.switch().name})`;
  } catch {
    return "unknown";
  }
}

interface Sent extends Leg {
  returnValue?: StellarSdk.xdr.ScVal;
  result?: StellarSdk.xdr.TransactionResult;
}

function txResult(b64: string | undefined): StellarSdk.xdr.TransactionResult | undefined {
  try {
    return b64 ? StellarSdk.xdr.TransactionResult.fromXDR(b64, "base64") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send a signed transaction and follow it to a final answer: it succeeded, it
 * failed, it was refused, or its validity ran out with the ledger past it, so
 * it can never be included. A send that errors is followed too (it may have
 * gone through). UNKNOWN only when the RPC never answers.
 */
async function submit(net: Net, tx: StellarSdk.Transaction): Promise<Sent> {
  const hash = tx.hash().toString("hex");
  const validUntil = Number(tx.timeBounds?.maxTime ?? 0);
  let sendError: string | undefined;
  let accepted = false;
  for (let attempt = 0; attempt < SEND_ATTEMPTS && !accepted && !sendError; attempt++) {
    try {
      const sent = await rpcCall<{ status: string; errorResultXdr?: string }>(net, "sendTransaction", { transaction: tx.toXDR() });
      if (sent.status === "ERROR") return { hash, status: "REJECTED", code: resultCode(txResult(sent.errorResultXdr)) };
      if (sent.status === "TRY_AGAIN_LATER") await net.io.sleep(POLL_MS);
      else accepted = true;
    } catch (err) {
      sendError = messageOf(err);
    }
  }
  if (!accepted && !sendError) return { hash, status: "REJECTED", code: "tryAgainLater" };
  for (;;) {
    await net.io.sleep(POLL_MS);
    let res: { status: string; resultXdr?: string; resultMetaXdr?: string; latestLedgerCloseTime?: string | number } | null = null;
    try {
      res = await rpcCall(net, "getTransaction", { hash });
    } catch {
      res = null;
    }
    if (res && res.status !== "NOT_FOUND") {
      const result = txResult(res.resultXdr);
      const feeXlm = result ? fmt(BigInt(result.feeCharged().toString())) : undefined;
      if (res.status === "SUCCESS") return { hash, status: "SUCCESS", feeXlm, returnValue: returnValueOf(res.resultMetaXdr), result };
      return { hash, status: "FAILED", code: resultCode(result), feeXlm };
    }
    if (res && Number(res.latestLedgerCloseTime) > validUntil + EXPIRY_GRACE_S) return { hash, status: "EXPIRED", code: sendError };
    if (net.io.now() / 1000 > validUntil + GIVE_UP_AFTER_S) return { hash, status: "UNKNOWN", code: sendError ?? "the RPC gave no answer" };
  }
}

const legOf = ({ returnValue: _r, result: _x, ...leg }: Sent): Leg => leg;
const outcome = (leg: Leg) => `${leg.status.toLowerCase()}${leg.code ? `: ${leg.code}` : ""}`;

/** An SDEX conversion back to ourselves: path payment strict send. */
function sdexTx(net: Net, source: StellarSdk.Account, sell: Side, amount: bigint, minOut: bigint, path: StellarSdk.Asset[]): StellarSdk.Transaction {
  return new StellarSdk.TransactionBuilder(source, txOptions(net, CLASSIC_BID, HEDGE_VALID_S))
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: net.asset[sell],
        sendAmount: fmt(amount),
        destination: net.cfg.address,
        destAsset: net.asset[other(sell)],
        destMin: fmt(minOut),
        path,
      })
    )
    .build();
}

/** The vault leg, simulated and assembled: swap(bot, bot, in, out, amount, minOut). Null when the vault has moved under the minimum. */
async function vaultSwapTx(
  net: Net,
  source: StellarSdk.Account,
  sell: Side,
  amountIn: bigint,
  minOut: bigint
): Promise<{ tx: StellarSdk.Transaction; simulatedOut: bigint; resourceFee: bigint } | null> {
  const me = StellarSdk.Address.fromString(net.cfg.address).toScVal();
  const i128 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "i128" });
  const tx = new StellarSdk.TransactionBuilder(source, txOptions(net, SOROBAN_BID, VAULT_VALID_S))
    .addOperation(
      new StellarSdk.Contract(net.cfg.vault).call(
        "swap",
        me,
        me,
        StellarSdk.Address.fromString(net.sac[sell]).toScVal(),
        StellarSdk.Address.fromString(net.sac[other(sell)]).toScVal(),
        i128(amountIn),
        i128(minOut)
      )
    )
    .build();
  const sim = await simulate(net, tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    const first = sim.error.split("\n")[0];
    // Error::Slippage: someone traded between reading the pools and simulating.
    if (/Error\(Contract, #3\)/.test(first)) return null;
    throw new Error(`vault swap simulation failed: ${first}`);
  }
  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) throw new Error("the vault's contract data is archived; restore it first");
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("vault swap simulation returned nothing");
  return {
    tx: StellarSdk.rpc.assembleTransaction(tx, sim).build(),
    simulatedOut: BigInt(StellarSdk.scValToNative(sim.result.retval) as bigint),
    resourceFee: BigInt(sim.minResourceFee),
  };
}

// ─── One run ─────────────────────────────────────────────────────────────────

export async function runOnce(cfg: ArbConfig): Promise<ArbReport> {
  const net = netOf(cfg);
  const report: ArbReport = { at: new Date(net.io.now()).toISOString(), mode: cfg.live ? "live" : "dry-run", address: cfg.address, action: "none" };
  try {
    if (cfg.live && (!cfg.keypair || cfg.keypair.publicKey() !== cfg.address)) {
      throw new Error("live mode needs the bot account's own key");
    }
    const [vault, account, xlmToUsdc, usdcToXlm] = await Promise.all([readVault(net), readAccount(net), sdexQuote(net, "XLM", REF_IN.XLM), sdexQuote(net, "USDC", REF_IN.USDC)]);
    if (!xlmToUsdc || !usdcToXlm) throw new Error("the SDEX has no XLM/USDC route");

    // SDEX: USDC per XLM selling XLM (bid) and buying it (ask).
    const market: Market = { bid: Number(xlmToUsdc.out) / Number(REF_IN.XLM), ask: Number(REF_IN.USDC) / Number(usdcToXlm.out) };
    const xlmPool = vault.pools.find((p) => p.asset === net.sac.XLM);
    const usdcPool = vault.pools.find((p) => p.asset === net.sac.USDC);
    if (!xlmPool || !usdcPool) throw new Error("the vault doesn't list both XLM and USDC");
    const vaultRate = Number(usdcPool.reserve) / Number(usdcPool.hitz) / (Number(xlmPool.reserve) / Number(xlmPool.hitz));
    Object.assign(report, {
      ledger: vault.ledger,
      balances: { xlm: fmt(account.xlm), usdc: account.usdc === null ? null : fmt(account.usdc) },
      market: { bid: Number(market.bid.toPrecision(7)), ask: Number(market.ask.toPrecision(7)) },
      vaultRate: Number(vaultRate.toPrecision(7)),
      gapPct: Number(((vaultRate / ((market.bid + market.ask) / 2) - 1) * 100).toFixed(3)),
    });

    if (account.usdc === null) {
      if (!cfg.live) {
        report.action = "skip";
        report.reason = "the bot account has no USDC trustline (a live run adds it)";
        return report;
      }
      const tx = new StellarSdk.TransactionBuilder(accountAt(net, account, 0n), txOptions(net, CLASSIC_BID, HEDGE_VALID_S))
        .addOperation(StellarSdk.Operation.changeTrust({ asset: net.asset.USDC }))
        .build();
      tx.sign(cfg.keypair!);
      report.setupLeg = legOf(await submit(net, tx));
      if (report.setupLeg.status === "SUCCESS") {
        report.action = "setup";
        report.reason = "added the USDC trustline";
      } else {
        report.action = "error";
        report.error = `adding the USDC trustline ${outcome(report.setupLeg)}`;
      }
      return report;
    }

    // Size both directions; keep the better one.
    const balances = { xlm: account.xlm, usdc: account.usdc };
    const sizing = { pools: vault.pools, now: 0n, hitz: cfg.hitz, sac: net.sac, market, maxTradeXlm: cfg.maxTradeXlm };
    const plan = planTrade({ ...sizing, balances });
    const floorOf = (p: TradePlan) => floorXlm(p, cfg);
    const underFloor = (profitXlm: number, p: TradePlan) => `the best round trip would earn ${profitXlm.toFixed(4)} XLM after fees, under the floor of ${floorOf(p).toFixed(4)}`;
    if (!plan) {
      const ample = 1n << 62n;
      report.reason = planTrade({ ...sizing, balances: { xlm: ample, usdc: ample } }) ? "the account can't fund a round trip at this gap" : "the vault is in line with the SDEX";
      return await maybeRebalance(net, account, market, report);
    }
    if (plan.profitXlm - FEE_ESTIMATE_XLM < floorOf(plan)) {
      report.reason = underFloor(plan.profitXlm - FEE_ESTIMATE_XLM, plan);
      return await maybeRebalance(net, account, market, report);
    }

    // The buy-back at the exact size, and the vault leg simulated, before anything is sent.
    const quote = await sdexQuote(net, plan.buy, plan.hedgeIn);
    if (!quote) {
      report.reason = "the SDEX has no route at this size";
      return report;
    }
    const prepared = await vaultSwapTx(net, accountAt(net, account, 1n), plan.sell, plan.amountIn, plan.hedgeIn);
    if (!prepared) {
      report.reason = "the vault moved while the trade was being planned";
      return report;
    }
    const xlmPerSold = plan.sell === "XLM" ? 1 : 1 / market.ask;
    const xlmPerBought = plan.sell === "XLM" ? 1 / market.ask : 1;
    const feeStroops = prepared.resourceFee + USUAL_INCLUSION;
    const feeXlm = toNum(feeStroops);
    const profitXlm = toNum(quote.out - plan.amountIn) * xlmPerSold + toNum(prepared.simulatedOut - plan.hedgeIn) * xlmPerBought - feeXlm;
    if (profitXlm < floorOf(plan)) {
      report.reason = underFloor(profitXlm, plan);
      return report;
    }
    // The SDEX leg must return what the vault leg sells plus the fees, whatever the market does meanwhile.
    const feeInSold = plan.sell === "XLM" ? feeStroops : BigInt(Math.ceil(Number(feeStroops) * market.bid));
    const hedgeMin = maxBig((quote.out * (10_000n - HEDGE_SLIPPAGE_BPS)) / 10_000n, plan.amountIn + feeInSold);
    const hedge = sdexTx(net, accountAt(net, account, 0n), plan.buy, plan.hedgeIn, hedgeMin, quote.path);
    report.plan = {
      sell: plan.sell,
      buy: plan.buy,
      amountIn: fmt(plan.amountIn),
      vaultOut: fmt(prepared.simulatedOut),
      hedgeIn: fmt(plan.hedgeIn),
      hedgeOut: fmt(quote.out),
      hedgeMin: fmt(hedgeMin),
      profit: fmt(quote.out - plan.amountIn),
      profitXlm: Number(profitXlm.toFixed(7)),
      feeXlm,
    };
    if (!cfg.live) {
      report.action = "would-trade";
      return report;
    }
    hedge.sign(cfg.keypair!);
    prepared.tx.sign(cfg.keypair!);

    // Leg 1: buy the asset back on the SDEX. If this doesn't go through, nothing has happened.
    const leg1 = await submit(net, hedge);
    report.hedgeLeg = legOf(leg1);
    if (leg1.status === "UNKNOWN") {
      report.action = "error";
      report.error = `the buy-back's outcome is unknown (${leg1.code}); the vault leg was not sent`;
      return report;
    }
    if (leg1.status !== "SUCCESS") {
      report.action = "missed";
      report.reason = `the SDEX buy-back ${outcome(leg1)}; nothing reached the vault`;
      return report;
    }
    // At least hedgeMin, by the network's own check, if the result can't be read.
    const boughtBack = pathPaymentReceived(leg1.result) ?? hedgeMin;
    report.hedgeLeg.received = fmt(boughtBack);

    // Leg 2: the vault, which must pay back at least what leg 1 spent.
    const leg2 = await submit(net, prepared.tx);
    report.vaultLeg = legOf(leg2);
    if (leg2.status !== "SUCCESS") {
      report.action = "trade-incomplete";
      report.reason = `the vault leg ${outcome(leg2)}; the buy-back stands as a plain SDEX conversion and the inventory rebalances later`;
      return report;
    }
    const paid = leg2.returnValue ? BigInt(StellarSdk.scValToNative(leg2.returnValue) as bigint) : prepared.simulatedOut;
    report.vaultLeg.received = fmt(paid);
    const fees = leg1.feeXlm && leg2.feeXlm ? toNum(raw(leg1.feeXlm) + raw(leg2.feeXlm)) : feeXlm;
    report.action = "trade";
    report.profit = fmt(boughtBack - plan.amountIn);
    report.profitXlm = Number((toNum(boughtBack - plan.amountIn) * xlmPerSold + toNum(paid - plan.hedgeIn) * xlmPerBought - fees).toFixed(7));
    return report;
  } catch (err) {
    report.action = "error";
    report.error = messageOf(err);
    return report;
  }
}

/** With nothing to trade: if one side holds under a fifth of the inventory, convert back toward half and half. */
async function maybeRebalance(net: Net, account: AccountView, market: Market, report: ArbReport): Promise<ArbReport> {
  const move = planRebalance({ xlm: account.xlm, usdc: account.usdc ?? 0n }, market);
  if (!move) return report;
  const note = (text: string) => {
    report.reason = report.reason ? `${report.reason}; ${text}` : text;
  };
  const quote = await sdexQuote(net, move.sell, move.amount);
  // The going price for this direction, from the small reference quotes.
  const going = move.sell === "XLM" ? market.bid : 1 / market.ask;
  if (!quote || Number(quote.out) < Number(move.amount) * going * (1 - REBALANCE_MAX_COST)) {
    note(`not rebalancing ${fmt(move.amount)} ${move.sell}: the SDEX ${quote ? "pays more than 1% under the going price at that size" : "has no route"}`);
    return report;
  }
  note(`rebalancing ${fmt(move.amount)} ${move.sell} to ${move.buy}`);
  if (!net.cfg.live) return report;
  const tx = sdexTx(net, accountAt(net, account, 0n), move.sell, move.amount, (quote.out * 995n) / 1000n, quote.path);
  tx.sign(net.cfg.keypair!);
  const leg = await submit(net, tx);
  report.hedgeLeg = legOf(leg);
  if (leg.status === "SUCCESS") {
    report.action = "rebalance";
    report.hedgeLeg.received = fmt(pathPaymentReceived(leg.result) ?? 0n);
  } else {
    report.action = "error";
    report.error = `rebalance ${outcome(leg)}`;
  }
  return report;
}
