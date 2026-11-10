"use client";

/**
 * The vault's live numbers on the Integrate page, read from the public API
 * (GET /api/v1/vault): the same answer an integrator's code gets.
 */

import { useEffect, useState } from "react";
import { apiBase } from "../../lib/api";
import { fmtCompact, fmtMoney, fmtUsd } from "../../lib/price";

interface VaultPool {
  asset: string;
  hitz: string;
  reserve: string;
  fee_pct: number;
  hitz_usd?: number;
}

interface VaultInfo {
  ledger: number;
  hitz: { event_horizon: string; total_mass: string };
  pools: VaultPool[];
  usd: { hitz: number | null; tvl: number | null; pool_spread_pct?: number; as_of: string } | null;
}

const num = (s: string) => Number(s);

export default function LiveVault() {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase()}/api/v1/vault`, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as VaultInfo;
        if (!cancelled) {
          setInfo(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!info) {
    return (
      <div className="bg-card border border-border rounded-2xl p-5 text-sm text-muted">
        {error ? `Couldn't load the vault right now (${error}).` : "Reading the vault…"}
      </div>
    );
  }

  const spread = info.usd?.pool_spread_pct;
  const pools = info.pools;
  const cheapest = pools.filter((p) => p.hitz_usd).sort((a, b) => (a.hitz_usd ?? 0) - (b.hitz_usd ?? 0))[0];
  const dearest = pools.filter((p) => p.hitz_usd).sort((a, b) => (b.hitz_usd ?? 0) - (a.hitz_usd ?? 0))[0];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="HITZ price" value={info.usd?.hitz ? fmtUsd(info.usd.hitz) : "n/a"} sub="liquidity-weighted" />
        <Stat label="Liquidity" value={info.usd?.tvl ? fmtMoney(info.usd.tvl) : "n/a"} sub={`${pools.length} pools`} />
        <Stat label="Event Horizon" value={`${fmtCompact(num(info.hitz.event_horizon))} HITZ`} sub="most an account can hold freely" />
        {pools.map((p) => (
          <Stat
            key={p.asset}
            label={`${p.asset} pool`}
            value={`${fmtCompact(num(p.reserve))} ${p.asset}`}
            sub={`${fmtCompact(num(p.hitz))} HITZ · fee ${p.fee_pct.toFixed(2)}%`}
          />
        ))}
        {spread !== undefined && cheapest && dearest && cheapest !== dearest && (
          <Stat
            label="Price gap"
            value={`${spread.toFixed(2)}%`}
            sub={`HITZ via ${dearest.asset} vs via ${cheapest.asset}`}
            highlight={spread > 2}
          />
        )}
      </div>
      <p className="text-[11px] text-muted-soft font-mono">
        Ledger {info.ledger.toLocaleString("en-US")} · GET /api/v1/vault · refreshes every 30s
      </p>
    </div>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className={`bg-card border rounded-2xl px-4 py-3 ${highlight ? "border-orange/40" : "border-border"}`}>
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</p>
      <p className={`font-mono text-lg mt-1 tabular-nums ${highlight ? "text-orange" : "text-foreground"}`}>{value}</p>
      <p className="text-[11px] text-muted mt-0.5">{sub}</p>
    </div>
  );
}
