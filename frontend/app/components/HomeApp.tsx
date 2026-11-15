"use client";

/**
 * HomeApp — the app on the home page: tabs layout (Trade / Vault / Monitor /
 * Admin). The page itself (app/(app)/page.tsx) is a server component that
 * renders this and passes the written part of the page (what HITZ Protocol
 * is, how it works, questions) as `children`, so that text is in the HTML
 * and costs no JavaScript.
 *
 * Trade swaps through the Sovereign Vault (components/VaultSwap). The Vault
 * tab is about the account's own gravity: free accounts get the send-to-
 * email card, vaulted ones the sell-to-release card.
 *
 * Only the Trade tab is in the first load. The Vault, Monitor and Admin
 * panels are fetched when their tab is first opened (and a moment earlier,
 * when the pointer reaches the tab), so a visitor who came to trade or to
 * read doesn't download the charts, the send form or the admin tools.
 *
 * Routing is intentionally local state: the tab choice is ephemeral and
 * shouldn't pollute the URL or survive reloads. The one exception is when
 * the connected account flips to Vaulted — we auto-jump to the Vault tab
 * because that's the only place from which the user can act. A vault-notice
 * banner appears on Trade/Monitor/Admin when vaulted, so the state is never
 * invisible.
 *
 * The sticky chain: <nav> → <PulseBar> → <tabs-bar>. Scrolling the tab-
 * panel body keeps all three visible, matching the reordered-HTML design.
 */

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import WalletButton from "./WalletButton";
import PulseBar from "./PulseBar";
import VaultSwap from "./VaultSwap";
import ConsentModal from "./ConsentModal";
import { CONSENT_KEY } from "../lib/consent";
import { CONTRACT_ID, getAdmin } from "../lib/stellar";
import { useWallet } from "../contexts/WalletContext";
import { useProtocol } from "../contexts/ProtocolContext";

/** Shown in a panel's place for the moment its code takes to arrive. */
function PanelLoading() {
  return <div className="side-card shimmer" style={{ height: 220 }} role="status" aria-label="Loading" />;
}

// The panels behind the other tabs, each in its own chunk, fetched when its
// tab is first shown. (The import() is written inside dynamic(), as Next asks.)
const VaultPanel = dynamic(() => import("./VaultPanel"), { loading: PanelLoading });
const MonitorPanel = dynamic(() => import("./MonitorPanel"), { loading: PanelLoading });
const AdminTab = dynamic(() => import("./AdminTab"), { loading: PanelLoading });

type Tab = "trade" | "vault" | "monitor" | "admin";

// The same chunks, by tab: importing one ahead of the click starts its download.
const PRELOAD: Partial<Record<Tab, () => Promise<unknown>>> = {
  vault: () => import("./VaultPanel"),
  monitor: () => import("./MonitorPanel"),
  admin: () => import("./AdminTab"),
};

/** Start fetching a tab's panel; harmless to call again, and a failure here is retried on click. */
function preload(tab: Tab): void {
  PRELOAD[tab]?.().catch(() => {});
}

const ALL_TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "trade", label: "Trade", icon: "◈" },
  { key: "vault", label: "Vault", icon: "⬡" },
  { key: "monitor", label: "Monitor", icon: "≡" },
  { key: "admin", label: "Admin", icon: "⚙" },
];

export default function HomeApp({ children }: { children?: ReactNode }) {
  const { publicKey } = useWallet();
  const { vaulted } = useProtocol();

  // Tab state — ephemeral, local.
  const [tab, setTab] = useState<Tab>("trade");

  // Admin-tab gating. The token contract's admin is read once from instance
  // storage; until the connected wallet matches it, the Admin tab simply
  // doesn't render. This is a UI convenience — the contract itself enforces
  // auth on every admin-only call, so hiding the tab saves curious users
  // from clicking into tools they couldn't execute anyway.
  const [adminAddress, setAdminAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAdmin().then((a) => {
      if (!cancelled) setAdminAddress(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const isAdmin = !!publicKey && !!adminAddress && publicKey === adminAddress;
  const TABS = isAdmin ? ALL_TABS : ALL_TABS.filter((t) => t.key !== "admin");

  // If the user somehow lands on the admin tab without being admin (e.g.
  // wallet disconnect after entering), drop them back to Trade.
  if (tab === "admin" && !isAdmin) {
    setTab("trade");
  }

  // Consent modal (preserved from the previous shell).
  const [hydration, setHydration] = useState({
    hydrated: false,
    consentGiven: false,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage read on mount
    setHydration({
      hydrated: true,
      consentGiven: !!localStorage.getItem(CONSENT_KEY),
    });
  }, []);

  // Auto-jump to the Vault tab the moment vaulted flips true. We only fire
  // once per transition so the user can still navigate away manually after —
  // using the "state-change during render" pattern (React 19 docs) instead of
  // a setState-in-effect, which the current lint config (rightly) forbids.
  const [prevVaulted, setPrevVaulted] = useState<boolean | null>(null);
  if (vaulted !== prevVaulted) {
    setPrevVaulted(vaulted);
    if (vaulted === true && prevVaulted !== true) {
      setTab("vault");
    }
  }

  const { hydrated, consentGiven } = hydration;
  const showModal = hydrated && publicKey !== null && !consentGiven;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {showModal && (
        <ConsentModal
          onAccept={() =>
            setHydration((prev) => ({ ...prev, consentGiven: true }))
          }
        />
      )}

      {/* ── Sticky nav ────────────────────────────────────────────────── */}
      <nav className="nav">
        <div className="nav-inner">
          {/* The brand, not the page's heading: the h1 is in the written part below. */}
          <div className="logo">
            <span className="logo-mark" aria-hidden />
            <span className="logo-name">SKYHITZ</span>
          </div>
          <div className="nav-right">
            <Link href="/terminal/" className="nav-link">
              Terminal
            </Link>
            <Link href="/integrate/" className="nav-link wide-only">
              Integrate
            </Link>
            <WalletButton />
          </div>
        </div>
      </nav>

      {/* ── Pulse bar ─────────────────────────────────────────────────── */}
      <PulseBar />

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <main className="main">
        {/* Sticky tab bar */}
        <div className="tabs-bar" role="tablist">
          {TABS.map(({ key, label, icon }) => {
            const active = tab === key;
            const showVaultBadge = key === "vault" && vaulted === true;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                className={active ? "active" : ""}
                onClick={() => setTab(key)}
                onPointerEnter={() => preload(key)}
                onFocus={() => preload(key)}
                onTouchStart={() => preload(key)}
              >
                <span className="tab-ico" aria-hidden>
                  {icon}
                </span>
                <span>{label}</span>
                {showVaultBadge && (
                  <span className="badge vault-badge">●</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Vault-notice banner on non-vault tabs when vaulted */}
        {vaulted === true && tab !== "vault" && (
          <div className="vault-notice">
            <span className="dot" aria-hidden />
            <div>
              <div className="txt">
                <strong>Your account is Vaulted.</strong>
              </div>
              <div className="sub">
                You can only send HITZ to a registered pool. Sell into the vault to get back under L, or wait for L to rise.{" "}
                <button
                  onClick={() => setTab("vault")}
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--purple)",
                    cursor: "pointer",
                    textDecoration: "underline",
                    padding: 0,
                    font: "inherit",
                  }}
                >
                  Sell to release →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Panels */}
        <div className="tab-panel" key={tab}>
          {tab === "trade" && <TradePanel />}
          {tab === "vault" && <VaultPanel vaulted={vaulted} />}
          {tab === "monitor" && <MonitorPanel />}
          {tab === "admin" && <AdminTab />}
        </div>

        {/* What HITZ Protocol is, how it works, questions: server-rendered. */}
        {children}
      </main>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer-inner">
          <p className="contract">
            <span className="network">Mainnet</span>
            <span className="sep" aria-hidden>·</span>
            {CONTRACT_ID}
          </p>
          <div className="footer-links">
            <Link href="/whitepaper/">Whitepaper</Link>
            <Link href="/terminal/">Terminal</Link>
            <Link href="/integrate/">API &amp; MCP</Link>
            <a href="https://docs.skyhitz.io/">Docs</a>
            <a
              href="https://github.com/skyhitz/hitz-gravity"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub ↗
            </a>
            <a
              href="https://github.com/skyhitz/hitz-gravity/blob/main/LEGAL.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Legal
            </a>
            <a
              href={`https://stellar.expert/explorer/public/contract/${CONTRACT_ID}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Stellar Expert →
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Panels ────────────────────────────────────────────────────────────────

function TradePanel() {
  return (
    <>
      <VaultSwap />
      <p className="trade-integrate">
        Trading from a bot or an AI agent? <Link href="/integrate/">Use the API or the MCP server →</Link>
      </p>
    </>
  );
}
