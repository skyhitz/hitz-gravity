"use client";

/**
 * LiquidityCard — HITZ pool liquidity on the Monitor tab, under the price.
 *
 * Everything is derived from the registered HITZ pools' on-chain reserves by
 * the Worker cron (functions/_lib/price-model.ts → summarizeLiquidity):
 * total liquidity and its 30-day trend, swap volume and fees, ±2% depth,
 * cross-pool spread, a per-pool breakdown, and a price-impact ladder.
 * Fetched every minute; the cron refreshes the snapshot every 5 minutes.
 */

import { useEffect, useMemo, useState } from "react";
import { buyImpact, fetchLiquidity, sellImpact, type LiquiditySnapshot } from "../lib/liquidity";
import { fmtCompact, fmtMoney, fmtPct, fmtUsd } from "../lib/price";
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
  if (v === null) return "—";
  const pct = v * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
}

export default function LiquidityCard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [range, setRange] = useState<RangeKey>("30D");
  const [view, setView] = useState<"chart" | "table">("chart");

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

  const change = visible.length > 1 ? visible[visible.length - 1][1] / visible[0][1] - 1 : null;
  const badge = state.status === "ready" ? "Live" : state.status === "error" ? "Offline" : "Syncing";

  return (
    <div className="mcard">
      <div className="mcard-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: "var(--accent)" }} aria-hidden />
          <h4>Liquidity</h4>
          <span className={`count ${state.status === "ready" ? "" : "idle"}`}>{badge}</span>
        </div>
        <div className="mcard-controls">
          <div className="mcard-seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={range === r.key ? "on" : ""}
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
              >
                {r.key}
              </button>
            ))}
          </div>
          <button
            className="mcard-toggle"
            aria-pressed={view === "table"}
            onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
          >
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
              both sides · {data.pools.length} registered pool{data.pools.length === 1 ? "" : "s"}
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
                  {w.trades.toLocaleString()} swap{w.trades === 1 ? "" : "s"} · {fmtMoney(w.feesUsd)} fees
                </div>
              </div>
            ))}
            <div>
              <div className="k">±2% depth</div>
              <div className="v">
                {fmtMoney(data.totals.depthUp2Usd)} / {fmtMoney(data.totals.depthDown2Usd)}
              </div>
              <div className="s">to move price +2% / −2%</div>
            </div>
            <div>
              <div className="k">Pool spread</div>
              <div className="v">{data.totals.spreadPct.toFixed(2)}%</div>
              <div className="s">price gap between pools</div>
            </div>
            <div>
              <div className="k">HITZ in pools</div>
              <div className="v">{fmtCompact(data.totals.hitzInPools)}</div>
              <div className="s">{((data.totals.hitzInPools / MAX_SUPPLY) * 100).toFixed(0)}% of 100M supply</div>
            </div>
          </div>

          <div className="mcard-scroll">
            <table className="liq-pools">
              <caption>Registered pools</caption>
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col">Liquidity</th>
                  <th scope="col">Share</th>
                  <th scope="col">HITZ</th>
                  <th scope="col">Quote</th>
                  <th scope="col">Price</th>
                  <th scope="col">±2%</th>
                  <th scope="col">Fee</th>
                </tr>
              </thead>
              <tbody>
                {data.pools.map((p) => (
                  <tr key={p.address}>
                    <th scope="row">
                      <a
                        href={`https://stellar.expert/explorer/public/contract/${p.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
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
                    <td>{fmtMoney(p.depthUp2Usd)}</td>
                    <td>{p.feeBps === null ? "—" : `${(p.feeBps / 100).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mcard-scroll">
            <table className="liq-impact">
              <caption>Price impact of a trade, best route across pools (fees included)</caption>
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
                <tr>
                  <th scope="row">Buy</th>
                  {IMPACT_SIZES.map((usd) => (
                    <td key={usd}>{fmtImpact(buyImpact(data.pools, usd))}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Sell</th>
                  {IMPACT_SIZES.map((usd) => (
                    <td key={usd}>{fmtImpact(sellImpact(data.pools, usd))}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mcard-foot">
            Both sides of every registered AMM pool, valued at pool price; XLM at the hourly Stellar DEX average.
            Volume counts swaps only — liquidity adds and removes are excluded, arbitrage is included. Updated every
            5 minutes.
          </p>
        </>
      )}
    </div>
  );
}
