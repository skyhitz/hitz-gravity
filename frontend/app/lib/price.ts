/**
 * price.ts — HITZ/USD history for the Monitor tab's price card.
 *
 * The Worker's ingestion cron keeps an hourly, liquidity-weighted HITZ/USD
 * series in D1, built from every registered HITZ pool's on-chain reserves
 * (and XLM/USD from the Stellar DEX for XLM-quoted pools). This module just
 * reads the pre-rendered snapshot from `/api/price/history`.
 *
 * `next dev` doesn't run the Worker, so in development we read from
 * `NEXT_PUBLIC_API_ORIGIN` (e.g. a local `wrangler dev` on :8787), falling
 * back to production — the route is public and CORS-open.
 */

export interface PriceHistory {
  /** ISO time the snapshot was last rebuilt. */
  asOf: string;
  pools: { address: string; pair: string; quote: string; weight: number }[];
  /** [hour (unix seconds), HITZ price in USD], ascending. */
  points: [number, number][];
}

function apiBase(): string {
  if (process.env.NODE_ENV !== "development") return "";
  return process.env.NEXT_PUBLIC_API_ORIGIN ?? "https://skyhitz.io";
}

/** Resolves null while the history is still being indexed (HTTP 503). */
export async function fetchPriceHistory(): Promise<PriceHistory | null> {
  const res = await fetch(`${apiBase()}/api/price/history`, { headers: { Accept: "application/json" } });
  if (res.status === 503) return null;
  if (!res.ok) throw new Error(`price history unavailable (HTTP ${res.status})`);
  return (await res.json()) as PriceHistory;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumSignificantDigits: 4,
  maximumSignificantDigits: 4,
});

/** HITZ trades far below a cent — four significant digits (`$0.00004092`). */
export function fmtUsd(price: number): string {
  return usd.format(price);
}

export function fmtPct(change: number): string {
  const pct = change * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}%`;
}
