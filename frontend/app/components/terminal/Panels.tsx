"use client";
/**
 * The HITZ Terminal's data panels. Each one polls its dataset from /api/terminal/data/* and shows what
 * the visitor's plan allows: a free visitor sees the delayed shape, and a dataset the plan lacks shows
 * the plan that opens it. Nothing here decides access; the server does.
 *
 * House style: no em-dashes.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { TimeSeriesChart } from "../TimeSeriesChart";
import { data, UNREACHABLE, type Meta, type PlanId, type PublicPlan, type Result } from "../../lib/terminal";
import { day, dayYear, frac, pct, price, short, stamp, timeUtc, tone, usd, xlm } from "./format";
import { furtherPlan } from "./planReach";
import { nextPollMs, retryable } from "./pollTiming";
import { cutByPlan, inRange, SDF_ALL_FROM, SDF_RANGES, type SdfRangeKey } from "./sdfRange";
import { spreadCut, spreadDefault, spreadQuery, SPREAD_RANGES, type SpreadQuery, type SpreadRangeKey } from "./spreadRange";
import { asking, dayGroups, emptyTape, failed, footerAction, HEAD_ROWS, HEAD_SPAN_MS, olderQuery, withHead, withOlder, type Tape } from "./transferTape";

// ─── Polling ──────────────────────────────────────────────────────────────────

/**
 * Poll a dataset. `params` must be stable (no timestamps): a window is given as `spanMs`, turned into
 * `from` at each fetch, so re-renders never restart the poll. `current` says whether the answer on hand
 * is for these params (false while a new window loads); with `enabled` false it makes no requests.
 */
export function usePollState<T>(
  dataset: string,
  params: Record<string, string | number | undefined>,
  everyMs: number,
  version: number,
  spanMs?: number,
  enabled = true,
): { res: Result<T> | null; current: boolean } {
  const [state, setState] = useState<{ id: string; res: Result<T> } | null>(null);
  const key = JSON.stringify(params);
  const id = `${dataset} ${key} ${spanMs ?? ""}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let failed = false;
      try {
        const p = JSON.parse(key) as Record<string, string | number | undefined>;
        if (spanMs) p.from = Date.now() - spanMs;
        const r = await data<T>(dataset, p);
        failed = retryable(r);
        // A failure on the server's side keeps this window's last good answer; the next tick retries.
        if (alive) setState((prev) => (!r.ok && r.status >= 500 && prev?.id === id && prev.res.ok ? prev : { id, res: r }));
      } catch (e) {
        failed = true;
        // Unreachable: keep this window's last answer, or say why there's none yet. The next tick retries.
        if (alive) setState((prev) => (prev?.id === id ? prev : { id, res: { ok: false, status: 0, code: "unreachable", error: e instanceof Error ? e.message : UNREACHABLE } }));
      }
      // A failure retries within a minute, even on a tab that refreshes every 15 (pollTiming.ts).
      if (alive) timer = setTimeout(tick, nextPollMs(everyMs, failed, document.visibilityState === "hidden"));
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [dataset, key, everyMs, version, spanMs, enabled, id]);
  if (!enabled) return { res: null, current: false };
  return { res: state?.res ?? null, current: state?.id === id };
}

export function usePoll<T>(dataset: string, params: Record<string, string | number | undefined>, everyMs: number, version: number, spanMs?: number): Result<T> | null {
  return usePollState<T>(dataset, params, everyMs, version, spanMs).res;
}

// ─── Frame ────────────────────────────────────────────────────────────────────

const PLAN_NAME: Record<PlanId, string> = { free: "Free", trader: "Trader", pro: "Pro", institutional: "Institutional" };

function DelayBadge({ meta }: { meta?: Meta }) {
  if (!meta) return null;
  if (meta.delayed_by_minutes > 0) return <span className="shrink-0 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded bg-orange/15 text-orange font-mono">{meta.delayed_by_minutes}m DELAY</span>;
  return <span className="shrink-0 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded bg-green/15 text-green font-mono">LIVE</span>;
}

/**
 * A data panel. `controls` (a panel's own tabs) sit in the header, left of the delay badge, and move to
 * their own line under the title when the panel is too narrow for both.
 */
export function Panel({ title, sub, meta, controls, children, className = "" }: { title: string; sub?: string; meta?: Meta; controls?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-card border border-border rounded-lg flex flex-col min-w-0 ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-2 border-b border-border-soft">
        <div className="min-w-0 flex-1 basis-32">
          <h3 className="text-[11px] font-semibold tracking-[0.14em] uppercase text-foreground truncate">{title}</h3>
          {sub ? <p className="text-[11px] text-muted truncate">{sub}</p> : null}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {controls}
          <DelayBadge meta={meta} />
        </div>
      </header>
      <div className="p-3 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/**
 * The line under a chart whose window the viewer's plan cut short, naming the plan that reaches further
 * back (from the plan table: planReach.ts).
 */
function PlanCut({ plan, since, further }: { plan: PlanId; since: string; further: { name: string; all: boolean } | null }) {
  return (
    <p className="text-[11px] text-muted">
      The {PLAN_NAME[plan]} plan reaches back to {since}.{further ? ` ${further.name} and up ${further.all ? "see the full history" : "reach further back"}.` : ""}{" "}
      <a href="#pricing" className="text-accent hover:underline">
        See plans
      </a>
    </p>
  );
}

function Locked({ plan, what }: { plan?: PlanId; what: string }) {
  return (
    <div className="h-full min-h-[120px] flex flex-col items-center justify-center text-center gap-2 py-6">
      <span className="text-[10px] font-mono tracking-widest text-muted">LOCKED</span>
      <p className="text-sm text-foreground max-w-[260px]">{what}</p>
      <p className="text-xs text-muted">
        Opens with the <strong className="text-foreground">{PLAN_NAME[plan ?? "trader"]}</strong> plan and up.
      </p>
      <a href="#pricing" className="text-xs text-accent hover:underline">
        See plans
      </a>
    </div>
  );
}

function Body<T>({ res, what, children }: { res: Result<T> | null; what: string; children: (d: T, m: Meta) => ReactNode }) {
  if (!res) return <div className="shimmer h-24" />;
  if (!res.ok) {
    if (res.status === 403 || res.status === 402) return <Locked plan={res.upgrade} what={what} />;
    return <p className="text-xs text-muted py-4">{res.status === 429 ? "Too many requests for now; it will refresh shortly." : res.error}</p>;
  }
  return <>{children(res.data, res.meta)}</>;
}

const Row = ({ k, v, cls = "" }: { k: string; v: ReactNode; cls?: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-[11px] text-muted truncate">{k}</span>
    <span className={`font-mono text-[12px] tabular-nums ${cls}`}>{v}</span>
  </div>
);

// ─── Overview ─────────────────────────────────────────────────────────────────

interface Overview {
  as_of: number;
  price: { usd: number; at: number; change_24h: number | null; volume_24h_usd: number | null } | null;
  spreads: { venue: string; at: number; gap_pct: number; venue_price: number; dex_price: number }[];
  open_interest: { usd: number; change_24h: number | null; markets: number } | null;
  funding_pct_8h: number | null;
  accounts_long_pct: number | null;
  liquidations_24h: { long_usd: number; short_usd: number } | null;
  book_tilt_1: number | null;
  whales_7d: { through: string; supply: number; demand: number; exch_in: number; exch_out: number } | null;
  reserves: { date: string; total_xlm: number; change_7d_xlm: number | null; exchanges: number } | null;
  sdf: { through: string; stayed_30d: number | null; z: number | null } | null;
  big_transfers_24h: { count: number; largest_xlm: number | null };
}

function Cell({ label, value, sub, cls = "" }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }) {
  return (
    <div className="px-3 py-2 border-r border-b border-border-soft min-w-0">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted truncate">{label}</p>
      <p className={`font-mono text-[15px] tabular-nums leading-tight ${cls}`}>{value}</p>
      {sub ? <p className="text-[11px] text-muted font-mono truncate">{sub}</p> : null}
    </div>
  );
}

export function OverviewStrip({ version, fast }: { version: number; fast: boolean }) {
  const res = usePoll<Overview>("overview", {}, fast ? 30_000 : 120_000, version);
  if (!res) return <div className="shimmer h-24 rounded-lg" />;
  if (!res.ok) return <p className="text-sm text-muted">{res.error}</p>;
  const o = res.data;
  const maxGap = o.spreads.reduce((m, s) => (Math.abs(s.gap_pct) > Math.abs(m) ? s.gap_pct : m), 0);
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-soft">
        <span className="text-[10px] font-mono text-muted">XLM / USD · as of {stamp(o.as_of)}</span>
        <DelayBadge meta={res.meta} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 -mr-px -mb-px">
        <Cell label="Price" value={price(o.price?.usd)} sub={o.price ? <span className={tone(o.price.change_24h)}>{frac(o.price.change_24h)} 24h</span> : undefined} />
        <Cell label="CEX vs DEX" value={pct(maxGap)} sub={`${o.spreads.length} venues`} cls={Math.abs(maxGap) >= 1 ? "text-orange" : ""} />
        <Cell label="Open interest" value={usd(o.open_interest?.usd)} sub={o.open_interest ? <span className={tone(o.open_interest.change_24h)}>{frac(o.open_interest.change_24h)} 24h</span> : undefined} />
        <Cell label="Funding 8h" value={o.funding_pct_8h === null ? "n/a" : `${o.funding_pct_8h.toFixed(4)}%`} sub={o.accounts_long_pct === null ? undefined : `${o.accounts_long_pct.toFixed(1)}% accts long`} />
        <Cell
          label="Liquidated 24h"
          value={o.liquidations_24h ? usd(o.liquidations_24h.long_usd + o.liquidations_24h.short_usd) : "n/a"}
          sub={o.liquidations_24h ? `L ${usd(o.liquidations_24h.long_usd)} · S ${usd(o.liquidations_24h.short_usd)}` : undefined}
        />
        <Cell label="Book tilt 1%" value={frac(o.book_tilt_1, 0)} cls={tone(o.book_tilt_1)} sub="bids vs asks" />
        <Cell label="Whales 7d" value={o.whales_7d ? `${xlm(o.whales_7d.supply)} in` : "n/a"} sub={o.whales_7d ? `${xlm(o.whales_7d.demand)} out` : undefined} />
        <Cell label="Exchange reserves" value={o.reserves ? `${xlm(o.reserves.total_xlm)} XLM` : "n/a"} sub={o.reserves?.change_7d_xlm != null ? <span className={tone(o.reserves.change_7d_xlm)}>{xlm(o.reserves.change_7d_xlm)} 7d</span> : undefined} />
        <Cell label="SDF 30d to exch." value={o.sdf?.stayed_30d != null ? `${xlm(o.sdf.stayed_30d)}` : "n/a"} sub={o.sdf?.z != null ? `z ${o.sdf.z >= 0 ? "+" : ""}${o.sdf.z.toFixed(1)} vs year` : undefined} cls={o.sdf?.z != null && o.sdf.z >= 1 ? "text-orange" : ""} />
        <Cell label="Big transfers 24h" value={String(o.big_transfers_24h.count)} sub={o.big_transfers_24h.largest_xlm ? `top ${xlm(o.big_transfers_24h.largest_xlm)} XLM` : "10M+ XLM"} />
        <Cell label="Volume 24h" value={usd(o.price?.volume_24h_usd)} />
        <Cell label="DEX price" value={price(o.spreads[0]?.dex_price)} sub="Stellar DEX" />
      </div>
    </div>
  );
}

// ─── Spreads ──────────────────────────────────────────────────────────────────

interface SpreadRow {
  t: number;
  venue: string;
  gap_pct: number;
  max_abs_gap_pct: number;
  venue_price: number;
  dex_price: number;
}

/**
 * Kraken's gap to the Stellar DEX on 1D, 7D, 30D, 90D or All. The venue table keeps today's poll (a paid
 * plan's day in 5-minute bins, Free's hourly week); a tab that differs asks for its own window in a
 * second poll (spreadRange.ts), and its chart stays dimmed until that window arrives.
 */
export function SpreadsPanel({ version, fine, plans }: { version: number; fine: boolean; plans: PublicPlan[] | null }) {
  const [picked, setPicked] = useState<SpreadRangeKey | null>(null);
  const home = spreadDefault(fine);
  const range = picked ?? home;
  const live = spreadQuery(home, fine);
  const tab = spreadQuery(range, fine);
  const res = usePoll<{ rows: SpreadRow[] }>("spreads", live.params, live.everyMs, version, live.spanMs);
  const own = usePollState<{ rows: SpreadRow[] }>("spreads", tab.params, tab.everyMs, version, tab.spanMs, range !== home);
  const chart = range === home ? { res, current: true } : own;
  const tabs = res?.ok ? (
    <div className="mcard-seg" role="group" aria-label="Time range">
      {SPREAD_RANGES.map((r) => (
        <button key={r.key} type="button" className={range === r.key ? "on" : ""} aria-pressed={range === r.key} onClick={() => setPicked(r.key)}>
          {r.key}
        </button>
      ))}
    </div>
  ) : null;
  return (
    <Panel title="CEX vs Stellar DEX" sub="Kraken and Coinbase against the DEX, % gap" meta={res?.ok ? res.meta : undefined} controls={tabs}>
      <Body res={res} what="Spreads">
        {(d) => {
          const venues = [...new Set(d.rows.map((r) => r.venue))];
          const last = venues.map((v) => d.rows.filter((r) => r.venue === v).at(-1)!);
          return (
            <div className="space-y-3">
              <SpreadChart res={chart.res} current={chart.current} q={tab} plans={plans} />
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 text-[11px] font-mono">
                <span className="text-muted">venue</span>
                <span className="text-muted text-right">price</span>
                <span className="text-muted text-right">gap</span>
                <span className="text-muted text-right">max</span>
                {last.map((r) => (
                  <Frag key={r.venue}>
                    <span>{r.venue}</span>
                    <span className="text-right tabular-nums">{price(r.venue_price)}</span>
                    <span className={`text-right tabular-nums ${tone(r.gap_pct)}`}>{pct(r.gap_pct, 3)}</span>
                    <span className="text-right tabular-nums">{pct(r.max_abs_gap_pct, 2, false)}</span>
                  </Frag>
                ))}
              </div>
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

/** One tab's chart: a shimmer until its window arrives, why it failed, or the gap, dimmed while stale. */
function SpreadChart({ res, current, q, plans }: { res: Result<{ rows: SpreadRow[] }> | null; current: boolean; q: SpreadQuery; plans: PublicPlan[] | null }) {
  if (!res) return <div className="shimmer h-[210px]" />;
  if (!res.ok) return <p className="text-xs text-muted py-4">{res.status === 429 ? "Too many requests for now; it will refresh shortly." : res.error}</p>;
  const kraken = res.data.rows.filter((r) => r.venue === "kraken");
  const cut = current && spreadCut(res.data.rows, q, res.meta);
  return (
    <div className={`space-y-2 transition-opacity ${current ? "" : "opacity-40"}`}>
      {kraken.length > 1 ? (
        <TimeSeriesChart
          points={kraken.map((r) => [r.t / 1000, r.gap_pct])}
          color="var(--accent)"
          label="Kraken vs DEX gap"
          formatValue={(v) => pct(v, 3)}
          formatTick={(v) => pct(v, 2)}
          daily={q.params.resolution === "1d"}
        />
      ) : null}
      {cut ? <PlanCut plan={res.meta.plan} since={dayYear(res.data.rows[0].t)} further={furtherPlan(plans, res.meta.plan, "intraday_days")} /> : null}
    </div>
  );
}

const Frag = ({ children }: { children: ReactNode }) => <>{children}</>;

// ─── Liquidations ─────────────────────────────────────────────────────────────

interface LiqBin {
  t: number;
  long_usd: number;
  short_usd: number;
  markets: number;
}

const BIN_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "1h": 3_600_000, "1d": 86_400_000 };

/**
 * Longs up, shorts down, each bar at its own time across the window. Only bins with liquidations come
 * back (Coinalyze stores no empty ones), so a gap in the chart is time without any.
 */
function MirrorBars({ rows, fromMs, toMs, binMs }: { rows: LiqBin[]; fromMs: number; toMs: number; binMs: number }) {
  const W = 600;
  const H = 140;
  const span = Math.max(binMs, toMs - fromMs);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.long_usd, r.short_usd)));
  const w = Math.max(1, (binMs / span) * W);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[140px]" role="img" aria-label="Longs liquidated above the line, shorts below, over time">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--border)" strokeWidth={1} />
      {rows.map((r) => {
        const x = ((r.t - fromMs) / span) * W;
        const lh = (r.long_usd / max) * (H / 2 - 4);
        const sh = (r.short_usd / max) * (H / 2 - 4);
        return (
          <g key={r.t}>
            <rect x={x} y={H / 2 - lh} width={Math.max(1, w - 0.5)} height={lh} fill="var(--red)" opacity={0.85} />
            <rect x={x} y={H / 2} width={Math.max(1, w - 0.5)} height={sh} fill="var(--green)" opacity={0.85} />
          </g>
        );
      })}
    </svg>
  );
}

export function LiquidationsPanel({ version, fine }: { version: number; fine: boolean }) {
  const res = usePoll<{ rows: LiqBin[] }>("liquidations", { resolution: fine ? "5m" : "1h" }, 60_000, version, (fine ? 1 : 7) * 86_400_000);
  return (
    <Panel title="Liquidations" sub="All 17 XLM perpetuals: longs above, shorts below" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Liquidations">
        {(d, m) => {
          const L = d.rows.reduce((s, r) => s + r.long_usd, 0);
          const S = d.rows.reduce((s, r) => s + r.short_usd, 0);
          const toMs = Date.parse(m.to ?? m.as_of);
          const fromMs = m.from ? Date.parse(m.from) : toMs - 86_400_000;
          const hours = Math.round((toMs - fromMs) / 3_600_000);
          return (
            <div className="space-y-2">
              <MirrorBars rows={d.rows} fromMs={fromMs} toMs={toMs} binMs={BIN_MS[m.resolution ?? "1h"] ?? 3_600_000} />
              <div className="flex justify-between text-[11px] font-mono">
                <span className="text-red">longs {usd(L)}</span>
                <span className="text-muted">{hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`}, {m.resolution ?? "1h"} bins</span>
                <span className="text-green">shorts {usd(S)}</span>
              </div>
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

interface LiqPrint {
  t: number;
  venue: string;
  symbol: string;
  side: string;
  xlm: number;
  price: number;
  usd: number;
}

export function FeedPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: LiqPrint[] }>("liquidation_feed", { limit: 40 }, 15_000, version);
  return (
    <Panel title="Liquidation tape" sub="Each Bybit and OKX liquidation as it happens" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="The live liquidation tape">
        {(d) =>
          d.rows.length ? (
            <ul className="text-[11px] font-mono max-h-[260px] overflow-y-auto divide-y divide-border-soft">
              {d.rows.map((r, i) => (
                <li key={`${r.t}-${i}`} className="flex justify-between gap-2 py-1">
                  <span className="text-muted">{timeUtc(r.t)}</span>
                  <span className="uppercase">{r.venue}</span>
                  <span className={r.side === "long" ? "text-red" : "text-green"}>{r.side}</span>
                  <span className="tabular-nums">{usd(r.usd)}</span>
                  <span className="text-muted tabular-nums">{price(r.price)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No liquidations in the last two days.</p>
          )
        }
      </Body>
    </Panel>
  );
}

// ─── Leverage ─────────────────────────────────────────────────────────────────

interface LevRow {
  t: number;
  oi_usd: number | null;
  markets: number | null;
  funding_pct: number | null;
  long_pct: number | null;
}

export function LeveragePanel({ version }: { version: number }) {
  const res = usePoll<{ rows: LevRow[] }>("leverage", { resolution: "1h" }, 120_000, version, 7 * 86_400_000);
  return (
    <Panel title="Leverage" sub="Open interest, funding and accounts long" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Open interest, funding and positioning">
        {(d) => {
          const oi = d.rows.filter((r) => r.oi_usd !== null);
          const last = d.rows.at(-1);
          return (
            <div className="space-y-2">
              {oi.length > 1 ? <TimeSeriesChart points={oi.map((r) => [r.t / 1000, r.oi_usd as number])} color="var(--purple)" label="Open interest" formatValue={(v) => usd(v)} formatTick={(v) => usd(v, 0)} /> : null}
              <Row k="Open interest" v={usd(last?.oi_usd)} />
              <Row k="Funding, 8h" v={last?.funding_pct == null ? "n/a" : `${last.funding_pct.toFixed(4)}%`} cls={tone(last?.funding_pct)} />
              <Row k="Accounts long" v={last?.long_pct == null ? "n/a" : `${last.long_pct.toFixed(1)}%`} />
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

// ─── Order books ──────────────────────────────────────────────────────────────

interface BookRow {
  t: number;
  venue: string;
  quote: string;
  mid: number;
  bid_1: number;
  ask_1: number;
  bid_2: number;
  ask_2: number;
  tilt_1: number | null;
}

export function BooksPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: BookRow[] }>("books", { resolution: "5m" }, 60_000, version, 30 * 60_000);
  return (
    <Panel title="Order books" sub="Depth within 1% and 2% of the mid" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Order book depth">
        {(d) => {
          const latest = new Map<string, BookRow>();
          for (const r of d.rows) latest.set(r.venue, r);
          const rows = [...latest.values()];
          return (
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-[11px] font-mono">
              <span className="text-muted">venue</span>
              <span className="text-muted text-right">bids 1%</span>
              <span className="text-muted text-right">asks 1%</span>
              <span className="text-muted text-right">tilt</span>
              {rows.map((r) => (
                <Frag key={r.venue}>
                  <span>
                    {r.venue}
                    {r.quote !== "USD" && r.quote !== "USDT" ? <span className="text-muted"> {r.quote}</span> : null}
                  </span>
                  <span className="text-right tabular-nums">{r.quote === "KRW" ? xlm(r.bid_1) : usd(r.bid_1)}</span>
                  <span className="text-right tabular-nums">{r.quote === "KRW" ? xlm(r.ask_1) : usd(r.ask_1)}</span>
                  <span className={`text-right tabular-nums ${tone(r.tilt_1)}`}>{frac(r.tilt_1, 0)}</span>
                </Frag>
              ))}
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

// ─── Whale flows ──────────────────────────────────────────────────────────────

interface Transfer {
  op_id: string;
  tx_hash: string | null;
  closed_at: string;
  xlm: number;
  flow_class: string;
  from_account: string;
  from_class: string;
  from_name: string | null;
  from_exchange: string | null;
  to_account: string;
  to_class: string;
  to_name: string | null;
  to_exchange: string | null;
}

/** How a wallet's class reads. Behavior-based classes are inferences, and say so. */
const CLASS_LABEL: Record<string, string> = {
  exchange: "an exchange",
  exchange_ops: "an exchange wallet",
  sdf: "SDF",
  sdf_linked: "SDF",
  custodian: "a custodian",
  trading_hub: "a trading hub (inferred)",
  coinbase_cluster: "the Coinbase cluster (inferred)",
  whale_active: "an active whale (inferred)",
  whale_dormant: "a dormant whale (inferred)",
  burn: "a burn address",
};

const who = (name: string | null, cls: string, exchange: string | null, account: string) => exchange ?? name ?? CLASS_LABEL[cls] ?? short(account);

/**
 * The newest transfers, polled, and older pages as the list scrolls, back as far as the plan reaches
 * (transferTape.ts decides which pages to ask for and how they join). The list is the liquidation tape's,
 * with a header per UTC day that stays pinned while its rows scroll.
 */
export function TransfersPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: Transfer[] }>("transfers", { limit: HEAD_ROWS }, 120_000, version, HEAD_SPAN_MS);
  const [tape, setTape] = useState<Tape<Transfer>>(emptyTape);
  // Each new head answer is folded in once, during render (not in an effect). A failed poll keeps the list.
  const [merged, setMerged] = useState<Result<{ rows: Transfer[] }> | null>(null);
  if (res?.ok && res !== merged) {
    setMerged(res);
    setTape(withHead(tape, res.data.rows, res.meta));
  }
  const shown = res && !res.ok && merged ? merged : res;

  const busy = useRef(false);
  // The footer button, and whether it had focus when the last page landed: when that page ends the list,
  // the button goes, and focus moves to the list instead of falling to the page.
  const action = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  const loadOlder = useCallback(async () => {
    if (busy.current || tape.status === "end") return;
    busy.current = true;
    const gen = tape.gen;
    setTape((t) => asking(t, gen));
    let next: (t: Tape<Transfer>) => Tape<Transfer>;
    try {
      const r = await data<{ rows: Transfer[] }>("transfers", olderQuery(tape));
      next = r.ok ? (t) => withOlder(t, gen, r.data.rows, r.meta) : (t) => failed(t, gen, r.status === 429 ? "Too many requests for now." : r.error);
    } catch (e) {
      next = (t) => failed(t, gen, e instanceof Error ? e.message : UNREACHABLE);
    }
    busy.current = false;
    refocus.current = action.current !== null && document.activeElement === action.current;
    setTape(next);
  }, [tape]);

  // The footer coming within 200px of the list's bottom asks for the next page, as does a list too short to scroll.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!scroller || !sentinel || tape.status !== "more" || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { root: scroller, rootMargin: "0px 0px 200px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scroller, sentinel, tape.status, loadOlder]);
  useEffect(() => {
    if (tape.status !== "end" || !refocus.current) return;
    refocus.current = false;
    scroller?.focus({ preventScroll: true });
  }, [tape.status, scroller]);

  const groups = dayGroups(tape.rows);
  const year = groups[0]?.day.slice(0, 4);
  return (
    <Panel title="Institutional and whale flows" sub="Labeled transfers, newest first" meta={shown?.ok ? shown.meta : undefined}>
      <Body res={shown} what="Whale transfers">
        {() => (
          <div
            ref={setScroller}
            tabIndex={0}
            role="region"
            aria-label="Transfers, newest first. Scroll for older ones."
            aria-busy={tape.status === "loading"}
            className="text-[11px] font-mono max-h-[300px] overflow-y-auto rounded outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {groups.map((g) => (
              <section key={g.day}>
                <h4 className="sticky top-0 z-10 flex justify-between bg-card border-b border-border-soft py-1 text-[10px] uppercase tracking-[0.14em] text-muted">
                  <span>{g.day.slice(0, 4) === year ? day(g.day) : dayYear(g.day)}</span>
                  <span>UTC</span>
                </h4>
                <ul className="divide-y divide-border-soft">
                  {g.rows.map((t) => (
                    <li key={t.op_id} className="py-1.5 space-y-0.5">
                      <div className="flex justify-between gap-2">
                        <span className="text-muted">{timeUtc(t.closed_at)}</span>
                        <span className={`tabular-nums ${t.flow_class === "to_exchange" ? "text-red" : t.flow_class === "from_exchange" ? "text-green" : ""}`}>{xlm(t.xlm)} XLM</span>
                      </div>
                      <div className="truncate">
                        {who(t.from_name, t.from_class, t.from_exchange, t.from_account)} <span className="text-muted">to</span> {who(t.to_name, t.to_class, t.to_exchange, t.to_account)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <div ref={setSentinel} aria-live="polite" className="py-2 text-center text-muted">
              <TapeFooter tape={tape} onOlder={() => void loadOlder()} actionRef={action} />
            </div>
          </div>
        )}
      </Body>
    </Panel>
  );
}

/**
 * The end of the transfers list: one button while there is more (to load, loading, or to try again, after
 * the error), so it keeps keyboard focus as it changes; then where the history ends.
 */
function TapeFooter({ tape, onOlder, actionRef }: { tape: Tape<Transfer>; onOlder: () => void; actionRef: RefObject<HTMLButtonElement | null> }) {
  const link = "text-accent hover:underline";
  const action = footerAction(tape);
  if (action) {
    return (
      <>
        {action.error ? <span>{action.error} </span> : null}
        <button
          ref={actionRef}
          type="button"
          aria-disabled={action.busy || undefined}
          onClick={action.busy ? undefined : onOlder}
          className={action.busy ? "cursor-default" : link}
        >
          {action.label}
        </button>
      </>
    );
  }
  const end = tape.end;
  const plan = end ? (PLAN_NAME[end.plan as PlanId] ?? end.plan) : "";
  const plans = (
    <>
      {" "}
      <a href="#pricing" className={link}>
        See plans
      </a>
    </>
  );
  if (tape.rows.length) {
    return end?.cut ? (
      <>
        The {plan} plan reaches back to {dayYear(end.from)}.{plans}
      </>
    ) : (
      <span>Start of the record.</span>
    );
  }
  return end?.cut ? (
    <>
      No transfers of this size since {dayYear(end.from)}, as far back as the {plan} plan reaches.{plans}
    </>
  ) : (
    <span>No transfers of this size on record.</span>
  );
}

interface FlowDay {
  day: string;
  exch_in: number;
  exch_out: number;
  supply: number | null;
  demand_pit: number | null;
}

export function FlowsPanel({ version }: { version: number }) {
  const res = usePoll<{ flows: FlowDay[]; reserves: { date: string; exchange: string; total_balance: number }[] }>("flows", {}, 600_000, version);
  return (
    <Panel title="Exchange flows by day" sub="1M+ XLM transfers in and out of exchanges" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Daily flows">
        {(d) => {
          const days = d.flows.slice(-10).reverse();
          return (
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono">
              <span className="text-muted">day</span>
              <span className="text-muted text-right">in</span>
              <span className="text-muted text-right">out</span>
              <span className="text-muted text-right">one-way in</span>
              {days.map((f) => (
                <Frag key={f.day}>
                  <span>{day(f.day)}</span>
                  <span className="text-right tabular-nums">{xlm(f.exch_in)}</span>
                  <span className="text-right tabular-nums">{xlm(f.exch_out)}</span>
                  <span className="text-right tabular-nums">{xlm(f.supply)}</span>
                </Frag>
              ))}
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

interface SdfDay {
  day: string;
  stayed: number;
  pace30: number | null;
  z: number | null;
}

/**
 * SDF's 30-day pace on 90D, 1Y, 3Y or All. The whole history comes in one answer and the tabs filter
 * it here, like the vault liquidity card. A plan with less daily history (Trader: a year) gets what it
 * has, and a line saying so on the ranges it can't fill.
 */
export function SdfPanel({ version, plans }: { version: number; plans: PublicPlan[] | null }) {
  const [range, setRange] = useState<SdfRangeKey>("1Y");
  const res = usePoll<{ rows: SdfDay[]; latest: SdfDay | null }>("sdf", { from: SDF_ALL_FROM }, 600_000, version);
  const days = SDF_RANGES.find((r) => r.key === range)!.days;
  const tabs = res?.ok ? (
    <div className="mcard-seg" role="group" aria-label="Time range">
      {SDF_RANGES.map((r) => (
        <button key={r.key} type="button" className={range === r.key ? "on" : ""} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
          {r.key}
        </button>
      ))}
    </div>
  ) : null;
  return (
    <Panel title="SDF supply" sub="What SDF sent to exchanges and left there, 30 days" meta={res?.ok ? res.meta : undefined} controls={tabs}>
      <Body res={res} what="SDF's supply to exchanges">
        {(d, m) => {
          const shown = inRange(d.rows, days);
          const pts = shown.filter((r) => r.pace30 !== null).map((r) => [Date.parse(`${r.day}T00:00:00Z`) / 1000, r.pace30 as number] as [number, number]);
          const total = shown.reduce((s, r) => s + r.stayed, 0);
          return (
            <div className="space-y-2">
              {pts.length > 1 ? <TimeSeriesChart points={pts} color="var(--orange)" label="SDF 30-day supply to exchanges" formatValue={(v) => `${xlm(v)} XLM`} formatTick={(v) => xlm(v)} daily /> : null}
              {cutByPlan(d.rows, days, m) ? <PlanCut plan={m.plan} since={dayYear(d.rows[0].day)} further={furtherPlan(plans, m.plan, "daily_days")} /> : null}
              <Row k="30 days to exchanges" v={`${xlm(d.latest?.pace30)} XLM`} />
              <Row k="Against its past year" v={d.latest?.z == null ? "n/a" : `z ${d.latest.z >= 0 ? "+" : ""}${d.latest.z.toFixed(2)}`} cls={d.latest?.z != null && d.latest.z >= 1 ? "text-orange" : ""} />
              {shown.length ? <Row k={`To exchanges since ${dayYear(shown[0].day)}`} v={`${xlm(total)} XLM`} /> : null}
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

interface Alert {
  id: string;
  kind: string;
  at: number;
  title: string;
  text: string;
}

const KIND: Record<string, string> = {
  exchange_deposit: "text-red",
  sdf_deposit: "text-orange",
  exchange_withdrawal: "text-green",
  liquidation_burst: "text-purple",
  spread_spike: "text-yellow",
};

export function AlertsPanel({ version }: { version: number }) {
  const res = usePoll<{ alerts: Alert[] }>("alerts", { limit: 50 }, 30_000, version);
  return (
    <Panel title="Alerts" sub="Deposits, withdrawals, SDF, liquidation bursts, spread spikes" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Alerts">
        {(d) =>
          d.alerts.length ? (
            <ul className="text-[12px] max-h-[320px] overflow-y-auto divide-y divide-border-soft">
              {d.alerts.map((a) => (
                <li key={a.id} className="py-1.5">
                  <div className="flex justify-between gap-2 font-mono text-[11px]">
                    <span className={KIND[a.kind] ?? "text-muted"}>{a.kind.replace(/_/g, " ")}</span>
                    <span className="text-muted">{stamp(a.at)}</span>
                  </div>
                  <p className="text-foreground leading-snug">{a.title}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No alerts in this window.</p>
          )
        }
      </Body>
    </Panel>
  );
}
