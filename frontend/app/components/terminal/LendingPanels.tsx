"use client";
/**
 * The HITZ Terminal's on-chain lending panels: the Stellar DeFi map, Blend's lending and liquidation
 * ladder, its liquidation auctions, and the borrower map (Institutional). The data is measured from the
 * Stellar ledger by the data worker; a dataset the visitor's plan lacks shows the plan that opens it.
 * Nothing here decides access; the server does.
 *
 * House style: no em-dashes.
 */
import { Fragment as Frag } from "react";
import { TimeSeriesChart } from "../TimeSeriesChart";
import { Body, Panel, Row, usePoll } from "./Panels";
import { day, frac, pct, price, short, timeUtc, usd, xlm } from "./format";

const DAY_MS = 86_400_000;
/** Blend's pools by name where they are well known; others by their contract's short form. */
const POOL_NAMES: Record<string, string> = { CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD: "Blend Fixed" };
const poolName = (id: string) => POOL_NAMES[id] ?? short(id);
/** A rate or a share (0.08) as an unsigned percent: frac signs it, which suits changes, not levels. */
const level = (v: number | null, digits = 2) => (v === null ? "n/a" : pct(v * 100, digits, false));
const BAND_LABEL: Record<number, string> = { 0: "now", 2: "2%", 5: "5%", 10: "10%", 15: "15%", 20: "20%", 30: "30%", 50: "50%", 100: "more" };

// ─── The Stellar DeFi map ─────────────────────────────────────────────────────

interface DefiRow {
  day: string;
  protocol: string;
  name: string;
  category: string | null;
  asset: string;
  symbol: string | null;
  held_usd: number | null;
  borrowed_usd: number | null;
}

export function DefiPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: DefiRow[] }>("defi", {}, 600_000, version, 30 * DAY_MS);
  return (
    <Panel title="Stellar DeFi" sub="Each protocol's holdings and debt, measured from the ledger" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="The Stellar DeFi map">
        {(d) => {
          if (!d.rows.length) return <p className="text-xs text-muted">No day recorded yet.</p>;
          const latest = d.rows.reduce((m, r) => (r.day > m ? r.day : m), "");
          const byProtocol = new Map<string, { name: string; category: string | null; held: number; borrowed: number }>();
          for (const r of d.rows.filter((x) => x.day === latest)) {
            const p = byProtocol.get(r.protocol) ?? { name: r.name, category: r.category, held: 0, borrowed: 0 };
            p.held += r.held_usd ?? 0;
            p.borrowed += r.borrowed_usd ?? 0;
            byProtocol.set(r.protocol, p);
          }
          const rows = [...byProtocol.values()].sort((a, b) => b.held - a.held);
          const totals = new Map<string, number>();
          for (const r of d.rows) totals.set(r.day, (totals.get(r.day) ?? 0) + (r.held_usd ?? 0));
          const points = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [Date.parse(`${k}T00:00:00Z`) / 1000, v] as [number, number]);
          return (
            <div className="space-y-2">
              {points.length > 1 ? <TimeSeriesChart points={points} color="var(--accent)" label="Held" formatValue={(v) => usd(v)} formatTick={(v) => usd(v, 0)} /> : null}
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-[11px] font-mono">
                <span className="text-muted">{day(latest)}</span>
                <span className="text-muted text-right">held</span>
                <span className="text-muted text-right">debt</span>
                {rows.map((p) => (
                  <Frag key={p.name}>
                    <span className="truncate">{p.name}</span>
                    <span className="text-right tabular-nums">{usd(p.held)}</span>
                    <span className="text-right tabular-nums text-muted">{p.borrowed ? usd(p.borrowed) : ""}</span>
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

// ─── Lending and the liquidation ladder ───────────────────────────────────────

interface LendingRow {
  t: number;
  pool: string;
  asset: string;
  symbol: string | null;
  supplied: number;
  borrowed: number;
  utilization: number | null;
  borrow_apr: number | null;
  price: number | null;
}

interface LadderRow {
  t: number;
  pool: string;
  side: string;
  band: number;
  debt_usd: number;
  collateral_xlm: number;
  accounts: number;
  price: number;
}

export function LendingPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: LendingRow[] }>("lending", { resolution: "1h" }, 300_000, version, 2 * DAY_MS);
  const ladder = usePoll<{ rows: LadderRow[] }>("ladder", { resolution: "1h" }, 300_000, version, 2 * DAY_MS);
  return (
    <Panel title="On-chain lending" sub="Blend's debt, rates and how far XLM must fall to liquidate it" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="On-chain lending and the liquidation ladder">
        {(d) => {
          const latestT = d.rows.reduce((m, r) => Math.max(m, r.t), 0);
          const now = d.rows.filter((r) => r.t === latestT && r.borrowed > 0).sort((a, b) => b.borrowed * (b.price ?? 0) - a.borrowed * (a.price ?? 0));
          const rungs = ladder?.ok ? ladder.data.rows : [];
          const lastRung = rungs.reduce((m, r) => Math.max(m, r.t), 0);
          const long = rungs.filter((r) => r.t === lastRung && r.side === "long").sort((a, b) => a.band - b.band);
          const top = Math.max(1, ...long.map((r) => r.debt_usd));
          return (
            <div className="space-y-3">
              {now.length ? (
                <div className="space-y-0.5">
                  {now.slice(0, 4).map((r) => (
                    <Row key={`${r.pool}-${r.asset}`} k={`${poolName(r.pool)} ${r.symbol ?? short(r.asset)}`} v={`${r.price === null ? `${xlm(r.borrowed)} ${r.symbol ?? ""}`.trim() : usd(r.borrowed * r.price)} borrowed, ${level(r.utilization, 0)} used, ${level(r.borrow_apr)} APR`} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">No reserve reading yet.</p>
              )}
              <div>
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted mb-1">Debt liquidated by a fall in XLM of</p>
                {long.length ? (
                  <div className="space-y-0.5">
                    {long.map((r) => (
                      <div key={r.band} className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 text-[11px] font-mono">
                        <span className="text-muted">{BAND_LABEL[r.band] ?? `${r.band}%`}</span>
                        <span className="h-2 rounded bg-border-soft overflow-hidden">
                          <span className={`block h-full ${r.band <= 10 ? "bg-red" : "bg-orange"}`} style={{ width: `${(r.debt_usd / top) * 100}%` }} />
                        </span>
                        <span className="tabular-nums text-right">{usd(r.debt_usd)}</span>
                      </div>
                    ))}
                    <p className="text-[11px] text-muted">From XLM at {price(long[0]?.price)}; {long.reduce((s, r) => s + r.accounts, 0)} borrowers.</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted">The ladder starts once the borrower history has loaded.</p>
                )}
              </div>
            </div>
          );
        }}
      </Body>
    </Panel>
  );
}

// ─── On-chain liquidations ────────────────────────────────────────────────────

interface AuctionRow {
  id: string;
  t: number;
  pool: string;
  kind: string;
  auction_type: number | null;
  account: string | null;
  percent: number | null;
  lot_usd: number | null;
  bid_usd: number | null;
  filler?: string | null;
}

const KIND: Record<string, string> = { new: "opened", fill: "filled", delete: "deleted", bad_debt: "bad debt", defaulted_debt: "defaulted" };

export function AuctionsPanel({ version }: { version: number }) {
  const res = usePoll<{ rows: AuctionRow[] }>("auctions", { limit: 40 }, 60_000, version, 7 * DAY_MS);
  return (
    <Panel title="On-chain liquidations" sub="Each Blend liquidation auction on the Stellar ledger" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="Blend's liquidation auctions">
        {(d) => {
          if (!d.rows.length) return <p className="text-xs text-muted">No liquidation auction in this window.</p>;
          // Fillers come only with Institutional; the column is there when the server sent it.
          const fillers = d.rows.some((r) => r.filler !== undefined);
          const cols = fillers ? "grid-cols-[5.5rem_4.5rem_1fr_3.75rem_4.25rem]" : "grid-cols-[5.5rem_4.5rem_1fr_3.75rem]";
          return (
            <ul className="text-[11px] font-mono max-h-[260px] overflow-y-auto divide-y divide-border-soft">
              {d.rows.map((r) => (
                <li key={r.id} className={`grid ${cols} gap-2 py-1`}>
                  <span className="text-muted">{`${day(r.t)} ${timeUtc(r.t)}`}</span>
                  <span className={r.kind === "new" ? "text-red" : "text-muted"}>{KIND[r.kind] ?? r.kind}</span>
                  <span className="truncate">{short(r.account)}</span>
                  <span className="tabular-nums text-right">{usd(r.lot_usd)}</span>
                  {fillers ? <span className="text-muted text-right">{r.filler ? short(r.filler) : ""}</span> : null}
                </li>
              ))}
            </ul>
          );
        }}
      </Body>
    </Panel>
  );
}

// ─── Borrowers (Institutional) ────────────────────────────────────────────────

interface BorrowerRow {
  pool: string;
  account: string;
  label: string | null;
  collateral: Record<string, number>;
  debt_usd: number | null;
  health: number | null;
  liq_price: number | null;
  side: string;
  move: number | null;
}

const XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

export function BorrowersPanel({ version }: { version: number }) {
  const res = usePoll<{ day: string | null; rows: BorrowerRow[] }>("borrowers", { limit: 25 }, 600_000, version);
  return (
    <Panel title="Borrowers" sub="Every on-chain borrower, with collateral, debt and liquidation price" meta={res?.ok ? res.meta : undefined}>
      <Body res={res} what="The borrower map: each account's debt and liquidation price">
        {(d) =>
          d.rows.length ? (
            <div className="overflow-x-auto">
              <div className="grid grid-cols-[minmax(8rem,1fr)_auto_auto_auto_auto] gap-x-3 gap-y-0.5 text-[11px] font-mono min-w-[32rem]">
                <span className="text-muted">account</span>
                <span className="text-muted text-right">debt</span>
                <span className="text-muted text-right">XLM collateral</span>
                <span className="text-muted text-right">liquidated at</span>
                <span className="text-muted text-right">away</span>
                {d.rows.map((r) => (
                  <Frag key={`${r.pool}-${r.account}`}>
                    <span className="truncate">{r.label ?? short(r.account)}</span>
                    <span className="text-right tabular-nums">{usd(r.debt_usd)}</span>
                    <span className="text-right tabular-nums">{xlm(r.collateral[XLM_SAC] ?? 0)}</span>
                    <span className="text-right tabular-nums">{r.side === "none" ? "n/a" : price(r.liq_price)}</span>
                    <span className={`text-right tabular-nums ${r.move !== null && Math.abs(r.move) <= 0.1 ? "text-red" : ""}`}>{r.move === null ? "n/a" : frac(r.move, 1)}</span>
                  </Frag>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted">No borrowers recorded yet: they load with the borrower history.</p>
          )
        }
      </Body>
    </Panel>
  );
}
