"use client";

/**
 * TimeSeriesChart — the single-series chart used by the Monitor tab's market
 * cards (HITZ/USD price, pool liquidity), plus DailyTable, its accessible
 * table twin.
 *
 * A 2px line with a faint wash, hairline grid, right-hand value axis, and a
 * crosshair that snaps to the nearest point (pointer, or ←/→ keys; Shift
 * jumps a day of hourly points). Pixel geometry is computed from the measured
 * width so strokes stay crisp at every size.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** `Sep 21` (UTC). */
export const fmtDate = (unixSeconds: number) => dateFmt.format(unixSeconds * 1000);
/** `Sep 21, 14:00 UTC`. */
export const fmtDateTime = (unixSeconds: number) => `${dateTimeFmt.format(unixSeconds * 1000)} UTC`;

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

export function TimeSeriesChart({
  points,
  color,
  formatValue,
  formatTick,
  label,
}: {
  /** [unix seconds, value], ascending. */
  points: [number, number][];
  /** CSS color for the line, wash and markers, e.g. `var(--purple)`. */
  color: string;
  /** Tooltip and screen-reader value format. */
  formatValue: (v: number) => string;
  /** Axis tick format (shorter than `formatValue`). */
  formatTick: (v: number) => string;
  /** What the series is, for the screen-reader summary ("HITZ price"). */
  label: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const washId = `ts-wash-${useId().replace(/:/g, "")}`;

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
      ? `${label} from ${fmtDate(points[0][0])} to ${fmtDate(points[points.length - 1][0])}: ` +
        `${formatValue(points[0][1])} to ${formatValue(points[points.length - 1][1])}. Use arrow keys to read hourly values.`
      : "Not enough data for this range.";

  return (
    <div
      ref={wrapRef}
      className="ts-chart"
      style={{ ["--series" as string]: color }}
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
            <linearGradient id={washId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.12" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.yTicks.map((v) => (
            <g key={v}>
              <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="tick" x={width - PAD.right + 8} y={geo.y(v)} dominantBaseline="middle">
                {formatTick(v)}
              </text>
            </g>
          ))}
          {geo.xTicks.map((t) => (
            <text key={t} className="tick" x={geo.x(t)} y={CHART_H - 6} textAnchor="middle">
              {points.length > 48 || geo.t1 - geo.t0 > 2 * 86_400 ? fmtDate(t) : dateTimeFmt.format(t * 1000)}
            </text>
          ))}
          <path d={geo.area} fill={`url(#${washId})`} />
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
        <div className="mcard-empty" style={{ height: CHART_H }}>
          {points.length < 2 ? "Not enough data for this range yet." : ""}
        </div>
      )}
      {geo && hover && (
        <div className="ts-tip" style={{ left: Math.min(Math.max(geo.x(hover[0]), 70), width - PAD.right - 70) }}>
          <b>{formatValue(hover[1])}</b>
          <span>{fmtDateTime(hover[0])}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The chart's accessible twin: one row per UTC day (the day's last point),
 * newest first, with day-over-day change.
 */
export function DailyTable({
  points,
  caption,
  valueHeader,
  formatValue,
  formatChange,
}: {
  points: [number, number][];
  caption: string;
  valueHeader: string;
  formatValue: (v: number) => string;
  formatChange: (ratio: number) => string;
}) {
  const rows = useMemo(() => {
    const byDay = new Map<number, [number, number]>();
    for (const p of points) byDay.set(Math.floor(p[0] / 86_400), p);
    return [...byDay.values()].reverse();
  }, [points]);
  return (
    <div className="mcard-table">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date (UTC)</th>
            <th scope="col">{valueHeader}</th>
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
                <td>{formatValue(v)}</td>
                <td className={d === null ? "" : d >= 0 ? "up" : "down"}>{d === null ? "—" : formatChange(d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
