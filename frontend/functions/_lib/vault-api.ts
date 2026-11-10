// Public API for the HITZ Sovereign Vault: live state, exact quotes,
// ready-to-sign swap transactions, submission and status. The REST routes
// (api/v1.ts) and the MCP server (api/mcp.ts) both call these functions, so
// they always give the same answers.
//
// Nothing here holds, derives or asks for a key. `buildSwap` returns an
// unsigned transaction whose source is the caller's own account; they sign
// it in their wallet and send it to `submitTransaction` (or any Stellar RPC).
//
// Quotes run the exact port of the contract's math (app/lib/vaultMath.ts) on
// `pools()` read in one ledger. A built transaction is also simulated, so the
// amount it reports is the contract's own answer for that ledger.

import * as StellarSdk from "@stellar/stellar-sdk";
import { limitFor, minimumToRelease } from "../../app/lib/gravity";
import {
  inputForOutput,
  poolsFromStates,
  swap as vaultSwap,
  VaultMathError,
  type Hop,
  type Pool,
  type PoolState,
} from "../../app/lib/vaultMath";
import { LIQUIDITY_SNAPSHOT_KEY } from "./ingest";
import type { Env } from "./types";

export const VAULT_ID = "CDEISYZM526FZJ4PDWNVKD7UHXFO4ATT46K47YTUQAOLWZQV64ANNBWU";

/**
 * Inclusion fee bid per transaction, in stroops (0.01 XLM). Simulation adds
 * the resource fee on top; the network charges the going inclusion rate, up
 * to this bid, so it only matters when the network is congested.
 */
const BASE_FEE = "100000";
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 1_000;
const DEFAULT_VALID_FOR_S = 300;
const MIN_VALID_FOR_S = 30;
const MAX_VALID_FOR_S = 3_600;
/** Mainnet base reserve: each account entry and subentry locks 0.5 XLM. */
const BASE_RESERVE = 5_000_000n;
const SUBMIT_WAIT_S = 25;

// ─── Errors ──────────────────────────────────────────────────────────────────

/** A failure the caller can act on: HTTP status, stable code, readable message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** A read-only contract call that the contract itself rejected. */
class ViewError extends Error {}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function upstream<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError || err instanceof ViewError) throw err;
    throw new ApiError(502, "upstream_unavailable", `Stellar network request failed while ${what}: ${messageOf(err)}`);
  }
}

// ─── Amounts ─────────────────────────────────────────────────────────────────

const big = (v: unknown): bigint => BigInt(v as bigint | number | string);

/** "12.5" in a token with `decimals` → raw integer units. Rejects anything ambiguous. */
export function parseUnits(input: unknown, decimals: number, field: string): bigint {
  const text = typeof input === "number" && Number.isFinite(input) ? input.toString() : input;
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text.trim())) {
    throw new ApiError(400, "invalid_amount", `${field} must be a positive decimal number, such as "100" or "0.5".`);
  }
  const [whole, frac = ""] = text.trim().split(".");
  if (frac.length > decimals) {
    throw new ApiError(400, "invalid_amount", `${field} has more than ${decimals} decimals.`);
  }
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (value <= 0n) throw new ApiError(400, "invalid_amount", `${field} must be greater than zero.`);
  return value;
}

/** Raw integer units → exact decimal string, trailing zeros trimmed. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = abs % base;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  return `${negative ? "-" : ""}${abs / base}${fracText}`;
}

/** A ratio or percentage for display: 8 significant digits is plenty. */
const round = (x: number, digits = 8): number => (Number.isFinite(x) ? Number(x.toPrecision(digits)) : 0);

/** 9-decimal fee rate → percent. */
const feePct = (rate: bigint): number => round(Number(rate) / 1e7, 6);
/** 18-decimal natural log → percent. */
const logPct = (d: bigint): number => round(Number(d) / 1e16, 6);

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface Token {
  symbol: string;
  /** Soroban contract address. */
  contract: string;
  decimals: number;
  /** Stellar classic form, for trustlines: "native" or CODE:ISSUER. Absent for Soroban tokens such as HITZ. */
  classic?: string;
}

export interface Amount {
  asset: string;
  contract: string;
  /** Exact decimal amount in the token's units. */
  amount: string;
  /** The same amount in raw integer units (stroops for 7 decimals). */
  raw: string;
}

const amountOf = (token: Token, raw: bigint): Amount => ({
  asset: token.symbol,
  contract: token.contract,
  amount: formatUnits(raw, token.decimals),
  raw: raw.toString(),
});

function hitzToken(env: Env): Token {
  return { symbol: "HITZ", contract: env.HITZ_CONTRACT_ID, decimals: 7 };
}

function classicTokens(env: Env): Token[] {
  const usdc = new StellarSdk.Asset("USDC", env.USDC_ISSUER);
  return [
    { symbol: "XLM", contract: StellarSdk.Asset.native().contractId(env.NETWORK_PASSPHRASE), decimals: 7, classic: "native" },
    { symbol: "USDC", contract: usdc.contractId(env.NETWORK_PASSPHRASE), decimals: 7, classic: `USDC:${env.USDC_ISSUER}` },
  ];
}

const tokenCache = new Map<string, Promise<Token>>();

/** Known tokens resolve locally; an asset listed later is asked for its symbol once. */
function tokenInfo(env: Env, contract: string): Promise<Token> {
  if (contract === env.HITZ_CONTRACT_ID) return Promise.resolve(hitzToken(env));
  const known = classicTokens(env).find((t) => t.contract === contract);
  if (known) return Promise.resolve(known);
  let pending = tokenCache.get(contract);
  if (!pending) {
    pending = (async () => {
      const [sym, dec] = await Promise.all([view(env, contract, "symbol"), view(env, contract, "decimals")]);
      const raw = String(sym.value);
      const [code, issuer] = raw.split(":");
      const token: Token = { symbol: code === "native" ? "XLM" : code, contract, decimals: Number(dec.value) };
      if (issuer) token.classic = raw;
      else if (code === "native") token.classic = "native";
      return token;
    })();
    pending.catch(() => tokenCache.delete(contract));
    tokenCache.set(contract, pending);
  }
  return pending;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Any well-formed account can be the source of a simulation; it needn't exist. */
const VIEW_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

const rpcServer = (env: Env) => new StellarSdk.rpc.Server(env.RPC_URL);
const addr = (a: string) => StellarSdk.Address.fromString(a).toScVal();
const i128 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "i128" });

/** A read-only contract call by simulation, and the ledger it was read in. */
async function view(
  env: Env,
  contract: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<{ value: unknown; ledger: number }> {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(VIEW_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(new StellarSdk.Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await upstream(`reading ${method}`, () => rpcServer(env).simulateTransaction(tx));
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new ViewError(sim.error);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new ApiError(502, "upstream_unavailable", `${method} returned no result`);
  }
  return { value: StellarSdk.scValToNative(sim.result.retval), ledger: sim.latestLedger };
}

interface VaultState {
  ledger: number;
  /** Pools as `pools()` reported them, brought to that ledger's time. */
  states: PoolState[];
  /** The same pools, ready to quote at that time. */
  pools: Pool[];
  /** Listed assets, aligned with `states`. */
  assets: Token[];
  hitz: Token;
}

async function readVault(env: Env): Promise<VaultState> {
  const { value, ledger } = await view(env, VAULT_ID, "pools");
  const states: PoolState[] = (value as Record<string, unknown>[]).map((p) => ({
    asset: String(p.asset),
    hitz: big(p.hitz),
    reserve: big(p.reserve),
    deviation: big(p.deviation),
    dislocation: big(p.dislocation),
    fee: big(p.fee),
  }));
  const assets = await Promise.all(states.map((s) => tokenInfo(env, s.asset)));
  return { ledger, states, pools: poolsFromStates(states, 0n), assets, hitz: hitzToken(env) };
}

async function hitzView(env: Env, method: string, account?: string): Promise<unknown> {
  return (await view(env, env.HITZ_CONTRACT_ID, method, account ? [addr(account)] : [])).value;
}

/** HITZ and listed assets, by symbol (any case), classic form or contract address. */
function resolveToken(vault: VaultState, input: unknown, field: string): Token {
  const all = [vault.hitz, ...vault.assets];
  const names = all.map((t) => t.symbol).join(", ");
  if (typeof input !== "string" || !input.trim()) {
    throw new ApiError(400, "invalid_asset", `${field} is required: one of ${names}, or a contract address.`);
  }
  const text = input.trim();
  const upper = text.toUpperCase();
  const matches = all.filter(
    (t) =>
      t.contract === text ||
      t.symbol.toUpperCase() === upper ||
      t.classic?.toUpperCase() === upper ||
      (upper === "NATIVE" && t.classic === "native")
  );
  if (matches.length > 1) {
    throw new ApiError(400, "ambiguous_asset", `${field} "${text}" matches several assets; use its contract address.`);
  }
  if (!matches.length) {
    throw new ApiError(400, "unsupported_asset", `${field} "${text}" isn't traded in the vault. Use one of ${names}.`);
  }
  return matches[0];
}

function requireAccount(input: unknown, field = "account"): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(text)) {
    throw new ApiError(400, "invalid_account", `${field} must be a Stellar account address (G…).`);
  }
  return text;
}

function requireAddress(input: unknown, field: string): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(text) && !StellarSdk.StrKey.isValidContract(text)) {
    throw new ApiError(400, "invalid_address", `${field} must be a Stellar address (G… or C…).`);
  }
  return text;
}

// ─── USD context (from the Monitor's liquidity snapshot) ─────────────────────

interface UsdPrices {
  asOf: string;
  /** USD per unit of each listed asset, by contract. */
  assets: Map<string, number>;
  /** USD per HITZ, liquidity-weighted across the vault's pools. */
  hitz: number | null;
  /** USD per HITZ in each pool, by asset contract. */
  hitzByPool: Map<string, number>;
  tvl: number | null;
}

let usdCache: { at: number; value: UsdPrices | null } | null = null;

/** Best effort: the cron's last snapshot (≤ 5 minutes old), or null. */
async function usdPrices(env: Env): Promise<UsdPrices | null> {
  if (usdCache && Date.now() - usdCache.at < 60_000) return usdCache.value;
  let value: UsdPrices | null = null;
  try {
    const row = await env.DB.prepare("SELECT json FROM snapshots WHERE key = ?")
      .bind(LIQUIDITY_SNAPSHOT_KEY)
      .first<{ json: string }>();
    if (row) {
      const snap = JSON.parse(row.json) as {
        asOf: string;
        totals?: { tvlUsd?: number };
        pools?: { address: string; venue?: string; quoteUsd?: number; priceUsd?: number; share?: number }[];
      };
      const assets = new Map<string, number>();
      const hitzByPool = new Map<string, number>();
      let weighted = 0;
      let weight = 0;
      for (const p of snap.pools ?? []) {
        const [contract, asset] = p.address.split(":");
        if (p.venue !== "vault" || contract !== VAULT_ID || !asset) continue;
        if (typeof p.quoteUsd === "number") assets.set(asset, p.quoteUsd);
        if (typeof p.priceUsd === "number") {
          hitzByPool.set(asset, p.priceUsd);
          weighted += p.priceUsd * (p.share ?? 0);
          weight += p.share ?? 0;
        }
      }
      value = { asOf: snap.asOf, assets, hitz: weight ? weighted / weight : null, hitzByPool, tvl: snap.totals?.tvlUsd ?? null };
    }
  } catch (err) {
    console.warn("[vault-api] no USD snapshot", err);
  }
  usdCache = { at: Date.now(), value };
  return value;
}

function usdValue(usd: UsdPrices | null, token: Token, raw: bigint, env: Env): number | null {
  if (!usd) return null;
  const unit = token.contract === env.HITZ_CONTRACT_ID ? usd.hitz : usd.assets.get(token.contract);
  if (unit == null) return null;
  return round((Number(raw) / 10 ** token.decimals) * unit, 6);
}

// ─── Vault state ─────────────────────────────────────────────────────────────

export async function vaultInfo(env: Env) {
  const [vault, totalMass, limit, usd] = await Promise.all([
    readVault(env),
    hitzView(env, "total_mass"),
    hitzView(env, "safety_limit"),
    usdPrices(env),
  ]);
  const pools = vault.states.map((s, i) => {
    const token = vault.assets[i];
    const scale = 10 ** (vault.hitz.decimals - token.decimals);
    const price = (Number(s.reserve) / Number(s.hitz)) * scale; // asset per HITZ
    return {
      asset: token.symbol,
      contract: token.contract,
      ...(token.classic ? { classic: token.classic } : {}),
      decimals: token.decimals,
      hitz: formatUnits(s.hitz, vault.hitz.decimals),
      reserve: formatUnits(s.reserve, token.decimals),
      price: round(price),
      hitz_per_unit: round(1 / price),
      fee_pct: feePct(s.fee),
      dislocation_pct: logPct(s.dislocation),
      ...(usd?.hitzByPool.has(token.contract)
        ? { hitz_usd: round(usd.hitzByPool.get(token.contract)!, 6) }
        : {}),
    };
  });
  const byPool = pools.map((p) => p.hitz_usd).filter((v): v is number => typeof v === "number");
  return {
    network: "mainnet",
    network_passphrase: env.NETWORK_PASSPHRASE,
    ledger: vault.ledger,
    vault: VAULT_ID,
    hitz: {
      contract: env.HITZ_CONTRACT_ID,
      decimals: vault.hitz.decimals,
      total_mass: formatUnits(big(totalMass), 7),
      event_horizon: formatUnits(big(limit), 7),
    },
    pools,
    usd: usd
      ? {
          as_of: usd.asOf,
          hitz: usd.hitz != null ? round(usd.hitz, 6) : null,
          tvl: usd.tvl,
          ...(byPool.length > 1 ? { pool_spread_pct: round((Math.max(...byPool) / Math.min(...byPool) - 1) * 100, 4) } : {}),
        }
      : null,
    fee_model: {
      calm_pct: 1,
      max_pct: 10,
      rule: "Each hop pays 1% × e^(100 × D), capped at 10%, where D is the largest dislocation between this pool's price and another pool's, after the trade.",
      decay: "Dislocations decay with a 2-hour time constant (half-life about 83 minutes).",
    },
    rpc_url: env.RPC_URL,
    horizon_url: env.HORIZON_URL,
    links: links(env),
  };
}

export function links(env: Env) {
  return {
    api: `${env.APP_URL}/api/v1`,
    openapi: `${env.APP_URL}/api/v1/openapi.json`,
    mcp: `${env.APP_URL}/mcp`,
    integrate: `${env.APP_URL}/integrate/`,
    llms_txt: `${env.APP_URL}/llms.txt`,
    contract_guide: "https://docs.skyhitz.io/vault/integration",
  };
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

function mathError(err: unknown, sell: Token, buy: Token): unknown {
  if (!(err instanceof VaultMathError)) return err;
  switch (err.message) {
    case "TradeTooSmall":
      return new ApiError(422, "trade_too_small", `The ${buy.symbol} paid out rounds to zero after the fee; trade a larger amount.`);
    case "UnsupportedPair":
      return new ApiError(400, "unsupported_pair", `${sell.symbol} and ${buy.symbol} can't be traded against each other in the vault.`);
    case "NotSeeded":
      return new ApiError(422, "pool_not_seeded", "That asset is listed but its pool has no liquidity yet.");
    default:
      return new ApiError(422, "quote_failed", err.message);
  }
}

function runSwap(vault: VaultState, sell: Token, buy: Token, amountIn: bigint) {
  try {
    return vaultSwap(vault.pools, sell.contract, buy.contract, amountIn, 0n, vault.hitz.contract);
  } catch (err) {
    throw mathError(err, sell, buy);
  }
}

/** Display units of `to` per display unit of `from`, for raw amounts. */
const displayRate = (out: number, inp: number, from: Token, to: Token) => (out / inp) * 10 ** (from.decimals - to.decimals);

/** Raw request input: every field is checked here, so any shape is accepted. */
export interface QuoteInput {
  sell?: unknown;
  buy?: unknown;
  /** Exact amount sold. */
  amount?: unknown;
  /** Or: the amount wanted out; the quote finds the smallest input that pays it. */
  buy_amount?: unknown;
  /** Optional: check balances, trustline and the Event Horizon for this account. */
  account?: unknown;
}

interface Quoted {
  vault: VaultState;
  sell: Token;
  buy: Token;
  amountIn: bigint;
  amountOut: bigint;
  hops: Hop[];
}

async function computeQuote(env: Env, input: QuoteInput): Promise<Quoted> {
  const vault = await readVault(env);
  const sell = resolveToken(vault, input.sell, "sell");
  const buy = resolveToken(vault, input.buy, "buy");
  if (sell.contract === buy.contract) {
    throw new ApiError(400, "unsupported_pair", "sell and buy must be different assets.");
  }
  const hasAmount = input.amount !== undefined && input.amount !== null && input.amount !== "";
  const hasBuyAmount = input.buy_amount !== undefined && input.buy_amount !== null && input.buy_amount !== "";
  if (hasAmount === hasBuyAmount) {
    throw new ApiError(400, "invalid_amount", "Give either amount (what you sell) or buy_amount (what you want to receive).");
  }
  let amountIn: bigint;
  if (hasBuyAmount) {
    const target = parseUnits(input.buy_amount, buy.decimals, "buy_amount");
    let needed: bigint | null;
    try {
      needed = inputForOutput(vault.pools, sell.contract, buy.contract, target, 0n, vault.hitz.contract);
    } catch (err) {
      throw mathError(err, sell, buy);
    }
    if (needed === null) {
      throw new ApiError(422, "insufficient_liquidity", `The vault can't pay out ${formatUnits(target, buy.decimals)} ${buy.symbol}.`);
    }
    amountIn = needed;
  } else {
    amountIn = parseUnits(input.amount, sell.decimals, "amount");
  }
  const result = runSwap(vault, sell, buy, amountIn);
  return { vault, sell, buy, amountIn, amountOut: result.amountOut, hops: result.hops };
}

function describeQuote(env: Env, q: Quoted, usd: UsdPrices | null) {
  const { vault, sell, buy } = q;
  let spot = 1; // raw out per raw in, for an infinitesimal trade, after fees
  const hops = q.hops.map((h) => {
    const s = vault.states[h.pool];
    const asset = vault.assets[h.pool];
    const [from, to] = h.hitzIn ? [vault.hitz, asset] : [asset, vault.hitz];
    const [rIn, rOut] = h.hitzIn ? [s.hitz, s.reserve] : [s.reserve, s.hitz];
    spot *= (Number(rOut) / Number(rIn)) * (1 - Number(s.fee) / 1e9);
    return {
      pool: asset.symbol,
      sell: amountOf(from, h.amountIn),
      buy: amountOf(to, h.amountOut),
      fee_pct: feePct(h.feeRate),
      fee: amountOf(to, h.feeAmount),
      dislocation_pct: logPct(h.dislocation),
    };
  });
  const executed = Number(q.amountOut) / Number(q.amountIn);
  const sellUsd = usdValue(usd, sell, q.amountIn, env);
  const buyUsd = usdValue(usd, buy, q.amountOut, env);
  return {
    ledger: vault.ledger,
    sell: amountOf(sell, q.amountIn),
    buy: amountOf(buy, q.amountOut),
    price: round(displayRate(Number(q.amountOut), Number(q.amountIn), sell, buy)),
    spot_price: round(spot * 10 ** (sell.decimals - buy.decimals)),
    price_impact_pct: round(Math.max(0, (1 - executed / spot) * 100), 4),
    route: [sell.symbol, ...q.hops.map((h) => (h.hitzIn ? vault.assets[h.pool].symbol : vault.hitz.symbol))],
    hops,
    ...(sellUsd != null && buyUsd != null && usd ? { usd: { sell: sellUsd, buy: buyUsd, as_of: usd.asOf } } : {}),
  };
}

export async function quote(env: Env, input: QuoteInput) {
  const account = input.account ? requireAccount(input.account) : null;
  const [q, usd] = await Promise.all([computeQuote(env, input), usdPrices(env)]);
  const out = describeQuote(env, q, usd);
  if (!account) return { ...out, warnings: [] as string[] };
  const checks = await accountChecks(env, q, account, account);
  return { ...out, account: checks.summary, warnings: checks.warnings };
}

// ─── Account checks ──────────────────────────────────────────────────────────

interface HorizonAccount {
  balances: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    selling_liabilities?: string;
  }[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
}

async function horizonAccount(env: Env, account: string): Promise<HorizonAccount | null> {
  return upstream("reading the account", async () => {
    const resp = await fetch(`${env.HORIZON_URL.replace(/\/$/, "")}/accounts/${account}`, {
      headers: { Accept: "application/json" },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`horizon ${resp.status}`);
    return (await resp.json()) as HorizonAccount;
  });
}

const stroops = (decimal: string | undefined) => (decimal ? parseUnitsLoose(decimal) : 0n);

function parseUnitsLoose(decimal: string): bigint {
  const [w, f = ""] = decimal.split(".");
  return BigInt(w) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
}

/** What the account can spend of a classic asset (XLM net of reserves), or null without a trustline. */
function classicSpendable(acct: HorizonAccount, token: Token): bigint | null {
  if (token.classic === "native") {
    const line = acct.balances.find((b) => b.asset_type === "native");
    if (!line) return 0n;
    const entries = 2n + BigInt(acct.subentry_count) + BigInt(acct.num_sponsoring ?? 0) - BigInt(acct.num_sponsored ?? 0);
    const free = stroops(line.balance) - entries * BASE_RESERVE - stroops(line.selling_liabilities);
    return free > 0n ? free : 0n;
  }
  const [code, issuer] = (token.classic ?? "").split(":");
  const line = acct.balances.find((b) => b.asset_code === code && b.asset_issuer === issuer);
  return line ? stroops(line.balance) - stroops(line.selling_liabilities) : null;
}

async function hitzBalance(env: Env, account: string): Promise<bigint> {
  return big(await hitzView(env, "balance", account));
}

async function isGravityExempt(env: Env, account: string): Promise<boolean> {
  const [pool, router] = await Promise.all([hitzView(env, "is_pool", account), hitzView(env, "is_router", account)]);
  return pool === true || router === true;
}

/**
 * Balance, trustline and Event Horizon checks for a trade: `account` pays,
 * `recipient` receives. Problems come back as warnings; the transaction
 * simulation is the final word.
 */
async function accountChecks(env: Env, q: Quoted, account: string, recipient: string) {
  const { sell, buy } = q;
  const buysHitz = buy.contract === env.HITZ_CONTRACT_ID;
  const sellsHitz = sell.contract === env.HITZ_CONTRACT_ID;
  const [payer, receiver, hitzHeld, recipientHitz, totalMass, exempt] = await Promise.all([
    horizonAccount(env, account),
    recipient === account || !StellarSdk.StrKey.isValidEd25519PublicKey(recipient) ? null : horizonAccount(env, recipient),
    sellsHitz ? hitzBalance(env, account) : null,
    buysHitz ? hitzBalance(env, recipient) : null,
    buysHitz ? hitzView(env, "total_mass").then(big) : null,
    buysHitz ? isGravityExempt(env, recipient) : false,
  ]);
  const warnings: string[] = [];
  const summary: Record<string, unknown> = { address: account, exists: payer !== null };
  if (!payer) {
    warnings.push(`Account ${account} doesn't exist on Stellar mainnet yet. Fund it with XLM first.`);
    return { summary, warnings };
  }

  // Can the account pay?
  const spendable = sellsHitz ? hitzHeld : sell.classic ? classicSpendable(payer, sell) : null;
  if (spendable !== null) {
    summary.spendable = amountOf(sell, spendable);
    if (spendable < q.amountIn) {
      warnings.push(
        `The account can spend ${formatUnits(spendable, sell.decimals)} ${sell.symbol}` +
          `${sell.classic === "native" ? " (after its reserve)" : ""}, less than the ${formatUnits(q.amountIn, sell.decimals)} this trade sells.`
      );
    }
  } else if (sell.classic) {
    warnings.push(`The account has no ${sell.symbol} trustline, so it holds no ${sell.symbol} to sell.`);
  }

  // Can the recipient receive?
  const receiving = recipient === account ? payer : receiver;
  if (buy.classic && buy.classic !== "native" && receiving && classicSpendable(receiving, buy) === null) {
    summary.can_receive = false;
    warnings.push(
      `${recipient === account ? "The account" : "The recipient"} has no ${buy.symbol} trustline, so it can't receive ${buy.symbol}. ` +
        `Add a trustline to ${buy.classic} first.`
    );
  }

  // Gravity: HITZ bought from the vault lowers Total Mass by the same amount.
  if (buysHitz && recipientHitz !== null && totalMass !== null) {
    const after = recipientHitz + q.amountOut;
    const horizonAfter = limitFor(totalMass - q.amountOut);
    const vaultedAfter = !exempt && after > horizonAfter;
    summary.gravity = {
      hitz_after: formatUnits(after, 7),
      event_horizon_after: formatUnits(horizonAfter, 7),
      vaulted_after: vaultedAfter,
    };
    if (vaultedAfter) {
      warnings.push(
        `After this trade ${recipient === account ? "the account" : "the recipient"} would hold ${formatUnits(after, 7)} HITZ, above the ` +
          `Event Horizon of ${formatUnits(horizonAfter, 7)} HITZ, and become vaulted: it can still receive HITZ and sell it ` +
          `back into the vault, but can't send HITZ anywhere else until it holds less than the limit.`
      );
    }
  }
  return { summary, warnings };
}

// ─── Account summary ─────────────────────────────────────────────────────────

/** The largest purchase x that keeps balance + x within L(S − x). */
function maxBuyBeforeVaulted(balance: bigint, totalMass: bigint): bigint {
  const fits = (x: bigint) => balance + x <= limitFor(totalMass - x);
  if (!fits(0n)) return 0n;
  let lo = 0n;
  let hi = limitFor(totalMass) - balance + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export async function accountSummary(env: Env, input: unknown) {
  const account = requireAccount(input, "address");
  const vault = await readVault(env);
  const [acct, hitz, totalMass, exempt] = await Promise.all([
    horizonAccount(env, account),
    hitzBalance(env, account),
    hitzView(env, "total_mass").then(big),
    isGravityExempt(env, account),
  ]);
  const limit = limitFor(totalMass);
  const balances: Record<string, string | null> = { HITZ: formatUnits(hitz, 7) };
  for (const token of vault.assets) {
    if (!token.classic) continue;
    if (!acct) {
      balances[token.symbol] = null;
      continue;
    }
    const line =
      token.classic === "native"
        ? acct.balances.find((b) => b.asset_type === "native")
        : acct.balances.find((b) => `${b.asset_code}:${b.asset_issuer}` === token.classic);
    balances[token.symbol] = line ? line.balance : null;
  }
  const vaulted = !exempt && hitz > limit;
  const release = vaulted ? minimumToRelease(hitz, totalMass) : null;
  return {
    address: account,
    exists: acct !== null,
    balances,
    xlm_spendable: acct ? formatUnits(classicSpendable(acct, classicTokens(env)[0]) ?? 0n, 7) : null,
    trustlines: Object.fromEntries(
      vault.assets.filter((t) => t.classic && t.classic !== "native").map((t) => [t.symbol, balances[t.symbol] !== null])
    ),
    gravity: {
      event_horizon: formatUnits(limit, 7),
      total_mass: formatUnits(totalMass, 7),
      exempt,
      vaulted,
      can_buy_hitz_before_vaulted: exempt ? null : formatUnits(maxBuyBeforeVaulted(hitz, totalMass), 7),
      ...(release !== null ? { sell_to_release_hitz: formatUnits(release, 7) } : {}),
    },
    notes: [
      "Balances in display units. null means the account doesn't exist or has no trustline for that asset.",
      "An account holding more HITZ than the Event Horizon is vaulted: it can only send HITZ to a registered pool, such as by selling into the vault.",
    ],
  };
}

// ─── Building a swap ─────────────────────────────────────────────────────────

export interface SwapInput extends QuoteInput {
  account?: unknown;
  /** Pays out here instead of to `account`. */
  to?: unknown;
  slippage_bps?: unknown;
  /** Seconds the transaction stays valid. */
  valid_for?: unknown;
}

function intParam(input: unknown, field: string, def: number, min: number, max: number): number {
  if (input === undefined || input === null || input === "") return def;
  const n = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, `invalid_${field}`, `${field} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

const VAULT_ERRORS: Record<number, [string, string]> = {
  1: ["invalid_amount", "The amount must be greater than zero."],
  2: ["unsupported_pair", "That pair isn't traded in the vault."],
  3: ["slippage", "The price moved past the slippage tolerance. Build the transaction again, or allow more slippage."],
  4: ["pool_not_seeded", "That asset's pool has no liquidity yet."],
  7: ["invalid_address", "Neither the sender nor the recipient can be the vault itself."],
  10: ["trade_too_small", "The output rounds to zero after the fee; trade a larger amount."],
  11: ["overflow", "The amount is far beyond any real supply."],
};

/**
 * A simulation failure, in words a person (or an agent) can act on.
 *
 * Token failures are matched first, by their messages: when an asset
 * contract fails inside `swap`, the vault re-raises the same error code as
 * "contract call failed", and the codes overlap (an asset contract's #10 is a
 * balance error, the vault's #10 is TradeTooSmall). Vault codes count only
 * when the vault raised them itself.
 */
export function explainFailure(raw: string, sell?: Token, buy?: Token): ApiError {
  const details = { raw: raw.slice(0, 2000) };
  if (/resulting balance is not within the allowed range|balance is not sufficient|insufficient balance/i.test(raw)) {
    return new ApiError(
      422,
      "insufficient_balance",
      `The account doesn't hold enough ${sell?.symbol ?? "of the sold asset"} for this trade` +
        `${sell?.classic === "native" ? " (XLM must also cover the account's reserve and the fee)" : ""}.`,
      details
    );
  }
  if (/trustline/i.test(raw)) {
    return new ApiError(
      422,
      "no_trustline",
      `A trustline is missing: the account needs one for ${buy?.classic && buy.classic !== "native" ? buy.classic : "the asset it trades"}.`,
      details
    );
  }
  if (/vaulted/i.test(raw)) {
    return new ApiError(422, "vaulted", "The account is vaulted: it can only send HITZ to a registered pool, such as the vault.", details);
  }
  if (!/contract call failed/.test(raw)) {
    const own = new RegExp(`contract:${VAULT_ID}, topics:\\[error, Error\\(Contract, #(\\d+)\\)\\]`).exec(raw);
    const known = own ? VAULT_ERRORS[Number(own[1])] : undefined;
    if (known) return new ApiError(422, known[0], known[1], details);
  }
  // The oldest error event in the log is the root cause; its data usually opens with a message.
  const errorLines = raw.split("\n").filter((l) => l.includes("topics:[error"));
  const root = errorLines[errorLines.length - 1] ?? raw.split("\n")[0];
  const reason = /data:\["([^"]+)"/.exec(root)?.[1] ?? /Error\([^)]*\)/.exec(root)?.[0] ?? root;
  return new ApiError(422, "simulation_failed", `The transaction would fail: ${reason.slice(0, 300)}`, details);
}

/** A restore transaction for archived entries the swap touches, ready for the account to sign. */
async function buildRestore(
  env: Env,
  account: string,
  preamble: StellarSdk.rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"]
): Promise<string> {
  const server = rpcServer(env);
  const source = await upstream("loading the account", () => server.getAccount(account));
  const draft = new StellarSdk.TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: env.NETWORK_PASSPHRASE })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(StellarSdk.Operation.restoreFootprint({}))
    .setTimeout(DEFAULT_VALID_FOR_S)
    .build();
  const sim = await upstream("simulating the restore", () => server.simulateTransaction(draft));
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw explainFailure(sim.error);
  return StellarSdk.rpc.assembleTransaction(draft, sim).build().toXDR();
}

/**
 * Where a person can sign `xdr`: skyhitz.io/sign (with their own wallet) and a
 * SEP-7 URI. The sign page only takes swaps that pay out to the signer, so a
 * swap with another recipient gets the SEP-7 link alone.
 */
export function signLinks(env: Env, xdr: string, paysSigner = true) {
  const encoded = encodeURIComponent(xdr);
  return {
    ...(paysSigner ? { web: `${env.APP_URL}/sign/#xdr=${encoded}` } : {}),
    sep7: `web+stellar:tx?xdr=${encoded}&network_passphrase=${encodeURIComponent(env.NETWORK_PASSPHRASE)}`,
  };
}

export async function buildSwap(env: Env, input: SwapInput) {
  const account = requireAccount(input.account);
  const recipient = input.to ? requireAddress(input.to, "to") : account;
  const slippageBps = intParam(input.slippage_bps, "slippage_bps", DEFAULT_SLIPPAGE_BPS, 0, MAX_SLIPPAGE_BPS);
  const validFor = intParam(input.valid_for, "valid_for", DEFAULT_VALID_FOR_S, MIN_VALID_FOR_S, MAX_VALID_FOR_S);
  if (input.buy_amount !== undefined && input.buy_amount !== null && input.buy_amount !== "") {
    throw new ApiError(
      400,
      "invalid_amount",
      "A swap sells an exact amount. Quote with buy_amount to find the amount to sell, then build with that amount."
    );
  }

  const server = rpcServer(env);
  const [q, usd, source] = await Promise.all([
    computeQuote(env, input),
    usdPrices(env),
    upstream("loading the account", async () => {
      try {
        return await server.getAccount(account);
      } catch (err) {
        if (/not\s*found|404/i.test(messageOf(err))) {
          throw new ApiError(404, "account_not_found", `Account ${account} doesn't exist on Stellar mainnet yet. Fund it with XLM first.`);
        }
        throw err;
      }
    }),
  ]);
  const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const tx = new StellarSdk.TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: env.NETWORK_PASSPHRASE })
    .addOperation(
      new StellarSdk.Contract(VAULT_ID).call(
        "swap",
        addr(account),
        addr(recipient),
        addr(q.sell.contract),
        addr(q.buy.contract),
        i128(q.amountIn),
        i128(minOut)
      )
    )
    .setTimeout(validFor)
    .build();

  const [sim, checks] = await Promise.all([
    upstream("simulating the swap", () => server.simulateTransaction(tx)),
    accountChecks(env, q, account, recipient),
  ]);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    const failure = explainFailure(sim.error, q.sell, q.buy);
    throw new ApiError(failure.status, failure.code, failure.message, { ...failure.details, warnings: checks.warnings });
  }
  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) {
    const restoreXdr = await buildRestore(env, account, sim.restorePreamble);
    throw new ApiError(
      409,
      "restore_required",
      "Some of this account's contract data has been archived after a long time without use. Sign and submit restore_xdr first " +
        "(it costs a small fee), then build the swap again.",
      { restore_xdr: restoreXdr, sign: signLinks(env, restoreXdr) }
    );
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new ApiError(502, "upstream_unavailable", "The swap simulation returned no result.");
  }
  const simulatedOut = big(StellarSdk.scValToNative(sim.result.retval));
  const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  const xdr = assembled.toXDR();
  const maxTime = Number(assembled.timeBounds?.maxTime ?? 0);
  const described = describeQuote(env, { ...q, amountOut: simulatedOut }, usd);
  return {
    xdr,
    network_passphrase: env.NETWORK_PASSPHRASE,
    account,
    recipient,
    sell: amountOf(q.sell, q.amountIn),
    buy: { expected: amountOf(q.buy, simulatedOut), minimum: amountOf(q.buy, minOut) },
    slippage_bps: slippageBps,
    network_fee_xlm: formatUnits(BigInt(assembled.fee), 7),
    valid_until: maxTime ? new Date(maxTime * 1000).toISOString() : null,
    quote: described,
    account_checks: checks.summary,
    warnings: checks.warnings,
    sign: signLinks(env, xdr, recipient === account),
    next:
      `Sign this transaction with the account's key in any Stellar wallet${recipient === account ? " (or open sign.web)" : ""}, ` +
      `then POST it to ${env.APP_URL}/api/v1/submit as {"xdr": "<signed xdr>"}, or submit it to any Stellar RPC before valid_until.`,
  };
}

// ─── Submitting and following transactions ──────────────────────────────────

interface VaultCall {
  method: string;
  args: StellarSdk.xdr.ScVal[];
}

/** The vault call inside a single-operation transaction, if that's what it is. */
function vaultCallOf(tx: StellarSdk.Transaction): VaultCall | null {
  if (tx.operations.length !== 1) return null;
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") return null;
  const fn = op.func;
  if (fn.switch().name !== "hostFunctionTypeInvokeContract") return null;
  const call = fn.invokeContract();
  if (StellarSdk.Address.fromScAddress(call.contractAddress()).toString() !== VAULT_ID) return null;
  return { method: call.functionName().toString(), args: call.args() };
}

/** A readable view of a vault `swap` call, with its output when known. */
async function describeSwapCall(env: Env, call: VaultCall, returnValue?: StellarSdk.xdr.ScVal) {
  if (call.method !== "swap" || call.args.length !== 6) return { method: call.method };
  const [from, to, tokenIn, tokenOut, amountIn, minOut] = call.args.map((a) => StellarSdk.scValToNative(a));
  const [sell, buy] = await Promise.all([tokenInfo(env, String(tokenIn)), tokenInfo(env, String(tokenOut))]);
  return {
    method: "swap",
    from: String(from),
    to: String(to),
    sell: amountOf(sell, big(amountIn)),
    minimum_out: amountOf(buy, big(minOut)),
    ...(returnValue ? { bought: amountOf(buy, big(StellarSdk.scValToNative(returnValue))) } : {}),
  };
}

const explorerTx = (hash: string) => `https://stellar.expert/explorer/public/tx/${hash}`;

/** `txBadSeq`, `txFailed (invokeHostFunctionTrapped)`, …; null when unreadable. */
function resultCode(result: StellarSdk.xdr.TransactionResult | undefined): string | null {
  if (!result) return null;
  try {
    const inner = result.result();
    let code: string = inner.switch().name;
    let results = code === "txFailed" ? inner.results() : null;
    if (code === "txFeeBumpInnerFailed") {
      const nested = inner.innerResultPair().result().result();
      code = `txFeeBumpInnerFailed/${nested.switch().name}`;
      results = nested.switch().name === "txFailed" ? nested.results() : null;
    }
    const op = results?.[0];
    const opCode = op ? (op.switch().name === "opInner" ? op.tr().value().switch().name : op.switch().name) : null;
    return opCode ? `${code} (${opCode})` : code;
  } catch {
    return null;
  }
}

const REJECTIONS: Record<string, string> = {
  txBadSeq: "The account's sequence number moved since this transaction was built (another transaction from it landed first). Build a new one.",
  txTooLate: "The transaction expired. Build a new one and sign it before valid_until.",
  txBadAuth: "The signature is missing or doesn't match the account. Sign with the source account's key.",
  txInsufficientBalance: "The account doesn't have enough XLM to pay the network fee.",
  txInsufficientFee: "The fee was too low for current network demand. Build the transaction again.",
  txNoAccount: "The source account doesn't exist.",
};

export async function submitTransaction(env: Env, input: unknown) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) throw new ApiError(400, "invalid_xdr", "xdr is required: the signed transaction envelope, base64.");
  let parsed: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction;
  try {
    parsed = StellarSdk.TransactionBuilder.fromXDR(text, env.NETWORK_PASSPHRASE);
  } catch {
    throw new ApiError(400, "invalid_xdr", "xdr isn't a valid Stellar transaction envelope (base64).");
  }
  const inner = parsed instanceof StellarSdk.FeeBumpTransaction ? parsed.innerTransaction : parsed;
  const call = vaultCallOf(inner);
  const isRestore = inner.operations.length === 1 && inner.operations[0].type === "restoreFootprint";
  if (!call && !isRestore) {
    throw new ApiError(
      400,
      "not_a_vault_transaction",
      "This endpoint only relays single-operation calls to the HITZ Sovereign Vault (and the restore transactions they may need). Submit other transactions to a Stellar RPC directly."
    );
  }
  if (!parsed.signatures.length || (parsed instanceof StellarSdk.FeeBumpTransaction && !inner.signatures.length)) {
    throw new ApiError(400, "unsigned", "The transaction isn't signed. Sign it with the source account's key first.");
  }

  const server = rpcServer(env);
  const sent = await upstream("submitting", () => server.sendTransaction(parsed));
  const hash = sent.hash;
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new ApiError(503, "try_again_later", "The network asked to resubmit in a few seconds.", { hash });
  }
  if (sent.status === "ERROR") {
    const code = resultCode(sent.errorResult) ?? "rejected";
    const base = code.replace(/^txFeeBumpInnerFailed\//, "").split(" ")[0];
    throw new ApiError(422, "rejected", REJECTIONS[base] ?? `The network rejected the transaction: ${code}.`, {
      hash,
      result_code: code,
    });
  }

  // PENDING or DUPLICATE: follow it to a final status.
  for (let i = 0; i < SUBMIT_WAIT_S; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await upstream("following the transaction", () => server.getTransaction(hash));
    if (res.status === "NOT_FOUND") continue;
    if (res.status === "SUCCESS") {
      return {
        status: "SUCCESS" as const,
        hash,
        ledger: res.ledger,
        explorer: explorerTx(hash),
        ...(call ? { call: await describeSwapCall(env, call, res.returnValue) } : { call: { method: "restoreFootprint" } }),
      };
    }
    const code = resultCode(res.resultXdr) ?? "txFailed";
    throw new ApiError(422, "failed", `The transaction was included but failed (${code}); the network fee was charged.`, {
      status: "FAILED",
      hash,
      ledger: res.ledger,
      result_code: code,
      explorer: explorerTx(hash),
    });
  }
  return { status: "PENDING" as const, hash, explorer: explorerTx(hash), next: `Check GET ${env.APP_URL}/api/v1/tx?hash=${hash}` };
}

export async function transactionStatus(env: Env, input: unknown) {
  const hash = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, "invalid_hash", "hash must be a 64-character transaction hash.");
  const res = await upstream("reading the transaction", () => rpcServer(env).getTransaction(hash));
  if (res.status === "NOT_FOUND") {
    return {
      status: "NOT_FOUND" as const,
      hash,
      note: "Not seen by the RPC: still pending, never submitted, or older than its retention window (about 7 days).",
    };
  }
  let call: Awaited<ReturnType<typeof describeSwapCall>> | null = null;
  try {
    const envelope = res.envelopeXdr;
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? new StellarSdk.FeeBumpTransaction(envelope, env.NETWORK_PASSPHRASE).innerTransaction
        : new StellarSdk.Transaction(envelope, env.NETWORK_PASSPHRASE);
    const vaultCall = vaultCallOf(tx);
    if (vaultCall) call = await describeSwapCall(env, vaultCall, res.status === "SUCCESS" ? res.returnValue : undefined);
  } catch (err) {
    console.warn("[vault-api] could not decode envelope", err);
  }
  return {
    status: res.status,
    hash,
    ledger: res.ledger,
    created_at: new Date(Number(res.createdAt) * 1000).toISOString(),
    ...(res.status === "FAILED" ? { result_code: resultCode(res.resultXdr) } : {}),
    ...(call ? { call } : {}),
    explorer: explorerTx(hash),
  };
}
