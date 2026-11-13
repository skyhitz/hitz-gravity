// The HITZ Terminal's plans: what each one sees and what it costs. The pricing page, the plan gate
// (gate.ts) and checkout all read this one table, so a price or a limit changes here and nowhere else.
//
// Pure and erasable TypeScript: tests/terminal-*.test.mjs run it in Node.

export type PlanId = "free" | "trader" | "pro" | "institutional";
export type Dataset =
  | "overview"
  | "spreads"
  | "liquidations"
  | "liquidation_feed"
  | "leverage"
  | "books"
  | "flows"
  | "transfers"
  | "sdf"
  | "alerts"
  | "labels"
  | "status";
export type Resolution = "1m" | "5m" | "1h" | "1d";

const MINUTE = 60_000;
const DAY = 86_400_000;

export const RESOLUTION_MS: Record<Resolution, number> = { "1m": MINUTE, "5m": 5 * MINUTE, "1h": 60 * MINUTE, "1d": DAY };

export interface Plan {
  id: PlanId;
  name: string;
  /** Higher sees more. */
  rank: number;
  /** Dollars per 30 days. */
  usd: number;
  tagline: string;
  features: string[];
  /** Intraday data newer than this is held back. */
  delayMinutes: number;
  /** How far back intraday series reach; null for all of it. */
  intradayDays: number | null;
  /** How far back daily series reach; null for all of it. */
  dailyDays: number | null;
  finest: Resolution;
  datasets: readonly Dataset[];
  /** Smallest whale transfer listed. */
  minTransferXlm: number;
  apiKeys: number;
  /** Requests per minute and per day: per address when free, per account when paid. */
  perMinute: number;
  perDay: number;
  webhooks: number;
}

const BASE: readonly Dataset[] = ["overview", "spreads", "liquidations", "flows", "transfers", "alerts", "status"];
const LIVE: readonly Dataset[] = [...BASE, "liquidation_feed", "leverage", "books", "sdf"];

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    rank: 0,
    usd: 0,
    tagline: "The market an hour ago",
    features: [
      "Overview, spreads and liquidations, an hour behind",
      "Hourly bins, the last 7 days",
      "Whale and exchange flows by day, the last 30 days",
      "Transfers of 50M+ XLM",
      "The alert feed, an hour behind",
    ],
    delayMinutes: 60,
    intradayDays: 7,
    dailyDays: 30,
    finest: "1h",
    datasets: BASE,
    minTransferXlm: 50_000_000,
    apiKeys: 0,
    perMinute: 30,
    perDay: 2_000,
    webhooks: 0,
  },
  trader: {
    id: "trader",
    name: "Trader",
    rank: 1,
    usd: 29,
    tagline: "Live dashboards and alerts",
    features: [
      "Everything live, no delay",
      "5-minute bins, 90 days back; daily data for a year",
      "Every Bybit and OKX liquidation as it happens",
      "Open interest, funding, accounts long, order books",
      "SDF's supply to exchanges and its pace",
      "Transfers of 10M+ XLM, labeled",
      "Alerts to 2 webhooks (Discord, Slack or your server)",
    ],
    delayMinutes: 0,
    intradayDays: 90,
    dailyDays: 365,
    finest: "5m",
    datasets: LIVE,
    minTransferXlm: 10_000_000,
    apiKeys: 0,
    perMinute: 60,
    perDay: 20_000,
    webhooks: 2,
  },
  pro: {
    id: "pro",
    name: "Pro",
    rank: 2,
    usd: 99,
    tagline: "The developer API",
    features: [
      "Everything in Trader",
      "API keys (3) for your own systems",
      "1-minute bins, a year back; all daily history",
      "300 requests a minute, 100,000 a day",
      "Alerts to 5 webhooks",
    ],
    delayMinutes: 0,
    intradayDays: 365,
    dailyDays: null,
    finest: "1m",
    datasets: LIVE,
    minTransferXlm: 10_000_000,
    apiKeys: 3,
    perMinute: 300,
    perDay: 100_000,
    webhooks: 5,
  },
  institutional: {
    id: "institutional",
    name: "Institutional",
    rank: 3,
    usd: 499,
    tagline: "Full history and the labeled wallet book",
    features: [
      "Everything in Pro",
      "All history at every resolution",
      "The labeled wallet book: exchanges, SDF, custodians, whales",
      "Transfers of 1M+ XLM",
      "API keys (10), 1,200 requests a minute, 1,000,000 a day",
      "Alerts to 20 webhooks",
    ],
    delayMinutes: 0,
    intradayDays: null,
    dailyDays: null,
    finest: "1m",
    datasets: [...LIVE, "labels"],
    minTransferXlm: 1_000_000,
    apiKeys: 10,
    perMinute: 1_200,
    perDay: 1_000_000,
    webhooks: 20,
  },
};

export const PLAN_IDS: readonly PlanId[] = ["free", "trader", "pro", "institutional"];
export const PAID_PLANS: readonly PlanId[] = ["trader", "pro", "institutional"];

/** A period is 30 days; twelve cost ten. */
export const PERIOD_DAYS = 30;
export const PERIOD_MS = PERIOD_DAYS * DAY;
export const PERIODS: readonly number[] = [1, 12];
export const ASSETS = ["USDC", "XLM"] as const;
export type PayAsset = (typeof ASSETS)[number];

/** Every answer carries this. */
export const LICENSE = "For the subscriber's own use: no redistribution or resale. Information only, not advice.";

export const isPlanId = (x: unknown): x is PlanId => typeof x === "string" && (PLAN_IDS as readonly string[]).includes(x);
export const isPaidPlan = (x: unknown): x is PlanId => isPlanId(x) && x !== "free";
export const isPayAsset = (x: unknown): x is PayAsset => typeof x === "string" && (ASSETS as readonly string[]).includes(x);

/** The price of `periods` periods of a plan, in dollars. Only 1 and 12 are sold. */
export function priceUsd(plan: PlanId, periods: number): number {
  if (!PERIODS.includes(periods)) throw new Error(`periods must be ${PERIODS.join(" or ")}`);
  return PLANS[plan].usd * (periods === 12 ? 10 : 1);
}

/** The cheapest plan that includes a dataset. */
export function cheapestWith(dataset: Dataset): PlanId {
  return PLAN_IDS.find((id) => PLANS[id].datasets.includes(dataset)) ?? "institutional";
}

/** What the pricing page and GET /api/terminal/plans show. */
export function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id,
      name: p.name,
      usd_per_30_days: p.usd,
      usd_per_year: p.usd * 10,
      tagline: p.tagline,
      features: p.features,
      delay_minutes: p.delayMinutes,
      intraday_days: p.intradayDays,
      daily_days: p.dailyDays,
      finest_resolution: p.finest,
      datasets: [...p.datasets],
      min_transfer_xlm: p.minTransferXlm,
      api_keys: p.apiKeys,
      requests_per_minute: p.perMinute,
      requests_per_day: p.perDay,
      webhooks: p.webhooks,
    };
  });
}
