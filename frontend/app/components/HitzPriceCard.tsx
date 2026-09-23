"use client";

/**
 * HitzPriceCard — HITZ/USD since launch, on the Monitor tab.
 *
 * Hourly, liquidity-weighted across the registered HITZ pools (see
 * functions/_lib/price-model.ts for the model). The series is pre-rendered
 * by the Worker cron; this card only fetches it every minute and draws it.
 *
 * Chart: a single 2px line with a faint wash, hairline grid, a crosshair
 * that snaps to the nearest hour (pointer or ←/→ keys), and a table view
 * of daily closes as its accessible twin.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchPriceHistory, fmtPct, fmtUsd, type PriceHistory } from "../lib/price";
import { DailyTable, TimeSeriesChart, fmtDate } from "./TimeSeriesChart";

const POLL_MS = 60_000;

const RANGES = [
  { key: "24H", hours: 24 },
  { key: "7D", hours: 24 * 7 },
  { key: "30D", hours: 24 * 30 },
  { key: "All", hours: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

type LoadState =
  | { status: "loading" }
  | { status: "indexing" }
  | { status: "error"; error: string }
  | { status: "ready"; history: PriceHistory };

// Axis ticks are round numbers — three significant digits is enough and
// keeps the right-hand gutter narrow.
const tickFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3,
});

export default function HitzPriceCard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [range, setRange] = useState<RangeKey>("30D");
  const [view, setView] = useState<"chart" | "table">("chart");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const history = await fetchPriceHistory();
        if (cancelled) return;
        setState(history ? { status: "ready", history } : { status: "indexing" });
      } catch (err) {
        if (cancelled) return;
        // Keep the last good series on a transient failure.
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

  const history = state.status === "ready" ? state.history : null;
  const points = useMemo(() => history?.points ?? [], [history]);
  const latest = points.at(-1);

  // Ranges are anchored to the newest point, not the wall clock, so the
  // view stays consistent with the data it was built from.
  const visible = useMemo(() => {
    if (!latest) return [];
    const hours = RANGES.find((r) => r.key === range)!.hours;
    return hours === Infinity ? points : points.filter(([h]) => h > latest[0] - hours * 3600);
  }, [points, latest, range]);

  const stats = useMemo(() => {
    if (!points.length) return null;
    let ath = points[0];
    let atl = points[0];
    for (const p of points) {
      if (p[1] > ath[1]) ath = p;
      if (p[1] < atl[1]) atl = p;
    }
    return { launch: points[0], ath, atl };
  }, [points]);

  const change = visible.length > 1 ? visible[visible.length - 1][1] / visible[0][1] - 1 : null;
  const badge = state.status === "ready" ? "Live" : state.status === "error" ? "Offline" : "Syncing";

  return (
    <div className="mcard">
      <div className="mcard-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: "var(--purple)" }} aria-hidden />
          <h4>HITZ / USD</h4>
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

      {!history ? (
        <div className="mcard-empty">
          {state.status === "loading" && "Loading price history…"}
          {state.status === "indexing" && "Price history is still being indexed. Check back in a few minutes."}
          {state.status === "error" && `Couldn't load price history: ${state.error}`}
        </div>
      ) : (
        <>
          <div className="mcard-hero">
            <div className="mcard-now">{latest ? fmtUsd(latest[1]) : "—"}</div>
            {change !== null && (
              <div className={`mcard-delta ${change >= 0 ? "up" : "down"}`}>
                {fmtPct(change)} <span>{range === "All" ? "since launch" : range}</span>
              </div>
            )}
          </div>

          {view === "chart" ? (
            <TimeSeriesChart
              points={visible}
              color="var(--purple)"
              formatValue={fmtUsd}
              formatTick={(v) => tickFmt.format(v)}
              label="HITZ price"
            />
          ) : (
            <DailyTable
              points={visible}
              caption="HITZ/USD daily close (last hourly price of each UTC day)"
              valueHeader="Close"
              formatValue={fmtUsd}
              formatChange={fmtPct}
            />
          )}

          {stats && latest && (
            <div className="mcard-stats">
              <div>
                <div className="k">Since launch</div>
                <div className={`v ${latest[1] >= stats.launch[1] ? "up" : "down"}`}>
                  {fmtPct(latest[1] / stats.launch[1] - 1)}
                </div>
                <div className="s">from {fmtUsd(stats.launch[1])}</div>
              </div>
              <div>
                <div className="k">All-time high</div>
                <div className="v">{fmtUsd(stats.ath[1])}</div>
                <div className="s">{fmtDate(stats.ath[0])}</div>
              </div>
              <div>
                <div className="k">All-time low</div>
                <div className="v">{fmtUsd(stats.atl[1])}</div>
                <div className="s">{fmtDate(stats.atl[0])}</div>
              </div>
            </div>
          )}

          <p className="mcard-foot">
            Liquidity-weighted across registered pools:{" "}
            {history.pools
              .filter((p) => p.weight > 0)
              .sort((a, b) => b.weight - a.weight)
              .map((p) => `${p.pair} ${(p.weight * 100).toFixed(0)}%`)
              .join(" · ")}
            . Reserves from on-chain pool events; XLM/USD from the Stellar DEX. Hourly, UTC.
          </p>
        </>
      )}
    </div>
  );
}
