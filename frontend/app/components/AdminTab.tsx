"use client";

/**
 * AdminTab — the destructive / privileged scenarios, hidden behind a tab.
 *
 * Everything here has sharp edges: Whale's Anchor intentionally crosses L,
 * a vault deposit can't be withdrawn, Protocol Growth registers pools on
 * behalf of the contract admin. The amber header makes that cost explicit so
 * no-one clicks through by accident.
 *
 * We keep the existing scenario components (FreeCitizen, WhaleAnchor, …) as-
 * is; this tab just wraps them in an accordion so the user can scan the list
 * and expand the one they want. Their internal flows already handle wallet
 * state, tx status, and errors — no need to re-engineer that logic here.
 */

import { useState } from "react";
import FreeCitizen from "./scenarios/FreeCitizen";
import WhaleAnchor from "./scenarios/WhaleAnchor";
import GhostVaulting from "./scenarios/GhostVaulting";
import Arbitrageur from "./scenarios/Arbitrageur";
import ProtocolGrowth from "./scenarios/ProtocolGrowth";
import VaultAdmin from "./scenarios/VaultAdmin";
import { useWallet } from "../contexts/WalletContext";

interface ToolCardDef {
  number: number;
  title: string;
  subtitle: string;
  icon: string;
  iconBg: string;
  iconColor: string;
  Component: React.ComponentType<{ publicKey: string | null }>;
}

// Selling to release lives on the Vault tab; the admin surface keeps the
// Sovereign Vault's status and liquidity, plus the low-level scenarios and
// registry management.
const TOOLS: ToolCardDef[] = [
  {
    number: 1,
    title: "Sovereign Vault",
    subtitle: "Status, timelocks and deposits",
    icon: "◈",
    iconBg: "rgba(191,90,242,0.1)",
    iconColor: "var(--purple)",
    Component: VaultAdmin,
  },
  {
    number: 2,
    title: "Free Citizen",
    subtitle: "Transfer under the Event Horizon",
    icon: "≈",
    iconBg: "rgba(48,209,88,0.1)",
    iconColor: "var(--green)",
    Component: FreeCitizen,
  },
  {
    number: 3,
    title: "Whale's Anchor",
    subtitle: "Accumulate past L, get Vaulted",
    icon: "⬡",
    iconBg: "rgba(255,69,58,0.1)",
    iconColor: "var(--red)",
    Component: WhaleAnchor,
  },
  {
    number: 4,
    title: "Ghost Vaulting",
    subtitle: "L shrinks, accounts passively Vaulted",
    icon: "◌",
    iconBg: "rgba(255,159,10,0.1)",
    iconColor: "var(--orange)",
    Component: GhostVaulting,
  },
  {
    number: 5,
    title: "Arbitrageur",
    subtitle: "Transfers, allowances, delegated transfers",
    icon: "⇌",
    iconBg: "rgba(255,214,10,0.1)",
    iconColor: "var(--yellow)",
    Component: Arbitrageur,
  },
  {
    number: 6,
    title: "Protocol Growth",
    subtitle: "Register pool & router addresses",
    icon: "⊕",
    iconBg: "rgba(10,132,255,0.1)",
    iconColor: "var(--accent)",
    Component: ProtocolGrowth,
  },
];

export default function AdminTab() {
  const { publicKey } = useWallet();
  const [openNum, setOpenNum] = useState<number | null>(null);

  return (
    <div>
      <div className="admin-header">
        <span className="icon">⚠</span>
        <div className="txt">
          <strong>Advanced tools.</strong>{" "}These exercise the protocol&apos;s
          edge cases and the admin&apos;s powers. Some deliberately cross the
          Event Horizon, add liquidity that can never be withdrawn, or write
          to admin-only storage. Read each description before executing.
        </div>
      </div>

      {TOOLS.map(({ number, title, subtitle, icon, iconBg, iconColor, Component }) => {
        const open = openNum === number;
        return (
          <div key={number} className={`tool-card ${open ? "open" : ""}`}>
            <button
              type="button"
              className="tool-head"
              onClick={() => setOpenNum(open ? null : number)}
              aria-expanded={open}
            >
              <div
                className="tool-icon"
                style={{ background: iconBg, color: iconColor }}
              >
                {icon}
              </div>
              <div className="tool-txt">
                <div className="tool-num">
                  {String(number).padStart(2, "0")}
                </div>
                <div className="tool-ttl">{title}</div>
                <div className="tool-sub">{subtitle}</div>
              </div>
              <svg
                className="tool-chev"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {open && (
              <div className="tool-body">
                <Component publicKey={publicKey} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
