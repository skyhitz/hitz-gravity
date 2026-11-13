"use client";
/**
 * The HITZ Terminal: XLM market, leverage and on-chain flow data on one screen. Free visitors see the
 * market an hour ago; paid plans see it live, with the tape, leverage, books, SDF supply, alerts and
 * the API. The data comes from /api/terminal/* (functions/_lib/terminal/), which reads it from the
 * data worker; nothing here decides what a visitor may see.
 *
 * House style: no em-dashes.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import WalletButton from "../WalletButton";
import { useWallet } from "../../contexts/WalletContext";
import * as api from "../../lib/terminal";
import type { Me, PublicPlan } from "../../lib/terminal";
import { KeysAndHooks, Pricing, useTerminalSignIn } from "./Account";
import { AlertsPanel, BooksPanel, FeedPanel, FlowsPanel, LeveragePanel, LiquidationsPanel, OverviewStrip, SdfPanel, SpreadsPanel, TransfersPanel } from "./Panels";
import { stamp } from "./format";

const SITE = "https://skyhitz.io";

const ENDPOINTS: [string, string][] = [
  ["GET /data/overview", "The headline numbers"],
  ["GET /data/spreads?resolution=1m|5m|1h|1d", "Kraken and Coinbase against the Stellar DEX"],
  ["GET /data/liquidations?resolution=5m|1h|1d", "Longs and shorts liquidated, all XLM perpetuals"],
  ["GET /data/liquidation_feed?limit=100", "Each Bybit and OKX liquidation"],
  ["GET /data/leverage?resolution=5m|1h|1d", "Open interest, funding, accounts long"],
  ["GET /data/books?resolution=1m|5m|1h|1d", "Depth within 0.5, 1 and 2%, tilt"],
  ["GET /data/flows?from=2024-01-01", "Whale and exchange flows and reserves by day"],
  ["GET /data/transfers?min_xlm=10000000", "Labeled transfers, newest first"],
  ["GET /data/sdf?from=2024-01-01", "SDF's supply to exchanges and its pace"],
  ["GET /data/alerts", "Deposits, withdrawals, SDF, liquidation bursts, spread spikes"],
  ["GET /data/labels", "The labeled wallet book (Institutional)"],
  ["GET /data/status", "When each dataset last updated"],
];

const CURL = `curl -H "Authorization: Bearer htz_YOUR_KEY" \\
  "${SITE}/api/terminal/data/spreads?resolution=1m&from=2026-11-13T00:00:00Z"`;

export default function TerminalApp() {
  const { publicKey, connectionType } = useWallet();
  const [me, setMe] = useState<Me | null>(null);
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const { signIn, busy, error } = useTerminalSignIn(refresh);

  useEffect(() => {
    api.plans().then(setPlans).catch(() => setPlans([]));
  }, []);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, [version, publicKey, connectionType]);

  const paid = !!me && me.plan !== "free";
  const needsSignIn = connectionType === "wallet" && !!publicKey && me !== null && (me.via === "none" || me.account !== publicKey);
  const signedIn = !!me?.account && (me.via === "wallet" || me.via === "email");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="max-w-[1400px] mx-auto px-4 h-12 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/" className="text-muted text-sm hover:text-foreground">
              ←
            </Link>
            <span className="font-mono text-sm tracking-[0.12em] sm:tracking-[0.2em] text-orange">HITZ</span>
            <span className="font-mono text-sm tracking-[0.12em] sm:tracking-[0.2em] hidden min-[420px]:inline">TERMINAL</span>
            <span className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.5 rounded border border-border text-muted">XLM</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="#pricing" className="hidden md:inline text-xs text-muted hover:text-foreground">
              Plans
            </a>
            <a href="#api" className="hidden md:inline text-xs text-muted hover:text-foreground">
              API
            </a>
            {me ? (
              <span className={`shrink-0 whitespace-nowrap text-[10px] font-mono px-1.5 py-0.5 rounded ${paid ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}>
                {me.plan_name.toUpperCase()}
                {me.until ? <span className="hidden sm:inline">{` · ${stamp(me.until)}`}</span> : null}
              </span>
            ) : null}
            {needsSignIn ? (
              <button onClick={signIn} disabled={busy} className="text-xs rounded bg-accent hover:bg-accent-hover text-white px-2 py-1 disabled:opacity-50">
                {busy ? "Signing" : "Sign in"}
              </button>
            ) : null}
            <WalletButton />
          </div>
        </div>
        {error ? <p className="max-w-[1400px] mx-auto px-4 pb-2 text-xs text-red">{error}</p> : null}
      </nav>

      <main className="max-w-[1400px] mx-auto px-4 py-6 space-y-6">
        <OverviewStrip version={version} fast={paid} />

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="space-y-3 min-w-0">
            <SpreadsPanel version={version} fine={paid} />
            <BooksPanel version={version} />
            <FlowsPanel version={version} />
          </div>
          <div className="space-y-3 min-w-0">
            <LiquidationsPanel version={version} fine={paid} />
            <FeedPanel version={version} />
            <LeveragePanel version={version} />
          </div>
          <div className="space-y-3 min-w-0">
            <AlertsPanel version={version} />
            <TransfersPanel version={version} />
            <SdfPanel version={version} />
          </div>
        </div>

        <Pricing plans={plans} me={me} onPaid={refresh} />

        {signedIn && me ? <KeysAndHooks me={me} onChange={refresh} /> : null}

        <section id="api" className="space-y-3 scroll-mt-16">
          <p className="text-muted text-xs uppercase tracking-[0.18em]">Developer API</p>
          <h2 className="text-2xl font-semibold tracking-tight">The same data, from your code</h2>
          <p className="text-sm text-muted max-w-3xl">
            Every panel is an endpoint under <span className="font-mono text-foreground">{SITE}/api/terminal</span>. Without a key you get the free
            shape (an hour behind, hourly bins, a week). Pro and Institutional keys get live data at the plan&apos;s resolution and history. Times are
            ISO dates or milliseconds; answers carry a <span className="font-mono">meta</span> block saying exactly what window you got.
          </p>
          <pre className="bg-card border border-border rounded-lg p-3 text-[12px] font-mono overflow-x-auto">{CURL}</pre>
          <div className="bg-card border border-border rounded-lg divide-y divide-border-soft">
            {ENDPOINTS.map(([path, what]) => (
              <div key={path} className="flex flex-wrap justify-between gap-2 px-3 py-1.5 text-[12px]">
                <span className="font-mono">{path}</span>
                <span className="text-muted">{what}</span>
              </div>
            ))}
          </div>
        </section>

        <footer className="text-[11px] text-muted space-y-1 border-t border-border pt-4">
          <p>Information only, not advice. Data is for the subscriber&apos;s own use: no redistribution or resale.</p>
          <p>
            Payments are a swap in the HITZ Sovereign Vault: your USDC or XLM buys HITZ, which goes to the treasury, and the vault keeps its fee.
            Read the{" "}
            <a href="https://github.com/skyhitz/hitz-gravity/blob/main/LEGAL.md" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              legal disclosure
            </a>{" "}
            before paying.
          </p>
        </footer>
      </main>
    </div>
  );
}
