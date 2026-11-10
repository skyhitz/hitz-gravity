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
//   3. if that clears the profit floor, swaps in the vault, then buys back
//      the asset it sold with an SDEX path payment whose minimum is the
//      amount sold, so a round trip can't lose more than its network fees.
//
// When there is nothing to trade and a failed buy-back has left the
// inventory lopsided, it rebalances to half XLM, half USDC on the SDEX.
//
// The same module runs in the Worker cron (arb-worker.ts) and from Node
// (scripts/arb-bot.mjs), so it is erasable TypeScript with explicit .ts
// imports, no Worker bindings, and plain `fetch` for Soroban RPC and Horizon.
// Strategy notes: frontend/ARB_BOT.md.

import * as StellarSdk from "@stellar/stellar-sdk";
import { poolsFromStates, swap as vaultSwap, VaultMathError, type Pool } from "../../app/lib/vaultMath.ts";

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
  /** How far under the quote the vault leg may land (basis points). */
  slippageBps: number;
}

export const DEFAULTS = {
  minProfitXlm: 0.05,
  minProfitBps: 30,
  maxTradeXlm: 150,
  feeBufferXlm: 5,
  slippageBps: 50,
};

type Side = "XLM" | "USDC";

export interface Leg {
  hash: string;
  status: "SUCCESS" | "FAILED" | "REJECTED" | "PENDING";
  /** Result code when it didn't succeed. */
  code?: string;
  /** XLM charged in fees. */
  feeXlm?: string;
  /** What the leg delivered (vault output, or what the buy-back received). */
  received?: string;
}

export interface ArbReport {
  at: string;
  mode: "live" | "dry-run";
  address: string;
  /** none: nothing worth doing · would-trade: dry run found a trade · trade: hedged round trip ·
   *  trade-unhedged: vault leg done, buy-back skipped or failed · rebalance · skip · error */
  action: "none" | "would-trade" | "trade" | "trade-unhedged" | "rebalance" | "skip" | "error";
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
    sell: Side;
    buy: Side;
    amountIn: string;
    vaultOut: string;
    minOut: string;
    hedgeOut: string;
    profit: string;
    profitXlm: number;
  };
  vaultLeg?: Leg;
  hedgeLeg?: Leg;
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
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

/** Smallest trades considered: dust isn't worth a transaction. */
const MIN_IN: Record<Side, bigint> = { XLM: 10_000_000n, USDC: 1_500_000n };
/** Reference sizes for the SDEX price. */
const REF_IN: Record<Side, bigint> = { XLM: 100_000_000n, USDC: 15_000_000n };
/** Network fees assumed when sizing (both legs), in XLM; the realized fees are reported. */
const FEE_ESTIMATE_XLM = 0.02;
/** Inclusion bids, in stroops. The network charges the going rate up to these. */
const SOROBAN_BID = "100000";
const CLASSIC_BID = "10000";
/** The buy-back may land this far under its quote (it never goes below the amount sold). */
const HEDGE_SLIPPAGE_BPS = 30n;
/** Rebalance when one side holds less than this share of the inventory's value. */
const REBALANCE_BELOW = 0.2;

// ─── Soroban RPC over fetch ──────────────────────────────────────────────────

async function rpcCall<T>(cfg: ArbConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result as T;
}

async function simulate(cfg: ArbConfig, tx: StellarSdk.Transaction): Promise<StellarSdk.rpc.Api.SimulateTransactionResponse> {
  const response = await rpcCall<StellarSdk.rpc.Api.RawSimulateTransactionResponse>(cfg, "simulateTransaction", { transaction: tx.toXDR() });
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

// ─── Reads ───────────────────────────────────────────────────────────────────

interface Assets {
  XLM: { asset: StellarSdk.Asset; sac: string };
  USDC: { asset: StellarSdk.Asset; sac: string };
}

function assetsOf(cfg: ArbConfig): Assets {
  const xlm = StellarSdk.Asset.native();
  const usdc = new StellarSdk.Asset("USDC", cfg.usdcIssuer);
  return {
    XLM: { asset: xlm, sac: xlm.contractId(cfg.networkPassphrase) },
    USDC: { asset: usdc, sac: usdc.contractId(cfg.networkPassphrase) },
  };
}

interface VaultView {
  ledger: number;
  pools: Pool[];
  /** Pool index by asset contract. */
  index: Map<string, number>;
}

const VIEW_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

async function readVault(cfg: ArbConfig): Promise<VaultView> {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(VIEW_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(new StellarSdk.Contract(cfg.vault).call("pools"))
    .setTimeout(30)
    .build();
  const sim = await simulate(cfg, tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`reading pools failed: ${"error" in sim ? sim.error : "no result"}`);
  }
  const states = (StellarSdk.scValToNative(sim.result.retval) as Record<string, unknown>[]).map((p) => ({
    asset: String(p.asset),
    hitz: BigInt(p.hitz as bigint),
    reserve: BigInt(p.reserve as bigint),
    deviation: BigInt(p.deviation as bigint),
    dislocation: BigInt(p.dislocation as bigint),
    fee: BigInt(p.fee as bigint),
  }));
  return { ledger: sim.latestLedger, pools: poolsFromStates(states, 0n), index: new Map(states.map((s, i) => [s.asset, i])) };
}

interface Balances {
  /** XLM the bot can spend: balance minus reserve, liabilities and the fee buffer. */
  xlm: bigint;
  /** null without a USDC trustline. */
  usdc: bigint | null;
  /**
   * The bot's account at its current sequence number. Every transaction of a
   * run is built from this one object, so each takes the next number even
   * before Horizon has indexed the previous one.
   */
  account: StellarSdk.Account;
}

const BASE_RESERVE = 5_000_000n;

async function readBalances(cfg: ArbConfig, assets: Assets): Promise<Balances> {
  const res = await fetch(`${cfg.horizonUrl}/accounts/${cfg.address}`, { headers: { Accept: "application/json" } });
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
  const xlm = native
    ? raw(native.balance) - entries * BASE_RESERVE - raw(native.selling_liabilities ?? "0") - fromXlm(cfg.feeBufferXlm)
    : 0n;
  const usdcLine = acct.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === assets.USDC.asset.getIssuer());
  return {
    xlm: xlm > 0n ? xlm : 0n,
    usdc: usdcLine ? raw(usdcLine.balance) - raw(usdcLine.selling_liabilities ?? "0") : null,
    account: new StellarSdk.Account(cfg.address, acct.sequence),
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

/** Best SDEX route selling `amount` of `sell` for `buy` (order book and AMMs), or null. */
async function sdexQuote(cfg: ArbConfig, sell: StellarSdk.Asset, amount: bigint, buy: StellarSdk.Asset): Promise<Route | null> {
  const dest = buy.isNative() ? "native" : `${buy.getCode()}:${buy.getIssuer()}`;
  const url = `${cfg.horizonUrl}/paths/strict-send?${horizonAsset("source", sell)}&source_amount=${fmt(amount)}&destination_assets=${encodeURIComponent(dest)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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

// ─── Sizing ──────────────────────────────────────────────────────────────────

function vaultOut(cfg: ArbConfig, assets: Assets, vault: VaultView, sell: Side, buy: Side, amount: bigint): bigint {
  try {
    return vaultSwap(vault.pools, assets[sell].sac, assets[buy].sac, amount, 0n, cfg.hitz).amountOut;
  } catch (err) {
    if (err instanceof VaultMathError) return 0n;
    throw err;
  }
}

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

interface Plan {
  sell: Side;
  buy: Side;
  amountIn: bigint;
  vaultOut: bigint;
  /** What buying the sold asset back on the SDEX should return. */
  hedgeOut: bigint;
  profit: bigint;
  profitXlm: number;
  notionalXlm: number;
}

/**
 * The most profitable round trip selling `sell` into the vault and buying it
 * back on the SDEX at `backRate` (units of `sell` per unit of `buy`), sized
 * up to `maxIn`. Null when none makes money before fees.
 */
function bestPlan(
  cfg: ArbConfig,
  assets: Assets,
  vault: VaultView,
  sell: Side,
  maxIn: bigint,
  backRate: number,
  xlmPerSold: number
): Plan | null {
  const buy: Side = sell === "XLM" ? "USDC" : "XLM";
  if (maxIn < MIN_IN[sell]) return null;
  const profit = (a: bigint) => BigInt(Math.floor(Number(vaultOut(cfg, assets, vault, sell, buy, a)) * backRate)) - a;
  const { x, value } = maximize(profit, MIN_IN[sell], maxIn);
  if (value <= 0n) return null;
  const out = vaultOut(cfg, assets, vault, sell, buy, x);
  return {
    sell,
    buy,
    amountIn: x,
    vaultOut: out,
    hedgeOut: x + value,
    profit: value,
    profitXlm: toNum(value) * xlmPerSold,
    notionalXlm: toNum(x) * xlmPerSold,
  };
}

// ─── Transactions ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const txResult = (b64: string | undefined) => (b64 ? StellarSdk.xdr.TransactionResult.fromXDR(b64, "base64") : undefined);

/** Sign, send and follow a transaction to a final status (about 30 seconds at most). */
async function send(cfg: ArbConfig, tx: StellarSdk.Transaction, keypair: StellarSdk.Keypair): Promise<Sent> {
  tx.sign(keypair);
  const sent = await rpcCall<{ status: string; hash: string; errorResultXdr?: string }>(cfg, "sendTransaction", { transaction: tx.toXDR() });
  if (sent.status === "ERROR") return { hash: sent.hash, status: "REJECTED", code: resultCode(txResult(sent.errorResultXdr)) };
  if (sent.status === "TRY_AGAIN_LATER") return { hash: sent.hash, status: "REJECTED", code: "tryAgainLater" };
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const res = await rpcCall<{ status: string; resultXdr?: string; resultMetaXdr?: string }>(cfg, "getTransaction", { hash: sent.hash });
    if (res.status === "NOT_FOUND") continue;
    const result = txResult(res.resultXdr);
    const feeXlm = result ? fmt(BigInt(result.feeCharged().toString())) : undefined;
    if (res.status === "SUCCESS") {
      return { hash: sent.hash, status: "SUCCESS", feeXlm, returnValue: returnValueOf(res.resultMetaXdr), result };
    }
    return { hash: sent.hash, status: "FAILED", code: resultCode(result), feeXlm };
  }
  return { hash: sent.hash, status: "PENDING" };
}

const legOf = ({ returnValue: _r, result: _x, ...leg }: Sent): Leg => leg;

/** The vault leg, simulated and assembled: swap(bot, bot, in, out, amount, minOut). */
async function vaultSwapTx(
  cfg: ArbConfig,
  account: StellarSdk.Account,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  minOut: bigint
): Promise<{ tx: StellarSdk.Transaction; simulatedOut: bigint }> {
  const me = StellarSdk.Address.fromString(cfg.address).toScVal();
  const i128 = (v: bigint) => StellarSdk.nativeToScVal(v, { type: "i128" });
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: SOROBAN_BID,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      new StellarSdk.Contract(cfg.vault).call(
        "swap",
        me,
        me,
        StellarSdk.Address.fromString(tokenIn).toScVal(),
        StellarSdk.Address.fromString(tokenOut).toScVal(),
        i128(amountIn),
        i128(minOut)
      )
    )
    .setTimeout(60)
    .build();
  const sim = await simulate(cfg, tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(`vault swap simulation failed: ${sim.error.split("\n")[0]}`);
  if (StellarSdk.rpc.Api.isSimulationRestore(sim)) throw new Error("the bot's contract data is archived; restore it first");
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("vault swap simulation returned nothing");
  return {
    tx: StellarSdk.rpc.assembleTransaction(tx, sim).build(),
    simulatedOut: BigInt(StellarSdk.scValToNative(sim.result.retval) as bigint),
  };
}

/** An SDEX conversion back to ourselves: path payment strict send. */
function sdexTx(
  cfg: ArbConfig,
  account: StellarSdk.Account,
  sell: StellarSdk.Asset,
  amount: bigint,
  buy: StellarSdk.Asset,
  minOut: bigint,
  path: StellarSdk.Asset[]
): StellarSdk.Transaction {
  return new StellarSdk.TransactionBuilder(account, {
    fee: CLASSIC_BID,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.pathPaymentStrictSend({
        sendAsset: sell,
        sendAmount: fmt(amount),
        destination: cfg.address,
        destAsset: buy,
        destMin: fmt(minOut),
        path,
      })
    )
    .setTimeout(60)
    .build();
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

// ─── One run ─────────────────────────────────────────────────────────────────

export async function runOnce(cfg: ArbConfig): Promise<ArbReport> {
  const report: ArbReport = { at: new Date().toISOString(), mode: cfg.live ? "live" : "dry-run", address: cfg.address, action: "none" };
  try {
    if (cfg.live && (!cfg.keypair || cfg.keypair.publicKey() !== cfg.address)) {
      throw new Error("live mode needs the bot account's own key");
    }
    const assets = assetsOf(cfg);
    const [vault, balances, xlmToUsdc, usdcToXlm] = await Promise.all([
      readVault(cfg),
      readBalances(cfg, assets),
      sdexQuote(cfg, assets.XLM.asset, REF_IN.XLM, assets.USDC.asset),
      sdexQuote(cfg, assets.USDC.asset, REF_IN.USDC, assets.XLM.asset),
    ]);
    if (!xlmToUsdc || !usdcToXlm) throw new Error("the SDEX has no XLM/USDC route");

    // SDEX: USDC per XLM selling XLM (bid), XLM per USDC selling USDC (1 / ask).
    const usdcPerXlm = Number(xlmToUsdc.out) / Number(REF_IN.XLM);
    const xlmPerUsdc = Number(usdcToXlm.out) / Number(REF_IN.USDC);
    const xlmPool = vault.pools[vault.index.get(assets.XLM.sac) ?? -1];
    const usdcPool = vault.pools[vault.index.get(assets.USDC.sac) ?? -1];
    if (!xlmPool || !usdcPool) throw new Error("the vault doesn't list both XLM and USDC");
    const vaultRate = (Number(usdcPool.reserve) / Number(usdcPool.hitz)) / (Number(xlmPool.reserve) / Number(xlmPool.hitz));
    const mid = (usdcPerXlm + 1 / xlmPerUsdc) / 2;
    Object.assign(report, {
      ledger: vault.ledger,
      balances: { xlm: fmt(balances.xlm), usdc: balances.usdc === null ? null : fmt(balances.usdc) },
      market: { bid: Number(usdcPerXlm.toPrecision(7)), ask: Number((1 / xlmPerUsdc).toPrecision(7)) },
      vaultRate: Number(vaultRate.toPrecision(7)),
      gapPct: Number(((vaultRate / mid - 1) * 100).toFixed(3)),
    });
    if (balances.usdc === null) {
      report.action = "skip";
      report.reason = "the bot account has no USDC trustline";
      return report;
    }

    // Size both directions; keep the better one.
    const cap = fromXlm(cfg.maxTradeXlm);
    const plans = [
      bestPlan(cfg, assets, vault, "XLM", minBig(balances.xlm, cap), xlmPerUsdc, 1),
      bestPlan(cfg, assets, vault, "USDC", minBig(balances.usdc, BigInt(Math.floor(Number(cap) * usdcPerXlm))), usdcPerXlm, xlmPerUsdc),
    ].filter((p): p is Plan => p !== null);
    plans.sort((a, b) => b.profitXlm - a.profitXlm);
    const plan = plans[0];
    const floor = (p: Plan) => Math.max(cfg.minProfitXlm, (cfg.minProfitBps / 10_000) * p.notionalXlm);
    if (!plan || plan.profitXlm - FEE_ESTIMATE_XLM < floor(plan)) {
      report.reason = plan
        ? `best round trip earns ${plan.profitXlm.toFixed(4)} XLM before fees, under the floor`
        : "the vault is in line with the SDEX";
      return await maybeRebalance(cfg, assets, balances, xlmPerUsdc, usdcPerXlm, report);
    }

    // Confirm the buy-back at the exact size before touching the vault.
    const back = await sdexQuote(cfg, assets[plan.buy].asset, plan.vaultOut, assets[plan.sell].asset);
    const xlmPerSold = plan.sell === "XLM" ? 1 : xlmPerUsdc;
    if (!back || toNum(back.out - plan.amountIn) * xlmPerSold - FEE_ESTIMATE_XLM < floor(plan)) {
      report.reason = "the SDEX quote at this size leaves too little profit";
      return report;
    }
    const minOut = (plan.vaultOut * (10_000n - BigInt(cfg.slippageBps))) / 10_000n;
    const { tx, simulatedOut } = await vaultSwapTx(cfg, balances.account, assets[plan.sell].sac, assets[plan.buy].sac, plan.amountIn, minOut);
    report.plan = {
      sell: plan.sell,
      buy: plan.buy,
      amountIn: fmt(plan.amountIn),
      vaultOut: fmt(simulatedOut),
      minOut: fmt(minOut),
      hedgeOut: fmt(back.out),
      profit: fmt(back.out - plan.amountIn),
      profitXlm: Number((toNum(back.out - plan.amountIn) * xlmPerSold).toFixed(7)),
    };
    if (!cfg.live) {
      report.action = "would-trade";
      return report;
    }

    // Leg 1: the vault.
    const leg1 = await send(cfg, tx, cfg.keypair!);
    report.vaultLeg = legOf(leg1);
    if (leg1.status !== "SUCCESS" || !leg1.returnValue) {
      report.action = "error";
      report.error = `vault leg ${leg1.status.toLowerCase()}${leg1.code ? `: ${leg1.code}` : ""}`;
      return report;
    }
    const received = BigInt(StellarSdk.scValToNative(leg1.returnValue) as bigint);
    report.vaultLeg.received = fmt(received);

    // Leg 2: buy the sold asset back on the SDEX, never for less than was sold.
    const quote = await sdexQuote(cfg, assets[plan.buy].asset, received, assets[plan.sell].asset);
    if (!quote || quote.out < plan.amountIn) {
      report.action = "trade-unhedged";
      report.reason = "the SDEX moved before the buy-back; the inventory rebalances later";
      return report;
    }
    const floorOut = (quote.out * (10_000n - HEDGE_SLIPPAGE_BPS)) / 10_000n;
    const hedge = sdexTx(
      cfg,
      balances.account,
      assets[plan.buy].asset,
      received,
      assets[plan.sell].asset,
      floorOut > plan.amountIn ? floorOut : plan.amountIn,
      quote.path
    );
    const leg2 = await send(cfg, hedge, cfg.keypair!);
    report.hedgeLeg = legOf(leg2);
    const back2 = leg2.status === "SUCCESS" ? pathPaymentReceived(leg2.result) : null;
    if (back2 === null) {
      report.action = "trade-unhedged";
      report.reason = `buy-back ${leg2.status.toLowerCase()}${leg2.code ? `: ${leg2.code}` : ""}`;
      return report;
    }
    report.hedgeLeg.received = fmt(back2);
    const fees = toNum(raw(leg1.feeXlm ?? "0")) + toNum(raw(leg2.feeXlm ?? "0"));
    report.action = "trade";
    report.profit = fmt(back2 - plan.amountIn);
    report.profitXlm = Number((toNum(back2 - plan.amountIn) * xlmPerSold - fees).toFixed(7));
    return report;
  } catch (err) {
    report.action = "error";
    report.error = err instanceof Error ? err.message : String(err);
    return report;
  }
}

/** With nothing to trade: if one side holds under a fifth of the inventory, convert back toward half and half. */
async function maybeRebalance(
  cfg: ArbConfig,
  assets: Assets,
  balances: Balances,
  xlmPerUsdc: number,
  usdcPerXlm: number,
  report: ArbReport
): Promise<ArbReport> {
  const usdc = balances.usdc ?? 0n;
  const xlmValue = toNum(balances.xlm);
  const usdcValue = toNum(usdc) * xlmPerUsdc;
  const total = xlmValue + usdcValue;
  if (total <= 0 || Math.min(xlmValue, usdcValue) >= total * REBALANCE_BELOW) return report;
  const sell: Side = xlmValue > usdcValue ? "XLM" : "USDC";
  const buy: Side = sell === "XLM" ? "USDC" : "XLM";
  const excessXlm = (Math.max(xlmValue, usdcValue) - total / 2) * 0.98;
  const amount = sell === "XLM" ? fromXlm(excessXlm) : fromXlm(excessXlm * usdcPerXlm);
  if (amount < MIN_IN[sell]) return report;
  const quote = await sdexQuote(cfg, assets[sell].asset, amount, assets[buy].asset);
  if (!quote) return report;
  report.reason = `${report.reason ?? ""}; rebalancing ${fmt(amount)} ${sell} to ${buy}`.replace(/^; /, "");
  if (!cfg.live) return report;
  const tx = sdexTx(cfg, balances.account, assets[sell].asset, amount, assets[buy].asset, (quote.out * 995n) / 1000n, quote.path);
  const leg = await send(cfg, tx, cfg.keypair!);
  report.hedgeLeg = legOf(leg);
  report.action = leg.status === "SUCCESS" ? "rebalance" : "error";
  if (leg.status !== "SUCCESS") report.error = `rebalance ${leg.status.toLowerCase()}${leg.code ? `: ${leg.code}` : ""}`;
  else report.hedgeLeg.received = fmt(pathPaymentReceived(leg.result) ?? 0n);
  return report;
}
