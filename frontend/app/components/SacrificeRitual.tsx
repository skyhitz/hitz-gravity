"use client";

/**
 * SacrificeRitual — the Vault tab's primary card when the connected account is
 * Vaulted (balance > L, outbound transfers blocked).
 *
 * The ritual: the vaulted user sends HITZ to an *audited pool* address. This
 * grows the Total Mass S, which raises the Event Horizon L (L ≈ sqrt(S)).
 * If after the sacrifice the new L ≥ the user's remaining balance, the
 * account can be released via `check_release`. We surface both numbers live
 * so the user can dial in an amount that actually frees them.
 *
 * Pool list comes from the real `listRegistrations()` helper — same source
 * the Registry card uses — so everything is chain-verified.
 *
 * Design note: the projected-L math mirrors the contract's safety limit
 * formula (√S) and is a preview only; the on-chain call is what counts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "../contexts/WalletContext";
import { useProtocol } from "../contexts/ProtocolContext";
import {
  CONTRACT_ID,
  parseHitz,
  type TxResult,
} from "../lib/stellar";
import { listRegistrations } from "../lib/registry";
import {
  getPoolReserves,
  getPoolTokens,
  getTokenInfo,
} from "../lib/aqua";
import { fmtFixed, truncAddr } from "../lib/format";
import Orbit, { orbitState } from "./Orbit";

/** Integer square root over BigInt (Newton's method). Never overflows. */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/**
 * Contract's safety limit is defined in 7-decimal stroops. The square root of
 * stroops(S) is not the same scale as L because L must itself be 7-decimal.
 * The contract uses `L = sqrt(S * 10^decimals)` so the result lives in stroops.
 * We mirror that.
 */
function projectedL(totalMassStroops: bigint): bigint {
  const DECIMALS_MULT = 10_000_000n; // 10^7
  return isqrt(totalMassStroops * DECIMALS_MULT);
}

/**
 * Minimum sacrifice to get back under the event horizon, computed by
 * bisection. The feasibility test: after transferring `x` HITZ out of the
 * user's balance (into an audited pool), the new state is
 *   balance' = balance - x
 *   S'       = S + x
 *   L'       = √(S' · 10⁷)
 * The account is released iff `balance' ≤ L'`. The LHS is monotonically
 * decreasing in `x`; the RHS is monotonically increasing — so there is a
 * unique crossover we can bisect on `[0, balance]` in BigInt.
 */
function minimumSacrificeToRelease(
  balance: bigint,
  totalMass: bigint
): bigint | null {
  if (balance <= 0n) return null;
  const feasible = (x: bigint): boolean => {
    const after = balance - x;
    const l = projectedL(totalMass + x);
    return after <= l;
  };
  if (!feasible(balance)) return null; // can't be released even by giving it all away
  if (feasible(0n)) return 0n; // already released

  let lo = 0n;
  let hi = balance;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (feasible(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Format a stroop amount into the input-friendly string (trim trailing 0s). */
function stroopsToInput(stroops: bigint): string {
  if (stroops <= 0n) return "0";
  const DEC = 10_000_000n;
  const whole = stroops / DEC;
  const frac = stroops % DEC;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * A token slot in an audited pool, resolved by simulating `symbol()` /
 * `decimals()` on the SAC contract itself. If either call fails we
 * fall back to the raw address with a 7-decimal default — keeps us
 * honest about unknown contracts instead of inventing a symbol.
 */
type TokenSlot = {
  address: string;
  /** Short symbol (e.g. "USDC") or null when unresolved. */
  symbol: string | null;
  decimals: number;
  color: string | null;
};

interface EnrichedPool {
  address: string;
  venue?: string;
  /** Raw token-contract addresses in the pool's canonical order (A, B). */
  tokens?: [string, string];
  /** Resolved display slots for each token in the pool. */
  slots?: [TokenSlot, TokenSlot];
  reserves?: { reserveA: bigint; reserveB: bigint } | null;
}

async function resolveSlot(tokenAddr: string): Promise<TokenSlot> {
  const info = await getTokenInfo(tokenAddr);
  if (info) {
    return {
      address: tokenAddr,
      symbol: info.symbol,
      decimals: info.decimals,
      color: info.color,
    };
  }
  // Unknown asset — default to 7 decimals (the Stellar convention) so the
  // reserve number renders in a sane ballpark.
  return { address: tokenAddr, symbol: null, decimals: 7, color: null };
}

type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "success"; hash: string; action: "sacrifice" | "release" }
  | { status: "error"; error: string };

export default function SacrificeRitual() {
  const { publicKey, callContract } = useWallet();
  const { totalMass, safetyLimit, balance, refresh } = useProtocol();

  const [pools, setPools] = useState<EnrichedPool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [selectedPool, setSelectedPool] = useState<string>("");
  const [poolOpen, setPoolOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [txState, setTxState] = useState<TxState>({ status: "idle" });

  // Load audited pool list from the chain-verified registry, then enrich
  // each address by hitting the pool contract directly for its tokens +
  // reserves. We avoid cross-referencing Aqua's router cache here — that
  // cache keys by candidate pair and only returns the first pool per pair,
  // which means registered pools that happen to live on a less-preferred
  // `(tokens, pool_index)` entry never match and end up showing as raw
  // addresses. Asking the pool itself is stable and works for every pool
  // exposing the standard `get_tokens` / `get_reserves` surface.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await listRegistrations();
        if (cancelled) return;

        const base: EnrichedPool[] = snap.pools.map((addr) => ({ address: addr }));
        setPools(base);
        if (base.length > 0) setSelectedPool((cur) => cur || base[0].address);
        setPoolsLoading(false);

        // Fan out enrichment — each pool's tokens + reserves are independent
        // simulations, so hit them in parallel but write each back as soon
        // as it lands so the UI progressively fills in.
        await Promise.all(
          base.map(async (p, idx) => {
            const [tokens, reserves] = await Promise.all([
              getPoolTokens(p.address),
              getPoolReserves(p.address),
            ]);
            if (cancelled) return;
            const slots: [TokenSlot, TokenSlot] | undefined = tokens
              ? ((await Promise.all([resolveSlot(tokens[0]), resolveSlot(tokens[1])])) as [
                  TokenSlot,
                  TokenSlot,
                ])
              : undefined;
            if (cancelled) return;
            setPools((prev) => {
              const next = prev.slice();
              next[idx] = {
                ...next[idx],
                venue: tokens ? "Aqua" : undefined,
                tokens: tokens ?? undefined,
                slots,
                reserves,
              };
              return next;
            });
          })
        );
      } catch {
        if (!cancelled) setPoolsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const poolByAddr = useMemo(() => {
    const map = new Map<string, EnrichedPool>();
    for (const p of pools) map.set(p.address, p);
    return map;
  }, [pools]);
  const selectedPoolData = poolByAddr.get(selectedPool);

  // ─── Projections ─────────────────────────────────────────────────────────
  const amountStroops = useMemo(() => {
    if (!amount) return 0n;
    try {
      return parseHitz(amount);
    } catch {
      return 0n;
    }
  }, [amount]);

  const afterBalance = balance !== null ? balance - amountStroops : null;
  const projectedMass = totalMass + amountStroops;
  const projectedNewL = projectedL(projectedMass);
  const willRelease =
    afterBalance !== null && afterBalance <= projectedNewL && amountStroops > 0n;

  // Over-horizon amount, for the subtitle copy.
  const overHorizon =
    balance !== null && safetyLimit > 0n && balance > safetyLimit
      ? balance - safetyLimit
      : 0n;

  // Minimum sacrifice that makes `balance' ≤ L'` (null if unreachable).
  const minToRelease = useMemo(() => {
    if (balance === null) return null;
    return minimumSacrificeToRelease(balance, totalMass);
  }, [balance, totalMass]);

  const state = orbitState(balance, 0n, safetyLimit, true); // vaulted

  // ─── Actions ─────────────────────────────────────────────────────────────
  // Both actions go through `callContract` — for wallet users it runs the
  // usual sim → sign → submit flow; for email users it POSTs to the
  // gateway which fee-bumps with the sponsor.
  const handleSacrifice = useCallback(async () => {
    if (!publicKey || !selectedPool || amountStroops <= 0n) return;
    setTxState({ status: "signing" });
    let res: TxResult;
    try {
      res = await callContract(CONTRACT_ID, "transfer", [
        StellarSdk.Address.fromString(publicKey).toScVal(),
        StellarSdk.Address.fromString(selectedPool).toScVal(),
        StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
      ]);
    } catch (err) {
      setTxState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (res.success && res.hash) {
      setTxState({ status: "success", hash: res.hash, action: "sacrifice" });
      refresh();
    } else {
      setTxState({ status: "error", error: res.error || "Transaction failed" });
    }
  }, [publicKey, selectedPool, amountStroops, callContract, refresh]);

  const handleCheckRelease = useCallback(async () => {
    if (!publicKey) return;
    setTxState({ status: "signing" });
    let res: TxResult;
    try {
      res = await callContract(CONTRACT_ID, "check_release", [
        StellarSdk.Address.fromString(publicKey).toScVal(),
      ]);
    } catch (err) {
      setTxState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (res.success && res.hash) {
      setTxState({ status: "success", hash: res.hash, action: "release" });
      refresh();
    } else {
      setTxState({ status: "error", error: res.error || "Transaction failed" });
    }
  }, [publicKey, callContract, refresh]);

  const busy = txState.status === "signing";

  return (
    <div className="hero vaulted fade-in">
      <div className="hero-header">
        <div className="hero-status">
          <span className="hero-status-dot" />
          <span className="hero-status-label">Vaulted</span>
        </div>
        <span className="hero-title">Sacrifice Ritual</span>
      </div>
      <div className="hero-body" style={{ padding: "28px 24px 24px" }}>
        <div style={{ display: "grid", gap: 18, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <Orbit
              balance={balance}
              expectedOut={0n}
              eventHorizon={safetyLimit}
              state={state}
            />
          </div>
          <div style={{ textAlign: "center", marginTop: -4 }}>
            <div className="vault-eyebrow">Industrial Reset</div>
            <h2 className="vault-title">You are out of Orbit.</h2>
            <p className="vault-subtitle" style={{ margin: "0 auto" }}>
              {balance !== null ? (
                <>
                  You hold {fmtFixed(balance, 2)} HITZ,{" "}
                  {minToRelease !== null && (
                    <strong className="cursor-pointer" style={{ color: "var(--purple)" }} onClick={() => setAmount(stroopsToInput(minToRelease))}>
                      {fmtFixed(overHorizon, 2)}
                    </strong>
                  )}{" "}
                  over the Event Horizon. Offer tokens to an audited pool to
                  grow Total Mass, raise L, and release your account.
                </>
              ) : (
                <>Connect a wallet to begin the ritual.</>
              )}
            </p>
          </div>
        </div>

        <div style={{ marginTop: 24 }}>
          {/* Audited pool picker */}
          <div className="field-group">
            <div className="field-label">Audited pool</div>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => setPoolOpen((o) => !o)}
                disabled={poolsLoading || pools.length === 0}
                style={{
                  width: "100%",
                  textAlign: "left",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "var(--bg-2)",
                  color: "var(--foreground)",
                  cursor: pools.length === 0 ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  fontSize: 13,
                  opacity: pools.length === 0 ? 0.6 : 1,
                }}
              >
                {selectedPool ? (
                  <PoolRowSummary pool={selectedPoolData} addr={selectedPool} />
                ) : (
                  <span style={{ color: "var(--muted)" }}>
                    {poolsLoading
                      ? "Loading audited pools…"
                      : "No audited pools registered"}
                  </span>
                )}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ opacity: 0.6, marginLeft: 6, flexShrink: 0 }}
                >
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {poolOpen && pools.length > 0 && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 40 }}
                    onClick={() => setPoolOpen(false)}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: "calc(100% + 6px)",
                      zIndex: 50,
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      padding: 4,
                      boxShadow: "0 20px 40px -10px rgba(0,0,0,0.8)",
                      maxHeight: 280,
                      overflowY: "auto",
                    }}
                  >
                    {pools.map((p) => (
                      <button
                        key={p.address}
                        onClick={() => {
                          setSelectedPool(p.address);
                          setPoolOpen(false);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "10px 12px",
                          borderRadius: 8,
                          border: 0,
                          background:
                            p.address === selectedPool
                              ? "var(--bg-2)"
                              : "transparent",
                          color: "var(--foreground)",
                          textAlign: "left",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: 12,
                        }}
                      >
                        <PoolRowSummary pool={p} addr={p.address} compact />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Amount input */}
          <div className="field-group">
            <div
              className="field-label"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
              <span>Amount to sacrifice</span>
              {minToRelease !== null && balance !== null && balance > 0n && (
                <button
                  type="button"
                  onClick={() => setAmount(stroopsToInput(minToRelease))}
                  title="Autofill the smallest sacrifice that releases your account."
                  style={{
                    background: "rgba(10,132,255,0.1)",
                    color: "var(--accent)",
                    border: "1px solid rgba(10,132,255,0.3)",
                    borderRadius: 999,
                    padding: "2px 10px",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Min to release
                </button>
              )}
            </div>
            <input
              className="inp mono"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {minToRelease !== null && balance !== null && balance > 0n && (
              <div
                style={{
                  fontSize: 10,
                  color: "var(--muted)",
                  marginTop: 6,
                  letterSpacing: "0.02em",
                }}
              >
                Minimum to escape Orbit:{" "}
                <span className="mono" style={{ color: "var(--accent)" }}>
                  {fmtFixed(minToRelease, 4)} HITZ
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Projection meter */}
        <div className="sacrifice-meter">
          <div className="row">
            <span className="k">After sacrifice</span>
            <span className="v">
              {afterBalance !== null ? fmtFixed(afterBalance, 4) : "–"} HITZ
            </span>
          </div>
          <div className="row">
            <span className="k">New L (projected)</span>
            <span className="v purple">
              {amountStroops > 0n ? fmtFixed(projectedNewL, 4) : fmtFixed(safetyLimit, 4)}{" "}
              HITZ
            </span>
          </div>
          <div className="row">
            <span className="k">Outcome</span>
            <span
              className="v"
              style={{
                color: willRelease ? "var(--green)" : "var(--orange)",
              }}
            >
              {amountStroops <= 0n
                ? "–"
                : willRelease
                  ? "Released"
                  : "Still vaulted"}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ marginTop: 20 }}>
          <button
            className="btn purple"
            disabled={
              !publicKey ||
              !selectedPool ||
              amountStroops <= 0n ||
              busy
            }
            onClick={handleSacrifice}
          >
            {busy && txState.status === "signing"
              ? "Awaiting signature…"
              : `Sacrifice ${amount || "0"} HITZ`}
          </button>
          <button
            className="btn ghost"
            style={{ marginTop: 10 }}
            disabled={!publicKey || busy}
            onClick={handleCheckRelease}
          >
            Check release status
          </button>
        </div>

        {/* Tx status */}
        {txState.status === "success" && (
          <div className="alert info" style={{ marginTop: 14 }}>
            <span className="icon">✓</span>
            <div>
              {txState.action === "sacrifice" ? "Sacrifice" : "Release check"}{" "}
              confirmed ·{" "}
              <a
                href={`https://stellar.expert/explorer/public/tx/${txState.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                view tx
              </a>
            </div>
          </div>
        )}
        {txState.status === "error" && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            <span className="icon">⚠</span>
            <div style={{ wordBreak: "break-word" }}>{txState.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PoolRowSummary ──────────────────────────────────────────────────────────
//
// Shared renderer for both the dropdown trigger and each option. We key the
// display on the pair symbols (venue · HITZ/XLM) rather than the address, and
// fold in live reserves when available. Fallback: the truncated contract
// address, so non-Aqua registered pools still render sanely.

function PoolRowSummary({
  pool,
  addr,
  compact = false,
}: {
  pool: EnrichedPool | undefined;
  addr: string;
  compact?: boolean;
}) {
  const reserves = pool?.reserves ?? null;

  // Reserves come back in the pool's canonical (tokenA, tokenB) order. The
  // slots were resolved from the same order, so reserveA/reserveB line up
  // with slots[0]/slots[1] without extra bookkeeping.
  const pairDisplay: { slot: TokenSlot; reserve?: bigint }[] | null = pool?.slots
    ? [
        { slot: pool.slots[0], reserve: reserves?.reserveA },
        { slot: pool.slots[1], reserve: reserves?.reserveB },
      ]
    : null;

  return (
    <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontWeight: 500,
            fontSize: compact ? 12 : 13,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--muted)" }}>
            {pool?.venue ?? "Registered"}
          </span>
          <span style={{ color: "var(--muted-soft, var(--muted))" }}>·</span>
          {pairDisplay ? (
            <span style={{ color: "var(--foreground)" }}>
              <SlotLabel slot={pairDisplay[0].slot} />
              <span style={{ color: "var(--muted)", margin: "0 3px" }}>/</span>
              <SlotLabel slot={pairDisplay[1].slot} />
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
              {truncAddr(addr, 6, 6)}
            </span>
          )}
        </div>
        {pairDisplay && (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--muted)",
              marginTop: 3,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {pairDisplay.map((p, i) => (
              <span key={i}>
                {p.reserve !== undefined && p.reserve !== null
                  ? fmtFixed(p.reserve, 0, p.slot.decimals)
                  : "…"}{" "}
                <SlotLabel slot={p.slot} />
              </span>
            ))}
          </div>
        )}
        {pairDisplay && (
          <div
            className="mono"
            style={{
              fontSize: 9,
              color: "var(--muted-soft, var(--muted))",
              marginTop: 2,
              opacity: 0.6,
            }}
          >
            {truncAddr(addr, 6, 6)}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Render a pool token identity: the on-chain `symbol()` in its
 * deterministic palette colour, or a truncated contract address in
 * muted mono if the contract didn't expose `symbol()`.
 */
function SlotLabel({ slot }: { slot: TokenSlot }) {
  if (slot.symbol) {
    return (
      <span style={{ color: slot.color ?? "var(--foreground)", fontWeight: 500 }}>
        {slot.symbol}
      </span>
    );
  }
  return (
    <span
      className="mono"
      title={slot.address}
      style={{ color: "var(--muted)", fontSize: "0.9em" }}
    >
      {truncAddr(slot.address, 4, 4)}
    </span>
  );
}
