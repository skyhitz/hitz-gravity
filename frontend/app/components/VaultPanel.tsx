"use client";

/**
 * VaultPanel — the Vault tab: the sell-to-release card for a vaulted account,
 * and otherwise the safe-orbit message with the send card for signed-in users.
 *
 * Its own file so the home page can load it when the tab is first opened
 * (components/HomeApp.tsx); the send and release cards are only for accounts
 * that are connected.
 */

import ReleaseCard from "./ReleaseCard";
import SendToEmail from "./SendToEmail";
import { useWallet } from "../contexts/WalletContext";

export default function VaultPanel({ vaulted }: { vaulted: boolean | null }) {
  const { publicKey } = useWallet();
  if (vaulted === true) {
    return <ReleaseCard />;
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
        <h2>You&apos;re free to move.</h2>
        <p>
          Your balance is below the Event Horizon: you can send HITZ anywhere
          and trade freely. If a purchase ever takes you over L you&apos;ll be
          Vaulted, and this tab will show how much to sell into the vault to
          get free again.
        </p>
      </div>
      {publicKey && <SendToEmail />}
    </div>
  );
}
