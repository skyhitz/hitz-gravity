"use client";

/**
 * LiquidityCard: the Sovereign Vault's liquidity, on the Monitor tab under
 * the price.
 *
 * Two sources:
 *  - The Worker's snapshot (functions/_lib/price-model.ts →
 *    summarizeLiquidity): USD values, the 30-day liquidity trend, and swap
 *    volume and fees, from the vault's own events. Fetched every minute; the
 *    cron refreshes it every 5 minutes.
 *  - The vault itself (`pools()`, read live): each pool's fee and
 *    dislocation right now, the vault's exchange rate between its assets,
 *    and, through the exact port of the contract math (lib/vaultMath.ts),
 *    the ±2% depth and the price impact of real trade sizes, fees included.
 *    The fee rises with the dislocation a trade leaves, so these come from
 *    the contract's own formula, not a flat-fee curve.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchLiquidity, type LiquiditySnapshot } from "../lib/liquidity";
import { fmtCompact, fmtMoney, fmtPct, fmtUsd } from "../lib/price";
import { useVaultPools } from "../lib/useVaultPools";
import { knownToken } from "../lib/tokens";
import { HITZ_ADDRESS, VAULT_ID } from "../lib/vault";
import { poolsFromStates, swap as vaultSwap, type PoolState } from "../lib/vaultMath";
import { DailyTable, TimeSeriesChart } from "./TimeSeriesChart";

const POLL_MS = 60_000;

/** The contract's hard cap (MAX_SUPPLY); fully minted at launch. */
const MAX_SUPPLY = 100_000_000;

const RANGES = [
  { key: "7D", hours: 24 * 7 },
  { key: "30D", hours: 24 * 30 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const IMPACT_SIZES = [10, 50, 100, 500, 1000];
const UNIT = 1e7;

type LoadState =
  | { status: "loading" }
  | { status: "indexing" }
  | { status: "error"; error: string }
  | { status: "ready"; data: LiquiditySnapshot };

const tickFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtImpact(v: number | null): string {
  if (v === null) return "–";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
}

const symbolOf = (asset: string) => knownToken(asset)?.symbol ?? `${asset.slice(0, 4)}…`;
const assetOf = (key: string) => key.split(":")[1] ?? key;

/** Price impact, fees included, of spending `usd` on HITZ through `asset`'s pool: +0.09 = paying 9% over spot. */
function buyImpact(states: PoolState[], asset: string, assetUsd: number, usd: number): number | null {
  const p = states.find((s) => s.asset === asset);
  if (!p) return null;
  try {
    const amountIn = BigInt(Math.round((usd / assetUsd) * UNIT));
    const out = vaultSwap(poolsFromStates(states), asset, HITZ_ADDRESS, amountIn, 0n, HITZ_ADDRESS).amountOut;
    const spot = (Number(p.reserve) / Number(p.hitz)) * assetUsd; // USD per HITZ
    return usd / (Number(out) / UNIT) / spot - 1;
  } catch {
    return null;
  }
}

/** Price impact, fees included, of selling `usd` worth of HITZ (at spot) for `asset`: −0.09 = receiving 9% under spot. */
function sellImpact(states: PoolState[], asset: string, assetUsd: number, usd: number): number | null {
  const p = states.find((s) => s.asset === asset);
  if (!p) return null;
  try {
    const spot = (Number(p.reserve) / Number(p.hitz)) * assetUsd;
    const hitzIn = BigInt(Math.round((usd / spot) * UNIT));
    const out = vaultSwap(poolsFromStates(states), HITZ_ADDRESS, asset, hitzIn, 0n, HITZ_ADDRESS).amountOut;
    return ((Number(out) / UNIT) * assetUsd) / usd - 1;
  } catch {
    return null;
  }
}

/**
 * USD it takes to move `asset`'s pool price by `move` (+0.02 = HITZ 2%
 * dearer, through a buy; −0.02 through a sale), fees included, by bisection
 * on the exact hop.
 */
function depthUsd(states: PoolState[], asset: string, assetUsd: number, move: number): number | null {
  const i = states.findIndex((s) => s.asset === asset);
  if (i < 0) return null;
  const p = states[i];
  const price0 = Number(p.reserve) / Number(p.hitz);
  const buy = move > 0;
  const priceAfter = (amount: bigint): number => {
    const r = vaultSwap(poolsFromStates(states), buy ? asset : HITZ_ADDRESS, buy ? HITZ_ADDRESS : asset, amount, 0n, HITZ_ADDRESS);
    const q = r.pools[i];
    return Number(q.reserve) / Number(q.hitz);
  };
  const reached = (amount: bigint) => {
    try {
      const ratio = priceAfter(amount) / price0;
      return buy ? ratio >= 1 + move : ratio <= 1 + move;
    } catch {
      return false;
    }
  };
  let lo = 0n;
  let hi = 1_000n;
  for (let k = 0; !reached(hi); k++) {
    if (k > 80) return null;
    lo = hi;
    hi *= 2n;
  }
  for (let k = 0; k < 60 && hi - lo > 1n; k++) {
    const mid = (lo + hi) / 2n;
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  const amount = Number(hi) / UNIT;
  // A buy spends the asset; a sale spends HITZ, valued at the pool's spot.
  return buy ? amount * assetUsd : amount * price0 * assetUsd;
}

export default function LiquidityCard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [range, setRange] = useState<RangeKey>("30D");
  const [view, setView] = useState<"chart" | "table">("chart");
  const { pools: live } = useVaultPools();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchLiquidity();
        if (cancelled) return;
        setState(data ? { status: "ready", data } : { status: "indexing" });
      } catch (err) {
        if (cancelled) return;
        // Keep the last good snapshot on a transient failure.
        setState((prev) =>
          prev.status === "ready" ? prev : { status: "error", error: err instanceof Error ? err.message : String(err) }
        );
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const history = useMemo(() => data?.history ?? [], [data]);
  const latest = history.at(-1);

  // Anchored to the newest point, like the price card.
  const visible = useMemo(() => {
    if (!latest) return [];
    const hours = RANGES.find((r) => r.key === range)!.hours;
    return history.filter(([h]) => h > latest[0] - hours * 3600);
  }, [history, latest, range]);

  // USD per unit of each listed asset, from the snapshot (Stellar DEX hourly average; USDC = 1).
  const assetUsd = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of data?.pools ?? []) m.set(assetOf(p.address), p.quoteUsd);
    return m;
  }, [data]);

  const vaultPools = useMemo(() => (data?.pools ?? []).filter((p) => p.venue === "vault"), [data]);
  const liveByAsset = useMemo(() => new Map((live ?? []).map((p) => [p.asset, p])), [live]);

  // The vault's own exchange rate between its first two assets, against the market.
  const pair = useMemo(() => {
    if (!live || live.length < 2) return null;
    const [b, q] = live;
    const bUsd = assetUsd.get(b.asset);
    const qUsd = assetUsd.get(q.asset);
    if (!bUsd || !qUsd) return null;
    const vaultRate = (Number(q.reserve) * Number(b.hitz)) / (Number(q.hitz) * Number(b.reserve));
    const marketRate = bUsd / qUsd;
    return { base: symbolOf(b.asset), quote: symbolOf(q.asset), vaultRate, marketRate, gap: vaultRate / marketRate - 1 };
  }, [live, assetUsd]);

  const exactDepth = useMemo(() => {
    if (!live) return null;
    let up = 0;
    let down = 0;
    for (const p of live) {
      const usd = assetUsd.get(p.asset);
      if (!usd) return null;
      const u = depthUsd(live, p.asset, usd, 0.02);
      const d = depthUsd(live, p.asset, usd, -0.02);
      if (u === null || d === null) return null;
      up += u;
      down += d;
    }
    return { up, down };
  }, [live, assetUsd]);

  const change = visible.length > 1 ? visible[visible.length - 1][1] / visible[0][1] - 1 : null;
  const badge = state.status === "ready" ? "Live" : state.status === "error" ? "Offline" : "Syncing";

  return (
    <div className="mcard">
      <div className="mcard-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: "var(--accent)" }} aria-hidden />
          <h4>Vault liquidity</h4>
          <span className={`count ${state.status === "ready" ? "" : "idle"}`}>{badge}</span>
        </div>
        <div className="mcard-controls">
          <div className="mcard-seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.key} className={range === r.key ? "on" : ""} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
                {r.key}
              </button>
            ))}
          </div>
          <button className="mcard-toggle" aria-pressed={view === "table"} onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}>
            {view === "chart" ? "Table" : "Chart"}
          </button>
        </div>
      </div>

      {!data ? (
        <div className="mcard-empty">
          {state.status === "loading" && "Loading liquidity…"}
          {state.status === "indexing" && "Liquidity data is still being indexed. Check back in a few minutes."}
          {state.status === "error" && `Couldn't load liquidity: ${state.error}`}
        </div>
      ) : (
        <>
          <div className="mcard-hero">
            <div className="mcard-now">{fmtMoney(data.totals.tvlUsd)}</div>
            {change !== null && (
              <div className={`mcard-delta ${change >= 0 ? "up" : "down"}`}>
                {fmtPct(change)} <span>{range}</span>
              </div>
            )}
            <div className="mcard-sub">
              both sides ·{" "}
              <a href={`https://stellar.expert/explorer/public/contract/${VAULT_ID}`} target="_blank" rel="noopener noreferrer">
                Sovereign Vault
              </a>{" "}
              · {vaultPools.length} pool{vaultPools.length === 1 ? "" : "s"}
            </div>
          </div>

          {view === "chart" ? (
            <TimeSeriesChart
              points={visible}
              color="var(--accent)"
              formatValue={fmtMoney}
              formatTick={(v) => tickFmt.format(v)}
              label="Total liquidity"
            />
          ) : (
            <DailyTable
              points={visible}
              caption="Total liquidity at the end of each UTC day"
              valueHeader="Liquidity"
              formatValue={fmtMoney}
              formatChange={fmtPct}
            />
          )}

          <div className="mcard-stats">
            {(
              [
                ["24h volume", data.volume.h24],
                ["7d volume", data.volume.d7],
                ["30d volume", data.volume.d30],
              ] as const
            ).map(([k, w]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className="v">{fmtMoney(w.usd)}</div>
                <div className="s">
                  {w.trades.toLocaleString()} hop{w.trades === 1 ? "" : "s"} · {fmtMoney(w.feesUsd)} fees
                </div>
              </div>
            ))}
            <div>
              <div className="k">Fee now</div>
              <div className="v">
                {live ? live.map((p) => `${(Number(p.fee) / 1e7).toFixed(2)}%`).join(" / ") : "…"}
              </div>
              <div className="s">
                {live ? live.map((p) => symbolOf(p.asset)).join(" / ") : ""} pool · 1% when calm, up to 10%
              </div>
            </div>
            <div>
              <div className="k">{pair ? `Vault ${pair.base}/${pair.quote}` : "Vault rate"}</div>
              <div className="v">{pair ? pair.vaultRate.toPrecision(4) : "…"}</div>
              <div className="s">
                {pair ? `market ${pair.marketRate.toPrecision(4)} (${fmtPct(pair.gap)}): the gap arbitrage closes` : "vs the market"}
              </div>
            </div>
            <div>
              <div className="k">±2% depth</div>
              <div className="v">
                {fmtMoney(exactDepth?.up ?? data.totals.depthUp2Usd)} / {fmtMoney(exactDepth?.down ?? data.totals.depthDown2Usd)}
              </div>
              <div className="s">to move price +2% / −2%, fees included</div>
            </div>
            <div>
              <div className="k">HITZ in the vault</div>
              <div className="v">{fmtCompact(data.totals.hitzInPools)}</div>
              <div className="s">{((data.totals.hitzInPools / MAX_SUPPLY) * 100).toFixed(1)}% of 100M supply</div>
            </div>
          </div>

          <div className="mcard-scroll">
            <table className="liq-pools">
              <caption>The vault&apos;s pools</caption>
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col">Liquidity</th>
                  <th scope="col">Share</th>
                  <th scope="col">HITZ</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Price</th>
                  <th scope="col">Fee now</th>
                  <th scope="col">D now</th>
                </tr>
              </thead>
              <tbody>
                {data.pools.map((p) => {
                  const lp = liveByAsset.get(assetOf(p.address));
                  const fee = lp ? Number(lp.fee) / 1e7 : p.feeBps === null ? null : p.feeBps / 100;
                  const disl = lp ? Number(lp.dislocation) / 1e16 : p.dislocationPct;
                  return (
                    <tr key={p.address}>
                      <th scope="row">
                        <a href={`https://stellar.expert/explorer/public/contract/${p.contract ?? p.address}`} target="_blank" rel="noopener noreferrer">
                          {p.pair}
                        </a>
                      </th>
                      <td>{fmtMoney(p.tvlUsd)}</td>
                      <td>{(p.share * 100).toFixed(0)}%</td>
                      <td>{fmtCompact(p.hitz)}</td>
                      <td>
                        {fmtCompact(p.quoteReserve)} {p.pair.split("/")[1]}
                      </td>
                      <td>{fmtUsd(p.priceUsd)}</td>
                      <td>{fee === null ? "–" : `${fee.toFixed(2)}%`}</td>
                      <td>{disl === null || disl === undefined ? "–" : `${disl.toFixed(2)}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {live && (
            <div className="mcard-scroll">
              <table className="liq-impact">
                <caption>Price impact of one trade through each pool, right now (vault fees included)</caption>
                <thead>
                  <tr>
                    <th scope="col">Trade</th>
                    {IMPACT_SIZES.map((usd) => (
                      <th scope="col" key={usd}>
                        {fmtMoney(usd).replace(".00", "")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {live.flatMap((p) => {
                    const usd = assetUsd.get(p.asset);
                    if (!usd) return [];
                    const sym = symbolOf(p.asset);
                    return [
                      <tr key={`b${p.asset}`}>
                        <th scope="row">Buy with {sym}</th>
                        {IMPACT_SIZES.map((x) => (
                          <td key={x}>{fmtImpact(buyImpact(live, p.asset, usd, x))}</td>
                        ))}
                      </tr>,
                      <tr key={`s${p.asset}`}>
                        <th scope="row">Sell for {sym}</th>
                        {IMPACT_SIZES.map((x) => (
                          <td key={x}>{fmtImpact(sellImpact(live, p.asset, usd, x))}</td>
                        ))}
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="mcard-foot">
            Both sides of every pool in the Sovereign Vault, valued at pool price; XLM at the hourly Stellar DEX average. Volume counts each
            hop through a pool (an XLM to USDC swap is two hops), from the vault&apos;s own events; fees are what each hop left in its pool.
            Fees, rate, depth and impact are read live from the vault and computed with its exact fee formula. Updated every 5 minutes.
          </p>
        </>
      )}
    </div>
  );
}
