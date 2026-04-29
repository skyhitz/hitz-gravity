"use client";

/**
 * ConnectModal — unified entry point for both connection modes.
 *
 * Two primary actions:
 *   1. Email form          → sends magic-link, shows "check your inbox"
 *   2. "Connect wallet" CTA → closes this modal, triggers SWK authModal()
 *
 * Deliberately kept minimal — one modal, two paths. No tabs, no toggles.
 * The email form is primary because that's the onboarding path for the
 * broader audience (non-crypto users); wallet is a secondary action below
 * a divider.
 *
 * Parent (WalletButton) controls visibility and drives the outcome.
 */

import { useState, type FormEvent } from "react";
import { useWallet } from "../contexts/WalletContext";

interface Props {
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export default function ConnectModal({ onClose }: Props) {
  const { connectWallet, connectEmail } = useWallet();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus({ kind: "sending" });
    const res = await connectEmail(trimmed);
    if (res.ok) setStatus({ kind: "sent", email: trimmed });
    else setStatus({ kind: "error", message: res.error || "Failed to send" });
  };

  const handleWallet = async () => {
    // Close first so SWK's modal doesn't stack on top of ours — mashing
    // two fixed overlays confuses focus-trap + keyboard users.
    onClose();
    await connectWallet();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#050507]/96 backdrop-blur-2xl" onClick={onClose} />

      <div className="relative w-full max-w-sm rounded-3xl border border-border bg-card shadow-2xl" style={{ animation: "fadeUp 0.18s ease-out both" }}>
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <p className="text-accent text-xs tracking-widest uppercase font-medium">Connect</p>
              <h2 className="text-xl font-semibold tracking-tight">Enter the Gravity Field</h2>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 w-8 h-8 rounded-full border border-border hover:border-muted transition-colors text-muted hover:text-foreground flex items-center justify-center"
            >
              ×
            </button>
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────── */}
        <div className="px-6 py-5 space-y-5">
          {status.kind === "sent" ? (
            <SentState email={status.email} onResend={() => setStatus({ kind: "idle" })} />
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <label className="block">
                <span className="block text-xs tracking-widest uppercase text-muted mb-2">Email</span>
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  placeholder="you@skyhitz.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="inp"
                  disabled={status.kind === "sending"}
                />
              </label>
              <button
                type="submit"
                disabled={status.kind === "sending" || email.trim().length === 0}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-colors bg-accent hover:bg-accent-hover text-white disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {status.kind === "sending" ? "Sending link…" : "Email me a sign-in link"}
              </button>
              {status.kind === "error" && (
                <p className="text-xs text-red">{status.message}</p>
              )}
            </form>
          )}

          {status.kind !== "sent" && (
            <>
              <div className="flex items-center gap-3 text-muted text-[11px] tracking-widest uppercase">
                <div className="flex-1 h-px bg-border" />
                <span>or</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              <button
                onClick={handleWallet}
                className="w-full py-3 rounded-xl text-sm font-medium border border-border hover:border-muted hover:bg-card-hover transition-colors cursor-pointer"
              >
                Connect Stellar wallet →
              </button>
            </>
          )}
        </div>

        {/* ── Footer hint ──────────────────────────────────────────── */}
        <div className="px-6 pb-5 pt-1">
          <p className="text-[11px] text-muted leading-relaxed">
            Email accounts are fully custodial — we derive a Stellar address
            deterministically from your email. Transactions are gas-sponsored:
            you&apos;ll never need XLM or a seed phrase.
          </p>
        </div>
      </div>
    </div>
  );
}

function SentState({ email, onResend }: { email: string; onResend: () => void }) {
  return (
    <div className="space-y-4 py-2">
      <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-green/10 border border-green/20 text-green text-2xl mx-auto">
        ✓
      </div>
      <div className="text-center space-y-1">
        <p className="text-sm text-foreground">Check your inbox.</p>
        <p className="text-xs text-muted">
          We sent a sign-in link to <span className="text-foreground">{email}</span>. The link expires in 10 minutes.
        </p>
      </div>
      <button
        onClick={onResend}
        className="w-full text-xs text-muted hover:text-foreground underline underline-offset-2 cursor-pointer"
      >
        Use a different email
      </button>
    </div>
  );
}
