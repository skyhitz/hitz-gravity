"use client";

import { useState, useRef, useEffect } from "react";

// v2 (Nov 4, 2026): the terms now cover the Sovereign Vault (fees, no
// withdrawals, timelocked admin powers), so everyone accepts them again.
// v3 (Nov 13, 2026): corrected. The admin can change the token's registry at
// once (which exempts an address from vaulting and moves L); v2 said the
// developers could not affect any Vaulted state. Everyone accepts again.
export const CONSENT_KEY = "gravity-hitz-consent-v3";

interface Props {
  onAccept: () => void;
}

export default function ConsentModal({ onAccept }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [checks, setChecks] = useState({
    vault: false,
    trading: false,
    waiver: false,
  });

  // If content doesn't overflow, unlock immediately.
  // This is a one-shot DOM measurement on mount — we must read scrollHeight
  // after layout, so setState-in-effect is the correct pattern here.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 16) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-layout measurement
      setHasScrolled(true);
    }
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || hasScrolled) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
      setHasScrolled(true);
    }
  };

  const toggle = (k: keyof typeof checks) => {
    if (!hasScrolled) return;
    setChecks((p) => ({ ...p, [k]: !p[k] }));
  };

  const allChecked = checks.vault && checks.trading && checks.waiver;

  const handleAccept = () => {
    localStorage.setItem(CONSENT_KEY, "true");
    onAccept();
  };

  return (
    // The overlay scrolls when the card is taller than the screen (a short
    // phone), so the header and the accept button are always reachable.
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      {/* Deep backdrop */}
      <div className="fixed inset-0 bg-[#050507]/96 backdrop-blur-2xl" />

      <div className="relative flex min-h-full items-center justify-center p-4">
        {/* Modal */}
        <div className="relative w-full max-w-md rounded-3xl border border-border bg-card flex flex-col animate-fade-in shadow-2xl">

          {/* ── Header ───────────────────────── */}
          <div className="px-6 pt-6 pb-5 border-b border-border shrink-0">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 min-w-0">
                <p className="text-accent text-xs tracking-widest uppercase font-medium">
                  Legal Disclosure
                </p>
                <h2 className="text-xl font-bold tracking-tight">HITZ Protocol</h2>
                <p className="text-muted text-sm">
                  Read before entering the protocol.
                </p>
              </div>
              <div className="shrink-0 w-11 h-11 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent text-xl select-none">
                ⊗
              </div>
            </div>
          </div>

          {/* ── Scroll area ──────────────────── */}
          <div className="relative shrink-0">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="overflow-y-auto px-6 py-5 space-y-5 text-sm"
              style={{ maxHeight: "320px", overscrollBehavior: "contain" }}
            >
              <LegalSection number="I" title="The Gravity Law">
                <p className="text-muted leading-relaxed">
                  The Protocol enforces a dynamic holding limit, the{" "}
                  <strong className="text-foreground">Event Horizon (L)</strong>, defined as:
                </p>
                <div className="my-3 bg-background border border-border rounded-xl px-4 py-3 font-mono text-base text-center text-foreground tracking-tight">
                  L = ⌊ √( S × 10<sup>7</sup> ) ⌋
                </div>
                <p className="text-muted leading-relaxed">
                  where <span className="font-mono text-purple">S</span> is the HITZ held
                  by registered pools: the Sovereign Vault and the treasury. Any account
                  whose HITZ balance exceeds L is{" "}
                  <strong className="text-red">automatically Vaulted</strong>: it can send
                  HITZ only to a registered pool, such as by selling it into the vault.{" "}
                  <strong className="text-foreground">
                    This is intentional, designed behavior, not a bug.
                  </strong>
                </p>
                <p className="text-muted text-xs leading-relaxed mt-2">
                  L is dynamic. It rises as HITZ enters registered pools and falls as it
                  leaves them, including whenever anyone buys HITZ from the vault, and a
                  purchase is judged against the L it leaves behind. An account safe today
                  may be Vaulted tomorrow. No one can set or clear a Vaulted state
                  directly, but the token&apos;s admin can change its registered pools
                  and routers at once: a registered address is never Vaulted, and
                  adding or removing a pool moves L for everyone.
                </p>
              </LegalSection>

              <Divider />

              <LegalSection number="II" title="Releasing a Vault">
                <p className="text-muted leading-relaxed">
                  A Vaulted balance comes down by moving HITZ into a registered pool:{" "}
                  <strong className="text-orange">selling it into the Sovereign Vault</strong>{" "}
                  (paid in XLM or USDC, minus the vault&apos;s fee) or a{" "}
                  <strong className="text-orange">Sacrifice</strong> (a transfer with
                  nothing back).
                </p>
                <div className="mt-3 space-y-1.5 text-xs text-muted">
                  {[
                    "Sales and Sacrifices are permanent and irreversible.",
                    "HITZ sent to the vault outside a swap or deposit is lost for good.",
                    "No guarantee any amount will reduce balance below L.",
                    "Developers have zero ability to refund or compensate.",
                  ].map((t) => (
                    <div key={t} className="flex items-start gap-2">
                      <span className="text-orange mt-0.5 shrink-0">·</span>
                      <span>{t}</span>
                    </div>
                  ))}
                </div>
              </LegalSection>

              <Divider />

              <LegalSection number="III" title="The Sovereign Vault">
                <div className="space-y-1.5 text-xs text-muted">
                  {[
                    "Every pass through a pool pays 1% to 10%, rising while a trade leaves one asset dislocated against another.",
                    "The vault's prices can differ from other markets and move before your trade executes; your slippage limit is the only bound.",
                    "Deposits earn no shares and can never be withdrawn.",
                    "Each listed asset carries its issuer's risk (freezes, clawbacks).",
                  ].map((t) => (
                    <div key={t} className="flex items-start gap-2">
                      <span className="text-orange mt-0.5 shrink-0">·</span>
                      <span>{t}</span>
                    </div>
                  ))}
                </div>
              </LegalSection>

              <Divider />

              <LegalSection number="IV" title="Assumption of Risk">
                <div className="space-y-2 text-xs text-muted">
                  {[
                    { head: "Smart Contract Risk", body: "Experimental; the token and the vault are not independently audited. Bugs may cause total, irrecoverable loss.", color: "text-red" },
                    { head: "Infrastructure Risk", body: "Depends on Stellar Network and Soroban VM. Outages beyond developer control.", color: "text-orange" },
                    { head: "Market & Regulatory Risk", body: "HITZ may have no value. You are solely responsible for legal compliance.", color: "text-yellow" },
                    { head: "Upgrade & Admin Risk", body: "Both contracts can be upgraded after a public 7-day timelock, and the vault's admin can list new assets the same way. Changes to the token's registered pools and routers take effect immediately. One account holds both admin roles and the treasury.", color: "text-muted" },
                  ].map(({ head, body, color }) => (
                    <div key={head} className="flex items-start gap-2">
                      <span className={`${color} shrink-0 mt-0.5`}>▸</span>
                      <span><strong className="text-foreground">{head}.</strong> {body}</span>
                    </div>
                  ))}
                </div>
              </LegalSection>

              <Divider />

              <LegalSection number="V" title="Class Action Waiver">
                <p className="text-muted text-xs leading-relaxed">
                  <strong className="text-foreground uppercase text-[11px] tracking-wider">
                    By using this software, you irrevocably waive your right to participate
                    in any class action lawsuit or class-wide arbitration.
                  </strong>{" "}
                  All disputes must be resolved individually via binding arbitration. You
                  may not act as a plaintiff or class member in any representative proceeding.
                </p>
              </LegalSection>

              <Divider />

              <LegalSection number="VI" title="No Financial Advice">
                <p className="text-muted text-xs leading-relaxed">
                  The <strong className="text-foreground">Event Horizon (L)</strong> and all
                  other protocol metrics, including prices, quotes, fees and liquidity, are
                  technical figures, not investment advice,
                  financial guidance, or a recommendation to buy, hold, or transfer any asset.
                  The Protocol is provided &quot;as is,&quot; without warranty of any kind.
                </p>
              </LegalSection>

              {/* Scroll target */}
              <div className="h-2" />
            </div>

            {/* Bottom fade + scroll hint */}
            <div
              className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none transition-opacity duration-300 flex items-end justify-center pb-1.5"
              style={{ opacity: hasScrolled ? 0 : 1 }}
            >
              <div className="absolute inset-0 bg-gradient-to-t from-card to-transparent" />
              <span className="relative text-xs text-muted shimmer">↓ scroll to continue</span>
            </div>
          </div>

          {/* ── Checkboxes + CTA ─────────────── */}
          <div
            className="px-6 py-5 border-t border-border space-y-3.5 shrink-0 bg-card rounded-b-3xl transition-opacity duration-300"
            style={{
              opacity: hasScrolled ? 1 : 0.3,
              pointerEvents: hasScrolled ? "auto" : "none",
            }}
          >
            <ConsentCheck
              checked={checks.vault}
              onChange={() => toggle("vault")}
              label="I acknowledge that exceeding the Event Horizon (L) will Vault my account: it can then send HITZ only to a registered pool, such as by selling into the vault."
            />
            <ConsentCheck
              checked={checks.trading}
              onChange={() => toggle("trading")}
              label="I understand that trades with the Sovereign Vault pay a 1% to 10% fee, that sales, Sacrifices and deposits are irreversible, and that deposits can never be withdrawn."
            />
            <ConsentCheck
              checked={checks.waiver}
              onChange={() => toggle("waiver")}
              label="I agree to the Class Action Waiver and accept all risks of this experimental software."
            />

            <button
              onClick={handleAccept}
              disabled={!allChecked}
              className="w-full mt-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer bg-accent hover:bg-accent-hover text-white disabled:opacity-25 disabled:cursor-not-allowed"
            >
              {allChecked ? "Enter the Gravity Field →" : "Acknowledge all items above"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────

function LegalSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-muted">{number}.</span>
        <h3 className="text-foreground font-semibold text-sm">{title}</h3>
      </div>
      <div className="pl-4">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-border" />;
}

function ConsentCheck({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group select-none" onClick={onChange}>
      <div
        className={`relative shrink-0 w-5 h-5 rounded-md border transition-all duration-150 flex items-center justify-center mt-0.5 ${
          checked
            ? "bg-accent border-accent"
            : "bg-background border-border group-hover:border-muted"
        }`}
      >
        {checked && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
            <path
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2 6.5l3 3 5-5"
            />
          </svg>
        )}
      </div>
      <span className={`text-xs leading-relaxed transition-colors ${checked ? "text-foreground" : "text-muted"}`}>
        {label}
      </span>
    </label>
  );
}
