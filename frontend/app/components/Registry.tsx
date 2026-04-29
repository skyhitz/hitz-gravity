"use client";

/**
 * Registry — live list of approved pools / routers.
 *
 * Pulls from the existing listRegistrations() helper (seeds ∪ localStorage ∪
 * recent events, verified by getLedgerEntries on ApprovedPools/Routers) so
 * we match exactly what the chain reports.
 *
 * This card replaces the registry list inside ProtocolGrowth for the Monitor
 * tab. The Admin tab's Protocol Growth scenario still owns the register /
 * remove flows — this component is read-only on purpose (explicit about its
 * role: monitoring, not mutation).
 */

import { useCallback, useEffect, useState } from "react";
import { listRegistrations, type RegistrySnapshot } from "../lib/registry";
import { truncAddr } from "../lib/format";

type Kind = "pool" | "router";

type ListState =
  | { status: "loading" }
  | { status: "ready"; snapshot: RegistrySnapshot }
  | { status: "error"; error: string };

export default function RegistryCardPair() {
  const [state, setState] = useState<ListState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const snapshot = await listRegistrations();
      setState({ status: "ready", snapshot });
    } catch (err) {
      setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snapshot = await listRegistrations();
        if (!cancelled) setState({ status: "ready", snapshot });
      } catch (err) {
        if (!cancelled) {
          setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
      <RegistryCard title="Registered Pools" kind="pool" state={state} onRefresh={refresh} />
      <RegistryCard
        title="Registered Routers"
        kind="router"
        state={state}
        onRefresh={refresh}
      />
    </div>
  );
}

function RegistryCard({
  title,
  kind,
  state,
  onRefresh,
}: {
  title: string;
  kind: Kind;
  state: ListState;
  onRefresh: () => void;
}) {
  const addresses =
    state.status === "ready"
      ? kind === "pool"
        ? state.snapshot.pools
        : state.snapshot.routers
      : [];
  const dotColor = kind === "pool" ? "var(--accent)" : "var(--purple)";

  return (
    <div className="registry">
      <div className="registry-head">
        <div className="ttl-wrap">
          <span className="dot" style={{ background: dotColor }} />
          <h4>{title}</h4>
          {state.status === "ready" && <span className="count">{addresses.length}</span>}
        </div>
        <button
          className="refresh"
          title="Refresh from chain"
          onClick={onRefresh}
          disabled={state.status === "loading"}
        >
          {state.status === "loading" ? (
            <>
              <span className="shimmer" style={{ width: 10, height: 10, borderRadius: 999 }} />
              Loading…
            </>
          ) : (
            <>↻ Refresh</>
          )}
        </button>
      </div>
      <p className="registry-sub">
        {kind === "pool"
          ? "Pool balances contribute to Total Mass. Vaulted users may only send here (Sacrifice)."
          : "Pass-through aggregators. Never affect mass; vaulted users cannot send to them."}
      </p>

      {state.status === "error" && (
        <div className="alert danger" style={{ marginBottom: 10 }}>
          <span className="icon">⚠</span>
          <div>{state.error}</div>
        </div>
      )}

      <div className="registry-list">
        {state.status === "ready" && addresses.length === 0 && (
          <div className="registry-empty">None registered</div>
        )}
        {addresses.map((addr) => (
          <AddressRow key={addr} address={addr} kind={kind} />
        ))}
      </div>
    </div>
  );
}

function AddressRow({ address, kind }: { address: string; kind: Kind }) {
  const [copied, setCopied] = useState(false);
  const explorerPath = address.startsWith("G") ? "account" : "contract";
  const explorerUrl = `https://stellar.expert/explorer/public/${explorerPath}/${address}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard perms — ignore */
    }
  };

  return (
    <div className={`registry-row ${kind}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="addr" title={address}>
          {truncAddr(address)}
        </div>
      </div>
      <div className="actions">
        <button onClick={copy} title="Copy address">
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer" title="View on Stellar Expert">
          ↗
        </a>
      </div>
    </div>
  );
}
