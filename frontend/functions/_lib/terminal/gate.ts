// The plan gate: turns a plan and a request's query into the exact call the data worker answers (the
// MARKET service binding's terminal* methods), or a refusal that names the plan that would open it.
// Everything a plan limits is decided here, in one pure function: datasets, the free plan's delay, how
// far back each plan reaches, the finest bins, the smallest transfer listed, page sizes.
//
// Pure and erasable TypeScript, run in Node by tests/terminal-gate.test.mjs.

import { cheapestWith, RESOLUTION_MS, type Dataset, type Plan, type PlanId, type Resolution } from "./plans.ts";

const DAY = 86_400_000;

/** The data worker's method for each dataset. */
export const METHOD: Record<Dataset, string> = {
  overview: "terminalOverview",
  spreads: "terminalSpreads",
  liquidations: "terminalLiquidations",
  liquidation_feed: "terminalLiquidationFeed",
  leverage: "terminalLeverage",
  books: "terminalBooks",
  flows: "terminalFlows",
  transfers: "terminalTransfers",
  sdf: "terminalSdf",
  alerts: "terminalAlerts",
  labels: "terminalLabels",
  status: "terminalStatus",
};
export const DATASETS = Object.keys(METHOD) as Dataset[];
const BINNED: readonly Dataset[] = ["spreads", "liquidations", "leverage", "books"];
const EVENTS_LIKE: readonly Dataset[] = ["liquidation_feed", "transfers", "alerts"];
const DAILY: readonly Dataset[] = ["flows", "sdf"];
/** The window when a request names none, by bin size. */
const DEFAULT_SPAN: Record<Resolution, number> = { "1m": 6 * 3_600_000, "5m": DAY, "1h": 7 * DAY, "1d": 365 * DAY };
const RES_ORDER: readonly Resolution[] = ["1m", "5m", "1h", "1d"];
export const MAX_LIMIT = 500;
/** The first day any daily series has (flows from 2021, liquidations from 2020). */
const FIRST_DAY = "2015-01-01";

export interface Meta {
  plan: PlanId;
  dataset: Dataset;
  delayed_by_minutes: number;
  from?: string;
  to?: string;
  resolution?: Resolution;
  /** Set when the request asked for finer bins or older data than the plan has. */
  limited?: string[];
}

export type Gated =
  | { ok: true; method: string; args: Record<string, unknown>; meta: Meta }
  | { ok: false; status: 400 | 403 | 404; code: string; message: string; upgrade?: PlanId };

/** ms since the epoch, or an ISO date or date-time; null when absent, NaN when unreadable. */
export function parseTime(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (/^\d{10,13}$/.test(v)) return Number(v) < 1e12 ? Number(v) * 1000 : Number(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : Number.NaN;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function gate(plan: Plan, dataset: string, params: Record<string, string | undefined>, nowMs: number): Gated {
  if (!(DATASETS as string[]).includes(dataset)) {
    return { ok: false, status: 404, code: "unknown_dataset", message: `No dataset "${dataset}". Try one of: ${DATASETS.join(", ")}.` };
  }
  const ds = dataset as Dataset;
  if (!plan.datasets.includes(ds)) {
    const up = cheapestWith(ds);
    return { ok: false, status: 403, code: "plan_required", message: `${ds} needs the ${up} plan or higher.`, upgrade: up };
  }
  const meta: Meta = { plan: plan.id, dataset: ds, delayed_by_minutes: plan.delayMinutes };
  const limited: string[] = [];
  const done = (args: Record<string, unknown>): Gated => ({ ok: true, method: METHOD[ds], args, meta: limited.length ? { ...meta, limited } : meta });
  const liveTo = nowMs - plan.delayMinutes * 60_000;

  if (ds === "overview") return done({ asOfMs: liveTo });
  if (ds === "labels" || ds === "status") return done({});

  const limit = (() => {
    const n = Number(params.limit ?? 100);
    return Number.isFinite(n) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(n))) : 100;
  })();

  if ((DAILY as readonly Dataset[]).includes(ds)) {
    const earliest = plan.dailyDays === null ? FIRST_DAY : isoDay(nowMs - plan.dailyDays * DAY);
    const fromT = parseTime(params.from);
    const toT = parseTime(params.to);
    if (Number.isNaN(fromT) || Number.isNaN(toT)) return { ok: false, status: 400, code: "invalid_time", message: "from and to are ISO dates or ms since the epoch." };
    let fromDay = fromT === null ? isoDay(nowMs - 30 * DAY) : isoDay(fromT);
    if (fromDay < earliest) {
      fromDay = earliest;
      limited.push(`history starts ${earliest} on the ${plan.name} plan`);
    }
    const toDay = toT === null ? undefined : isoDay(toT);
    meta.from = fromDay;
    if (toDay) meta.to = toDay;
    return done(toDay ? { fromDay, toDay } : { fromDay });
  }

  const fromT = parseTime(params.from);
  const toT = parseTime(params.to);
  if (Number.isNaN(fromT) || Number.isNaN(toT)) return { ok: false, status: 400, code: "invalid_time", message: "from and to are ISO date-times or ms since the epoch." };
  let resolution: Resolution = "1h";
  if ((BINNED as readonly Dataset[]).includes(ds)) {
    const asked = params.resolution as Resolution | undefined;
    if (asked !== undefined && !RES_ORDER.includes(asked)) return { ok: false, status: 400, code: "invalid_resolution", message: `resolution is one of ${RES_ORDER.join(", ")}.` };
    resolution = asked ?? "1h";
    if (RESOLUTION_MS[resolution] < RESOLUTION_MS[plan.finest]) {
      limited.push(`bins of ${plan.finest} or wider on the ${plan.name} plan`);
      resolution = plan.finest;
    }
  }
  const toMs = Math.min(toT ?? liveTo, liveTo);
  if (toT !== null && toT > liveTo && plan.delayMinutes > 0) limited.push(`data ${plan.delayMinutes} minutes behind on the ${plan.name} plan`);
  const earliest = plan.intradayDays === null ? 0 : nowMs - plan.intradayDays * DAY;
  const span = (EVENTS_LIKE as readonly Dataset[]).includes(ds) ? DAY : DEFAULT_SPAN[resolution];
  let fromMs = fromT ?? toMs - span;
  if (fromMs < earliest) {
    fromMs = earliest;
    limited.push(`history starts ${plan.intradayDays} days back on the ${plan.name} plan`);
  }
  fromMs = Math.min(fromMs, toMs);
  meta.from = iso(fromMs);
  meta.to = iso(toMs);

  if (ds === "transfers") {
    const asked = Number(params.min_xlm ?? plan.minTransferXlm);
    const minXlm = Math.max(plan.minTransferXlm, Number.isFinite(asked) ? asked : plan.minTransferXlm);
    if (Number.isFinite(asked) && asked < plan.minTransferXlm) limited.push(`transfers of ${plan.minTransferXlm / 1e6}M+ XLM on the ${plan.name} plan`);
    return done({ fromMs, toMs, minXlm, limit });
  }
  if (ds === "liquidation_feed" || ds === "alerts") return done({ fromMs, toMs, limit });
  meta.resolution = resolution;
  return done({ fromMs, toMs, resolution });
}
