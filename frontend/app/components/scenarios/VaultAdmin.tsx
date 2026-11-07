"use client";

/**
 * VaultAdmin: the Sovereign Vault's state and its liquidity, for the admin.
 *
 *  - Status: who administers the vault and the token, whether the vault's
 *    code can still change, and anything waiting out its 7-day timelock (an
 *    upgrade of either contract, or a new listing).
 *  - Deposit: add liquidity to a pool at its current ratio. Anyone can call
 *    `deposit`; there are no shares and no withdrawals, so what goes in
 *    stays in the vault and only leaves through swaps. Deeper pools move
 *    less per trade, so every trade pays a lower fee.
 *
 * Listing a new asset, seeding it and upgrades stay CLI / Stellar Lab
 * operations (contracts/sovereign-vault/MIGRATION.md): they are rare,
 * timelocked, and worth doing with the runbook open.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "../../contexts/WalletContext";
import { useVaultPools } from "../../lib/useVaultPools";
import { getAdmin, getPendingUpgrade, type PendingUpgrade } from "../../lib/stellar";
import { knownToken, readBalance } from "../../lib/tokens";
import { VAULT_ID, depositAmount, depositCall, explainVaultError, readVaultStatus, type VaultStatus } from "../../lib/vault";
import { formatStroops, parseAmount } from "../../lib/swap";
import { fmtFixed, truncAddr } from "../../lib/format";
import { HITZ_ADDRESS } from "../../lib/tokens";

const TOLERANCE_BPS = 50n; // the deposit accepts the pool ratio ± 0.5%

function eta(ts: number): string {
  const left = ts * 1000 - Date.now();
  const when = new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  if (left <= 0) return `${when} (ready)`;
  const h = Math.floor(left / 3_600_000);
  return `${when} (in ${Math.floor(h / 24)}d ${h % 24}h)`;
}

export default function VaultAdmin({ publicKey }: { publicKey: string | null }) {
  const { callContract } = useWallet();
  const { pools, refresh } = useVaultPools();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [token, setToken] = useState<{ admin: string | null; pending: PendingUpgrade | null } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([readVaultStatus(), getAdmin(), getPendingUpgrade()])
      .then(([v, admin, pending]) => {
        if (cancelled) return;
        setStatus(v);
        setToken({ admin, pending });
      })
      .catch((e) => !cancelled && setStatusError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Deposit ─────────────────────────────────────────────────────────────
  const [asset, setAsset] = useState<string | null>(null);
  const pool = useMemo(() => pools?.find((p) => p.asset === (asset ?? pools[0]?.asset)) ?? null, [pools, asset]);
  const [hitzInput, setHitzInput] = useState("");
  const hitz = useMemo(() => {
    try {
      return parseAmount(hitzInput);
    } catch {
      return 0n;
    }
  }, [hitzInput]);
  const amount = pool && hitz > 0n ? depositAmount(pool, hitz) : 0n;
  const sym = pool ? knownToken(pool.asset)?.symbol ?? truncAddr(pool.asset, 4, 4) : "";

  const [balances, setBalances] = useState<{ key: string; hitz: bigint | null; asset: bigint | null } | null>(null);
  const balKey = `${publicKey}|${pool?.asset}`;
  useEffect(() => {
    if (!publicKey || !pool) return;
    let cancelled = false;
    void Promise.all([readBalance(HITZ_ADDRESS, publicKey), readBalance(pool.asset, publicKey)]).then(([h, a]) => {
      if (cancelled) return;
      setBalances({ key: balKey, hitz: h.status === "ok" ? h.amount : null, asset: a.status === "ok" ? a.amount : null });
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, pool, balKey]);
  const bal = balances?.key === balKey ? balances : null;

  const [tx, setTx] = useState<{ status: "idle" | "signing" } | { status: "done"; hash: string } | { status: "error"; error: string }>({
    status: "idle",
  });
  const deposit = useCallback(async () => {
    if (!publicKey || !pool || hitz <= 0n) return;
    setTx({ status: "signing" });
    const call = depositCall({
      account: publicKey,
      asset: pool.asset,
      hitz,
      minAmount: (amount * (10_000n - TOLERANCE_BPS)) / 10_000n,
      maxAmount: (amount * (10_000n + TOLERANCE_BPS)) / 10_000n + 1n,
    });
    try {
      const res = await callContract(call.contractId, call.method, call.args);
      if (res.success && res.hash) {
        setTx({ status: "done", hash: res.hash });
        setHitzInput("");
        void refresh();
      } else {
        setTx({ status: "error", error: explainVaultError(res.error ?? "Transaction failed") });
      }
    } catch (e) {
      setTx({ status: "error", error: explainVaultError(e instanceof Error ? e.message : String(e)) });
    }
  }, [publicKey, pool, hitz, amount, callContract, refresh]);

  return (
    <div className="space-y-6">
      <p className="text-muted text-sm leading-relaxed">
        HITZ&apos;s own exchange,{" "}
        <a className="underline" href={`https://stellar.expert/explorer/public/contract/${VAULT_ID}`} target="_blank" rel="noopener noreferrer">
          {truncAddr(VAULT_ID)}
        </a>
        . One pool per trusted asset, all against HITZ; registered on the token as a pool, so the HITZ it holds is Total Mass.
        Upgrades and new listings are public for 7 days before they can run.
      </p>

      <div className="space-y-2 text-xs">
        <h4 className="text-sm font-medium text-foreground">Status</h4>
        {statusError && <p className="text-red">{statusError}</p>}
        <Row k="Vault admin" v={status ? (status.admin ? truncAddr(status.admin) : "renounced") : "…"} />
        <Row k="Vault code" v={status ? (status.upgradable ? "upgradable (7-day timelock)" : "frozen for good") : "…"} />
        <Row
          k="Vault upgrade pending"
          v={status ? (status.pendingUpgrade ? `${status.pendingUpgrade.wasmHash.slice(0, 12)}… at ${eta(status.pendingUpgrade.eta)}` : "none") : "…"}
        />
        <Row
          k="Listing pending"
          v={
            status
              ? status.pendingListing
                ? `${knownToken(status.pendingListing.asset)?.symbol ?? truncAddr(status.pendingListing.asset)} at ${eta(status.pendingListing.eta)}`
                : "none"
              : "…"
          }
        />
        <Row k="Token admin" v={token ? (token.admin ? truncAddr(token.admin) : "renounced") : "…"} />
        <Row k="Token upgrade pending" v={token ? (token.pending ? `${token.pending.wasmHash.slice(0, 12)}… at ${eta(token.pending.eta)}` : "none") : "…"} />
      </div>

      <div className="space-y-2 text-xs">
        <h4 className="text-sm font-medium text-foreground">Pools</h4>
        {(pools ?? []).map((p) => (
          <Row
            key={p.asset}
            k={`HITZ/${knownToken(p.asset)?.symbol ?? truncAddr(p.asset, 4, 4)}`}
            v={`${fmtFixed(p.hitz, 0)} HITZ · ${fmtFixed(p.reserve, 2)} · fee ${(Number(p.fee) / 1e7).toFixed(2)}% · D ${(Number(p.dislocation) / 1e16).toFixed(2)}%`}
          />
        ))}
        {!pools && <p className="text-muted">Reading the vault…</p>}
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <h4 className="text-sm font-medium text-foreground">Deposit liquidity</h4>
        <p className="text-muted text-xs">
          Adds HITZ and the matching amount of the asset at the pool&apos;s current ratio, so the price doesn&apos;t move. No shares and no
          withdrawals: it stays in the vault for good, and deeper pools charge every trade less. From the treasury, HITZ moves pool to pool and
          Total Mass doesn&apos;t change.
        </p>
        <div className="seg" role="group" aria-label="Pool">
          {(pools ?? []).map((p) => (
            <button key={p.asset} className={pool?.asset === p.asset ? "active" : ""} onClick={() => setAsset(p.asset)}>
              {knownToken(p.asset)?.symbol ?? truncAddr(p.asset, 4, 4)}
            </button>
          ))}
        </div>
        <input value={hitzInput} onChange={(e) => setHitzInput(e.target.value.replace(/,/g, ""))} placeholder="HITZ to deposit" inputMode="decimal" />
        <p className="text-muted text-xs mono">
          {pool && hitz > 0n ? `+ ${formatStroops(amount)} ${sym} (accepted within ±0.5%)` : `the matching ${sym} is computed from the pool`}
        </p>
        {bal && (
          <p className="text-muted text-xs mono">
            You hold {bal.hitz !== null ? fmtFixed(bal.hitz, 2) : "?"} HITZ · {bal.asset !== null ? fmtFixed(bal.asset, 2) : "?"} {sym}
          </p>
        )}
        <button
          type="button"
          className="btn primary btn-sm"
          disabled={!publicKey || !pool || hitz <= 0n || tx.status === "signing" || (bal?.hitz != null && hitz > bal.hitz) || (bal?.asset != null && amount > bal.asset)}
          onClick={deposit}
        >
          {tx.status === "signing" ? "Awaiting signature…" : `Deposit ${hitzInput || "0"} HITZ + ${pool && hitz > 0n ? formatStroops(amount) : "0"} ${sym}`}
        </button>
        {tx.status === "done" && (
          <p className="text-xs text-green">
            Deposited ·{" "}
            <a className="underline" href={`https://stellar.expert/explorer/public/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer">
              view tx
            </a>
          </p>
        )}
        {tx.status === "error" && <p className="text-xs text-red break-words">{tx.error}</p>}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{k}</span>
      <span className="mono text-right">{v}</span>
    </div>
  );
}
