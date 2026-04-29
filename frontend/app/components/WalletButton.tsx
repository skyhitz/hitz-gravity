"use client";

/**
 * WalletButton — the nav-corner entry point.
 *
 * Disconnected state: a single "Connect" button that opens <ConnectModal>.
 * The modal handles the email / wallet split — this component is purely a
 * launch pad + a dropdown for the connected state.
 *
 * Connected state: a pill showing either the wallet address (G...) or the
 * email label. Clicking opens a dropdown with copy / switch / disconnect.
 * "Switch" is contextual:
 *   - wallet mode → opens SWK auth modal to pick a different wallet
 *   - email mode  → opens ConnectModal so the user can send a link to a
 *                   different email (or swap to a wallet)
 */

import { useState, useRef, useEffect } from "react";
import { useWallet } from "../contexts/WalletContext";
import ConnectModal from "./ConnectModal";

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function WalletButton() {
  const { publicKey, email, connectionType, connecting, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const copyAddress = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setOpen(false);
    }, 1500);
  };

  const handleDisconnect = async () => {
    setOpen(false);
    await disconnect();
  };

  const handleSwitch = () => {
    setOpen(false);
    setModalOpen(true);
  };

  // Label in the connected pill — email gets truncated at @, wallet gets the
  // usual G…XXXX. The mode dot picks a distinguishing color so users with
  // both paths handy can tell at a glance which one is live.
  const label =
    connectionType === "email" && email
      ? email.length > 22 ? `${email.slice(0, 20)}…` : email
      : publicKey
      ? shortenAddress(publicKey)
      : "";

  const modeColor = connectionType === "email" ? "bg-purple" : "bg-green";

  // ── Connected state ──────────────────────────────────────────────────────
  if (publicKey) {
    return (
      <>
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 bg-card border border-border hover:border-accent/50 rounded-full px-4 py-2 text-sm transition-all duration-150 cursor-pointer group"
            aria-haspopup="true"
            aria-expanded={open}
          >
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${modeColor} opacity-60`} />
              <span className={`relative inline-flex rounded-full h-2 w-2 ${modeColor}`} />
            </span>
            <span className={connectionType === "email" ? "text-foreground tracking-tight" : "font-mono text-foreground tracking-tight"}>
              {label}
            </span>
            <svg
              className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {open && (
            <div
              className="absolute right-0 top-full mt-2 w-60 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden z-50"
              style={{ animation: "fadeUp 0.12s ease-out both" }}
            >
              <div className="px-4 pt-3 pb-2">
                <p className="text-[10px] uppercase tracking-widest text-muted mb-1">
                  {connectionType === "email" ? "Signed in as" : "Connected"}
                </p>
                {connectionType === "email" && email ? (
                  <p className="text-xs text-foreground break-all leading-relaxed">{email}</p>
                ) : null}
                <p className="font-mono text-[11px] text-muted break-all leading-relaxed mt-0.5">
                  {publicKey.slice(0, 20)}…{publicKey.slice(-8)}
                </p>
              </div>

              <div className="border-t border-border" />

              <button
                onClick={copyAddress}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-card-hover text-foreground"
              >
                {copied ? (
                  <>
                    <CheckIcon />
                    <span className="text-green">Copied!</span>
                  </>
                ) : (
                  <>
                    <CopyIcon />
                    <span>Copy address</span>
                  </>
                )}
              </button>

              <button
                onClick={handleSwitch}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-card-hover text-foreground"
              >
                <SwitchIcon />
                <span>{connectionType === "email" ? "Switch account" : "Switch wallet"}</span>
              </button>

              <div className="border-t border-border" />

              <button
                onClick={handleDisconnect}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-red/10 text-red"
              >
                <DisconnectIcon />
                <span>Disconnect</span>
              </button>
            </div>
          )}
        </div>

        {modalOpen && <ConnectModal onClose={() => setModalOpen(false)} />}
      </>
    );
  }

  // ── Disconnected state ───────────────────────────────────────────────────
  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        disabled={connecting}
        className="bg-accent hover:bg-accent-hover disabled:opacity-60 text-white font-medium rounded-full px-5 py-2 text-sm transition-colors cursor-pointer disabled:cursor-not-allowed"
      >
        {connecting ? (
          <span className="flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Connecting…
          </span>
        ) : (
          "Connect"
        )}
      </button>
      {modalOpen && <ConnectModal onClose={() => setModalOpen(false)} />}
    </>
  );
}

// ─── Icon components ──────────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg className="w-4 h-4 text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-green shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg className="w-4 h-4 text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M4 17h12M4 17l4 4M4 17l4-4" />
    </svg>
  );
}

function DisconnectIcon() {
  return (
    <svg className="w-4 h-4 text-red shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}
