"use client";

import { useEffect, useState, useCallback } from "react";
import { getTotalMass, getSafetyLimit, formatHitz } from "../lib/stellar";

interface Stats {
  totalMass: bigint;
  safetyLimit: bigint;
}

export default function StatusBar() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [totalMass, safetyLimit] = await Promise.all([
        getTotalMass(),
        getSafetyLimit(),
      ]);
      setStats({ totalMass, safetyLimit });
    } catch (e) {
      console.error("Failed to fetch stats:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="space-y-5">
      {/* Live badge */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted tracking-widest uppercase font-medium">
          Protocol State
        </p>
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-green pulse-dot" />
          <span className="text-muted text-xs">Live</span>
          <button
            onClick={refresh}
            className="text-muted hover:text-foreground transition-colors cursor-pointer text-xs ml-1"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Stats grid — always 2 columns, no wrapping */}
      <div className="grid grid-cols-2 gap-px bg-border rounded-2xl overflow-hidden">
        <StatCell
          symbol="S"
          label="Total Mass"
          value={loading ? null : stats ? formatHitz(stats.totalMass) : "–"}
          unit="HITZ"
          color="text-purple"
        />
        <StatCell
          symbol="L"
          label="Event Horizon"
          value={loading ? null : stats ? formatHitz(stats.safetyLimit) : "–"}
          unit="HITZ"
          color="text-accent"
        />
      </div>

      {/* Zero-state hint */}
      {!loading && stats && stats.totalMass === 0n && (
        <p className="text-xs text-muted leading-relaxed animate-fade-in">
          No pools registered. L = 0, so every account is vaulted.
          Register a pool in <span className="text-orange">Scenario 6</span> to raise L.
        </p>
      )}
    </div>
  );
}

function StatCell({
  symbol,
  label,
  value,
  unit,
  color,
}: {
  symbol: string;
  label: string;
  value: string | null;
  unit: string;
  color: string;
}) {
  return (
    <div className="bg-card px-5 py-4 space-y-1">
      <div className="flex items-center gap-1.5">
        <span className={`font-mono text-xs font-semibold ${color}`}>{symbol}</span>
        <span className="text-muted text-xs">{label}</span>
      </div>
      {value === null ? (
        <div className="h-7 w-28 rounded bg-border shimmer" />
      ) : (
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className={`font-mono font-semibold text-lg leading-none ${color} truncate`}>
            {value}
          </span>
          <span className="text-muted text-xs shrink-0">{unit}</span>
        </div>
      )}
    </div>
  );
}
