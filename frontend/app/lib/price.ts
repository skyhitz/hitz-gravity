/**
 * price.ts — HITZ/USD history for the Monitor tab's price card, plus the
 * money formatters the market cards share.
 *
 * The Worker's ingestion cron keeps an hourly, liquidity-weighted HITZ/USD
 * series in D1, built from every registered HITZ pool's on-chain reserves
 * (and XLM/USD from the Stellar DEX for XLM-quoted pools).
 */

import { fetchSnapshot } from "./api";

export interface PriceHistory {
  /** ISO time the snapshot was last rebuilt. */
  asOf: string;
  pools: { address: string; pair: string; quote: string; weight: number }[];
  /** [hour (unix seconds), HITZ price in USD], ascending. */
  points: [number, number][];
}

/** Resolves null while the history is still being indexed. */
export function fetchPriceHistory(): Promise<PriceHistory | null> {
  return fetchSnapshot<PriceHistory>("/api/price/history");
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

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Dollar amounts: `$7,001` from $1,000 up, `$161.31` below it, `<$0.01` for dust. */
export function fmtMoney(v: number): string {
  if (v > 0 && v < 0.01) return "<$0.01";
  return Math.abs(v) >= 1000 ? money.format(v) : cents.format(v);
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Token amounts: `88.4M`, `9.8K`. */
export function fmtCompact(v: number): string {
  return compact.format(v);
}
