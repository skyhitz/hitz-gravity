"use client";

/**
 * Home — tabs layout (Trade / Vault / Monitor / Admin).
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

import { useEffect, useState } from "react";
import Link from "next/link";
import WalletButton from "./components/WalletButton";
import PulseBar from "./components/PulseBar";
import AccountPulse from "./components/AccountPulse";
import AccountInspector from "./components/AccountInspector";
import SmartSwap from "./components/scenarios/SmartSwap";
import SacrificeRitual from "./components/SacrificeRitual";
import SendToEmail from "./components/SendToEmail";
import MonitorStatCards from "./components/MonitorStatCards";
import RegistryCardPair from "./components/Registry";
import AdminTab from "./components/AdminTab";
import ConsentModal, { CONSENT_KEY } from "./components/ConsentModal";
import { CONTRACT_ID, getAdmin } from "./lib/stellar";
import { useWallet } from "./contexts/WalletContext";
import { useProtocol } from "./contexts/ProtocolContext";

type Tab = "trade" | "vault" | "monitor" | "admin";

const ALL_TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "trade", label: "Trade", icon: "◈" },
  { key: "vault", label: "Vault", icon: "⬡" },
  { key: "monitor", label: "Monitor", icon: "≡" },
  { key: "admin", label: "Admin", icon: "⚙" },
];

export default function Home() {
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
          <div className="logo">
            <span className="logo-mark" aria-hidden />
            <h1>SKYHITZ</h1>
            <span style={{ color: "var(--border)", userSelect: "none" }}>·</span>
            <span
              style={{
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              Mainnet
            </span>
          </div>
          <div className="nav-right">
            <Link href="/whitepaper" className="nav-link">
              Whitepaper
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
                Outbound transfers are blocked until you Sacrifice or L rises.{" "}
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
                  Begin the ritual →
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
      </main>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer-inner">
          <p className="contract">{CONTRACT_ID}</p>
          <div className="footer-links">
            <Link href="/whitepaper">Whitepaper</Link>
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
  return <SmartSwap />;
}

function VaultPanel({ vaulted }: { vaulted: boolean | null }) {
  const { publicKey } = useWallet();
  if (vaulted === true) {
    return <SacrificeRitual />;
  }
  // Safe-orbit empty state (and fallback when no wallet connected). The
  // SendToEmail card sits directly below because this is the first tab a
  // new user lands on when they're NOT mid-trade, and "send to an email"
  // is a natural next step after signing in.
  //
  // Gating: only signed-in users (wallet OR email session) see SendToEmail.
  // A disconnected visitor has no `from` account to transfer from, so the
  // card would be a dead-end input. Vaulted users are handled above.
  return (
    <div
      style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}
    >
      <div className="empty-state">
        <div className="glyph" aria-hidden>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </div>
        <div className="eyebrow">Safe Orbit</div>
        <h2>No ritual required.</h2>
        <p>
          Your balance is below the Event Horizon. Outbound transfers and Smart
          Swap are both unlocked. If a future trade crosses L you&apos;ll be
          Vaulted, and this tab will unlock the Sacrifice Ritual.
        </p>
      </div>
      {publicKey && <SendToEmail />}
    </div>
  );
}

function MonitorPanel() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: 16,
      }}
    >
      <MonitorStatCards />
      <AccountPulse />
      <RegistryCardPair />
      <div className="side-card">
        <h4>Inspect Account</h4>
        <AccountInspector />
      </div>
    </div>
  );
}
