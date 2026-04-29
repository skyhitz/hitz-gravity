"use client";

/**
 * MonitorStatCards — the two-up stat grid at the top of the Monitor tab.
 *
 * Total Mass (S) and Event Horizon (L) live at the core of the protocol.
 * These cards give them room to breathe: a big number, a contextual subline,
 * and a decorative sparkline for motion. The sparkline is purely ornamental
 * — the chain doesn't expose historical series over RPC, so we don't pretend
 * to chart them. It's a visual heartbeat, not data.
 */

import { useProtocol } from "../contexts/ProtocolContext";
import { fmtFixed } from "../lib/format";

// A pleasant, slightly irregular wave — long enough to avoid an obvious
// repeat, short enough to not bloat the DOM.
const SPARK_PATTERN = [
  0.45, 0.55, 0.5, 0.6, 0.52, 0.65, 0.58, 0.7, 0.62, 0.78, 0.72, 0.82, 0.8, 0.88,
  0.85, 0.92, 0.9, 0.95, 0.93, 1.0,
];

export default function MonitorStatCards() {
  const { totalMass, safetyLimit } = useProtocol();

  return (
    <div className="monitor-grid">
      <StatCard
        title="Total Mass (S)"
        value={fmtFixed(totalMass, 2)}
        unit="HITZ"
        sub="Sum of balances in regular accounts and audited pools. Grows only when tokens are sacrificed."
        dotColor="var(--purple)"
      />
      <StatCard
        title="Event Horizon (L)"
        value={fmtFixed(safetyLimit, 4)}
        unit="HITZ"
        sub="Per-account cap. Balances beyond this are Vaulted, transfers out blocked until L rises."
        dotColor="var(--accent)"
      />
    </div>
  );
}

function StatCard({
  title,
  value,
  unit,
  sub,
  dotColor,
}: {
  title: string;
  value: string;
  unit: string;
  sub: string;
  dotColor: string;
}) {
  return (
    <div className="stat-card">
      <div className="ttl" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: dotColor,
            display: "inline-block",
          }}
        />
        {title}
      </div>
      <div className="big">
        {value}
        <span
          style={{
            fontSize: 12,
            color: "var(--muted)",
            marginLeft: 6,
            fontWeight: 400,
          }}
        >
          {unit}
        </span>
      </div>
      <div className="sub">{sub}</div>
      <Sparkline barClass={dotColor === "var(--purple)" ? "purple" : ""} />
    </div>
  );
}

function Sparkline({ barClass }: { barClass: string }) {
  return (
    <div className="sparkline" aria-hidden>
      {SPARK_PATTERN.map((v, i) => (
        <div
          key={i}
          className={`b ${barClass} ${i === SPARK_PATTERN.length - 1 ? "last" : ""}`}
          style={{ height: `${v * 100}%` }}
        />
      ))}
    </div>
  );
}
