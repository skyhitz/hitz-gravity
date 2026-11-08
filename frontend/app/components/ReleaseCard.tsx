"use client";

/**
 * ReleaseCard: the Vault tab's primary card when the connected account is
 * Vaulted (balance > L: it can't send HITZ anywhere but a registered pool).
 *
 * The way out is a sale into the Sovereign Vault. The vault is a registered
 * pool, so the token always lets a vaulted account send HITZ to it, and the
 * sale pays out XLM or USDC. HITZ entering a pool grows Total Mass S, which
 * raises the Event Horizon L = √(S·10⁷); the account is free once
 * `balance − x ≤ L(S + x)`. We compute the smallest such x and quote it with
 * the vault's exact fee math, then confirm with the contract's `quote`.
 *
 * Projections are previews; the token decides on chain. It re-syncs the
 * vault flag on every transfer, so no separate release call is needed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "../contexts/WalletContext";
import { useProtocol } from "../contexts/ProtocolContext";
import { useVaultPools } from "../lib/useVaultPools";
import { HITZ_ADDRESS, getTokenInfos, knownToken, type TokenInfo } from "../lib/tokens";
import { explainVaultError, quoteOnChain, swapCall } from "../lib/vault";
import { FEE_CAP, VaultMathError, poolsFromStates, swap as vaultSwap, type Hop } from "../lib/vaultMath";
import { limitFor, minimumToRelease } from "../lib/gravity";
import { applySlippage, formatStroops, parseAmount } from "../lib/swap";
import { fmtFixed } from "../lib/format";
import { errorMessage } from "../lib/errors";
import Orbit, { orbitState } from "./Orbit";

const SLIPPAGE_BPS = 100; // 1%

type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "success"; hash: string }
  | { status: "error"; error: string };

function toInput(stroops: bigint): string {
  return stroops > 0n ? formatStroops(stroops).replace(/,/g, "") : "";
}

export default function ReleaseCard() {
  const { publicKey, callContract } = useWallet();
  const { totalMass, safetyLimit, balance, refresh } = useProtocol();
  const { pools: states, readAt, refresh: refreshPools } = useVaultPools();

  const assets = useMemo(() => states?.map((p) => p.asset) ?? [], [states]);
  const [infos, setInfos] = useState<Map<string, TokenInfo>>(new Map());
  const assetsKey = assets.join(",");
  useEffect(() => {
    if (!assetsKey) return;
    let cancelled = false;
    void getTokenInfos(assetsKey.split(",")).then((m) => {
      if (!cancelled) setInfos(m);
    });
    return () => {
      cancelled = true;
    };
  }, [assetsKey]);
  const info = (t: string): TokenInfo =>
    infos.get(t) ?? knownToken(t) ?? { address: t, symbol: `${t.slice(0, 4)}…`, decimals: 7, color: "var(--muted)" };

  const [picked, setPicked] = useState<string | null>(null);
  const asset = picked && assets.includes(picked) ? picked : assets[0] ?? null;
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  const amountStroops = useMemo(() => {
    try {
      return parseAmount(amount);
    } catch {
      return 0n;
    }
  }, [amount]);

  // ─── Gravity ─────────────────────────────────────────────────────────────
  const minToRelease = useMemo(() => (balance === null ? null : minimumToRelease(balance, totalMass)), [balance, totalMass]);
  const overHorizon = balance !== null && safetyLimit > 0n && balance > safetyLimit ? balance - safetyLimit : 0n;
  const afterBalance = balance !== null ? balance - amountStroops : null;
  const newL = limitFor(totalMass + amountStroops);
  const willRelease = afterBalance !== null && amountStroops > 0n && afterBalance <= newL;

  // ─── Quote ───────────────────────────────────────────────────────────────
  const local = useMemo((): { out: bigint; hop: Hop } | { error: string } | null => {
    if (!states || !asset || amountStroops <= 0n) return null;
    try {
      const r = vaultSwap(poolsFromStates(states), HITZ_ADDRESS, asset, amountStroops, 0n, HITZ_ADDRESS);
      return { out: r.amountOut, hop: r.hops[0] };
    } catch (err) {
      return { error: err instanceof VaultMathError ? `Vault: ${err.message}` : String(err) };
    }
  }, [states, asset, amountStroops]);

  const quoteKey = `${asset}|${amountStroops}|${readAt}`;
  const [chain, setChain] = useState<{ key: string; out: bigint | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!asset || amountStroops <= 0n || !local || "error" in local) return;
    let cancelled = false;
    const h = setTimeout(() => {
      quoteOnChain(HITZ_ADDRESS, asset, amountStroops)
        .then((out) => !cancelled && setChain({ key: quoteKey, out, error: null }))
        .catch((err) => !cancelled && setChain({ key: quoteKey, out: null, error: explainVaultError(String(err?.message ?? err)) }));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [quoteKey, asset, amountStroops, local]);
  const confirmedOut = chain?.key === quoteKey ? chain.out : null;
  const quoteError = chain?.key === quoteKey ? chain.error : local && "error" in local ? local.error : null;
  const out = confirmedOut ?? (local && "out" in local ? local.out : null);
  const assetInfo = asset ? info(asset) : null;

  const state = orbitState(balance, 0n, safetyLimit, true);

  // ─── Sell ────────────────────────────────────────────────────────────────
  const handleSell = useCallback(async () => {
    if (!publicKey || !asset || confirmedOut === null || amountStroops <= 0n) return;
    setTx({ status: "signing" });
    try {
      const call = swapCall({
        account: publicKey,
        tokenIn: HITZ_ADDRESS,
        tokenOut: asset,
        amountIn: amountStroops,
        expectedOut: confirmedOut,
        slippageBps: SLIPPAGE_BPS,
      });
      const res = await callContract(call.contractId, call.method, call.args);
      if (res.success && res.hash) {
        setTx({ status: "success", hash: res.hash });
        setAmount("");
        void refreshPools();
        void refresh();
      } else {
        setTx({ status: "error", error: explainVaultError(res.error || "Transaction failed") });
      }
    } catch (err) {
      setTx({ status: "error", error: explainVaultError(errorMessage(err)) });
    }
  }, [publicKey, asset, confirmedOut, amountStroops, callContract, refreshPools, refresh]);

  const busy = tx.status === "signing";
  const tooMuch = balance !== null && amountStroops > balance;
  const feeRate = local && "hop" in local ? local.hop.feeRate : null;

  return (
    <div className="hero vaulted fade-in">
      <div className="hero-header">
        <div className="hero-status">
          <span className="hero-status-dot" />
          <span className="hero-status-label">Vaulted</span>
        </div>
        <span className="hero-title">Sell to Release</span>
      </div>
      <div className="hero-body" style={{ padding: "28px 24px 24px" }}>
        <div style={{ display: "grid", gap: 18, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <Orbit balance={balance} expectedOut={0n} eventHorizon={safetyLimit} state={state} />
          </div>
          <div style={{ textAlign: "center", marginTop: -4 }}>
            <div className="vault-eyebrow">Out of Orbit</div>
            <h2 className="vault-title">Your account is vaulted.</h2>
            <p className="vault-subtitle" style={{ margin: "0 auto" }}>
              {balance !== null ? (
                <>
                  You hold {fmtFixed(balance, 2)} HITZ, {fmtFixed(overHorizon, 2)} over the Event Horizon. You can still sell HITZ into the
                  Sovereign Vault: it&apos;s a registered pool, so the sale grows Total Mass and raises L. Once your balance is at or under L,
                  you&apos;re free.
                </>
              ) : (
                <>Connect to see your way out.</>
              )}
            </p>
          </div>
        </div>

        <div style={{ marginTop: 24 }}>
          <div className="field-group">
            <div className="field-label">Receive</div>
            <div className="seg" role="group" aria-label="Asset to receive">
              {assets.map((a) => (
                <button key={a} className={a === asset ? "active" : ""} aria-pressed={a === asset} onClick={() => setPicked(a)}>
                  <span className="dot" style={{ background: info(a).color }} />
                  {info(a).symbol}
                </button>
              ))}
              {!assets.length && <span style={{ color: "var(--muted)", fontSize: 12 }}>Loading the vault…</span>}
            </div>
          </div>

          <div className="field-group">
            <div className="field-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>HITZ to sell</span>
              {minToRelease !== null && minToRelease > 0n && (
                <button
                  type="button"
                  className="max-btn"
                  onClick={() => setAmount(toInput(minToRelease))}
                  title="Fill in the smallest sale that releases your account."
                >
                  Min to release
                </button>
              )}
            </div>
            <input className="inp mono" placeholder="0.00" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/,/g, ""))} />
            {minToRelease !== null && minToRelease > 0n && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6, letterSpacing: "0.02em" }}>
                Smallest sale that releases you:{" "}
                <span className="mono" style={{ color: "var(--accent)" }}>
                  {fmtFixed(minToRelease, 4)} HITZ
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="sacrifice-meter">
          <div className="row">
            <span className="k">You receive</span>
            <span className="v">
              {out !== null && assetInfo ? `≈ ${formatStroops(out, assetInfo.decimals)} ${assetInfo.symbol}` : "–"}
            </span>
          </div>
          <div className="row">
            <span className="k">Vault fee</span>
            <span className="v" style={{ color: feeRate !== null && feeRate >= FEE_CAP ? "var(--red)" : undefined }}>
              {feeRate !== null ? `${(Number(feeRate) / 1e7).toFixed(2)}%` : "–"}
            </span>
          </div>
          <div className="row">
            <span className="k">Balance after</span>
            <span className="v">{afterBalance !== null ? fmtFixed(afterBalance, 4) : "–"} HITZ</span>
          </div>
          <div className="row">
            <span className="k">New L (projected)</span>
            <span className="v purple">{fmtFixed(amountStroops > 0n ? newL : safetyLimit, 4)} HITZ</span>
          </div>
          <div className="row">
            <span className="k">Outcome</span>
            <span className="v" style={{ color: willRelease ? "var(--green)" : "var(--orange)" }}>
              {amountStroops <= 0n ? "–" : willRelease ? "Released" : "Still vaulted"}
            </span>
          </div>
        </div>

        {feeRate !== null && feeRate > 15_000_000n && (
          <div className="alert warn" style={{ marginTop: 14 }}>
            <span className="icon">!</span>
            <div>
              A sale this size moves the vault&apos;s price, so it pays a higher fee (up to 10%). The fee falls back to 1% within a few hours:
              selling in smaller parts over time costs less.
            </div>
          </div>
        )}
        {quoteError && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{quoteError}</div>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <button
            className="btn purple"
            disabled={!publicKey || !asset || amountStroops <= 0n || tooMuch || confirmedOut === null || busy}
            onClick={handleSell}
          >
            {busy
              ? "Awaiting signature…"
              : tooMuch
                ? "More than your balance"
                : `Sell ${amount || "0"} HITZ${assetInfo ? ` for ${assetInfo.symbol}` : ""}`}
          </button>
          {confirmedOut !== null && assetInfo && (
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 8, textAlign: "center" }}>
              Minimum received {formatStroops(applySlippage(confirmedOut, SLIPPAGE_BPS), assetInfo.decimals)} {assetInfo.symbol} (1% slippage)
            </div>
          )}
        </div>

        {tx.status === "success" && (
          <div className="alert info" style={{ marginTop: 14 }}>
            <span className="icon">✓</span>
            <div>
              Sale confirmed ·{" "}
              <a
                href={`https://stellar.expert/explorer/public/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                view tx
              </a>
            </div>
          </div>
        )}
        {tx.status === "error" && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{tx.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}
