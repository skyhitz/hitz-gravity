"use client";

/**
 * Registry — live list of approved pools / routers.
 *
 * Reads the token's own `list_pools` / `list_routers` views (via
 * listRegistrations), so it matches exactly what the chain reports, and
 * names what it can: the Sovereign Vault, the treasury, the gas sponsor.
 *
 * This card replaces the registry list inside ProtocolGrowth for the Monitor
 * tab. The Admin tab's Protocol Growth scenario still owns the register /
 * remove flows — this component is read-only on purpose (explicit about its
 * role: monitoring, not mutation).
 */

import { useCallback, useEffect, useState } from "react";
import { KNOWN_ROUTERS, listRegistrations, type RegistrySnapshot } from "../lib/registry";
import { describePools } from "../lib/holders";
import { truncAddr } from "../lib/format";

type Kind = "pool" | "router";

type ListState =
  | { status: "loading" }
  | { status: "ready"; snapshot: RegistrySnapshot; labels: Map<string, string> }
  | { status: "error"; error: string };

/** The registry plus a name for every address we can name. */
async function loadLabelled(): Promise<{ snapshot: RegistrySnapshot; labels: Map<string, string> }> {
  const snapshot = await listRegistrations();
  const labels = new Map<string, string>(Object.entries(KNOWN_ROUTERS));
  const pools = await describePools(snapshot.pools).catch(() => new Map<string, { title: string }>());
  for (const [address, l] of pools) labels.set(address, l.title);
  return { snapshot, labels };
}

export default function RegistryCardPair() {
  const [state, setState] = useState<ListState>({ status: "loading" });

  const refresh = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", ...(await loadLabelled()) });
    } catch (err) {
      setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadLabelled();
        if (!cancelled) setState({ status: "ready", ...loaded });
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
          ? "HITZ held here is Total Mass. Vaulted accounts can still send HITZ here, such as selling into the vault."
          : "Pass-through infrastructure. Never counted as mass; vaulted accounts can't send to them."}
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
          <AddressRow key={addr} address={addr} kind={kind} label={state.status === "ready" ? state.labels.get(addr) : undefined} />
        ))}
      </div>
    </div>
  );
}

function AddressRow({ address, kind, label }: { address: string; kind: Kind; label?: string }) {
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
        {label && <div className="registry-label">{label}</div>}
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
