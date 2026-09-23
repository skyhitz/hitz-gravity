"use client";

/**
 * TractionCard — is anyone actually using HITZ? On the Monitor tab, under
 * liquidity.
 *
 * North Star: active non-infrastructure accounts over the last 30 days.
 * Around it: new vs returning, the human share of all HITZ activity, how
 * accounts arrive (email gateway / own wallet / received), monthly history,
 * and where the 100M supply actually sits. Built hourly by the Worker cron
 * (functions/_lib/traction-model.ts); fetched every few minutes.
 *
 * Wording is deliberately "accounts", not "people": one person can control
 * several accounts, and the data already shows wallets sized just under L.
 */

import { useEffect, useMemo, useState } from "react";
import { fetchTraction, type Channel, type TractionSnapshot } from "../lib/traction";
import { fmtCompact } from "../lib/price";
import { MonthlyColumns } from "./MonthlyColumns";
import { fmtDate } from "./TimeSeriesChart";

const POLL_MS = 5 * 60_000;

type LoadState =
  | { status: "loading" }
  | { status: "indexing" }
  | { status: "error"; error: string }
  | { status: "ready"; data: TractionSnapshot };

const CHANNELS: { key: Channel; label: string; note: string }[] = [
  { key: "wallet", label: "Own wallet", note: "signed their own transaction, e.g. bought from a pool" },
  { key: "email", label: "Email gateway", note: "onboarded through Skyhitz email, gas sponsored" },
  { key: "received", label: "Received", note: "sent HITZ by someone else" },
  { key: "unknown", label: "Unknown", note: "transaction details not indexed yet" },
];

const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function pct(part: number, whole: number, digits = 1): string {
  if (!whole) return "—";
  const v = (part / whole) * 100;
  const floor = 10 ** -digits;
  return v > 0 && v < floor ? `<${floor}%` : `${v.toFixed(digits)}%`;
}

export default function TractionCard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchTraction();
        if (cancelled) return;
        setState(data ? { status: "ready", data } : { status: "indexing" });
      } catch (err) {
        if (cancelled) return;
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

  const data = state.status === "ready" ? state.data : null;
  const currentMonth = data ? data.asOf.slice(0, 7) : "";
  const columns = useMemo(
    () =>
      (data?.months ?? []).map((m) => ({
        month: m.month,
        value: m.activePeople,
        detail: `${m.newPeople} new · ${m.returningPeople} returning`,
      })),
    [data]
  );
  const badge = state.status === "ready" ? "Live" : state.status === "error" ? "Offline" : "Syncing";

  return (
    <div className="mcard">
      <div className="mcard-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: "var(--gold)" }} aria-hidden />
          <h4>Traction</h4>
          <span className={`count ${state.status === "ready" ? "" : "idle"}`}>{badge}</span>
        </div>
        {data && <span className="mcard-meta">updated hourly</span>}
      </div>

      {!data ? (
        <div className="mcard-empty">
          {state.status === "loading" && "Loading traction…"}
          {state.status === "indexing" && "Traction metrics are still being built. Check back within the hour."}
          {state.status === "error" && `Couldn't load traction: ${state.error}`}
        </div>
      ) : (
        <TractionBody data={data} columns={columns} currentMonth={currentMonth} />
      )}
    </div>
  );
}

function TractionBody({
  data,
  columns,
  currentMonth,
}: {
  data: TractionSnapshot;
  columns: { month: string; value: number; detail: string }[];
  currentMonth: string;
}) {
  const w = data.window;
  const delta = w.activePeople - w.prevActivePeople;
  const s = data.holders.supply;
  const peopleHeld = s.people + s.vaultedPeople;
  const channelTotal = Object.values(data.channels.allTime).reduce((a, b) => a + b, 0);

  const supplyRows = [
    { label: "AMM pools", hitz: s.amm, note: "liquidity in registered pools" },
    { label: "Treasury", hitz: s.treasury, note: "admin reserve, counted as pool mass" },
    { label: "Vaulted accounts", hitz: s.vaultedPeople, note: `${data.holders.vaultedPeople} accounts above L` },
    { label: "Accounts below L", hitz: s.people, note: `${data.holders.people - data.holders.vaultedPeople} accounts` },
    { label: "Routers", hitz: s.routers, note: "pass-through infrastructure" },
    { label: "Other contracts", hitz: s.contracts, note: `${data.holders.contracts} bots / aggregators` },
  ].filter((r) => r.hitz > 0 || r.label === "Accounts below L");

  return (
    <>
      <div className="mcard-hero">
        <div className="mcard-now">{w.activePeople}</div>
        <div className={`mcard-delta ${delta >= 0 ? "up" : "down"}`}>
          {delta >= 0 ? "+" : "−"}
          {Math.abs(delta)} <span>vs previous 30 days ({w.prevActivePeople})</span>
        </div>
        <div className="mcard-sub">active accounts in the last 30 days · outside pools, routers and treasury</div>
      </div>

      <div className="mcard-stats">
        <div>
          <div className="k">New accounts</div>
          <div className="v">{w.newPeople}</div>
          <div className="s">
            last 30 days · {data.allTime.people} since {fmtDate(Date.parse(data.since) / 1000)}
          </div>
        </div>
        <div>
          <div className="k">Returning</div>
          <div className="v">{w.returningPeople}</div>
          <div className="s">active before this window</div>
        </div>
        <div>
          <div className="k">Human share</div>
          <div className="v">{pct(w.humanTxs, w.allTxs)}</div>
          <div className="s">
            {w.humanTxs} of {w.allTxs.toLocaleString()} HITZ txs · rest is bots and infrastructure
          </div>
        </div>
        <div>
          <div className="k">Via email</div>
          <div className="v">{w.gatewayPeople ?? "—"}</div>
          <div className="s">
            last 30 days · {data.allTime.gatewayPeople ?? "—"} all time
          </div>
        </div>
        <div>
          <div className="k">Holders</div>
          <div className="v">{data.holders.people}</div>
          <div className="s">
            {data.holders.vaultedPeople} vaulted · {data.holders.nearHorizonPeople} near the horizon
          </div>
        </div>
        <div>
          <div className="k">Held by accounts</div>
          <div className="v">{pct(peopleHeld, s.total, 2)}</div>
          <div className="s">of supply · top 10 hold {(data.holders.top10Share * 100).toFixed(0)}% of it</div>
        </div>
      </div>

      <div className="mcard-section">Active accounts per month</div>
      <MonthlyColumns columns={columns} color="var(--gold)" unit="active account" currentMonth={currentMonth} />

      <div className="mcard-scroll">
        <table className="liq-pools">
          <caption>Monthly activity (current month to date)</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Active</th>
              <th scope="col">New</th>
              <th scope="col">Returning</th>
              <th scope="col">Via email</th>
              <th scope="col">Human txs</th>
              <th scope="col">All txs</th>
              <th scope="col">Human share</th>
            </tr>
          </thead>
          <tbody>
            {[...data.months].reverse().map((m) => (
              <tr key={m.month}>
                <th scope="row">
                  {monthFmt.format(new Date(`${m.month}-01T00:00:00Z`))}
                  {m.month === currentMonth ? " · MTD" : ""}
                </th>
                <td>{m.activePeople}</td>
                <td>{m.newPeople}</td>
                <td>{m.returningPeople}</td>
                <td>{m.gatewayPeople ?? "—"}</td>
                <td>{m.humanTxs}</td>
                <td>{m.allTxs.toLocaleString()}</td>
                <td>{pct(m.humanTxs, m.allTxs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="trc-grid">
        <div>
          <div className="mcard-section">How accounts arrived · since {fmtDate(Date.parse(data.since) / 1000)}</div>
          <ul className="trc-rows">
            {CHANNELS.filter((c) => c.key !== "unknown" || data.channels.allTime.unknown > 0).map((c) => {
              const n = data.channels.allTime[c.key];
              return (
                <li key={c.key} title={c.note}>
                  <span className="name">{c.label}</span>
                  <span className="bar" aria-hidden>
                    <span style={{ width: channelTotal ? `${(n / channelTotal) * 100}%` : 0 }} />
                  </span>
                  <span className="num">
                    {n} <em>{pct(n, channelTotal, 0)}</em>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <div className="mcard-section">Where the supply sits</div>
          <ul className="trc-rows">
            {supplyRows.map((r) => (
              <li key={r.label} title={r.note}>
                <span className="name">{r.label}</span>
                <span className="bar" aria-hidden>
                  <span style={{ width: `${Math.max(r.hitz > 0 ? 0.6 : 0, (r.hitz / s.total) * 100)}%` }} />
                </span>
                <span className="num">
                  {fmtCompact(r.hitz)} <em>{pct(r.hitz, s.total, 2)}</em>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mcard-foot">
        Accounts are G-addresses outside the registered pools, routers and treasury, not verified people; one person
        can run several (several recent wallets are sized just under L). Activity is from HITZ transfers since{" "}
        {fmtDate(Date.parse(data.since) / 1000)}, when the event store begins; holders and supply are read live from the
        ledger.
      </p>
    </>
  );
}
