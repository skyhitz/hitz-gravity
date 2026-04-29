"use client";

import { useState } from "react";
import {
  getBalance,
  isAccountVaulted,
  isPool,
  isRouter,
  formatHitz,
} from "../lib/stellar";

interface AccountInfo {
  address: string;
  balance: bigint;
  vaulted: boolean;
  pool: boolean;
  router: boolean;
}

export default function AccountInspector() {
  const [address, setAddress] = useState("");
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    const trimmed = address.trim();
    if (!trimmed.startsWith("G") && !trimmed.startsWith("C")) return;
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const [balance, vaulted, pool, router] = await Promise.all([
        getBalance(trimmed),
        isAccountVaulted(trimmed),
        isPool(trimmed),
        isRouter(trimmed),
      ]);
      setInfo({ address: trimmed, balance, vaulted, pool, router });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to inspect account");
    } finally {
      setLoading(false);
    }
  };

  const identityLabel = (info: AccountInfo) => {
    if (info.pool) return { label: "Approved Pool", color: "text-purple" };
    if (info.router) return { label: "Approved Router", color: "text-accent" };
    return { label: "Regular address", color: "text-muted" };
  };

  return (
    <div className="space-y-3">
      {/* Input row */}
      <div className="flex gap-2">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Stellar address (G… or C…)"
          onKeyDown={(e) => e.key === "Enter" && inspect()}
          className="flex-1"
        />
        <button
          onClick={inspect}
          disabled={loading || (!address.startsWith("G") && !address.startsWith("C"))}
          className="bg-card hover:bg-card-hover border border-border text-foreground rounded-xl px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {loading ? (
            <span className="shimmer inline-block">···</span>
          ) : (
            "Inspect"
          )}
        </button>
      </div>

      {error && (
        <p className="text-red text-xs px-1 animate-fade-in">{error}</p>
      )}

      {info && (
        <div className="animate-fade-in rounded-2xl border border-border overflow-hidden">
          {/* Address header */}
          <div className="px-4 py-3 border-b border-border">
            <p className="font-mono text-xs text-muted truncate">{info.address}</p>
          </div>

          {/* Stats rows */}
          <div className="divide-y divide-border">
            <Row label="Balance">
              <span className="font-mono font-medium text-foreground">
                {formatHitz(info.balance)}
              </span>
              <span className="text-muted text-xs ml-1">HITZ</span>
            </Row>

            <Row label="Vault Status">
              {info.vaulted ? (
                <Badge dot="bg-red" text="Vaulted" textColor="text-red" />
              ) : (
                <Badge dot="bg-green" text="Free" textColor="text-green" />
              )}
            </Row>

            <Row label="Identity">
              {(() => {
                const { label, color } = identityLabel(info);
                return <span className={`text-sm font-medium ${color}`}>{label}</span>;
              })()}
            </Row>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-muted text-sm">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Badge({
  dot,
  text,
  textColor,
}: {
  dot: string;
  text: string;
  textColor: string;
}) {
  return (
    <span className={`flex items-center gap-1.5 text-sm font-medium ${textColor}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  );
}
