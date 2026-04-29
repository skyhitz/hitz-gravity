/**
 * aqua.ts — Aqua AMM router client (Stellar testnet, Soroban).
 *
 * Aqua is NOT Uniswap-style. There is no `path: Vec<Address>` quote. Pools
 * are keyed by `(tokens_sorted, pool_index: BytesN<32>)` and the router
 * exposes per-hop primitives:
 *
 *   • `get_pools(tokens_sorted) -> Map<BytesN<32>, Address>` — discovery.
 *   • `estimate_swap(tokens_sorted, token_in, token_out, pool_index, in_amount) -> u128`
 *     — sovereign quote for a single hop.
 *   • `swap(user, tokens_sorted, token_in, token_out, pool_index, in_amount, out_min) -> u128`
 *     — single-hop execution.
 *   • `swap_chained(user, swaps_chain, token_in, in_amount, out_min) -> u128`
 *     — multi-hop execution; each hop is `(tokens_sorted, pool_index, token_out_of_hop)`.
 *
 * Pool discovery is rooted entirely in the HITZ contract's pool registry —
 * `discoverPoolsFromRegistry(addresses)` queries each registered pool's
 * `get_tokens()` and asks the Aqua router for the matching `pool_index`.
 * No hardcoded token tables, no candidate-pair scans. Whatever the admin
 * registers on chain *is* the routable graph.
 *
 * Soroban constraint (unchanged): one `InvokeHostFunction` per transaction.
 * Multi-leg *splits* still require one on-chain swap, but a multi-hop *path*
 * compresses into a single `swap_chained` call.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { applySlippage } from "./swap";

// ─── Network ─────────────────────────────────────────────────────────────────
// testnet URL: https://soroban-testnet.stellar.org
// mainnet URL: https://soroban-rpc.mainnet.stellar.gateway.fm
export const RPC_URL = "https://soroban-rpc.mainnet.stellar.gateway.fm";
// mainnet passphrase: Public Global Stellar Network ; September 2015
export const NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const server = new StellarSdk.rpc.Server(RPC_URL);

// ─── HITZ token (the only address we hardcode — it's *us*) ───────────────────
// testnet address: CCWURGGZMECUABLCNKZMWKSR6TXFJX6AYWYR7R756ZXUHM2HLULTV4LK
// mainnet address: CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU
export const HITZ_ADDRESS = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU";

/**
 * Token symbols are queried at runtime from `symbol()` on the SAC contract
 * itself. They're not an enum — a registered pool can pair HITZ with any
 * token the admin trusts, and SAC-wrapped classic assets carry distributor-
 * scoped symbols (e.g. `USDC:GAHP…`) we don't get to enumerate up front.
 *
 * The string here is the canonical human-readable symbol *after* trimming
 * any `:GISSUER` suffix. Use `getTokenInfo(address)` to look one up.
 */
export type TokenSymbol = string;

// ─── Router ──────────────────────────────────────────────────────────────────
// testnet address: CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD
// mainnet address: CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK
export const AQUA_ROUTER = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";

// ─── Pool registry ───────────────────────────────────────────────────────────

export interface PoolInfo {
  /** Sorted pair — `[tokenA, tokenB]` in the canonical byte order Aqua uses. */
  tokenA: string;
  tokenB: string;
  /** Aqua pool contract address (used for UI labeling; swaps go through router). */
  address: string;
  /** BytesN<32> pool hash used as the router's pool key. */
  poolIndex: Buffer;
}

/** TTL for the registered-pool memo cache (ms). */
const POOLS_CACHE_MS = 60_000;

/**
 * Force a fresh registry walk on the next call. Components that know
 * the pool set may have changed (admin just registered a new HITZ/X
 * pool, etc.) call this to short-circuit the 60 s TTL.
 */
export function refreshPools(): void {
  registeredPoolsCache = null;
  tokenInfoCache.clear();
}

// ─── Dynamic token metadata ─────────────────────────────────────────────────

export interface TokenInfo {
  address: string;
  /** Short human symbol — `:ISSUER` suffix trimmed. */
  symbol: string;
  decimals: number;
  /** CSS color for dots / labels. Stable per address (palette hash). */
  color: string;
}

/**
 * Stable color palette for unfamiliar tokens. HITZ keeps its purple,
 * native XLM keeps the accent blue. Everything else is deterministically
 * hashed into one of the remaining design tokens — same address always
 * maps to the same color across reloads.
 */
const PALETTE = [
  "var(--green)",
  "var(--yellow)",
  "var(--orange)",
  "var(--accent)",
  "var(--purple)",
];
// testnet address for xlm SAC: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
// mainnet address for xlm SAC: CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
const FIXED_COLORS: Record<string, string> = {
  [HITZ_ADDRESS]: "var(--purple)",
  // Stellar testnet native (XLM) SAC — kept by address, not symbol, so a
  // fake "XLM" SAC doesn't steal the canonical color.
  CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA: "var(--accent)",
};

function colorFor(address: string): string {
  if (FIXED_COLORS[address]) return FIXED_COLORS[address];
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

const tokenInfoCache = new Map<string, TokenInfo>();

/**
 * Resolve a token contract's display metadata by simulating `symbol()`
 * and `decimals()` on the contract itself. Returns null if either call
 * fails (non-token contract, archived state, etc.) — the caller can
 * fall back to a truncated address.
 *
 * Results are memoised process-wide; symbols and decimals don't change
 * after deployment.
 */
export async function getTokenInfo(address: string): Promise<TokenInfo | null> {
  const cached = tokenInfoCache.get(address);
  if (cached) return cached;
  try {
    const [symRetval, decRetval] = await Promise.all([
      simulateInvocation(address, "symbol", []),
      simulateInvocation(address, "decimals", []),
    ]);
    const rawSym = String(StellarSdk.scValToNative(symRetval));
    const trimmed = rawSym.split(":")[0].trim() || rawSym;
    // The native XLM SAC reports its symbol as "native" — surface it as XLM
    // for display, matching what users see everywhere else on Stellar.
    const symbol = trimmed === "native" ? "XLM" : trimmed;
    const decimals = Number(StellarSdk.scValToNative(decRetval));
    const info: TokenInfo = {
      address,
      symbol,
      decimals: Number.isFinite(decimals) ? decimals : 7,
      color: colorFor(address),
    };
    tokenInfoCache.set(address, info);
    return info;
  } catch {
    return null;
  }
}

/**
 * Resolve metadata for many addresses in parallel. Tokens that fail
 * to resolve are simply absent from the returned map — the caller
 * should treat the address as an unknown SAC and render a truncated
 * mono string.
 */
export async function getTokenInfos(
  addresses: string[]
): Promise<Map<string, TokenInfo>> {
  const unique = Array.from(new Set(addresses));
  const infos = await Promise.all(unique.map(getTokenInfo));
  const out = new Map<string, TokenInfo>();
  for (let i = 0; i < unique.length; i++) {
    const info = infos[i];
    if (info) out.set(unique[i], info);
  }
  return out;
}

/**
 * Derive tradable pools from the HITZ contract's pool registry.
 *
 * For each registered address we query `get_tokens()` (the Aqua /
 * Soroswap pool convention) to discover the token pair, then ask the
 * Aqua router which `pool_index` corresponds to the *registered
 * address* (not just any pool for that pair — Aqua may index multiple
 * pools per pair, and only the admin-registered one counts).
 *
 * Addresses that don't expose `get_tokens` (classic Stellar accounts,
 * non-AMM contracts) are silently dropped — valid for TotalMass
 * accounting but not as swap targets.
 *
 * This is the *only* pool-discovery path. There is no hardcoded
 * candidate-pair list, no bridge-pair augmentation: what the admin
 * registers on chain is exactly what SmartSwap surfaces, with
 * 2-hop routing derived from the registered graph itself.
 */
interface CachedRegisteredPools {
  promise: Promise<PoolInfo[]>;
  fetchedAt: number;
  // Keyed on the sorted registeredAddresses list so passing in a
  // different set invalidates the cache cleanly.
  key: string;
}
let registeredPoolsCache: CachedRegisteredPools | null = null;

export async function discoverPoolsFromRegistry(
  registeredAddresses: string[]
): Promise<PoolInfo[]> {
  const key = [...registeredAddresses].sort().join(",");
  const now = Date.now();
  if (
    !registeredPoolsCache ||
    registeredPoolsCache.key !== key ||
    now - registeredPoolsCache.fetchedAt > POOLS_CACHE_MS
  ) {
    registeredPoolsCache = {
      fetchedAt: now,
      key,
      promise: (async () => {
        const enriched = await Promise.all(
          registeredAddresses
            .filter((a) => a.startsWith("C"))
            .map(enrichRegisteredPool)
        );
        return enriched.filter((p): p is PoolInfo => p !== null);
      })(),
    };
  }
  return registeredPoolsCache.promise;
}

/**
 * The subset of a PoolInfo list that pairs HITZ directly with another
 * token — i.e. the alt-token *addresses* the SmartSwap dropdown should
 * surface. Symbols are resolved by the UI via `getTokenInfo(address)`.
 */
export function hitzPairTokens(pools: PoolInfo[]): string[] {
  const out = new Set<string>();
  for (const p of pools) {
    if (p.tokenA === HITZ_ADDRESS) out.add(p.tokenB);
    else if (p.tokenB === HITZ_ADDRESS) out.add(p.tokenA);
  }
  return Array.from(out);
}

/**
 * Resolve a registered pool address into a `PoolInfo`. We:
 *
 *   1. Read `get_tokens()` from the pool contract.
 *   2. Ask the Aqua router for *all* pools indexing that pair, then
 *      pick the entry whose value matches the registered address.
 *      Aqua often indexes multiple pools (constant-product +
 *      stableswap) for the same pair; matching by address is the
 *      only way to bind to the *exact* registered pool.
 *
 * If `get_tokens()` succeeds but the router doesn't return a matching
 * `pool_index`, we still return a `PoolInfo` with an empty index — it
 * won't quote through the Aqua router (we drop it before path
 * generation in that case via the `poolIndex.length` check), but the
 * UI can still surface its tokens for sacrifice / display purposes.
 */
async function enrichRegisteredPool(address: string): Promise<PoolInfo | null> {
  const tokens = await getPoolTokens(address);
  if (!tokens) return null;
  const [a, b] = tokens;
  const [tokenA, tokenB] = sortTokens(a, b);

  try {
    const retval = await simulateInvocation(AQUA_ROUTER, "get_pools", [
      vecAddr([tokenA, tokenB]),
    ]);
    const entries = readPoolsMap(retval);
    // Bind to the exact registered address — not the first entry the
    // router happens to return.
    const match = entries.find(([, addr]) => addr === address);
    if (match) {
      const [poolIndex, poolAddress] = match;
      return { tokenA, tokenB, address: poolAddress, poolIndex };
    }
  } catch {
    // Router lookup failed; fall through.
  }
  // Router doesn't index this pool (or call failed). Surface it
  // anyway with an empty index — callers that route via Aqua filter
  // it out, but UI displays still resolve.
  return { tokenA, tokenB, address, poolIndex: Buffer.alloc(0) };
}

/** Returns the pool for an unordered pair, or undefined if none exists. */
export function findPool(pools: PoolInfo[], a: string, b: string): PoolInfo | undefined {
  return pools.find(
    (p) => (p.tokenA === a && p.tokenB === b) || (p.tokenA === b && p.tokenB === a)
  );
}

// ─── Token sort (Aqua uses raw-bytes comparison) ─────────────────────────────

/**
 * Sort two addresses the way Aqua's `sort_tokens` does: by raw account-ID
 * bytes. We compare via the decoded Address buffer, not the strkey string.
 */
function sortTokens(a: string, b: string): [string, string] {
  const ba = StellarSdk.StrKey.decodeContract(a);
  const bb = StellarSdk.StrKey.decodeContract(b);
  return compareBytes(ba, bb) <= 0 ? [a, b] : [b, a];
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Read an `ScMap<ScBytes, ScAddress>` return value into `[Buffer, strkey][]`.
 * Works off the raw ScVal, avoiding `scValToNative`'s lossy handling of
 * non-string map keys.
 */
function readPoolsMap(retval: StellarSdk.xdr.ScVal): [Buffer, string][] {
  if (retval.switch() !== StellarSdk.xdr.ScValType.scvMap()) return [];
  const map = retval.map();
  if (!map) return [];
  const out: [Buffer, string][] = [];
  for (const entry of map) {
    const key = entry.key();
    const val = entry.val();
    if (key.switch() !== StellarSdk.xdr.ScValType.scvBytes()) continue;
    if (val.switch() !== StellarSdk.xdr.ScValType.scvAddress()) continue;
    const buf = Buffer.from(key.bytes());
    const addrStr = StellarSdk.Address.fromScAddress(val.address()).toString();
    out.push([buf, addrStr]);
  }
  return out;
}

// ─── Soroban helpers ─────────────────────────────────────────────────────────

/** A dummy source account for read-only simulations (no signing required). */
const SIM_SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

function addr(value: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(value).toScVal();
}

function u128(value: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: "u128" });
}

function bytesN(buf: Buffer): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBytes(buf);
}

function vecAddr(addresses: string[]): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvVec(addresses.map(addr));
}

async function simulateInvocation(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<StellarSdk.xdr.ScVal> {
  const account = new StellarSdk.Account(SIM_SOURCE, "0");
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation error: ${sim.error}`);
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
    throw new Error("Simulation did not succeed");
  }
  if (!sim.result) throw new Error("Simulation returned no result");
  return sim.result.retval;
}

// ─── estimate_swap (per-hop quote) ───────────────────────────────────────────

/**
 * Quotes a single hop on a known pool. Returns the output amount in stroops
 * or `null` if the router rejects the call (dead pool, insufficient liquidity).
 */
async function estimateSwap(
  pool: PoolInfo,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<bigint | null> {
  try {
    const retval = await simulateInvocation(AQUA_ROUTER, "estimate_swap", [
      vecAddr([pool.tokenA, pool.tokenB]),
      addr(tokenIn),
      addr(tokenOut),
      bytesN(pool.poolIndex),
      u128(amountIn),
    ]);
    const native = StellarSdk.scValToNative(retval) as unknown;
    const out = BigInt(native as string | number | bigint);
    return out > 0n ? out : null;
  } catch {
    return null;
  }
}

// ─── Path-based quote (Uniswap-shaped facade over Aqua's per-hop API) ────────

/**
 * Simulates a full path quote by walking each hop through `estimate_swap`.
 * Returns `bigint[]` of length `path.length` where `out[0] = amountIn` and
 * `out[n-1]` is the final tokenOut amount. Returns `null` if any hop is dead
 * or unknown.
 *
 * Caller supplies the pool graph — typically the registry-derived list
 * from `discoverPoolsFromRegistry`. There is intentionally no fallback;
 * a stale or hardcoded fallback would silently route through pools the
 * admin hasn't approved.
 */
export async function getAmountsOut(
  path: string[],
  amountIn: bigint,
  pools: PoolInfo[]
): Promise<bigint[] | null> {
  if (path.length < 2) return null;
  if (amountIn <= 0n) return null;

  const amounts: bigint[] = [amountIn];

  for (let i = 0; i < path.length - 1; i++) {
    const pool = findPool(pools, path[i], path[i + 1]);
    if (!pool || pool.poolIndex.length === 0) return null;
    const out = await estimateSwap(pool, path[i], path[i + 1], amounts[i]);
    if (out === null || out <= 0n) return null;
    amounts.push(out);
  }

  return amounts;
}

// ─── Reverse quote: getAmountInForPath ──────────────────────────────────────
//
// Aqua has no reverse-quote primitive — `estimate_swap` only computes
// `out(in)`. To let the UI ask "how much do I need to pay to receive X?"
// we invert `getAmountsOut` numerically:
//
//   1. Probe the path with a small amount to learn the marginal rate.
//   2. Linearly extrapolate an initial `amountIn` guess.
//   3. Run 2–3 Newton-style refinements: next = guess * target / got.
//   4. Nudge upward once if the final guess under-delivers, so the caller
//      can use the result as an `amountIn` that actually yields ≥ target.
//
// Small probe + a handful of refinements keeps the RPC cost bounded
// (~5–7 simulation calls) — comparable to a single forward aggregation leg.

const PROBE_AMOUNT = 10_000_000n; // 1 unit at 7 decimals

/**
 * Invert a path's forward quote: find an `amountIn` such that the path
 * produces at least `amountOut`. Returns null if the path is dead or the
 * target is unreachable.
 */
export async function getAmountInForPath(
  path: string[],
  amountOut: bigint,
  pools: PoolInfo[]
): Promise<bigint | null> {
  if (path.length < 2) return null;
  if (amountOut <= 0n) return null;

  // Probe at a tiny size to learn the marginal exchange rate.
  const probeAmounts = await getAmountsOut(path, PROBE_AMOUNT, pools);
  if (!probeAmounts) return null;
  const probeOut = probeAmounts[probeAmounts.length - 1];
  if (probeOut <= 0n) return null;

  // Linear first guess: if `probe` produces `probeOut`, target ≈
  // `probe * amountOut / probeOut`. AMM curves are convex, so this
  // underestimates — the refine loop handles that.
  let guess = (PROBE_AMOUNT * amountOut) / probeOut;
  if (guess <= 0n) guess = 1n;

  // Refine via fixed-point iteration. Converges quickly for AMM curves.
  for (let i = 0; i < 4; i++) {
    const a = await getAmountsOut(path, guess, pools);
    if (!a) return null;
    const got = a[a.length - 1];
    if (got <= 0n) return null;
    if (got === amountOut) return guess;
    const next = (guess * amountOut) / got;
    if (next === guess) break;
    guess = next > 0n ? next : 1n;
  }

  // Final safety: if we land just under target, nudge up until we cover it
  // (so callers can safely use this as a "pay exactly this to receive ≥ X"
  // input). Bounded — AMM quotes are monotone.
  for (let i = 0; i < 6; i++) {
    const a = await getAmountsOut(path, guess, pools);
    if (!a) return null;
    const got = a[a.length - 1];
    if (got >= amountOut) return guess;
    guess = guess + guess / 500n + 1n; // +0.2%
  }
  return guess;
}

// ─── Pool reserves (for Sacrifice Ritual audited-pool display) ──────────────
//
// The Aqua router doesn't expose reserves; we go directly to the pool
// contract's `get_reserves() -> Vec<u128>`. Reserves come back in the pool's
// token order (sorted), matching the `tokenA`/`tokenB` on `PoolInfo`.

export interface PoolReserves {
  reserveA: bigint;
  reserveB: bigint;
}

/**
 * Fetch on-chain reserves for an Aqua pool. Accepts either a `PoolInfo` or a
 * raw pool contract address — the latter lets callers (e.g. the sacrifice
 * ritual's registered-pool list) enrich any audited pool without having to
 * first cross-reference the router's candidate-pair cache.
 */
export async function getPoolReserves(
  pool: PoolInfo | string
): Promise<PoolReserves | null> {
  const address = typeof pool === "string" ? pool : pool.address;
  try {
    const retval = await simulateInvocation(address, "get_reserves", []);
    if (retval.switch() !== StellarSdk.xdr.ScValType.scvVec()) return null;
    const vec = retval.vec();
    if (!vec || vec.length < 2) return null;
    const a = StellarSdk.scValToNative(vec[0]);
    const b = StellarSdk.scValToNative(vec[1]);
    return {
      reserveA: BigInt(a as string | number | bigint),
      reserveB: BigInt(b as string | number | bigint),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the token addresses for a pool contract. Aqua pools expose
 * `get_tokens() -> Vec<Address>` in canonical (sorted) order. Returns null
 * on failure or when the contract isn't a recognisable AMM pool.
 */
export async function getPoolTokens(
  poolAddress: string
): Promise<[string, string] | null> {
  try {
    const retval = await simulateInvocation(poolAddress, "get_tokens", []);
    if (retval.switch() !== StellarSdk.xdr.ScValType.scvVec()) return null;
    const vec = retval.vec();
    if (!vec || vec.length < 2) return null;
    const a = StellarSdk.Address.fromScAddress(vec[0].address()).toString();
    const b = StellarSdk.Address.fromScAddress(vec[1].address()).toString();
    return [a, b];
  } catch {
    return null;
  }
}

// ─── buildSwapArgs — produces the contract call shape ─────────────────────

export interface BuildSwapArgs {
  /** The connected wallet. */
  userAddress: string;
  /** Trade path of token addresses, e.g. [USDC, XLM, HITZ]. */
  path: string[];
  /** Input amount in stroops. */
  amountIn: bigint;
  /** Expected output in stroops (from the aggregator). */
  amountOut: bigint;
  /** Slippage budget, in basis points (50 = 0.5%). */
  slippageBps: number;
  /**
   * Pool graph — required. Always the registry-derived list from
   * `discoverPoolsFromRegistry`, so the swap call binds to exactly the
   * pools the admin registered (and the dropdown surfaced).
   */
  pools: PoolInfo[];
}

/**
 * Shape of a contract call — consumed by both the wallet path (which will
 * sim + sign + submit locally) and the gateway path (which POSTs the args
 * to the Worker for fee-bumping).
 */
export interface SwapCall {
  contractId: string;
  method: "swap" | "swap_chained";
  args: StellarSdk.xdr.ScVal[];
}

/**
 * Returns the Aqua router call as (method, args) so callers can route it
 * through whatever execution strategy they prefer (wallet-signed local
 * submit, or sponsored fee-bump via the gateway).
 *
 * One-hop paths invoke `swap`; multi-hop paths invoke `swap_chained` with
 * the hop chain `Vec<(Vec<Address>, BytesN<32>, Address)>`.
 */
export async function buildSwapArgs(args: BuildSwapArgs): Promise<SwapCall> {
  if (args.path.length < 2) throw new Error("Path too short");
  const amountOutMin = applySlippage(args.amountOut, args.slippageBps);

  const hops: PoolInfo[] = [];
  for (let i = 0; i < args.path.length - 1; i++) {
    const pool = findPool(args.pools, args.path[i], args.path[i + 1]);
    if (!pool) throw new Error(`No pool for ${args.path[i]} → ${args.path[i + 1]}`);
    if (pool.poolIndex.length === 0) {
      throw new Error(
        `Pool ${pool.address} is registered but not indexed by the Aqua router`
      );
    }
    hops.push(pool);
  }

  if (hops.length === 1) {
    const pool = hops[0];
    return {
      contractId: AQUA_ROUTER,
      method: "swap",
      args: [
        addr(args.userAddress),
        vecAddr([pool.tokenA, pool.tokenB]),
        addr(args.path[0]),
        addr(args.path[1]),
        bytesN(pool.poolIndex),
        u128(args.amountIn),
        u128(amountOutMin),
      ],
    };
  }

  // swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>
  // Each tuple is encoded as scvVec of 3 elements.
  const chain = StellarSdk.xdr.ScVal.scvVec(
    hops.map((pool, i) =>
      StellarSdk.xdr.ScVal.scvVec([
        vecAddr([pool.tokenA, pool.tokenB]),
        bytesN(pool.poolIndex),
        addr(args.path[i + 1]), // token_out of this hop
      ])
    )
  );
  return {
    contractId: AQUA_ROUTER,
    method: "swap_chained",
    args: [
      addr(args.userAddress),
      chain,
      addr(args.path[0]),
      u128(args.amountIn),
      u128(amountOutMin),
    ],
  };
}

/**
 * Legacy builder kept for any external consumer that still wants a fully-
 * assembled unsigned XDR. Internally just prepends sim + assembleTransaction
 * onto buildSwapArgs. Present only for backwards compatibility — prefer
 * buildSwapArgs + callContract for new code.
 */
export async function buildSwapXdr(args: BuildSwapArgs): Promise<string> {
  const call = await buildSwapArgs(args);
  const account = await server.getAccount(args.userAddress);
  const contract = new StellarSdk.Contract(call.contractId);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(call.method, ...call.args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  return StellarSdk.rpc.assembleTransaction(tx, sim).build().toXDR();
}

// ─── Submit signed XDR ───────────────────────────────────────────────────────

export interface SubmitResult {
  success: boolean;
  hash?: string;
  error?: string;
}

export async function submitSignedXdr(signedXdr: string): Promise<SubmitResult> {
  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    const response = await server.sendTransaction(tx);
    if (response.status === "ERROR") {
      return { success: false, error: "sendTransaction returned ERROR" };
    }

    let getResponse = await server.getTransaction(response.hash);
    const deadline = Date.now() + 60_000;
    while (getResponse.status === "NOT_FOUND" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await server.getTransaction(response.hash);
    }

    if (getResponse.status === "SUCCESS") {
      return { success: true, hash: response.hash };
    }
    return {
      success: false,
      hash: response.hash,
      error: `Transaction ${getResponse.status}`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
