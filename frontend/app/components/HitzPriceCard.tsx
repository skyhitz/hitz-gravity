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

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPriceHistory, fmtPct, fmtUsd, type PriceHistory } from "../lib/price";

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

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const fmtDate = (hour: number) => dateFmt.format(hour * 1000);
// Axis ticks are round numbers — three significant digits is enough and
// keeps the right-hand gutter narrow.
const tickFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3,
});
const fmtDateTime = (hour: number) => `${dateTimeFmt.format(hour * 1000)} UTC`;

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
    <div className="price-card">
      <div className="price-head">
        <div className="ttl-wrap">
          <span className="dot" aria-hidden />
          <h4>HITZ / USD</h4>
          <span className={`count ${state.status === "ready" ? "" : "idle"}`}>{badge}</span>
        </div>
        <div className="price-controls">
          <div className="price-seg" role="group" aria-label="Time range">
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
            className="price-view-toggle"
            aria-pressed={view === "table"}
            onClick={() => setView((v) => (v === "chart" ? "table" : "chart"))}
          >
            {view === "chart" ? "Table" : "Chart"}
          </button>
        </div>
      </div>

      {!history ? (
        <div className="price-empty">
          {state.status === "loading" && "Loading price history…"}
          {state.status === "indexing" && "Price history is still being indexed. Check back in a few minutes."}
          {state.status === "error" && `Couldn't load price history: ${state.error}`}
        </div>
      ) : (
        <>
          <div className="price-hero">
            <div className="price-now">{latest ? fmtUsd(latest[1]) : "—"}</div>
            {change !== null && (
              <div className={`price-delta ${change >= 0 ? "up" : "down"}`}>
                {fmtPct(change)} <span>{range === "All" ? "since launch" : range}</span>
              </div>
            )}
          </div>

          {view === "chart" ? (
            <PriceChart points={visible} />
          ) : (
            <PriceTable points={visible} />
          )}

          {stats && latest && (
            <div className="price-stats">
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

          <p className="price-foot">
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

// ─── Chart ───────────────────────────────────────────────────────────────────

const CHART_H = 210;
const PAD = { top: 12, right: 72, bottom: 26, left: 2 };

function niceTicks(lo: number, hi: number, count: number): number[] {
  const step = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step) ?? step;
  const out: number[] = [];
  for (let v = Math.ceil(lo / nice) * nice; v <= hi + nice * 1e-9; v += nice) out.push(v);
  return out;
}

function PriceChart({ points }: { points: [number, number][] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2 || width <= PAD.left + PAD.right) return null;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, v] of points) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const pad = (hi - lo || hi * 0.05) * 0.08;
    lo -= pad;
    hi += pad;
    const innerW = width - PAD.left - PAD.right;
    const innerH = CHART_H - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * innerW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * innerH;
    const line = points.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const bottom = PAD.top + innerH;
    const area = `${line}L${x(t1).toFixed(1)},${bottom}L${x(t0).toFixed(1)},${bottom}Z`;
    const yTicks = niceTicks(lo, hi, 3);
    const xTicks = Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * (i + 0.5)) / 4);
    return { x, y, line, area, bottom, yTicks, xTicks, t0, t1, innerW };
  }, [points, width]);

  const nearest = (clientX: number) => {
    if (!geo || !wrapRef.current) return null;
    const rect = wrapRef.current.getBoundingClientRect();
    const t = geo.t0 + ((clientX - rect.left - PAD.left) / geo.innerW) * (geo.t1 - geo.t0);
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid][0] < t) lo = mid;
      else hi = mid;
    }
    return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? lo : hi;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!points.length) return;
    const last = points.length - 1;
    const step = e.shiftKey ? 24 : 1;
    if (e.key === "ArrowLeft") setActive((a) => Math.max(0, (a ?? last) - step));
    else if (e.key === "ArrowRight") setActive((a) => Math.min(last, (a ?? last) + step));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Escape") setActive(null);
    else return;
    e.preventDefault();
  };

  const idx = active !== null && active < points.length ? active : null;
  const hover = idx !== null ? points[idx] : null;
  const endPoint = points.at(-1);
  const summary =
    points.length > 1
      ? `HITZ price from ${fmtDate(points[0][0])} to ${fmtDate(points[points.length - 1][0])}: ` +
        `${fmtUsd(points[0][1])} to ${fmtUsd(points[points.length - 1][1])}. Use arrow keys to read hourly values.`
      : "Not enough data for this range.";

  return (
    <div
      ref={wrapRef}
      className="price-chart"
      tabIndex={0}
      role="img"
      aria-label={summary}
      onPointerMove={(e) => setActive(nearest(e.clientX))}
      onPointerLeave={() => setActive(null)}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
    >
      {geo ? (
        <svg width={width} height={CHART_H} aria-hidden>
          <defs>
            <linearGradient id="price-wash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--purple)" stopOpacity="0.12" />
              <stop offset="100%" stopColor="var(--purple)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="tick" x={width - PAD.right + 8} y={geo.y(v)} dominantBaseline="middle">
                {tickFmt.format(v)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t) => (
            <text key={t} className="tick" x={geo.x(t)} y={CHART_H - 6} textAnchor="middle">
              {points.length > 48 || geo.t1 - geo.t0 > 2 * 86_400 ? fmtDate(t) : dateTimeFmt.format(t * 1000)}
            </text>
          ))}
          <path d={geo.area} fill="url(#price-wash)" />
          <path className="line" d={geo.line} />
          {endPoint && !hover && <circle className="end" cx={geo.x(endPoint[0])} cy={geo.y(endPoint[1])} r={4} />}
          {hover && (
            <>
              <line className="cross" x1={geo.x(hover[0])} x2={geo.x(hover[0])} y1={PAD.top} y2={geo.bottom} />
              <circle className="end" cx={geo.x(hover[0])} cy={geo.y(hover[1])} r={4} />
            </>
          )}
        </svg>
      ) : (
        <div className="price-empty" style={{ height: CHART_H }}>
          {points.length < 2 ? "Not enough data for this range yet." : ""}
        </div>
      )}
      {geo && hover && (
        <div
          className="price-tip"
          style={{
            left: Math.min(Math.max(geo.x(hover[0]), 70), width - PAD.right - 70),
          }}
        >
          <b>{fmtUsd(hover[1])}</b>
          <span>{fmtDateTime(hover[0])}</span>
        </div>
      )}
    </div>
  );
}

// ─── Table view (the chart's accessible twin) ────────────────────────────────

function PriceTable({ points }: { points: [number, number][] }) {
  // Daily closes: the last hourly point of each UTC day, newest first.
  const rows = useMemo(() => {
    const byDay = new Map<number, [number, number]>();
    for (const p of points) byDay.set(Math.floor(p[0] / 86_400), p);
    return [...byDay.values()].reverse();
  }, [points]);
  return (
    <div className="price-table">
      <table>
        <caption>HITZ/USD daily close (last hourly price of each UTC day)</caption>
        <thead>
          <tr>
            <th scope="col">Date (UTC)</th>
            <th scope="col">Close</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([h, v], i) => {
            const prev = rows[i + 1];
            const d = prev ? v / prev[1] - 1 : null;
            return (
              <tr key={h}>
                <td>{fmtDate(h)}</td>
                <td>{fmtUsd(v)}</td>
                <td className={d === null ? "" : d >= 0 ? "up" : "down"}>{d === null ? "—" : fmtPct(d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
