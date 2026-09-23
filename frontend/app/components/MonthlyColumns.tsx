"use client";

/**
 * MonthlyColumns — a single-series column chart for small monthly counts.
 *
 * Every column carries its value as a direct label (there are only ever a
 * handful of months, and the values are small integers — an axis would add
 * nothing). Columns are ≤24px with a rounded data end and a square base; each
 * one is focusable and shows a tooltip on hover or focus. The current month
 * is drawn lighter and marked MTD because it is still accumulating.
 */

import { useEffect, useRef, useState } from "react";

export interface MonthColumn {
  /** `YYYY-MM`. */
  month: string;
  value: number;
  /** Extra tooltip lines, e.g. "11 new · 0 returning". */
  detail: string;
}

const H = 150;
const PAD = { top: 22, bottom: 24, x: 8 };
const BAR_MAX = 24;
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthYearFmt = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const toDate = (m: string) => new Date(`${m}-01T00:00:00Z`);

/** Rect with only the top corners rounded (the data end). */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function MonthlyColumns({
  columns,
  color,
  unit,
  currentMonth,
}: {
  columns: MonthColumn[];
  color: string;
  /** Singular noun for the value, e.g. "active account". */
  unit: string;
  currentMonth: string;
}) {
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

  const max = Math.max(1, ...columns.map((c) => c.value));
  const slot = columns.length ? (width - 2 * PAD.x) / columns.length : 0;
  const barW = Math.min(BAR_MAX, Math.max(6, slot * 0.5));
  const innerH = H - PAD.top - PAD.bottom;
  const base = PAD.top + innerH;
  const plural = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const hover = active !== null ? columns[active] : null;

  return (
    <div ref={wrapRef} className="mcol" style={{ ["--series" as string]: color }}>
      {width > 0 && (
        <svg width={width} height={H} role="list" aria-label={`${unit}s per month`}>
          <line className="base" x1={PAD.x} x2={width - PAD.x} y1={base} y2={base} />
          {columns.map((c, i) => {
            const cx = PAD.x + slot * (i + 0.5);
            const h = (c.value / max) * innerH;
            const partial = c.month === currentMonth;
            return (
              <g
                key={c.month}
                role="listitem"
                tabIndex={0}
                aria-label={`${monthYearFmt.format(toDate(c.month))}${partial ? " (month to date)" : ""}: ${plural(c.value)}. ${c.detail}`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className={`col ${partial ? "partial" : ""} ${active === i ? "on" : ""}`}
              >
                {/* Hit target: the whole slot, so thin or zero columns are still easy to hover. */}
                <rect className="hit" x={cx - slot / 2} y={PAD.top - 18} width={slot} height={innerH + 18} />
                {h > 0 && <path className="bar" d={columnPath(cx - barW / 2, base - h, barW, h, 4)} />}
                <text className="val" x={cx} y={base - h - 6} textAnchor="middle">
                  {c.value}
                </text>
                <text className="lbl" x={cx} y={H - 6} textAnchor="middle">
                  {monthFmt.format(toDate(c.month))}
                  {partial ? " · MTD" : ""}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && active !== null && (
        <div className="ts-tip" style={{ left: Math.min(Math.max(PAD.x + slot * (active + 0.5), 80), width - 80) }}>
          <b>{plural(hover.value)}</b>
          <span>
            {monthYearFmt.format(toDate(hover.month))}
            {hover.month === currentMonth ? " · to date" : ""} — {hover.detail}
          </span>
        </div>
      )}
    </div>
  );
}
